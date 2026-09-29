'use strict';

// Mutual friends (#2386): the pure rules, the staging demo, and the wiring
// contracts that keep friends private and silent. The SQL itself runs in
// tests/friends-postgres.test.js against the full schema; this file pins what
// that one cannot see — how the pieces are joined to each other.
//
// Run with: node --test tests/friends-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const friends = require('../src/services/friends');
const poolMod = require('../src/db/pool');

test('what each side sees of a pair: four answers, and a decline looks pending to its sender', () => {
  const ME = 7;
  const THEM = 9;
  assert.equal(friends.stateFor(null, ME), 'none');
  assert.equal(friends.stateFor({ requester_id: ME, status: 'pending' }, ME), 'outgoing');
  assert.equal(friends.stateFor({ requester_id: ME, status: 'declined' }, ME), 'outgoing',
    'the sender is never told');
  assert.equal(friends.stateFor({ requester_id: THEM, status: 'pending' }, ME), 'incoming');
  assert.equal(friends.stateFor({ requester_id: THEM, status: 'declined' }, ME), 'none',
    'a request you declined is gone for you');
  assert.equal(friends.stateFor({ requester_id: THEM, status: 'accepted' }, ME), 'friends');
  assert.equal(friends.stateFor({ requester_id: ME, status: 'accepted' }, ME), 'friends');
  assert.deepEqual(friends.STATES, ['none', 'outgoing', 'incoming', 'friends']);
  assert.deepEqual(
    [friends.MAX_PENDING_OUTGOING, friends.MAX_REQUESTS_PER_DAY, friends.DECLINE_QUIET_DAYS],
    [20, 50, 30],
    'the caps and the quiet period the product owner agreed',
  );
});

test('a write for yourself or no one is refused before any lock or query', async () => {
  const pool = { connect() { throw new Error('must not touch the database'); } };
  for (const fn of ['sendRequest', 'accept', 'decline', 'cancel', 'unfriend']) {
    await assert.rejects(friends[fn](pool, { id: 5 }, 5), { status: 404, code: 'not_found' }, fn);
    await assert.rejects(friends[fn](pool, { id: 5 }, null), { status: 404, code: 'not_found' }, fn);
  }
});

test('the staging demo has one person in each state, and every transition answers', () => {
  assert.deepEqual(friends.DEMO_PEOPLE.map((p) => [p.username, p.state]),
    [['ada', 'friends'], ['lin', 'incoming'], ['grace', 'outgoing'], ['turing', 'none']]);
  const lists = friends.demoLists();
  assert.deepEqual(lists.friends.map((p) => p.username), ['ada']);
  assert.deepEqual(lists.incoming.map((p) => p.username), ['lin']);
  assert.deepEqual(lists.outgoing.map((p) => p.username), ['grace']);
  const lin = friends.demoProfile('lin');
  assert.deepEqual(lin.friendship, { userId: 910002, state: 'incoming' });
  assert.equal(lin.profile.username, 'lin');
  assert.match(lin.profile.bio, /^\[Staging demo\]/, 'obviously fake');
  assert.equal(friends.demoProfile('nobody'), null);
  assert.equal(friends.demoProfile('910002'), null, 'a profile is addressed by handle only');
  assert.deepEqual(friends.demoTransition('accept', 910002), { userId: 910002, state: 'friends' });
  assert.deepEqual(friends.demoTransition('request', 910004), { userId: 910004, state: 'outgoing' });
  assert.deepEqual(friends.demoTransition('request', 910002), { userId: 910002, state: 'friends' });
  assert.deepEqual(friends.demoTransition('unfriend', 910001), { userId: 910001, state: 'none' });
  assert.equal(friends.demoTransition('request', 42), null, 'a real id falls through to the real route');
});

function loadFriendRoutes(env) {
  const prevEnv = process.env.USERNODE_ENV;
  if (env == null) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  const prevGetPool = poolMod.getPool;
  poolMod.getPool = () => ({ query() { throw new Error('demo must not query'); }, connect() { throw new Error('demo must not connect'); } });
  const routePath = require.resolve('../src/routes/friends');
  delete require.cache[routePath];
  const mod = require('../src/routes/friends');
  if (prevEnv == null) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prevEnv;
  poolMod.getPool = prevGetPool;
  delete require.cache[routePath];
  return mod;
}

