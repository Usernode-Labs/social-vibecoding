'use strict';

// #7189: a contributor is a PERSON.
//
// The request: a creator could not delete an app they made alone, because
// Homeroom bot - a synthetic account that authored the merged session of the
// build it made for them - was counted as a second contributor. The fix does
// not relax the delete rule; it fixes who the rule counts: synthetic accounts
// are not contributors, and a bot-built merged change is credited to the
// person who asked for it (services/change-person.js), exactly as the Journey
// and admin pages already do.
//
// What this pins, against the FULL PostgreSQL schema:
//   1. A creator plus a merged bot session the creator asked for is ONE
//      contributor, so the app's creator may delete it.
//   2. The same bot session asked for by another real person is TWO, so the
//      app is still shared and the creator still may not delete it alone.
//   3. A bot build nobody asked for counts for nobody.
//   4. A synthetic member is not a contributor.
//   5. The ranked Contributors read credits the bot's builds to the requester
//      ("N live") and never lists the bot.
//   6. The public API's loadContributors is the same loader, so the bot leaves
//      the public directory too.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/contributors-people.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('contributors are people: bot builds credit their requester', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `contributors_people_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const contributors = require('../src/services/contributors');
  const { deleteBlockReason } = require('../src/routes/apps');
  const publicApi = require('../src/routes/public-api');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const person = (username) => one(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [username]);
  const bot = await one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot_cp', 'x', TRUE) RETURNING id, username`);
  const demoPartner = await one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('demo_partner_cp', 'x', TRUE) RETURNING id, username`);
  const maker = await person('cp_maker');
  const helper = await person('cp_helper');

  const project = (slug, createdBy) => one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ($1, $1, 'running', $2, 'public', 'public') RETURNING id`, [slug, createdBy])
    .then(async (app) => app);

  // A merged session: the bot built it from issue #<n> of this app.
  const botBuild = (appId, issueNumber) => one(
    `INSERT INTO chat_sessions (app_id, user_id, status, created_from_issue_number, merged_at)
     VALUES ($1, $2, 'merged', $3, NOW()) RETURNING id`, [appId, bot.id, issueNumber]);

  // ── 1. creator + a bot build the creator asked for: one person ─────────
  const solo = await project('cp-solo', maker.id);
  await one(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
     VALUES ($1, 4, $2, 'Make it') RETURNING app_id`, [solo.id, maker.id]);
  await botBuild(solo.id, 4);

  const soloList = await contributors.loadContributors(pool, [solo.id]);
  assert.deepEqual(soloList.get(solo.id).map((r) => r.username), ['cp_maker'],
    'the bot is not a contributor; its build is the requester\'s');
  const soloCounts = await contributors.loadContributorCounts(pool, [solo.id]);
  assert.equal(soloCounts.get(solo.id), 1);
  assert.equal(deleteBlockReason({ id: solo.id, created_by: maker.id }, maker, soloCounts.get(solo.id)), null,
    'the creator of a bot-built app may now delete it');

  // ── 2. the bot build was asked for by ANOTHER person: shared ───────────
  const shared = await project('cp-shared', maker.id);
  await one(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
     VALUES ($1, 5, $2, 'Add a track') RETURNING app_id`, [shared.id, helper.id]);
  await botBuild(shared.id, 5);

  const sharedList = await contributors.loadContributors(pool, [shared.id]);
  assert.deepEqual(sharedList.get(shared.id).map((r) => r.username).sort(), ['cp_helper', 'cp_maker']);
  const sharedCounts = await contributors.loadContributorCounts(pool, [shared.id]);
  assert.equal(sharedCounts.get(shared.id), 2);
  assert.equal(deleteBlockReason({ id: shared.id, created_by: maker.id }, maker, sharedCounts.get(shared.id)), 'shared',
    'a project another real person contributed to still needs the group');

  // ── 3. a bot build nobody asked for counts for nobody ──────────────────
  const unasked = await project('cp-unasked', maker.id);
  await botBuild(unasked.id, 7);
  const unaskedList = await contributors.loadContributors(pool, [unasked.id]);
  assert.deepEqual(unaskedList.get(unasked.id).map((r) => r.username), ['cp_maker']);
  assert.equal((await contributors.loadContributorCounts(pool, [unasked.id])).get(unasked.id), 1);

  // ── 4. synthetic members and creators are not contributors ─────────────
  const botMade = await project('cp-botmade', demoPartner.id);
  await one(
    `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
    [botMade.id, bot.id]);
  await one(
    `INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`,
    [botMade.id, maker.id]);
  const botMadeList = await contributors.loadContributors(pool, [botMade.id]);
  assert.deepEqual(botMadeList.get(botMade.id).map((r) => r.username), ['cp_maker'],
    'a synthetic creator and a synthetic member are both left out');

  // ── 5. the ranked read credits the requester's builds ──────────────────
  const ranked = await contributors.loadRankedContributors(pool, solo.id);
  const rows = ranked.items;
  assert.ok(!rows.some((r) => r.username === 'homeroom_bot_cp'), 'the bot never appears');
  const makerRow = rows.find((r) => r.username === 'cp_maker');
  assert.equal(makerRow.merged_count, 1, 'the bot\'s merged build is the requester\'s');
  assert.equal(makerRow.is_creator, true);
  assert.equal(ranked.total, 1);

  // ── 6. the public API shares the definition ────────────────────────────
  assert.equal(publicApi.loadContributors, contributors.loadContributors);
  const publicList = await publicApi.loadContributors(pool, [solo.id]);
  assert.deepEqual(publicList.get(solo.id).map((r) => r.username), ['cp_maker']);

  // The loaders' SQL says so in as many words (the DB above is the proof).
  assert.match(contributors.CONTRIBUTOR_IDS_CTE, /is_synthetic|CHANGE_PERSON/);
  assert.ok(contributors.CONTRIBUTOR_IDS_CTE.includes(
    require('../src/services/change-person').CHANGE_PERSON_SQL),
    'the merged branch is the platform\'s one change-person expression');
});
