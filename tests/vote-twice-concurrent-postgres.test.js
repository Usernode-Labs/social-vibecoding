'use strict';

// #6728: "Two tabs and my vote got sent twice". One person with the inbox
// open in two tabs pressed Yes in both; the proposal showed two votes from
// them. The stored vote was already one row (UNIQUE(session_id, user_id)),
// but both requests read "no prior vote" before either committed, so both
// announced: two "voted yes" lines in the change's discussion, two author
// notifications, two tally pushes.
//
// recordVote now decides it inside one transaction. It takes the FOR UPDATE
// lock on chat_sessions first and reads the person's vote in its OWN
// statement after it, so the second request waits for the first to commit
// and then sees the row it wrote. That request answers `unchanged: true`,
// and the route skips the vote line, the author's notification and the
// tally push for it.
//
// Against the REAL schema in a throwaway PostgreSQL database, so the row
// lock's concurrency behaviour is the one that ships (a stub could only
// pretend).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/vote-twice-concurrent-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HEAD = 'a'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// The route's dependencies, stubbed exactly as tests/vote-reasons.test.js
// stubs them: everything the vote calls OUT to is recorded, and the DB is
// the real one. `recordVote` itself is never replaced.
function loadRouteWithRealDb(pool) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    visuals: require.resolve('../src/services/visuals'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    governance: require.resolve('../src/services/governance'),
    conversation: require.resolve('../src/services/conversation-prompt'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const systemMessages = [];
  const voteNotifications = [];
  const voteUpdates = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async () => ({ state: 'open', merged: false, head: { sha: HEAD } }),
    getInstallationOctokit: async () => ({ request: async () => ({ data: {} }) }),
  });
  stub(ids.staging, { teardownStaging: async () => {} });
  stub(ids.docker, {});
  stub(ids.ws, {
    sendSystemMessage: async (_pool, appId, content, msgType, metadata, thread) => {
      systemMessages.push({ appId, content, msgType, metadata, thread });
      return { id: 100 + systemMessages.length, createdAt: new Date().toISOString() };
    },
    pushNotificationToUser() {},
    pushVoteUpdate(data) { voteUpdates.push(data); },
    pushSessionUpdate() {},
    broadcastGlobalScoped() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
    isUserActive: async () => true,
    isContested: () => false,
    listActiveUserIds: async () => [],
    mergeGate,
  });
  stub(ids.notifications, {
    markReadForSession: async () => 0,
    createProposalVoteNotification: async (_pool, args) => { voteNotifications.push(args); return []; },
    hydrateAndPush: async () => {},
    serialize: (x) => x,
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, {
    record: () => {},
    EVENT_TYPES: {
      PR_VOTE_CAST: 'pr_vote_cast', PR_VOTE_RECEIVED: 'pr_vote_received',
      PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged',
    },
  });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});
  stub(ids.visuals, { setChecksPending: async () => true, notifyChecksPending() {} });
  stub(ids.prImportSync, {
    rerunChecksForNewHead: async () => {},
    reconcileImportedHead: async () => ({ reconciled: false, reason: 'fork_head' }),
  });
  // Below the bar on every count, so the background merge check a vote
  // starts goes nowhere.
  stub(ids.governance, {
    getGovernance: async () => ({ approverPolicy: 'anyone' }),
    getApproverSet: async () => ({ ids: [] }),
    governedGate: async () => ({
      mergeable: false, thresholdMet: false, lazyArmed: false, windowElapsed: false,
      qualifiedYes: 0, qualifiedNo: 0, activeCount: 3, required: 2,
    }),
  });
  stub(ids.conversation, {
    promptIfContested: async () => ({ prompted: false, why: 'not_contested' }),
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, systemMessages, voteNotifications, voteUpdates, restore };
}

// mergeGate is a pure function the route's background work reaches through
// the active-users stub; vote-reasons.test.js takes the real one.
const { mergeGate } = require('../src/services/active-users');

