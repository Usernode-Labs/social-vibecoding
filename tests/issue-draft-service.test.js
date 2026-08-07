// #1037: services/issue-draft.js — the shared draft-card creator behind
// BOTH the build agent's usernode-report-platform-issue CLI (via
// routes/internal.js) and the Mayor's in-process draft_issue_report tool.
//
// What matters here is the result-object contract the two callers map
// onto their own surfaces, and the guardrails that keep a card from being
// drafted when it shouldn't be: destination resolution, the two de-dupes
// (with the deliberate asymmetry on dismissed drafts), and the per-source
// rate caps.
//
// Run with: node --test tests/issue-draft-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');
const sessionBus = require('../src/services/session-bus');
const ws = require('../src/services/ws');
const issueDraft = require('../src/services/issue-draft');

const CONFIG = { platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };

// Minimal pg-pool double. Each query is matched by a fragment of its SQL
// so the tests read as "what the DB holds", not "what SQL ran".
function makePool({ session, priorDrafts = [], recentCount = 0, failOn = null } = {}) {
  const inserted = [];
  const pool = {
    inserted,
    async query(sql, params) {
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      if (sql.includes('FROM chat_sessions cs')) {
        return { rows: session === null ? [] : [session] };
      }
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ n: recentCount }] };
      }
      if (sql.includes('SELECT id, metadata FROM chat_session_messages')) {
        return { rows: priorDrafts };
      }
      if (sql.includes('INSERT INTO chat_session_messages')) {
        inserted.push({ sql, params });
        return { rows: [{ id: 900 + inserted.length }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  return pool;
}

const SESSION = {
  id: 5,
  app_id: 3,
  app_slug: 'demo-app',
  app_name: 'Demo App',
  repo_url: 'https://github.com/someone/demo-app',
};

const priorRow = (draft) => ({ id: 11, metadata: { platformIssueDraft: draft } });

// Stub every outbound edge (GitHub reads, the two live-push channels) and
// restore after each test. Records the events so "exactly one push" is
// assertable.
function withStubs(t, { issues = { issues: [] }, appInstalled = true } = {}) {
  const orig = {
    fetchPublicIssues: github.fetchPublicIssues,
    isEnabled: github.isEnabled,
    publish: sessionBus.publish,
    broadcastGlobal: ws.broadcastGlobal,
    token: process.env.GITHUB_BOT_TOKEN,
  };
  const events = { bus: [], global: [] };
  github.fetchPublicIssues = async () => issues;
  github.isEnabled = () => appInstalled;
  sessionBus.publish = (id, e) => events.bus.push({ id, e });
  ws.broadcastGlobal = (e) => events.global.push(e);
  process.env.GITHUB_BOT_TOKEN = 'bot-pat';
  t.after(() => {
    github.fetchPublicIssues = orig.fetchPublicIssues;
    github.isEnabled = orig.isEnabled;
    sessionBus.publish = orig.publish;
    ws.broadcastGlobal = orig.broadcastGlobal;
    if (orig.token === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = orig.token;
  });
  return events;
}

const draftMeta = (pool) =>
  JSON.parse(pool.inserted[0].params[2]).platformIssueDraft;

// ── The happy path ─────────────────────────────────────────────────────

test('a platform draft inserts exactly one row and pushes exactly one event', async (t) => {
  const events = withStubs(t);
  const pool = makePool({ session: SESSION });

  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'Bridge hangs after resume', body: 'Detail.', target: 'platform',
  });

  assert.deepEqual(
    { ok: res.ok, suggested: res.suggested, target: res.target },
    { ok: true, suggested: true, target: 'platform' }
  );
  assert.equal(pool.inserted.length, 1, 'exactly one row inserted');
  assert.equal(events.bus.length, 1, 'exactly one session-bus publish');
  assert.equal(events.global.length, 1, 'exactly one global broadcast');
  assert.equal(events.bus[0].e.type, 'platform_issue_draft',
    'the dedicated event type — a status event would kill the running-agent spinner');

  const meta = draftMeta(pool);
  assert.equal(meta.status, 'pending', 'nothing is filed by the service');
  assert.equal(meta.target, 'platform');
  assert.equal(meta.owner, 'Usernode-Labs');
  assert.equal(meta.repo, 'social-vibecoding', 'destination stamped at draft time');
});

test('an app-target draft stamps the app repo, not the platform repo', async (t) => {
  withStubs(t);
  const pool = makePool({ session: SESSION });

  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'Stale leaderboard', body: 'Detail.', target: 'app',
    source: 'user_request',
  });

  assert.equal(res.ok, true);
  assert.equal(res.target, 'app');
  const meta = draftMeta(pool);
  assert.equal(meta.owner, 'someone');
  assert.equal(meta.repo, 'demo-app');
  assert.equal(meta.source, 'user_request');
});

