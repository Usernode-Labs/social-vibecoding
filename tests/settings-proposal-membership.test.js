// SEC-09: proposing a settings change is taking part, so it is a member's
// (AGENTS.md, "Membership gates taking part, not reading"). Every settings
// proposal route (src/routes/apps.js) mounts the community's gate, and the
// conductor that opens the PR reads membership again
// (services/manifest-proposal-operation.js), so leaving between the two
// opens nothing. The gate asks whoever could otherwise propose: anyone who
// builds here for a rename or a variable, the creator or an app admin for a
// change to who sees, builds or decides, whether or not they build here.
// Anyone else keeps the route's own refusal, never a Join prompt.
//
// Run with: node --test tests/settings-proposal-membership.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });
// Settings proposals are written on a conductor: run that operation here.
require('./lib/inline-operations').inlineOperations({ pool: () => poolMod.getPool(), user: () => currentUser, app: () => APP_ROW });

const github = require('../src/services/github');
let ghCalls;
github.isEnabled = () => true;
github.hasWriteAccess = () => true;
github.getFileContent = async () => JSON.stringify({ name: 'Demo', tests: [] }, null, 2);
github.createBranch = async (owner, repo, branch) => { ghCalls.push({ op: 'branch', branch }); };
github.pushFiles = async () => { ghCalls.push({ op: 'push' }); };
github.createPR = async (owner, repo, { branch }) => {
  ghCalls.push({ op: 'pr', branch });
  return { number: 778, html_url: 'https://github.com/o/r/pull/778' };
};

const manifestProposal = require('../src/services/manifest-proposal-operation');
const platformOperations = require('../src/services/platform-operations');
const { appRoutes } = require('../src/routes/apps');
const express = require('express');

// A project anyone may see and only its collaborators build.
const APP_ROW = {
  id: 12, slug: 'demo', name: 'Demo', created_by: 1, self_hosted: false, community_id: 4,
  repo_url: 'https://github.com/o/r', collab_visibility: 'private', view_visibility: 'public',
};
const BUILDER = { id: 7, username: 'maya', isAdmin: false };   // a collaborator
const MANAGER = { id: 8, username: 'ines', isAdmin: false };   // an app admin who does not build here
const VIEWER = { id: 9, username: 'theo', isAdmin: false };    // neither
const COLLABORATORS = new Set([BUILDER.id]);
const APP_ADMINS = [MANAGER.id];

let currentUser;
// What each read of the membership gate finds, in order; the last repeats.
let memberReads;
let gateReads;

function handler() {
  return async (sql, params) => {
    if (/FROM apps a WHERE a\.slug = \$1/.test(sql)) {
      const isMember = memberReads[Math.min(gateReads, memberReads.length - 1)];
      gateReads += 1;
      return { rows: [{ ...APP_ROW, is_member: isMember }] };
    }
    if (/SELECT \* FROM apps WHERE (slug|id) = \$1/.test(sql)) return { rows: [APP_ROW] };
    if (/FROM app_collaborators WHERE app_id = \$1 AND user_id = \$2 AND status = 'member'/.test(sql)) {
      return { rows: COLLABORATORS.has(params[1]) ? [{ '?column?': 1 }] : [] };
    }
    if (/SELECT user_id FROM app_admins WHERE app_id = \$1/.test(sql)) {
      return { rows: APP_ADMINS.map((user_id) => ({ user_id })) };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 4344 }] };
    if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) return { rows: [{ cnt: '3' }] };
    return { rows: [] };
  };
}

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => {
  ghCalls = [];
  currentUser = BUILDER;
  memberReads = [true];
  gateReads = 0;
  poolQueryHandler = handler();
});

const post = (path, body) => fetch(`${base}/api/apps/demo/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const rename = () => post('rename', { newName: 'Demo Two' });
const declare = () => post('secret-declaration-pr', { key: 'FEATURE_FLAG', value: '', description: 'A flag' });
const visibility = () => post('visibility-pr', { collabVisibility: 'private', viewVisibility: 'private' });
// The manage-level routes; each body is refused, if at all, after the gate.
const MANAGE = [
  visibility,
  () => post('who-decides-pr', { visibility: 'private' }),
  () => post('admins-pr', { admins: ['ines'] }),
  () => post('governance-pr', { approverPolicy: 'majority' }),
];

async function askedToJoin(res) {
  assert.equal(res.status, 403, res.url);
  const body = await res.json();
  assert.equal(body.code, 'join_required', res.url);
  assert.deepEqual(body.app, { slug: 'demo', name: 'Demo' });
}

test('a member who builds here opens a rename; a member who manages it opens a visibility change', async () => {
  const res = await rename();
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  currentUser = MANAGER;
  const vis = await visibility();
  assert.equal(vis.status, 201, JSON.stringify(await vis.clone().json()));
  assert.deepEqual(ghCalls.map((c) => c.op), ['branch', 'push', 'pr', 'branch', 'push', 'pr']);
});

test('someone who could propose but has not joined is asked to join, and the route asks no conductor', async (t) => {
  const asked = t.mock.method(platformOperations, 'request');
  memberReads = [false];
  for (const ask of [rename, declare]) await askedToJoin(await ask());
  // An app admin is asked whether or not they build here.
  currentUser = MANAGER;
  for (const ask of MANAGE) await askedToJoin(await ask());
  assert.equal(asked.mock.callCount(), 0, 'each route refuses it without asking a conductor');
  assert.deepEqual(ghCalls, []);
});

test('someone who could not propose anyway is never offered Join: they keep the route\'s refusal', async () => {
  memberReads = [false];
  currentUser = VIEWER;
  for (const ask of [rename, declare]) {
    const res = await ask();
    assert.equal(res.status, 404, 'the project stays hidden from a non-builder');
    assert.notEqual((await res.json()).code, 'join_required');
  }
  // Building here does not let you propose who decides.
  for (const user of [VIEWER, BUILDER]) {
    currentUser = user;
    for (const ask of MANAGE) {
      const res = await ask();
      assert.notEqual((await res.json()).code, 'join_required', `${user.username}: ${res.url}`);
      assert.ok(res.status === 400 || res.status === 403, `${user.username}: ${res.url} answered ${res.status}`);
    }
  }
  assert.deepEqual(ghCalls, []);
});

test('leaving between the route and the conductor opens nothing', async () => {
  for (const [user, ask] of [[BUILDER, rename], [MANAGER, visibility]]) {
    currentUser = user;
    memberReads = [true, false];
    gateReads = 0;
    const res = await ask();
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'join_required');
    assert.equal(gateReads, 2, 'the conductor read membership again');
  }
  assert.deepEqual(ghCalls, []);
});

test('the conductor reads membership for every settings change, asking whoever holds its access', async () => {
  memberReads = [false];
  for (const [flavor, f] of manifestProposal.FLAVORS) {
    assert.equal(f.member, true, flavor);
    currentUser = f.access === 'manage' ? MANAGER : BUILDER;
    const refusal = await manifestProposal.authorize({ config: {}, pool: poolMod.getPool() },
      { appId: APP_ROW.id, input: { flavor, args: {} } }, currentUser);
    assert.equal(refusal?.code, 'join_required', flavor);
  }
});