test('two identical Yes presses at once record one vote and announce it once', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 10000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `vote_twice_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6, connectionTimeoutMillis: 10000 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username],
  )).rows[0];
  const ada = await user('ada_twice');
  const kampred = await user('kampred_twice');

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('vote-twice', 'vote-twice', 'running', $1, 'private', 'private', 'https://github.com/example/vote-twice') RETURNING id`,
    [ada.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const m of [ada, kampred]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`, [app.id, m.id]);
    await pool.query('INSERT INTO app_favorites (app_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.id, m.id]);
  }

  // An imported change up for a vote: the reviewed head is the import head,
  // so the route reaches the vote itself without a GitHub round-trip.
  const session = async () => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, promoted_at, branch_name, pr_number, pr_title,
                                check_state, approval_epoch, source, imported_pr_head_sha)
     VALUES ($1, $2, 'promoted', NOW(), $3, 6728, 'Native iOS look', 'passing', 1, 'imported', $4)
     RETURNING *`,
    [app.id, ada.id, `test/${crypto.randomBytes(4).toString('hex')}`, HEAD],
  )).rows[0];

  // ── 1. The write itself ──────────────────────────────────────────────
  const { subject, systemMessages, voteNotifications, voteUpdates, restore } = loadRouteWithRealDb(pool);
  t.after(restore);
  const first = await session();
  const [a, b] = await Promise.all([
    subject.recordVote({ pool, session: first, userId: kampred.id, vote: 'yes', headSha: HEAD, revisionEnforced: false }),
    subject.recordVote({ pool, session: first, userId: kampred.id, vote: 'yes', headSha: HEAD, revisionEnforced: false }),
  ]);
  const verdicts = [a, b].map((r) => r.unchanged).sort();
  assert.deepEqual(verdicts, [false, true], 'exactly one of the two writes changed the vote');
  assert.deepEqual([a.previousVote, b.previousVote].sort(), [null, 'yes'],
    'the second request, waiting on the row lock, saw the vote the first wrote');
  assert.equal(a.rowCount, 1, 'the statement always answers one row when the vote was eligible');
  assert.equal(b.rowCount, 1);
  const { rows: stored } = await pool.query(
    'SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2', [first.id, kampred.id]
  );
  assert.deepEqual(stored.map((r) => r.vote), ['yes'], 'one stored vote for one person');

  // A flip is still a real change, through the same locked write.
  const flip = await subject.recordVote({
    pool, session: first, userId: kampred.id, vote: 'no', headSha: HEAD, revisionEnforced: false,
  });
  assert.equal(flip.unchanged, false, 'switching side is a change');
  const { rows: flipped } = await pool.query(
    'SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2', [first.id, kampred.id]
  );
  assert.deepEqual(flipped.map((r) => r.vote), ['no']);

  // ── 2. The route, twice at once ──────────────────────────────────────
  const second = await session();
  const express = require('express');
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = { id: kampred.id, username: kampred.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(subject.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(async () => {
    await new Promise((r) => listener.close(r));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const postYes = () => fetch(`${base}/api/sessions/${second.id}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ vote: 'yes' }),
  });

  const [r1, r2] = await Promise.all([postYes(), postYes()]);
  assert.deepEqual([r1.status, r2.status], [200, 200], 'both tabs are answered without an error');
  const bodies = [await r1.json(), await r2.json()];
  assert.equal(bodies.filter((body) => body.unchanged === true).length, 1,
    'one answer says the vote was already recorded');
  assert.equal(systemMessages.length, 1, 'one "voted yes" line in the change\'s discussion');
  assert.match(systemMessages[0].content, /voted yes/);
  assert.equal(voteNotifications.length, 1, 'one notification to the change\'s author');
  assert.equal(voteUpdates.length, 1, 'one tally push to the open screens');
  const { rows: routeStored } = await pool.query(
    'SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2', [second.id, kampred.id]
  );
  assert.deepEqual(routeStored.map((r) => r.vote), ['yes'], 'and one counted vote');
});
