'use strict';

// The admin Journey's creation path and pairs: the three records the path
// needs (services/journey-events.js: a project's first run, a preview
// opened, a change live) and the two readings (services/journey.js
// creationPath and pairs). Real schema in a throwaway database: required
// when TEST_DATABASE_URL is set, skipped when no server is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const journey = require('../src/services/journey');
const journeyEvents = require('../src/services/journey-events');
const { createSchemaDatabase } = require('./lib/schema-database');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function freshDatabase(t, prefix) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = prefix + crypto.randomBytes(6).toString('hex');
  await createSchemaDatabase(admin, name);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });
  const user = async (username, cols = {}) => {
    const base = { has_platform_access: true, ...cols };
    const keys = Object.keys(base);
    return (await pool.query(
      `INSERT INTO users (username, password, ${keys.join(', ')})
       VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
      [username, ...keys.map((k) => base[k])])).rows[0].id;
  };
  const app = async (slug, createdBy, createdAt = null, selfHosted = false) => (await pool.query(
    `INSERT INTO apps (name, slug, created_by, status, self_hosted, created_at)
     VALUES ($1, $2, $3, 'running', $4, COALESCE($5::timestamptz, NOW())) RETURNING id`,
    [slug.replace(/-/g, ' '), slug, createdBy, selfHosted, createdAt])).rows[0].id;
  const session = async (appId, userId, cols = {}) => {
    const keys = Object.keys(cols);
    return (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id${keys.map((k) => `, ${k}`).join('')})
       VALUES ($1, $2${keys.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id`,
      [appId, userId, ...keys.map((k) => cols[k])])).rows[0].id;
  };
  const event = (type, { userId = null, appId = null, sessionId = null, at, metadata = {} }) => pool.query(
    `INSERT INTO events (user_id, app_id, session_id, event_type, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [userId, appId, sessionId, type, JSON.stringify(metadata), at]);
  return { pool, user, app, session, event };
}

test('the three records: a first run once, a preview once per viewer, a change live once', { timeout: 120000 }, async (t) => {
  const db = await freshDatabase(t, 'journey_records_');
  if (!db) return;
  const { pool, user, app, session } = db;
  const ana = await user('ana');
  const ben = await user('ben');
  const cat = await user('cat');
  const bot = await user('homeroom_bot', { is_synthetic: true });
  const project = await app('book-swap', ana);

  // First run: set once, with its event, and a second deploy writes nothing.
  assert.equal(await journeyEvents.markFirstRunning(pool, project), true);
  const first = (await pool.query('SELECT first_running_at FROM apps WHERE id = $1', [project])).rows[0].first_running_at;
  assert.ok(first instanceof Date);
  assert.equal(await journeyEvents.markFirstRunning(pool, project), false, 'a second run is not a first run');
  assert.equal((await pool.query('SELECT first_running_at FROM apps WHERE id = $1', [project])).rows[0].first_running_at.getTime(),
    first.getTime(), 'the moment is kept');
  const running = (await pool.query("SELECT user_id, app_id, metadata, created_at FROM events WHERE event_type = 'app_running'")).rows;
  assert.equal(running.length, 1);
  assert.deepEqual([running[0].user_id, running[0].app_id], [ana, project]);
  assert.equal(typeof running[0].metadata.secondsFromCreation, 'number');
  assert.equal(running[0].created_at.getTime(), first.getTime());
  assert.equal(await journeyEvents.markFirstRunning(pool, 'x'), false);
  assert.equal(await journeyEvents.markFirstRunning({ query: async () => { throw new Error('down'); } }, project), false,
    'a failed write never fails the deploy');

  // Preview opened: once per viewer per change, with who they are to it.
  const change = await session(project, ben);
  assert.equal(await journeyEvents.notePreviewOpened(pool, { sessionId: change, viewerId: ben }), true);
  assert.equal(await journeyEvents.notePreviewOpened(pool, { sessionId: change, viewerId: ben }), false);
  journeyEvents._seen.clear();
  assert.equal(await journeyEvents.notePreviewOpened(pool, { sessionId: change, viewerId: ben }), false,
    'the database keeps it to once, not only this process');
  assert.equal(await journeyEvents.notePreviewOpened(pool, { sessionId: change, viewerId: ana }), true);
  assert.equal(await journeyEvents.notePreviewOpened(pool, { sessionId: change, viewerId: cat }), true);
  assert.equal(await journeyEvents.notePreviewOpened(pool, { sessionId: 'x', viewerId: cat }), false);
  const opened = (await pool.query(
    "SELECT user_id, app_id, session_id, metadata FROM events WHERE event_type = 'preview_opened' ORDER BY id")).rows;
  assert.deepEqual(opened.map((r) => [r.user_id, r.metadata.viewerRole, r.metadata.sessionId, r.session_id, r.app_id]), [
    [ben, 'author', change, change, project],
    [ana, 'creator', change, change, project],
    [cat, 'member', change, change, project],
  ]);

  // Change live: the bot's first version for ana, which also answers cat's
  // request #5. The bot itself asked for nothing.
  const built = await session(project, bot, { linked_issues: [5], status: 'merged' });
  await pool.query("INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, 5, 'Covers', $2)", [project, cat]);
  await pool.query(
    "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 4, 'live', 'ready', $2)",
    [project, built]);
  await pool.query(
    'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, first_version) VALUES ($1, 4, $2, TRUE)', [project, ana]);
  await pool.query(
    "INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number) VALUES ($1, $2, 'swap books', 'filed', 4)",
    [project, ana]);
  const at = new Date('2026-10-01T10:00:00Z');
  const live = await journeyEvents.recordChangeLive(pool, {
    session: { id: built, app_id: project, user_id: bot, linked_issues: [5] }, sha: 'a'.repeat(40), at,
    deps: { live: async () => true },
  });
  assert.deepEqual(live, {
    sessionId: built, requesterIds: [ana, cat].sort((a, b) => a - b), firstVersion: true, live: true, sha: 'a'.repeat(40),
  });
  assert.equal(await journeyEvents.recordChangeLive(pool, {
    session: { id: built, app_id: project, user_id: bot, linked_issues: [5] }, sha: 'a'.repeat(40), deps: { live: async () => true },
  }), null, 'once per change');
  const row = (await pool.query("SELECT user_id, app_id, session_id, created_at FROM events WHERE event_type = 'change_live'")).rows[0];
  assert.deepEqual([row.user_id, row.app_id, row.session_id, row.created_at.getTime()], [bot, project, built, at.getTime()],
    'recorded at the merge, not after the health reading');

  // A change somebody made themselves, on Homeroom's own project (no
  // deploy here, so not read as live).
  const own = await session(project, ben, { created_from_issue_number: 9 });
  const mine = await journeyEvents.recordChangeLive(pool, { session: { id: own, app_id: project, user_id: ben, created_from_issue_number: 9 } });
  assert.deepEqual(mine, { sessionId: own, requesterIds: [ben], firstVersion: false, live: false, sha: null });
  assert.deepEqual(journeyEvents.requestNumbers({ linked_issues: [3, '3', 0, null], created_from_issue_number: 7 }), [3, 7]);
  assert.equal(await journeyEvents.recordChangeLive({ query: async () => { throw new Error('down'); } }, {
    session: { id: own, app_id: project, user_id: ben },
  }), null, 'a failed write never fails the merge');
});

test('the creation path: people per step, times from creation, targets, and what is not recorded', { timeout: 120000 }, async (t) => {
  const db = await freshDatabase(t, 'journey_creation_');
  if (!db) return;
  const { pool, user, app, session, event } = db;
  const now = new Date('2026-10-07T12:00:00Z');
  const week = journey.parseWeek('2026-09-28', now);
  const ana = await user('ana');
  const ben = await user('ben');
  const cat = await user('cat');
  const eve = await user('eve');
  const boss = await user('boss', { is_admin: true });
  const plus = (iso, seconds) => new Date(new Date(iso).getTime() + seconds * 1000).toISOString();

  // Recording began on 22 Sep: Early's first run is the first record of a
  // run, and the first preview and change records are that day too.
  const early = await app('early', cat, '2026-09-21T23:00:00Z');
  await pool.query("UPDATE apps SET first_running_at = '2026-09-22T00:00:00Z' WHERE id = $1", [early]);
  await event('app_running', { userId: cat, appId: early, at: '2026-09-22T00:00:00Z' });
  await event('preview_opened', { userId: boss, appId: early, at: '2026-09-22T00:00:00Z' });
  await event('change_live', { userId: boss, appId: early, at: '2026-09-22T00:00:00Z', metadata: { requesterIds: [boss] } });
  // Before any record: a project from mid September.
  await app('old', ben, '2026-09-15T10:00:00Z');

  // The week: ana's first project reaches every step; her second runs
  // faster, so her Running time is that one's.
  const A1 = '2026-09-29T10:00:00Z';
  const anaOne = await app('ana-one', ana, A1);
  await pool.query('UPDATE apps SET first_running_at = $2 WHERE id = $1', [anaOne, plus(A1, 90)]);
  const fv = await session(anaOne, boss, { status: 'promoted', created_at: plus(A1, 95), promoted_at: plus(A1, 100) });
  await pool.query("INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number) VALUES ($1, $2, 'x', 'filed', 1)", [anaOne, ana]);
  await pool.query("INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 1, 'live', 'ready', $2)", [anaOne, fv]);
  await event('preview_opened', { userId: ana, appId: anaOne, sessionId: fv, at: plus(A1, 200) });
  await event('preview_opened', { userId: ben, appId: anaOne, sessionId: fv, at: plus(A1, 150) });
  await event('change_live', { userId: boss, appId: anaOne, sessionId: fv, at: plus(A1, 700), metadata: { requesterIds: [ana] } });
  const A2 = '2026-09-30T10:00:00Z';
  const anaTwo = await app('ana-two', ana, A2);
  await pool.query('UPDATE apps SET first_running_at = $2 WHERE id = $1', [anaTwo, plus(A2, 60)]);
  // Ben's runs and he opens a preview late; a change live there was cat's.
  const B1 = '2026-09-30T12:00:00Z';
  const benOne = await app('ben-one', ben, B1);
  await pool.query('UPDATE apps SET first_running_at = $2 WHERE id = $1', [benOne, plus(B1, 120)]);
  await event('preview_opened', { userId: ben, appId: benOne, at: plus(B1, 400) });
  await event('change_live', { userId: cat, appId: benOne, at: plus(B1, 300), metadata: { requesterIds: [cat] } });
  // Cat's never ran.
  await app('cat-one', cat, '2026-10-01T09:00:00Z');
  // Not counted: an admin's project, Homeroom's own, and eve's once she is left out.
  await app('boss-one', boss, '2026-09-30T09:00:00Z');
  await app('homeroom', ana, '2026-09-30T09:00:00Z', true);
  const eveOne = await app('eve-one', eve, '2026-10-02T09:00:00Z');
  await pool.query('UPDATE apps SET first_running_at = $2 WHERE id = $1', [eveOne, plus('2026-10-02T09:00:00Z', 30)]);

  const path = await journey.creationPath(pool, { week, now, leftOutIds: [eve] });
  assert.equal(path.week, '2026-09-28');
  assert.equal(path.finished, true);
  assert.deepEqual(path.steps.map((s) => [s.key, s.reached, s.of, s.medianSeconds, s.targetSeconds, s.withinTarget]), [
    ['created', 3, 3, null, null, null],
    ['running', 2, 3, 90, 300, 2],
    ['first_version', 1, 3, 100, 120, 1],
    ['preview', 2, 3, 300, null, null],
    ['change_live', 1, 3, 700, 600, 0],
  ]);
  assert.deepEqual(path.recordedFrom, {
    running: '2026-09-22T00:00:00.000Z', preview: '2026-09-22T00:00:00.000Z', change_live: '2026-09-22T00:00:00.000Z',
  });
  assert.deepEqual(path.examples.map((e) => e.slug), ['cat-one', 'ben-one', 'ana-two', 'ana-one'], 'newest first');
  assert.deepEqual(path.examples[3].steps.map((s) => [s.key, s.recorded, s.seconds]), [
    ['running', true, 90], ['first_version', true, 100], ['preview', true, 200], ['change_live', true, 700],
  ]);
  assert.deepEqual(path.examples[0].steps.map((s) => s.seconds), [null, null, null, null], 'cat\'s never ran');

  // The weeks: eight, ending with this one. The week of 21 Sep counts
  // Early's run (it has its record) but not its preview: it was created
  // before previews were recorded at all, and nothing says it was opened.
  assert.deepEqual(path.weeks.map((w) => w.week), [
    '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28',
  ]);
  const step = (w, key) => path.weeks.find((x) => x.week === w).steps.find((s) => s.key === key).reached;
  assert.equal(step('2026-09-21', 'running'), 1);
  assert.deepEqual(step('2026-09-21', 'preview').recorded, false);
  assert.deepEqual(step('2026-09-14', 'running').recorded, false, 'before any record: not recorded, never 0');
  assert.equal(step('2026-09-14', 'first_version'), 0, 'a first version is read from rows kept all along');
  assert.equal(step('2026-08-10', 'created'), 0);

  // The filters: one cohort's people, and all time.
  const bens = await journey.creationPath(pool, { week, now, leftOutIds: [eve], memberIds: new Set([ben]) });
  assert.deepEqual(bens.steps.map((s) => s.reached), [1, 1, 0, 1, 0]);
  const all = await journey.creationPath(pool, { week: journey.allTime(now), now, leftOutIds: [eve] });
  assert.equal(all.week, 'all');
  assert.equal(all.steps[0].reached, 3, 'ana, ben and cat made projects, all time');
  assert.equal(all.weeks[all.weeks.length - 1].week, '2026-09-28', 'all time ends its weeks at the last finished one');
  const withEve = await journey.creationPath(pool, { week, now });
  assert.equal(withEve.steps[0].reached, 4, 'eve counts until she is left out');
});

test('pairs: two people active within 7 days of the second joining', { timeout: 120000 }, async (t) => {
  const db = await freshDatabase(t, 'journey_pairs_');
  if (!db) return;
  const { pool, user, app, session } = db;
  const now = new Date('2026-10-07T12:00:00Z');
  const week = journey.parseWeek('2026-09-28', now);
  const ana = await user('ana');
  const ben = await user('ben');
  const cat = await user('cat');
  const eve = await user('eve');
  const boss = await user('boss', { is_admin: true });
  const community = async (appId) => (await pool.query('SELECT community_id FROM apps WHERE id = $1', [appId])).rows[0].community_id;
  const member = async (appId, userId, source, at) => pool.query(
    'INSERT INTO community_members (community_id, user_id, source, joined_at) VALUES ($1, $2, $3, $4)',
    [await community(appId), userId, source, at]);

  // Duo: ben comes in through ana's invite link; both active within days.
  // A backfill row for cat says nothing about when she joined.
  const duo = await app('duo', ana, '2026-09-20T10:00:00Z');
  const invite = (await pool.query(
    `INSERT INTO community_invites (token, community_id, app_id, created_by, expires_at)
     VALUES ('t1', $1, $2, $3, '2026-10-30T00:00:00Z') RETURNING id`, [await community(duo), duo, ana])).rows[0].id;
  await pool.query("INSERT INTO community_invite_redemptions (invite_id, user_id, status) VALUES ($1, $2, 'joined')", [invite, ben]);
  await member(duo, ben, 'joined', '2026-09-29T10:00:00Z');
  await member(duo, cat, 'active', '2026-09-01T00:00:00Z');
  await pool.query("INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'hi', '2026-09-30T08:00:00Z')", [duo, ben]);
  await pool.query("INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, 60, '2026-10-02')", [duo, ana]);

  // Solo: an admin joins first (not a real person), eve second by a pin;
  // cat wrote before eve joined, so only eve is active in her 7 days.
  const solo = await app('solo', cat, '2026-09-25T10:00:00Z');
  await member(solo, boss, 'joined', '2026-09-29T09:00:00Z');
  await member(solo, eve, 'favorite', '2026-09-30T08:00:00Z');
  await pool.query("INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'early', '2026-09-29T12:00:00Z')", [solo, cat]);
  const soloChange = await session(solo, cat);
  await pool.query("INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', '2026-10-01T10:00:00Z')", [soloChange, eve]);

  // Late: cat accepted a collaborator invite on 4 Oct and wrote to an agent
  // the next day; ben has not been back yet, and her 7 days are not over.
  const late = await app('late', ben, '2026-09-26T10:00:00Z');
  await pool.query(
    "INSERT INTO app_collaborators (app_id, user_id, status, created_at, accepted_at) VALUES ($1, $2, 'member', '2026-10-03T00:00:00Z', '2026-10-04T12:00:00Z')",
    [late, cat]);
  const catSession = await session(late, cat);
  await pool.query("INSERT INTO chat_session_messages (session_id, role, content, created_at) VALUES ($1, 'user', 'add a list', '2026-10-05T09:00:00Z')", [catSession]);

  // The week before: Old Pair, cat joined on 22 Sep; both active.
  const oldPair = await app('old-pair', ana, '2026-09-10T10:00:00Z');
  await member(oldPair, cat, 'joined', '2026-09-22T10:00:00Z');
  const issue = (await pool.query("INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, 3, 'x', $2) RETURNING id", [oldPair, ana])).rows[0].id;
  await pool.query("INSERT INTO issue_votes (issue_id, user_id, vote, created_at) VALUES ($1, $2, 'up', '2026-09-23T10:00:00Z')", [issue, cat]);
  await pool.query("INSERT INTO chat_messages (app_id, user_id, content, created_at) VALUES ($1, $2, 'yes', '2026-09-24T10:00:00Z')", [oldPair, ana]);

  // Homeroom's own project: everybody is in it, so it never counts.
  const homeroom = await app('homeroom', ana, '2026-09-01T00:00:00Z', true);
  await pool.query(
    "UPDATE community_members SET source = 'joined', joined_at = '2026-09-30T00:00:00Z' WHERE community_id = $1 AND user_id = $2",
    [await community(homeroom), ben]);

  const read = await journey.pairs(pool, { week, now });
  assert.deepEqual([read.week, read.days, read.count, read.of, read.open], ['2026-09-28', 7, 1, 3, 1]);
  assert.deepEqual(read.examples.map((e) => [e.slug, e.pair.map((p) => p.name), e.via, e.bothActive, e.hoursToBoth, e.open]), [
    ['late', ['ben', 'cat'], 'members', false, null, true],
    ['solo', ['cat', 'eve'], 'members', false, null, false],
    ['duo', ['ana', 'ben'], 'invite', true, 62, false],
  ]);
  assert.equal(read.trend.length, 8);
  assert.deepEqual(read.trend.slice(-2), [
    { week: '2026-09-21', count: 1, of: 1 },
    { week: '2026-09-28', count: 1, of: 3 },
  ]);

  // The filters: a cohort keeps pairs with one of its people in them; a
  // left-out person is nobody's second member.
  const eves = await journey.pairs(pool, { week, now, memberIds: new Set([eve]) });
  assert.deepEqual([eves.count, eves.of], [0, 1]);
  const withoutBen = await journey.pairs(pool, { week, now, leftOutIds: [ben] });
  assert.deepEqual(withoutBen.examples.map((e) => e.slug), ['solo']);
  const all = await journey.pairs(pool, { week: journey.allTime(now), now });
  assert.deepEqual([all.week, all.count, all.of], ['all', 2, 4]);
  assert.equal(journey.pairReading({
    slug: 's', name: 'S', second_at: '2026-10-06T00:00:00Z', via_invite: false,
    host_id: 1, host: 'a', second_id: 2, second: 'b', host_active_at: null, second_active_at: null,
  }, now).open, true, 'inside its 7 days, it is open, not a no');
});
