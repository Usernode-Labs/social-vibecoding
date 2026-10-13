'use strict';

// What a Homeroom preview spends before it listens. Measured on production
// on 2026-10-13, the migration took 6.1 to 6.3 seconds of each preview's
// start, and 3.6 seconds of that was not database work: 152 demo screenshots
// drawn pixel by pixel (twenty different pictures), three bcrypt hashes of
// fixture passwords at the cost real passwords get, and nine
// searches of the copied chat for merge announcements that nine fixtures
// never had.
//
// These pin the three fixes, and that none of them changes what a preview
// holds: the same screenshot bytes, the same rows, the same sign-ins, the
// same backfill result. The last test runs the old search beside the new
// one on a real PostgreSQL; it skips when no database is reachable, unless
// TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const demo = require('../src/services/bench/demo');
const migrate = require('../src/db/migrate');

const MIGRATE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8');
const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

const savedEnvironment = process.env.USERNODE_ENV;
test.afterEach(() => {
  if (savedEnvironment === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = savedEnvironment;
});

test('a demo screenshot is the same bytes it was when every pixel was drawn', () => {
  // Digests taken from the pixel-by-pixel version at 91a19c88e.
  const accent = [217, 119, 6];
  const cases = [
    [[390, 844, [250, 250, 249], [{ y: 120, h: 40, rgb: [1, 2, 3] }]], 'f24d38acb1c4c2f1'],
    [[1280, 800, [24, 24, 27], [{ y: 64, h: 48, rgb: accent }, { y: 160, h: 88, rgb: [63, 63, 70] }, { y: 280, h: 320, rgb: accent }]], 'ad97527af31882d6'],
    [[20, 10, [1, 1, 1], []], 'cc7fa9a5b2c1a517'],
    // Overlapping bars: the first one listed wins, as before.
    [[40, 30, [9, 9, 9], [{ y: 0, h: 30, rgb: [5, 6, 7] }, { y: 5, h: 5, rgb: [8, 8, 8] }]], '19cb882b07d5c642'],
  ];
  for (const [args, digest] of cases) assert.equal(sha(demo.demoPng(...args)).slice(0, 16), digest);
});

test('the taste and studio demos draw twenty pictures, not 152, and store the same 152', async () => {
  process.env.USERNODE_ENV = 'staging';
  const stored = [];
  const pool = {
    async query(sql, params) {
      if (/FROM apps/.test(sql)) return { rows: [{ id: 7, slug: 'demo' }] };
      if (/INSERT INTO bench_trial_artifacts/.test(sql)) stored.push(params);
      return { rows: [], rowCount: 0 };
    },
  };
  const deflate = zlib.deflateSync;
  let drawn = 0;
  zlib.deflateSync = (...args) => { drawn += 1; return deflate.apply(zlib, args); };
  try {
    assert.equal(await demo.seedStagingTaste(pool), true);
    assert.equal(await demo.seedStagingStudio(pool), true);
  } finally {
    zlib.deflateSync = deflate;
  }
  assert.equal(stored.length, 152, 'eight builds, nineteen screenshots each');
  assert.equal(new Set(stored.map((p) => p[10])).size, 20, 'of twenty kinds');
  assert.ok(drawn <= 20, `each kind is drawn at most once in a process (drew ${drawn})`);
  // Every row as the pixel-by-pixel version stored it at 91a19c88e: trial,
  // shot, size, byte count, digest, and a digest that is the data's own.
  const rows = stored.map((p) => `${p[1]} ${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[7]}x${p[8]} ${p[9]} ${p[10]} ${sha(p[6]) === p[10]}`);
  assert.equal(sha(rows.join('\n')), '56db33a9fde2f0809108d9445302159154543e4ad68311d46105d659b71ec841');
  assert.ok(stored.every((p) => p[6].subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));
});

// Each top-level function of migrate.js, by name.
function functionsOf(source) {
  const out = new Map();
  const starts = [...source.matchAll(/^(?:async )?function (\w+)\(/gm)];
  for (const [i, m] of starts.entries()) {
    const end = source.indexOf('\n}\n', m.index);
    out.set(m[1], source.slice(m.index, end < 0 || (starts[i + 1] && end > starts[i + 1].index) ? starts[i + 1]?.index : end));
  }
  return out;
}

test('the cheap hash is for a fixture\'s literal, on staging, and nothing else', () => {
  assert.match(MIGRATE_SOURCE, /^const STAGING_FIXTURE_BCRYPT_COST = 4;$/m);
  const cheap = [];
  for (const [name, body] of functionsOf(MIGRATE_SOURCE)) {
    for (const call of body.matchAll(/bcrypt\.hash\(([\s\S]*?),\s*([\w.]+)\s*\)/g)) {
      const [, what, cost] = call;
      if (cost !== 'STAGING_FIXTURE_BCRYPT_COST') {
        assert.match(cost, /^1[02]$/, `${name} hashes at the cost real secrets get`);
        continue;
      }
      cheap.push(name);
      assert.match(name, /^seedStaging/, `${name} is a staging fixture`);
      assert.match(body.slice(0, body.indexOf('bcrypt.hash(')), /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/,
        `${name} has returned before the hash anywhere but staging`);
      assert.match(what.trim(), /^('staging-[a-z-]+'|crypto\.randomBytes\(32\)\.toString\('hex'\))$/,
        `${name} hashes a literal of this file or bytes nobody keeps, never something a person chose`);
    }
  }
  assert.deepEqual(cheap.sort(), ['seedStagingEmailCodeAccounts', 'seedStagingEmailCodeAccounts', 'seedStagingTopochain']);
  // The accounts a production database has keep the full cost.
  for (const name of ['seedAdmin', 'seedCaptureUser', 'seedCaptureAdminUser']) {
    assert.match(functionsOf(MIGRATE_SOURCE).get(name), /bcrypt\.hash\([\s\S]*?, 12\)/, name);
  }
});

test('a hash at the fixture cost still signs the documented literal in', async () => {
  const hash = await bcrypt.hash('staging-code-password', 4);
  assert.equal(bcrypt.getRounds(hash), 4);
  assert.equal(await bcrypt.compare('staging-code-password', hash), true);
  assert.equal(await bcrypt.compare('staging-code-passwore', hash), false);
});

// A pool that answers the backfill's two reads from arrays.
function scripted({ sessions, announcements, failAnnouncements = false }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM chat_sessions/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: sessions };
      if (/FROM chat_messages/.test(sql)) {
        if (failAnnouncements) throw new Error('relation "chat_messages" does not exist');
        return { rows: announcements.filter((a) => params[0].includes(a.app_id)) };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

test('the votes backfill reads the announcements once, whatever the number of merged rows', async () => {
  delete process.env.USERNODE_ENV; // It is not a fixture: production runs it too.
  const sessions = [
    { id: 1, app_id: 10, pr_number: 1 }, { id: 2, app_id: 10, pr_number: 12 }, { id: 3, app_id: 10, pr_number: null },
    { id: 4, app_id: 11, pr_number: 1 }, { id: 5, app_id: 10, pr_number: 77 }, { id: 6, app_id: 10, pr_number: 8 },
  ];
  // Newest first, as the query orders them.
  const announcements = [
    { app_id: 10, content: 'PR #12 "b" merged and deployed! (7/12 votes)' },
    { app_id: 10, content: 'PR #1 "a" force-merged by admin evan (1/9 vote(s) at the time)' },
    { app_id: 10, content: 'PR #1 "a" merged and deployed! (5/8 votes)' },
    { app_id: 10, content: 'About PR #3: merged and deployed! (2/3 votes)' },
    { app_id: 11, content: 'PR #1 "other app" merged and deployed! (2/2 votes)' },
    { app_id: 10, content: 'PR #8 merged and deployed! with no figure' },
  ];
  const pool = scripted({ sessions, announcements });
  await migrate.backfillVotesRequired(pool);
  assert.equal(pool.calls.filter((c) => /FROM chat_messages/.test(c.sql)).length, 1, 'one read of the chat');
  assert.deepEqual(pool.calls[1].params, [[10, 11]], 'for the apps concerned');
  assert.match(pool.calls[1].sql, /msg_type = 'system'[\s\S]*merged and deployed![\s\S]*force-merged by admin[\s\S]*ORDER BY created_at DESC/);
  const updates = pool.calls.filter((c) => /UPDATE chat_sessions/.test(c.sql)).map((c) => c.params);
  assert.deepEqual(updates, [
    [1, 5, 9], // "PR #1" is not "PR #12"; the newest of its two lines wins
    [2, 7, 12],
    [3, 2, 3], // no PR number: the session id is the reference
    [4, 2, 2], // the same PR number in another app reads that app's line
  ], 'PR #77 has no line and PR #8\'s has no figure: both stay empty');
  assert.equal(pool.calls.length, 2 + 4);

  const none = scripted({ sessions: [], announcements });
  await migrate.backfillVotesRequired(none);
  assert.equal(none.calls.length, 1, 'nothing to fill, nothing read');

  const broken = scripted({ sessions, announcements, failAnnouncements: true });
  await migrate.backfillVotesRequired(broken); // never aborts a boot
  assert.equal(broken.calls.filter((c) => /UPDATE/.test(c.sql)).length, 0);
});

// The search this replaced, one per merged row, kept here as the oracle.
const OLD_SEARCH = `SELECT content FROM chat_messages
  WHERE app_id = $1 AND msg_type = 'system'
    AND content ~ $2
    AND (content LIKE '%merged and deployed!%'
         OR content LIKE '%force-merged by admin%')
  ORDER BY created_at DESC
  LIMIT 1`;

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('on PostgreSQL the one read fills what the per-row searches filled', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fixture_boot_cost_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 2 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(`
    INSERT INTO users (id, username, password) VALUES (1, 'a', 'x');
    INSERT INTO apps (id, name, slug, status) VALUES (10, 'Self', 'self', 'running'), (11, 'Other', 'other', 'running');
    INSERT INTO chat_sessions (id, app_id, user_id, branch_name, status, pr_number)
      SELECT g, CASE WHEN g % 7 = 0 THEN 11 ELSE 10 END, 1, 'b' || g, CASE WHEN g % 5 = 0 THEN 'promoted' ELSE 'merged' END,
             CASE WHEN g % 9 = 0 THEN NULL ELSE g + 100 END
        FROM generate_series(1, 60) g;
    UPDATE chat_sessions SET votes_required = 3 WHERE id IN (2, 4);
    INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
      SELECT CASE WHEN g % 7 = 0 THEN 11 ELSE 10 END, 1,
             CASE g % 6
               WHEN 0 THEN 'PR #' || (g + 100) || ' "t" merged and deployed! (' || g || '/' || (g + 3) || ' votes)'
               WHEN 1 THEN 'PR #' || (g + 100) || ' "t" force-merged by admin a (1/' || g || ' vote(s) at the time)'
               WHEN 2 THEN 'PR #' || (g + 100) || ' was proposed (2/5 votes)'
               WHEN 3 THEN E'line one\\nPR #' || g || ' merged and deployed! (4/' || (g + 1) || ' votes)'
               WHEN 4 THEN 'PR #' || (g + 100) || '0 "ten times" merged and deployed! (9/99 votes)'
               ELSE 'PR #' || (g + 100) || ' merged and deployed! twice (6/' || (g + 20) || ' votes)'
             END,
             CASE WHEN g % 11 = 0 THEN 'message' ELSE 'system' END, NOW() - (g || ' minutes')::interval
        FROM generate_series(1, 60) g;
    INSERT INTO chat_messages (app_id, user_id, content, msg_type, created_at)
      SELECT 10, 1, 'PR #' || (g + 100) || ' merged and deployed! older (1/1 votes)', 'system', NOW() - INTERVAL '3 days'
        FROM generate_series(1, 60) g WHERE g % 4 = 0;
  `);

  // What the per-row search would fill, worked out before anything is written.
  const { rows: candidates } = await pool.query(
    "SELECT id, app_id, pr_number FROM chat_sessions WHERE status = 'merged' AND votes_required IS NULL ORDER BY id");
  const expected = {};
  for (const s of candidates) {
    const ref = s.pr_number || s.id;
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(OLD_SEARCH, [s.app_id, `(^|[^0-9])PR #${ref}([^0-9]|$)`]);
    const m = rows.length ? /\((\d+)\s*\/\s*(\d+)\s+vote/.exec(rows[0].content) : null;
    if (m && Number(m[2]) >= 1) expected[s.id] = [Math.floor(Number(m[2]) / 2) + 1, Number(m[2])];
  }
  assert.ok(Object.keys(expected).length >= 10 && Object.keys(expected).length < candidates.length, 'some rows fill and some do not');

  let reads = 0;
  await migrate.backfillVotesRequired({ query: (...args) => { reads += /FROM chat_messages/.test(args[0]) ? 1 : 0; return pool.query(...args); } });
  assert.equal(reads, 1);
  const { rows: after } = await pool.query(
    "SELECT id, votes_required, active_users_at_merge FROM chat_sessions WHERE status = 'merged' AND id NOT IN (2, 4) ORDER BY id");
  const got = {};
  for (const r of after) if (r.votes_required !== null) got[r.id] = [r.votes_required, r.active_users_at_merge];
  assert.deepEqual(got, expected);
  assert.deepEqual((await pool.query('SELECT votes_required FROM chat_sessions WHERE id IN (2, 4)')).rows.map((r) => r.votes_required), [3, 3],
    'a row that already has its figure keeps it');
});
