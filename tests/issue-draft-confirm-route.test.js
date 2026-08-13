// #1037: POST /api/sessions/:id/platform-issue/:msgId/confirm files the
// drafted issue where the CARD SAID IT WOULD.
//
// A draft now carries `target`. Platform keeps the historical bot-PAT
// fetch against config.platformRepoUrl; 'app' files into the app's own
// repo through the GitHub App installation (github.createIssue), the same
// path routes/feedback.js uses — the platform PAT isn't guaranteed to
// reach every app repo. A draft with NO target predates #1037 and must
// behave exactly as before.
//
// Same harness shape as tests/recheck-route-pending.test.js: override
// getPool BEFORE requiring the route module, mount the router on a real
// express app, inject req.user.
//
// Run with: node --test tests/issue-draft-confirm-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const github = require('../src/services/github');
const issueAnnounce = require('../src/services/issue-announce');
const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const OWNER = { id: 7, username: 'tester' };
const CONFIG = { platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };

const APP_COLUMNS = {
  app_id: 3,
  app_slug: 'demo',
  app_name: 'Demo App',
  app_repo_url: 'https://github.com/acme/demo',
  // sessionCollabGuard selects these alongside the session and
  // checkAppAccess throws on a row missing them.
  collab_visibility: 'public',
  view_visibility: 'public',
};

// Drives the whole handler: the guard's session lookup, the draft row
// fetch, the atomic claim, the revert, and the metadata enrich. Records
// every UPDATE so status transitions are assertable.
function installPool(draft, { claimRows = 1 } = {}) {
  const updates = [];
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/FROM chat_sessions cs\s+JOIN apps a/.test(s) || /FROM chat_sessions cs JOIN apps a/.test(s)) {
      return { rows: [{ id: 42, user_id: OWNER.id, status: 'active', ...APP_COLUMNS }] };
    }
    if (/FROM chat_session_messages m/.test(s)) {
      return {
        rows: [{
          id: 99,
          metadata: draft ? { platformIssueDraft: draft } : {},
          ...APP_COLUMNS,
        }],
      };
    }
    if (/UPDATE chat_session_messages/.test(s)) {
      const status = (s.match(/'"(\w+)"'/) || [])[1] || 'enrich';
      updates.push({ status, params });
      return { rowCount: status === 'filed' ? claimRows : 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return updates;
}

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = OWNER; next(); });
  app.use(sessionRoutes(CONFIG));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function confirm(server, action = 'confirm') {
  const port = server.address().port;
  const res = await fetch(
    `http://127.0.0.1:${port}/api/sessions/42/platform-issue/99/${action}`,
    { method: 'POST' }
  );
  return { res, body: await res.json().catch(() => ({})) };
}

// Stub every outbound edge. `fetchCalls` records the hand-rolled bot-PAT
// POST (the platform path); `createIssueCalls` records the GitHub App
// path (the app path); `announceCalls` records the panel refresh.
function withStubs(t, { createIssue, ghFetchOk = true } = {}) {
  const origFetch = global.fetch;
  const origCreate = github.createIssue;
  const origEnabled = github.isEnabled;
  const origAnnounce = issueAnnounce.announceIssueCreated;
  const origToken = process.env.GITHUB_BOT_TOKEN;
  const rec = { fetchCalls: [], createIssueCalls: [], announceCalls: [] };

  process.env.GITHUB_BOT_TOKEN = 'bot-pat';
  github.isEnabled = () => true;
  github.createIssue = async (owner, repo, payload) => {
    rec.createIssueCalls.push({ owner, repo, payload });
    if (createIssue) return createIssue(owner, repo, payload);
    return { number: 77, html_url: 'https://github.com/acme/demo/issues/77' };
  };
  issueAnnounce.announceIssueCreated = async (_pool, owner, repo, issue, appCtx) => {
    rec.announceCalls.push({ owner, repo, issue, appCtx });
  };
  global.fetch = async (url, init) => {
    const u = String(url);
    // Let the test's own request to the local express server through.
    if (u.startsWith('http://127.0.0.1:')) return origFetch(url, init);
    rec.fetchCalls.push({ url: u, init });
    if (!ghFetchOk) return { ok: false, status: 422, text: async () => 'nope' };
    return {
      ok: true,
      json: async () => ({
        number: 55,
        html_url: 'https://github.com/Usernode-Labs/social-vibecoding/issues/55',
      }),
    };
  };

  t.after(() => {
    global.fetch = origFetch;
    github.createIssue = origCreate;
    github.isEnabled = origEnabled;
    issueAnnounce.announceIssueCreated = origAnnounce;
    if (origToken === undefined) delete process.env.GITHUB_BOT_TOKEN;
    else process.env.GITHUB_BOT_TOKEN = origToken;
  });
  return rec;
}

