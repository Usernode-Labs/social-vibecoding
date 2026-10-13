'use strict';

// #3654, against the FULL PostgreSQL schema: a run's snapshot is stored
// compressed and once per distinct text, read back whole, capped and marked
// when a text is too long, replaced (not duplicated) when the same run and
// stage record again, and kept when its run is deleted. And the rating fix:
// a one-tap Yes/No no longer erases the note written beside it, and the
// verdict a labeller says was right is stored next to both.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const snapshots = require('../src/services/homeroom-bot-snapshots');
const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('run snapshots and ratings against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_snap_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const run = async () => (await pool.query(
    "INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 12, 'shadow', 'ready') RETURNING id",
    [app.id],
  )).rows[0].id;

  await t.test('stored compressed, once per distinct text, and read back whole', async () => {
    const runA = await run();
    const runB = await run();
    const thread = snapshots.frozenThread({
      issueNumber: 12, issue: { number: 12, title: 'Pins', body: 'drift', extraneous: 'x' },
      comments: [{ author: 'ann', body: 'zoom', createdAt: '2026-09-20T00:00:00Z', reactions: 9 }],
      threadMessages: [], botLogin: 'usernode-bot',
    });
    const shared = 'DESIGN GUIDANCE '.repeat(2000);
    const a = await snapshots.recordSnapshot(pool, {
      runId: runA, stage: 'triage', appId: app.id, issueNumber: 12, baseSha: 'A'.repeat(40),
      texts: { seed: 'seed A', prompt: `seed A\n${shared}`, thread }, extra: { model: 'z-ai/glm-5.3-flash' },
    });
    const b = await snapshots.recordSnapshot(pool, {
      runId: runB, stage: 'triage', appId: app.id, issueNumber: 12,
      texts: { seed: 'seed A', prompt: `seed A\n${shared}`, thread }, extra: {},
    });
    assert.ok(a && b && a !== b);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_snapshot_blobs');
    assert.equal(n, 3, 'two runs that read the same texts store them once');
    const { rows: [{ stored, chars }] } = await pool.query(
      'SELECT octet_length(content) AS stored, chars FROM homeroom_bot_snapshot_blobs ORDER BY chars DESC LIMIT 1',
    );
    assert.ok(stored < chars / 10, `a repetitive prompt compresses (${stored} bytes for ${chars} chars)`);

    const back = await snapshots.snapshotForRun(pool, runA, 'triage');
    assert.equal(back.texts.seed, 'seed A');
    assert.equal(back.texts.prompt, `seed A\n${shared}`);
    assert.equal(back.baseSha, 'a'.repeat(40), 'normalised to lower case');
    assert.equal(back.promptHash, snapshots.hashText(`seed A\n${shared}`));
    assert.deepEqual(back.thread.issue, { number: 12, title: 'Pins', body: 'drift' }, 'only the fields the seed reads');
    assert.deepEqual(back.thread.comments, [{ author: 'ann', body: 'zoom', createdAt: '2026-09-20T00:00:00Z' }]);
    assert.equal(back.extra.model, 'z-ai/glm-5.3-flash');
    assert.deepEqual(await snapshots.stagesForRuns(pool, [runA, runB, 999999]), { [runA]: ['triage'], [runB]: ['triage'] });
  });

  await t.test('a text over the cap is cut and marked; the same run and stage record once', async () => {
    const id = await run();
    const huge = 'x'.repeat(snapshots.MAX_TEXT_CHARS + 50);
    await snapshots.recordSnapshot(pool, { runId: id, stage: 'build', appId: app.id, issueNumber: 12, texts: { seed: huge } });
    await snapshots.recordSnapshot(pool, { runId: id, stage: 'build', appId: app.id, issueNumber: 12, texts: { seed: huge } });
    const { rows } = await pool.query('SELECT truncated FROM homeroom_bot_run_snapshots WHERE run_id = $1', [id]);
    assert.equal(rows.length, 1, 'replaced, not duplicated');
    assert.equal(rows[0].truncated, true);
    const back = await snapshots.snapshotForRun(pool, id, 'build');
    assert.equal(back.texts.seed.length, snapshots.MAX_TEXT_CHARS);
    assert.ok(back.texts.seed.endsWith(snapshots.TRUNCATED_MARK));
  });

  await t.test('an unknown stage is refused without throwing; a deleted run leaves its snapshot', async () => {
    assert.equal(await snapshots.recordSnapshot(pool, { runId: null, stage: 'judge', appId: app.id, issueNumber: 1 }), null);
    const id = await run();
    const snap = await snapshots.recordSnapshot(pool, { runId: id, stage: 'triage', appId: app.id, issueNumber: 12, texts: { seed: 's' } });
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = $1', [id]);
    const kept = await snapshots.readSnapshot(pool, snap);
    assert.equal(kept.runId, null);
    assert.equal(kept.texts.seed, 's');
  });

  await t.test('a Yes/No keeps the note and the label; the label is its own field', async () => {
    const { rows: [user] } = await pool.query(
      "INSERT INTO users (username, password) VALUES ('rater', 'x') RETURNING id",
    );
    const id = await run();
    let r = await bot.rateRun(pool, { id, note: 'Should have asked which screen.', labelVerdict: 'question', actorId: user.id });
    assert.equal(r.ok, true);
    assert.equal(r.run.rating, null);
    r = await bot.rateRun(pool, { id, rating: 'no', actorId: user.id });
    assert.equal(r.run.rating, 'no');
    assert.equal(r.run.rating_note, 'Should have asked which screen.', 'the one-tap rating left the note alone');
    assert.equal(r.run.label_verdict, 'question');
    r = await bot.rateRun(pool, { id, rating: null, actorId: user.id });
    assert.equal(r.run.rating, null);
    assert.equal(r.run.rating_note, 'Should have asked which screen.');
    r = await bot.rateRun(pool, { id, note: null, labelVerdict: null, actorId: user.id });
    assert.equal(r.run.rating_note, null, 'null clears');
    assert.equal(r.run.label_verdict, null);
    assert.equal((await bot.rateRun(pool, { id, labelVerdict: 'failed' })).status, 400);
    assert.equal((await bot.rateRun(pool, { id })).status, 400, 'nothing to rate');
  });
});