test('the row content distinguishes a user request from an agent suggestion', async (t) => {
  withStubs(t);
  const agentPool = makePool({ session: SESSION });
  await issueDraft.createDraft(agentPool, CONFIG, {
    sessionId: 5, title: 'A', body: 'x', source: 'agent',
  });
  const userPool = makePool({ session: SESSION });
  await issueDraft.createDraft(userPool, CONFIG, {
    sessionId: 5, title: 'B', body: 'x', source: 'user_request',
  });

  assert.equal(agentPool.inserted[0].params[1], issueDraft.CONTENT_AGENT);
  assert.equal(userPool.inserted[0].params[1], issueDraft.CONTENT_USER);
  assert.notEqual(issueDraft.CONTENT_AGENT, issueDraft.CONTENT_USER);
});

// ── Validation + configuration ─────────────────────────────────────────

test('validation rejects an empty or oversized title/body without inserting', async (t) => {
  withStubs(t);
  const cases = [
    [{ title: '   ', body: 'x' }, 'bad_title'],
    [{ title: 'a'.repeat(issueDraft.TITLE_MAX + 1), body: 'x' }, 'title_too_long'],
    [{ title: 'ok', body: 'b'.repeat(issueDraft.BODY_MAX + 1) }, 'body_too_long'],
  ];
  for (const [input, code] of cases) {
    const pool = makePool({ session: SESSION });
    const res = await issueDraft.createDraft(pool, CONFIG, { sessionId: 5, ...input });
    assert.deepEqual(res, { ok: false, code }, `${code} refused`);
    assert.equal(pool.inserted.length, 0, 'nothing persisted on a rejected draft');
  }
});

test('a missing session is session_not_found, not a throw', async (t) => {
  withStubs(t);
  const pool = makePool({ session: null });
  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'x', body: 'y',
  });
  assert.deepEqual(res, { ok: false, code: 'session_not_found' });
});

test('no bot token → not_configured for platform; no app repo → no_repo for app', async (t) => {
  withStubs(t);
  delete process.env.GITHUB_BOT_TOKEN;
  const pool = makePool({ session: SESSION });
  assert.deepEqual(
    await issueDraft.createDraft(pool, CONFIG, { sessionId: 5, title: 'x', body: 'y' }),
    { ok: false, code: 'not_configured' }
  );

  process.env.GITHUB_BOT_TOKEN = 'bot-pat';
  const noRepoPool = makePool({ session: { ...SESSION, repo_url: null } });
  assert.deepEqual(
    await issueDraft.createDraft(noRepoPool, CONFIG, {
      sessionId: 5, title: 'x', body: 'y', target: 'app',
    }),
    { ok: false, code: 'no_repo' }
  );
  assert.equal(noRepoPool.inserted.length, 0);
});

test('canDraft is false only when NEITHER destination is filable', (t) => {
  withStubs(t);
  assert.equal(issueDraft.canDraft(CONFIG, SESSION.repo_url), true, 'both work');
  assert.equal(issueDraft.canDraft({}, SESSION.repo_url), true, 'app repo alone is enough');
  delete process.env.GITHUB_BOT_TOKEN;
  assert.equal(issueDraft.canDraft(CONFIG, null), false, 'neither');
  assert.equal(issueDraft.canDraft(CONFIG, SESSION.repo_url), true, 'app path still open');
});

// ── De-dupe ────────────────────────────────────────────────────────────

test('an open issue with the same normalised title dedupes instead of drafting', async (t) => {
  withStubs(t, {
    issues: {
      issues: [{ number: 42, title: 'Bridge  HANGS after resume!', htmlUrl: 'https://gh/42' }],
    },
  });
  const pool = makePool({ session: SESSION });

  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'Bridge hangs after resume', body: 'x',
  });

  assert.deepEqual(res, { ok: true, deduped: true, number: 42, url: 'https://gh/42' });
  assert.equal(pool.inserted.length, 0, 'no card drawn for something already filed');
});