const pending = (over = {}) => ({
  title: 'Bridge hangs after resume',
  body: 'Detail of the report.',
  status: 'pending',
  appSlug: 'demo',
  appName: 'Demo App',
  ...over,
});

test('a legacy draft with NO target files to the platform repo, exactly as before', async (t) => {
  const rec = withStubs(t);
  installPool(pending());
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 200);
  assert.equal(body.status, 'filed');
  assert.equal(body.number, 55);
  assert.equal(rec.createIssueCalls.length, 0, 'the App installation path is not used');
  assert.equal(rec.fetchCalls.length, 1, 'one bot-PAT POST');
  assert.match(rec.fetchCalls[0].url,
    /repos\/Usernode-Labs\/social-vibecoding\/issues$/);
  const sent = JSON.parse(rec.fetchCalls[0].init.body);
  assert.deepEqual(sent.labels, ['usernode', 'agent-reported'], 'labels unchanged');
  assert.match(sent.body, /\*\*Reported while working on:\*\* Demo App \(demo\)/);
  assert.equal(rec.announceCalls[0].appCtx, null, 'platform resolves its app row by repo');
});

test('an app-target draft files into the app repo through the GitHub App', async (t) => {
  const rec = withStubs(t);
  installPool(pending({
    target: 'app', source: 'user_request', owner: 'acme', repo: 'demo',
  }));
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 200);
  assert.equal(body.number, 77);
  assert.equal(rec.fetchCalls.length, 0, 'the platform PAT is never used for an app repo');
  assert.equal(rec.createIssueCalls.length, 1);
  assert.equal(rec.createIssueCalls[0].owner, 'acme');
  assert.equal(rec.createIssueCalls[0].repo, 'demo');
  assert.match(rec.createIssueCalls[0].payload.body, /\*\*App:\*\* Demo App \(demo\)/);
  assert.match(rec.createIssueCalls[0].payload.body, /confirmed by `tester`/);
  assert.deepEqual(
    rec.announceCalls[0].appCtx,
    { id: 3, slug: 'demo', name: 'Demo App' },
    "the app's own Open Issues panel is refreshed"
  );
});

test('the stamped owner/repo wins, so a card can never file somewhere it did not say', async (t) => {
  const rec = withStubs(t);
  // The app's repo_url has since moved; the draft was stamped earlier.
  installPool(pending({ target: 'app', owner: 'acme', repo: 'old-name' }));
  const server = await startServer();
  t.after(() => server.close());

  await confirm(server);

  assert.equal(rec.createIssueCalls[0].repo, 'old-name',
    'files where the card displayed, not where repo_url now points');
});

test('an app-target GitHub failure reverts the draft to pending with an actionable hint', async (t) => {
  withStubs(t, { createIssue: async () => { throw new Error('not installed'); } });
  const updates = installPool(pending({ target: 'app', owner: 'acme', repo: 'demo' }));
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 502);
  assert.match(body.error, /bot may not be installed/);
  assert.deepEqual(updates.map((u) => u.status), ['filed', 'pending'],
    'claimed then reverted — the card is tappable again');
});

test('a platform GitHub refusal still reverts the draft to pending', async (t) => {
  withStubs(t, { ghFetchOk: false });
  const updates = installPool(pending());
  const server = await startServer();
  t.after(() => server.close());

  const { res } = await confirm(server);

  assert.equal(res.status, 502);
  assert.deepEqual(updates.map((u) => u.status), ['filed', 'pending']);
});

test('dismiss never touches GitHub, whatever the target', async (t) => {
  const rec = withStubs(t);
  const updates = installPool(pending({ target: 'app', owner: 'acme', repo: 'demo' }));
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server, 'dismiss');

  assert.equal(res.status, 200);
  assert.equal(body.status, 'dismissed');
  assert.deepEqual(updates.map((u) => u.status), ['dismissed']);
  assert.equal(rec.fetchCalls.length + rec.createIssueCalls.length, 0);
});

test('a concurrent confirm that loses the atomic claim cannot double-file', async (t) => {
  const rec = withStubs(t);
  installPool(pending({ target: 'app', owner: 'acme', repo: 'demo' }), { claimRows: 0 });
  const server = await startServer();
  t.after(() => server.close());

  const { res } = await confirm(server);

  assert.equal(res.status, 409);
  assert.equal(rec.createIssueCalls.length, 0, 'the loser files nothing');
});

test('an already-resolved draft reports its final state instead of re-filing', async (t) => {
  const rec = withStubs(t);
  installPool(pending({
    status: 'filed', issueUrl: 'https://gh/12', issueNumber: 12, target: 'app',
  }));
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 409);
  assert.equal(body.number, 12);
  assert.equal(rec.createIssueCalls.length, 0);
});
