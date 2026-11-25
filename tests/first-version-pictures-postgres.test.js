'use strict';

// #7118: the card picture a first version commits (`brand/card.png`) applies
// to its app once, on the first production deploy after that version merged,
// through services/first-version-pictures.js applyFirstCard, against the FULL
// PostgreSQL schema in a throwaway database.
//
// What this pins:
//   1. Nothing applies before the first version merged, and bot_builds =
//      false is never touched.
//   2. After the merge: the light and dark pictures are stored in
//      app_illustrations, apps.featured_illustration wears them centred with
//      the card colour of the icon block's hue, and card_picture_at is set.
//   3. A picture the creator already chose, or one waiting for a vote, is
//      kept: the step only marks that it ran.
//   4. It runs once, so a picture removed later is never put back.
//   5. An oversized PNG is shrunk under the card limit; a missing file marks
//      without applying.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-version-pictures-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// A real PNG pngjs reads back: `noise` makes it incompressible, so a big one
// is over the 1 MB card limit and has to be shrunk.
function pngBytes(width, height, salt, { noise = false } = {}) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  if (noise) {
    crypto.randomFillSync(png.data);
  } else {
    for (let i = 0; i < png.data.length; i += 1) png.data[i] = i % 4 === 3 ? 255 : salt & 0xff;
  }
  return PNG.sync.write(png);
}

