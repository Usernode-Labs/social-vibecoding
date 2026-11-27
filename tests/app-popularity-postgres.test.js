// Hearts and plays (src/services/app-popularity.js) against a real
// PostgreSQL: the counts the directory and the hub read, a visitor's play
// counted once per source per day, a heart given and taken back, and the
// marks deleted once they are of no use. The screen's half is
// tests/app-popularity.test.js.
//
// Run with: node --test tests/app-popularity-postgres.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const popularity = require('../src/services/app-popularity');
const { listPublicApps } = require('../src/services/public-app-directory');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('plays are one per person per day and hearts one per account (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2_000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
      return;
    }
    const name = `app_popularity_${crypto.randomBytes(6).toString('hex')}`;
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

    const makeUser = async (username, synthetic = false) => (await pool.query(
      `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'unused', $2) RETURNING id`,
      [username, synthetic]
    )).rows[0].id;
    const ana = await makeUser('popularity_ana');
    const ben = await makeUser('popularity_ben');
    const bot = await makeUser('popularity_bot', true);
    const makeApp = async (slug, snapshot) => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility, status, manifest_snapshot)
       VALUES ($1, $1, $2, 'public', 'public', 'running', $3::jsonb) RETURNING id`,
      [slug, ana, JSON.stringify(snapshot)]
    )).rows[0].id;
    const game = await makeApp('popularity-game', { category: 'games', description: 'A card game.' });
    const tool = await makeApp('popularity-tool', { category: 'tools', description: 'A bill splitter.' });

    // Nothing yet: every count is zero, and a game is played while a tool is opened.
    assert.deepEqual(await popularity.summaryFor(pool, game, ana), { plays: 0, hearts: 0, hearted: false, played: true });
    assert.deepEqual(await popularity.summaryFor(pool, tool, null), { plays: 0, hearts: 0, hearted: false, played: false });
    assert.equal(await popularity.summaryFor(pool, 2147483000, ana), null, 'no such app');

    // Somebody signed in: one play for each day they used the app, however
    // long, and none for an account that is not a person.
    const spend = (appId, userId, daysAgo) => pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, 90, CURRENT_DATE - $3::int)`,
      [appId, userId, daysAgo]
    );
    await spend(game, ana, 0);
    await spend(game, ana, 1);
    await spend(game, ben, 0);
    await spend(game, bot, 0);
    await spend(tool, ben, 3);
    assert.equal((await popularity.summaryFor(pool, game, null)).plays, 3);

    // A visitor: one play per source per app per day. The same source again
    // adds nothing; another source, or the same one on another app, does.
    assert.deepEqual(await popularity.recordVisitorPlay(pool, { appId: game, source: 'aaaaaaaaaaaaaaaa' }), { counted: true });
    assert.deepEqual(await popularity.recordVisitorPlay(pool, { appId: game, source: 'aaaaaaaaaaaaaaaa' }), { counted: false });
    assert.deepEqual(await popularity.recordVisitorPlay(pool, { appId: game, source: 'bbbbbbbbbbbbbbbb' }), { counted: true });
    assert.deepEqual(await popularity.recordVisitorPlay(pool, { appId: tool, source: 'aaaaaaaaaaaaaaaa' }), { counted: true });
    assert.deepEqual(await popularity.recordVisitorPlay(pool, { appId: game, source: '' }), { counted: false }, 'no source, no count');
    assert.equal((await pool.query('SELECT plays FROM app_visitor_plays WHERE app_id = $1', [game])).rows[0].plays, 2);
    assert.equal((await popularity.summaryFor(pool, game, null)).plays, 5, 'three signed in and two visitors');
    assert.equal((await popularity.summaryFor(pool, tool, null)).plays, 2);

    // A heart: given once however often it is asked for, taken back the same
    // way, and counted only from people.
    assert.deepEqual(await popularity.setHeart(pool, { appId: game, userId: ana, hearted: true }), { hearted: true, hearts: 1 });
    assert.deepEqual(await popularity.setHeart(pool, { appId: game, userId: ana, hearted: true }), { hearted: true, hearts: 1 });
    assert.deepEqual(await popularity.setHeart(pool, { appId: game, userId: ben, hearted: true }), { hearted: true, hearts: 2 });
    assert.deepEqual(await popularity.setHeart(pool, { appId: game, userId: bot, hearted: true }), { hearted: true, hearts: 2 });
    assert.deepEqual(await popularity.summaryFor(pool, game, ana), { plays: 5, hearts: 2, hearted: true, played: true });
    assert.equal((await popularity.summaryFor(pool, tool, ana)).hearted, false, 'a heart is for one app');
    assert.deepEqual(await popularity.setHeart(pool, { appId: game, userId: ben, hearted: false }), { hearted: false, hearts: 1 });
    assert.deepEqual(await popularity.setHeart(pool, { appId: game, userId: ben, hearted: false }), { hearted: false, hearts: 1 });

    // The directory carries the same two numbers on each card.
    const apps = await listPublicApps(pool, { includeWallets: false });
    const card = (slug) => apps.find((a) => a.slug === slug);
    assert.equal(card('popularity-game').plays, 5);
    assert.equal(card('popularity-game').hearts, 1);
    assert.equal(card('popularity-tool').plays, 2);
    assert.equal(card('popularity-tool').hearts, 0);
    const [one] = await listPublicApps(pool, { includeWallets: false, slug: 'popularity-game' });
    assert.equal(one.plays, 5, 'and on the one app the project page asks for');

    // A mark is kept for its day and the next, then deleted; the count stays.
    await pool.query(
      `INSERT INTO app_visitor_play_marks (app_id, day, source)
       VALUES ($1, CURRENT_DATE - 1, 'yesterday'), ($1, CURRENT_DATE - 5, 'last-week')`,
      [game]
    );
    assert.equal(await popularity.pruneMarks(pool), 1);
    const marks = (await pool.query('SELECT source FROM app_visitor_play_marks WHERE app_id = $1 ORDER BY source', [game])).rows;
    assert.deepEqual(marks.map((m) => m.source), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'yesterday']);
    assert.equal((await popularity.summaryFor(pool, game, null)).plays, 5);

    // An account that goes takes its heart with it; an app that goes takes everything.
    await pool.query('DELETE FROM app_hearts WHERE user_id = $1', [bot]);
    await pool.query('DELETE FROM apps WHERE id = $1', [game]);
    assert.equal((await pool.query('SELECT 1 FROM app_hearts WHERE app_id = $1', [game])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM app_visitor_plays WHERE app_id = $1', [game])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM app_visitor_play_marks WHERE app_id = $1', [game])).rowCount, 0);
  });
