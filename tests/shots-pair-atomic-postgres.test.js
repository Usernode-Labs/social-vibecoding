'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const state = require('../src/services/shots-state');
const files = require('../src/services/shots-files');
const fixtures = require('./fixtures/shots');

test('a valid pair replacement rolls back both old photos when the second database insert fails', async (t) => {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres' });
  try { await admin.query('SELECT 1'); } catch (error) { await admin.end(); if (process.env.TEST_DATABASE_URL) throw error; t.skip('PostgreSQL unavailable'); return; }
  const name = 'shots_atomic_' + process.pid + '_' + Date.now();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres'); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: url.href });
  try {
    // Only the storage seam's tables, in an isolated disposable database.
    await pool.query(`CREATE TABLE chat_sessions (id int PRIMARY KEY, shots_run_id text, shots_state text);
      CREATE TABLE shot_runs (id text PRIMARY KEY, session_id int, head_sha text, plan_hash text, state text);
      CREATE TABLE shot_artifacts (id text PRIMARY KEY, run_id text, story_id text, viewport text, side text, variant text, media text,
        content_type text, data bytea, width int, height int, bytes int, sha256 text, focus_rect jsonb, stage_labels jsonb, color_scheme text);`);
    const run = 'a'.repeat(32), headSha = 'b'.repeat(40), planHash = 'c'.repeat(64);
    await pool.query('INSERT INTO chat_sessions VALUES (1,$1,\'reviewing\')', [run]);
    await pool.query('INSERT INTO shot_runs VALUES ($1,1,$2,$3,\'reviewing\')', [run, headSha, planHash]);
    const pair = (shade) => ['light', 'dark'].map((colorScheme, i) => {
      const buffer = fixtures.png({ shade: shade + i });
      const target = files.shotTarget(fixtures.intent(), { change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'screen', colorScheme });
      return files.stored(target, buffer, files.inspectImage(buffer));
    });
    const original = pair(10), replacement = pair(110), fence = { headSha, planHash };
    await state.storeArtifacts(pool, run, original, fence);
    // Both incoming images are valid. Light INSERT succeeds; Dark INSERT
    // hits an actual database constraint, after the transactional DELETE.
    await pool.query("ALTER TABLE shot_artifacts ADD CONSTRAINT injected_second_write_failure CHECK (color_scheme <> 'dark') NOT VALID");
    await assert.rejects(state.storeArtifacts(pool, run, replacement, fence), { code: '23514' });
    const saved = (await pool.query('SELECT color_scheme, sha256, data FROM shot_artifacts ORDER BY color_scheme DESC')).rows;
    assert.equal(saved.length, 2);
    for (const file of original) {
      const row = saved.find(r => r.color_scheme === file.colorScheme);
      assert.equal(row.sha256, file.sha256); assert.ok(row.data.equals(file.data), 'previous file bytes remain unchanged');
    }
    await pool.query('ALTER TABLE shot_artifacts DROP CONSTRAINT injected_second_write_failure');
    await state.storeArtifacts(pool, run, replacement, fence);
    const next = (await pool.query('SELECT color_scheme, sha256 FROM shot_artifacts')).rows;
    for (const file of replacement) assert.equal(next.find(r => r.color_scheme === file.colorScheme).sha256, file.sha256);
  } finally { await pool.end(); await admin.query(`DROP DATABASE "${name}"`); await admin.end(); }
});