test('a failed open-issue fetch lets a genuine report through (best-effort dedupe)', async (t) => {
  withStubs(t, { issues: { issues: [], note: 'rate limited' } });
  const pool = makePool({ session: SESSION });
  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'Something real', body: 'x',
  });
  assert.equal(res.ok, true);
  assert.equal(pool.inserted.length, 1);
});

test('a pending or filed draft in this session blocks a re-draft from either source', async (t) => {
  withStubs(t);
  for (const status of ['pending', 'filed']) {
    for (const source of ['agent', 'user_request']) {
      const pool = makePool({
        session: SESSION,
        priorDrafts: [priorRow({
          title: 'Bridge hangs', status,
          ...(status === 'filed' ? { issueUrl: 'https://gh/9', issueNumber: 9 } : {}),
        })],
      });
      const res = await issueDraft.createDraft(pool, CONFIG, {
        sessionId: 5, title: 'bridge  hangs', body: 'x', source,
      });
      assert.equal(res.deduped, true, `${status} blocks ${source}`);
      assert.equal(res.draftStatus, status);
      assert.equal(pool.inserted.length, 0);
    }
  }
});

test('a DISMISSED draft blocks the agent but NOT a user asking again', async (t) => {
  withStubs(t);
  // The agent re-raising a card the user already dismissed is exactly the
  // spam the human gate exists to prevent...
  const agentPool = makePool({
    session: SESSION,
    priorDrafts: [priorRow({ title: 'Bridge hangs', status: 'dismissed' })],
  });
  const agentRes = await issueDraft.createDraft(agentPool, CONFIG, {
    sessionId: 5, title: 'Bridge hangs', body: 'x', source: 'agent',
  });
  assert.equal(agentRes.deduped, true, 'agent is still blocked');
  assert.equal(agentPool.inserted.length, 0);

  // ...but a user explicitly asking again has changed their mind.
  const userPool = makePool({
    session: SESSION,
    priorDrafts: [priorRow({ title: 'Bridge hangs', status: 'dismissed' })],
  });
  const userRes = await issueDraft.createDraft(userPool, CONFIG, {
    sessionId: 5, title: 'Bridge hangs', body: 'x', source: 'user_request',
  });
  assert.equal(userRes.ok, true, 'user gets a fresh card');
  assert.equal(userRes.deduped, undefined);
  assert.equal(userPool.inserted.length, 1);
});

// ── Rate caps ──────────────────────────────────────────────────────────

test('the per-source rate cap is looser for an explicitly requested draft', async (t) => {
  withStubs(t);
  assert.ok(issueDraft.RATE_MAX.user_request > issueDraft.RATE_MAX.agent,
    'a user asking for a card is not throttled at the agent spam rate');

  const atAgentCap = issueDraft.RATE_MAX.agent;
  const agentPool = makePool({ session: SESSION, recentCount: atAgentCap });
  assert.deepEqual(
    await issueDraft.createDraft(agentPool, CONFIG, {
      sessionId: 5, title: 'x', body: 'y', source: 'agent',
    }),
    { ok: false, code: 'rate_limited' }
  );

  // The same window still has room for a user-requested draft.
  const userPool = makePool({ session: SESSION, recentCount: atAgentCap });
  const userRes = await issueDraft.createDraft(userPool, CONFIG, {
    sessionId: 5, title: 'x', body: 'y', source: 'user_request',
  });
  assert.equal(userRes.ok, true);

  const userAtCap = makePool({
    session: SESSION, recentCount: issueDraft.RATE_MAX.user_request,
  });
  assert.deepEqual(
    await issueDraft.createDraft(userAtCap, CONFIG, {
      sessionId: 5, title: 'x', body: 'y', source: 'user_request',
    }),
    { ok: false, code: 'rate_limited' }
  );
});

test('a rate-count query failure never blocks a legitimate report', async (t) => {
  withStubs(t);
  const pool = makePool({ session: SESSION, failOn: 'COUNT(*)' });
  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'x', body: 'y',
  });
  assert.equal(res.ok, true);
});

test('an insert failure is db_error, not a throw', async (t) => {
  withStubs(t);
  const pool = makePool({ session: SESSION, failOn: 'INSERT INTO chat_session_messages' });
  const res = await issueDraft.createDraft(pool, CONFIG, {
    sessionId: 5, title: 'x', body: 'y',
  });
  assert.deepEqual(res, { ok: false, code: 'db_error' });
});
