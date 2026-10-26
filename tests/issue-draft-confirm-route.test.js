// #1037: POST /api/sessions/:id/platform-issue/:msgId/confirm files the
// drafted issue where the CARD SAID IT WOULD.
//
// A draft now carries `target`: the platform's own board
// (config.platformRepoUrl), or 'app', the app's own. Both file through
// github.createIssue, which since 26 Oct 2026 writes a request row
// (services/requests.js) rather than a GitHub issue; the platform target
// used to POST to GitHub with the bot's token. A draft with NO target
// predates #1037 and still files on the platform's board.
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

// Stub every outbound edge. `createIssueCalls` records each filing (both
// targets file through github.createIssue); `fetchCalls` records anything
// sent to GitHub, which must be nothing; `announceCalls` records the panel
// refresh. The platform's board answers #55, an app's #77.
function withStubs(t, { createIssue } = {}) {
  const origFetch = global.fetch;
  const origCreate = github.createIssue;
  const origEnabled = github.isEnabled;
  const origAnnounce = issueAnnounce.announceIssueCreated;
  const rec = { fetchCalls: [], createIssueCalls: [], announceCalls: [] };

  github.isEnabled = () => true;
  github.createIssue = async (owner, repo, payload) => {
    rec.createIssueCalls.push({ owner, repo, payload });
    if (createIssue) return createIssue(owner, repo, payload);
    return owner === 'Usernode-Labs'
      ? { number: 55, html_url: 'https://app.example.test/#app/homeroom/dev/issues/55' }
      : { number: 77, html_url: 'https://app.example.test/#app/demo/dev/issues/77' };
  };
  issueAnnounce.announceIssueCreated = async (_pool, owner, repo, issue, appCtx) => {
    rec.announceCalls.push({ owner, repo, issue, appCtx });
  };
  global.fetch = async (url, init) => {
    const u = String(url);
    // Let the test's own request to the local express server through.
    if (u.startsWith('http://127.0.0.1:')) return origFetch(url, init);
    rec.fetchCalls.push({ url: u, init });
    return { ok: false, status: 599, text: async () => 'unexpected', json: async () => ({}) };
  };

  t.after(() => {
    global.fetch = origFetch;
    github.createIssue = origCreate;
    github.isEnabled = origEnabled;
    issueAnnounce.announceIssueCreated = origAnnounce;
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

test('a legacy draft with NO target files on the platform\'s board', async (t) => {
  const rec = withStubs(t);
  installPool(pending());
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 200);
  assert.equal(body.status, 'filed');
  assert.equal(body.number, 55);
  assert.equal(rec.fetchCalls.length, 0, 'nothing is sent to GitHub');
  assert.equal(rec.createIssueCalls.length, 1, 'one request filed');
  assert.equal(rec.createIssueCalls[0].owner, 'Usernode-Labs');
  assert.equal(rec.createIssueCalls[0].repo, 'social-vibecoding');
  const sent = rec.createIssueCalls[0].payload;
  assert.deepEqual(sent.labels, ['usernode', 'agent-reported'], 'labels unchanged');
  assert.equal(sent.createdBy, OWNER.id, 'filed for the person who confirmed it');
  assert.match(sent.body, /\*\*Reported while working on:\*\* Demo App \(demo\)/);
  assert.equal(rec.announceCalls[0].appCtx, null, 'platform resolves its app row by repo');
});

test('an app-target draft files on the app\'s own board', async (t) => {
  const rec = withStubs(t);
  installPool(pending({
    target: 'app', source: 'user_request', owner: 'acme', repo: 'demo',
  }));
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 200);
  assert.equal(body.number, 77);
  assert.equal(rec.fetchCalls.length, 0, 'nothing is sent to GitHub');
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

test('an app-target filing failure reverts the draft to pending and says where it failed', async (t) => {
  withStubs(t, { createIssue: async () => { throw new Error('connection refused'); } });
  const updates = installPool(pending({ target: 'app', owner: 'acme', repo: 'demo' }));
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 502);
  assert.equal(body.error, "Couldn't file the request on this app's board",
    'never rerouted to the platform board: the card said where it would file');
  assert.deepEqual(updates.map((u) => u.status), ['filed', 'pending'],
    'claimed then reverted — the card is tappable again');
});

test('a platform filing failure still reverts the draft to pending', async (t) => {
  withStubs(t, { createIssue: async () => { throw Object.assign(new Error('No app has the repository'), { status: 404 }); } });
  const updates = installPool(pending());
  const server = await startServer();
  t.after(() => server.close());

  const { res, body } = await confirm(server);

  assert.equal(res.status, 502);
  assert.equal(body.error, "Couldn't file the request on Homeroom's board");
  assert.deepEqual(updates.map((u) => u.status), ['filed', 'pending']);
});

test('dismiss files nothing, whatever the target', async (t) => {
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