test('a first version\'s card picture applies once, after its version merged', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `fv_pictures_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  const { applyFirstCard, cardToneFor } = require('../src/services/first-version-pictures');

  async function user(username) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id`,
      [username],
    );
    return row.id;
  }
  const maker = await user('fv_maker');
  const bot = await user('fv_bot');
  let n = 0;
  async function makeApp(slug) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $1, 'running', $2, $3, 'public', 'public') RETURNING id`,
      [slug, maker, `https://github.com/usernode-bot/${slug}`],
    );
    return row.id;
  }
  async function firstVersion(appId, { botBuilds = true, issue = 1, merged = true } = {}) {
    await pool.query(
      `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, bot_builds)
       VALUES ($1, $2, 'A plant log', 'filed', $3, $4)`,
      [appId, maker, issue, botBuilds],
    );
    if (merged) {
      await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, merged_at)
         VALUES ($1, $2, 'merged', ARRAY[$3]::int[], NOW())`,
        [appId, bot, issue],
      );
    }
  }
  function cloneWith(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-pictures-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (files) {
      fs.mkdirSync(path.join(dir, 'brand'), { recursive: true });
      for (const [rel, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), data);
    }
    return dir;
  }
  const manifest = { icon: { image: 'brand/icon.png', color: '#3DD68A' } };
  const LIGHT = pngBytes(64, 40, 7);
  const DARK = pngBytes(64, 40, 9);

  await t.test('nothing applies before the first version merged', async () => {
    const appId = await makeApp('fv-early');
    await firstVersion(appId, { merged: false });
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-early' }, manifest, cloneWith({ 'brand/card.png': LIGHT })), false);
    const { rows } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [appId]);
    assert.equal(rows[0].featured_illustration, null);
    const { rows: [fv] } = await pool.query('SELECT card_picture_at FROM homeroom_bot_first_versions WHERE app_id = $1', [appId]);
    assert.equal(fv.card_picture_at, null, 'not marked: the starter\'s own deploy is not the step');
  });

  await t.test('a first version a person builds is never touched', async () => {
    const appId = await makeApp('fv-person');
    await firstVersion(appId, { botBuilds: false });
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-person' }, manifest, cloneWith({ 'brand/card.png': LIGHT })), false);
    const { rows } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [appId]);
    assert.equal(rows[0].featured_illustration, null);
  });

  await t.test('after the merge it applies the light and dark pictures, centred, tinted to the icon hue, once', async () => {
    const appId = await makeApp('fv-applied');
    await firstVersion(appId);
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-applied' }, manifest, cloneWith({
      'brand/card.png': LIGHT, 'brand/card-dark.png': DARK,
    })), true);
    const { rows: [app] } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [appId]);
    const featured = app.featured_illustration;
    assert.equal(featured.zoom, 1);
    assert.deepEqual([featured.x, featured.y], [0, 0]);
    assert.equal(featured.tint, 'mint', 'green maps to mint');
    assert.match(featured.url, /^\/app-illustrations\/[a-f0-9]{32}$/);
    assert.match(featured.darkUrl, /^\/app-illustrations\/[a-f0-9]{32}$/);
    const { rows: [stored] } = await pool.query('SELECT id, content_type, data, dark_id, dark_data FROM app_illustrations WHERE app_id = $1', [appId]);
    assert.equal(`/app-illustrations/${stored.id}`, featured.url);
    assert.equal(`/app-illustrations/${stored.dark_id}`, featured.darkUrl);
    assert.equal(stored.content_type, 'image/png');
    assert.deepEqual(stored.data, LIGHT);
    assert.deepEqual(stored.dark_data, DARK);
    const { rows: [fv] } = await pool.query('SELECT card_picture_at FROM homeroom_bot_first_versions WHERE app_id = $1', [appId]);
    assert.ok(fv.card_picture_at instanceof Date, 'marked done');
    // A second deploy does nothing, even after the creator removed it.
    await pool.query('DELETE FROM app_illustrations WHERE app_id = $1', [appId]);
    await pool.query('UPDATE apps SET featured_illustration = NULL WHERE id = $1', [appId]);
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-applied' }, manifest, cloneWith({ 'brand/card.png': LIGHT })), false);
    const { rows: [after] } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [appId]);
    assert.equal(after.featured_illustration, null, 'never put back');
  });

  await t.test('the creator\'s own picture, or one waiting for a vote, wins: the step only marks', async () => {
    const appId = await makeApp('fv-chosen');
    await firstVersion(appId);
    const chosen = { url: '/app-illustrations/' + 'a'.repeat(32), darkUrl: null, zoom: 1.2, x: 3, y: -4, tint: 'blue' };
    await pool.query('UPDATE apps SET featured_illustration = $2::jsonb WHERE id = $1', [appId, JSON.stringify(chosen)]);
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-chosen' }, manifest, cloneWith({ 'brand/card.png': LIGHT })), false);
    const { rows: [kept] } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [appId]);
    assert.deepEqual(kept.featured_illustration, chosen);
    const { rows: [fv] } = await pool.query('SELECT card_picture_at FROM homeroom_bot_first_versions WHERE app_id = $1', [appId]);
    assert.ok(fv.card_picture_at, 'marked, so it never runs again');

    const waitingId = await makeApp('fv-waiting');
    await firstVersion(waitingId);
    await pool.query(
      `INSERT INTO issues (app_id, kind, status, title, created_by, payload)
       VALUES ($1, 'featured_illustration', 'open', 'Add a featured illustration', $2, '{}'::jsonb)`,
      [waitingId, maker],
    );
    assert.equal(await applyFirstCard(pool, { id: waitingId, slug: 'fv-waiting' }, manifest, cloneWith({ 'brand/card.png': LIGHT })), false);
    const { rows: [pending] } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [waitingId]);
    assert.equal(pending.featured_illustration, null);
    const { rows: [wfv] } = await pool.query('SELECT card_picture_at FROM homeroom_bot_first_versions WHERE app_id = $1', [waitingId]);
    assert.ok(wfv.card_picture_at, 'marked too');
  });

  await t.test('an oversized PNG is shrunk under the card limit; a missing file marks without applying', async () => {
    const big = pngBytes(1200, 1200, 11, { noise: true });
    assert.ok(big.length > 1024 * 1024, 'the fixture is over the limit');
    const appId = await makeApp('fv-big');
    await firstVersion(appId);
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-big' }, manifest, cloneWith({ 'brand/card.png': big })), true);
    const { rows: [stored] } = await pool.query('SELECT data, dark_id FROM app_illustrations WHERE app_id = $1', [appId]);
    assert.ok(stored.data.length <= 1024 * 1024, 'under the card limit');
    assert.equal(stored.dark_id, null, 'no dark picture to keep');

    const missingId = await makeApp('fv-missing');
    await firstVersion(missingId);
    assert.equal(await applyFirstCard(pool, { id: missingId, slug: 'fv-missing' }, manifest, cloneWith({ 'brand/card-dark.png': DARK })), false);
    const { rows: [none] } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [missingId]);
    assert.equal(none.featured_illustration, null);
    const { rows: [mfv] } = await pool.query('SELECT card_picture_at FROM homeroom_bot_first_versions WHERE app_id = $1', [missingId]);
    assert.ok(mfv.card_picture_at, 'marked: nothing is retried later');
  });

  await t.test('an icon colour off the palette leaves the tint out', async () => {
    const appId = await makeApp('fv-plain');
    await firstVersion(appId);
    assert.equal(await applyFirstCard(pool, { id: appId, slug: 'fv-plain' }, { icon: { emoji: '🌱' } }, cloneWith({ 'brand/card.png': LIGHT })), true);
    const { rows: [app] } = await pool.query('SELECT featured_illustration FROM apps WHERE id = $1', [appId]);
    assert.equal(app.featured_illustration.tint, undefined, 'the card keeps its slug\'s hash');
    assert.equal(cardToneFor('#123456'), null);
  });
});