test('?demo=1 on staging answers from fixtures and writes nothing', async () => {
  const { friendRoutes } = loadFriendRoutes('staging');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(friendRoutes({}));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const lists = await (await fetch(`${base}/api/friends?demo=1`)).json();
    assert.equal(lists.demo, true);
    assert.deepEqual(lists.incoming.map((p) => p.id), [910002]);
    const state = await (await fetch(`${base}/api/friends/910003?demo=1`)).json();
    assert.deepEqual(state, { userId: 910003, state: 'outgoing', demo: true });
    const accepted = await (await fetch(`${base}/api/friends/910002/accept?demo=1`, { method: 'POST' })).json();
    assert.deepEqual(accepted, { userId: 910002, state: 'friends', demo: true });
    const cancelled = await (await fetch(`${base}/api/friends/910003/request?demo=1`, { method: 'DELETE' })).json();
    assert.deepEqual(cancelled, { userId: 910003, state: 'none', demo: true });
    const self = await fetch(`${base}/api/friends/7/request?demo=1`, { method: 'POST' });
    assert.equal(self.status, 404, 'yourself is refused even in the demo');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('outside staging, ?demo=1 is ignored', () => {
  const route = read('src/routes/friends.js');
  assert.match(route, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
  assert.match(route, /return IS_STAGING && req\.query\.demo === '1';/);
  const profiles = read('src/routes/profiles.js');
  assert.match(profiles, /IS_STAGING && req\.query\.demo === '1' \? friends\.demoProfile\(username\) : null/);
  assert.match(profiles, /\.\.\.\(req\.user \? \{ friendship: demo\.friendship \} : \{\}\)/,
    'even the demo relationship is for signed-in viewers only');
});

test('every write takes the pair lock before it reads or locks a row', () => {
  const source = read('src/services/friends.js');
  for (const name of ['sendRequest', 'accept', 'decline', 'cancel', 'unfriend']) {
    const start = source.indexOf(`async function ${name}(`);
    assert.ok(start > 0, name);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const lock = body.indexOf('conversations.lockPair(db,');
    assert.ok(lock > 0, `${name} takes the pair lock`);
    assert.ok(lock < body.indexOf('lockPairRow('), `${name}: advisory lock before the row lock`);
  }
  const send = source.slice(source.indexOf('async function sendRequest('), source.indexOf('async function accept('));
  assert.ok(send.indexOf('lockPair(db') < send.indexOf('friend-requests:'),
    'the sender lock comes AFTER the pair lock, never before it');
  assert.match(send, /status IN \('pending', 'declined'\)/, 'a declined request still counts toward the cap');
  assert.match(send, /quiet\.rows\.length \? 'declined' : 'pending'/,
    'inside the quiet period the new request is written straight into declined');
  const decline = source.slice(source.indexOf('async function decline('), source.indexOf('async function cancel('));
  assert.doesNotMatch(decline, /insertNotification/, 'a decline notifies nobody');
  const unfriend = source.slice(source.indexOf('async function unfriend('), source.indexOf('async function removePairOnBlock('));
  assert.doesNotMatch(unfriend, /insertNotification/, 'an unfriend notifies nobody');
});

test('the block and DM hooks live inside the conversation transactions they extend', () => {
  const source = read('src/services/conversations.js');
  const block = source.slice(source.indexOf('async function setBlock('), source.indexOf('async function listBlocks('));
  const hook = block.indexOf("require('./friends').removePairOnBlock(db, userId, targetId)");
  assert.ok(hook > 0, 'setBlock removes the pair\'s friendship and requests');
  assert.ok(block.indexOf('INSERT INTO user_blocks') < hook, 'after the block row, under the same pair lock');
  assert.ok(block.indexOf('if (!blocked)') < hook,
    'past the unblock branch\'s early return: only on block, never on unblock');
  const direct = source.slice(source.indexOf('async function createDirect('), source.indexOf('async function ensureEligibleInvitees('));
  assert.ok(direct.indexOf('lockPair(db, user.id, targetUserId)') < direct.indexOf('areFriends('),
    'friendship is read under the pair lock');
  const friendBranch = direct.indexOf('if (friends) {');
  assert.ok(friendBranch > 0 && friendBranch < direct.indexOf("kind: 'conversation_invite'"),
    'between friends the invitation notification is never written');
});

test('friend tables are private: staging-scrubbed and denied to the production debugger', () => {
  const schema = read('src/db/schema.sql');
  const debugAccess = require('../src/services/debug-access');
  for (const table of ['friendships', 'friend_request_sends', 'friend_request_declines']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
    assert.ok(debugAccess.DENIED_TABLES.has(table), `${table} is denied to prod debug`);
  }
  assert.match(schema, /friendships[\s\S]*?CHECK \(user_low_id < user_high_id\)/,
    'pair-normalised like conversation_direct_pairs');
  const tables = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS friendships'),
    schema.indexOf("COMMENT ON TABLE friendships IS 'staging:private'"));
  assert.equal((tables.match(/REFERENCES users\(id\) ON DELETE CASCADE/g) || []).length, 6,
    'every user reference cascades with account deletion');
});

test('no route lists or counts anybody else\'s friends', () => {
  const route = read('src/routes/friends.js');
  const paths = [...route.matchAll(/router\.(get|post|delete|put|patch)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(paths, [
    'GET /api/friends',
    'GET /api/friends/:userId',
    'POST /api/friends/:userId/request',
    'DELETE /api/friends/:userId/request',
    'POST /api/friends/:userId/accept',
    'POST /api/friends/:userId/decline',
    'DELETE /api/friends/:userId',
  ]);
  assert.match(route, /friends\.listFor\(pool, req\.user\.id\)/, 'the list is always the viewer\'s own');
  assert.match(route, /friends\.relationshipFor\(pool, req\.user\.id, userId\)/,
    'the per-person read is the viewer\'s own relationship');
  assert.doesNotMatch(read('src/services/friends.js'), /COUNT\(\*\)[^`]*FROM friendships[^`]*status = 'accepted'/,
    'nothing counts friendships');
  const server = read('server.js');
  assert.ok(server.indexOf('app.use(authMiddleware(config));') < server.indexOf('app.use(friendRoutes(config));'),
    'mounted behind authentication and the platform-access gate');
});

test('notifications carry the two friend kinds, and nothing new on any other row', () => {
  const notifications = require('../src/services/notifications');
  const base = { id: 1, kind: 'mention', read_at: null, created_at: 't', source_user_id: 9, friend_request_pending: true };
  assert.equal('sourceUserId' in notifications.serialize(base), false, 'other kinds keep their exact shape');
  assert.equal('friendRequestPending' in notifications.serialize(base), false);
  const request = notifications.serialize({ ...base, kind: 'friend_request' });
  assert.deepEqual([request.sourceUserId, request.friendRequestPending], [9, true]);
  const accepted = notifications.serialize({ ...base, kind: 'friend_accept' });
  assert.deepEqual([accepted.sourceUserId, accepted.friendRequestPending], [9, false]);
  assert.deepEqual([...notifications.FRIEND_NOTIFICATION_KINDS], ['friend_request', 'friend_accept']);
});
