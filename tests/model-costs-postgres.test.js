'use strict';

// The typical change measured from agent_turns, against the FULL PostgreSQL
// schema (tests/model-costs.test.js covers the rest with a stubbed pool).
//
// input_tokens is every prompt token of a turn, cache reads and cache writes
// included, on every path that records one (Codex reports the total; a
// Claude Code turn's three counts are added up to it in agent-turn.js
// usageTotalFromResult). The measured profile once added cached_input_tokens
// and cache_write_input_tokens on top of it, which counted almost every token
// twice. This pins the profile against real rows: input counted once, the
// cached parts measured as each change's share of its own input, a change
// with no input left out of the shares rather than read as uncached.
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const modelCosts = require('../src/services/model-costs');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the measured typical change counts input once, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `model_costs_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/o/todo') RETURNING id",
  );
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('costs_member', 'x') RETURNING id",
  );
  const change = async (turns) => {
    const { rows: [s] } = await pool.query(
      'INSERT INTO chat_sessions (app_id, user_id) VALUES ($1, $2) RETURNING id', [app.id, user.id],
    );
    for (const [input, cached, written, output] of turns) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO agent_turns (id, session_id, user_id, backend, status, input_tokens,
                                  cached_input_tokens, cache_write_input_tokens, output_tokens)
         VALUES ($1, $2, $3, 'codex_openrouter', 'completed', $4, $5, $6, $7)`,
        [crypto.randomUUID(), s.id, user.id, input, cached, written, output],
      );
    }
  };

  // Too few changes for a median: the documented constant, and it says so.
  await change([[1_000_000, 950_000, 30_000, 10_000], [500_000, 480_000, 0, 5_000]]);
  const thin = await modelCosts.typicalChange(pool, { days: 30 });
  assert.equal(thin.source, 'documented_constant');
  assert.equal(thin.changes, 1);

  // Twenty changes alike: two turns, 1.5M input of which 1.43M were cache
  // reads and 30k cache writes, and 15k output. One very long change, and
  // one that only ever answered (no input at all).
  for (let i = 1; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await change([[1_000_000, 950_000, 30_000, 10_000], [500_000, 480_000, 0, 5_000]]);
  }
  await change([[100_000_000, 99_000_000, 0, 1_000_000]]);
  await change([[0, 0, 0, 100]]);

  const profile = await modelCosts.typicalChange(pool, { days: 30 });
  assert.deepEqual(profile, {
    // 1.5M, not the 2.96M that adding the cached counts to it read.
    inputTokens: 1_500_000,
    cachedInputTokens: 1_430_000,
    cacheWriteInputTokens: 30_000,
    outputTokens: 15_000,
    source: 'recorded_usage',
    changes: 22,
  });

  // The same rows through the payloads: the profile the picker and the
  // console state, and an estimate priced from it.
  const picker = await modelCosts.pickerPayload(pool);
  assert.deepEqual(picker.typicalChange, {
    inputTokens: 1_500_000, cachedInputTokens: 1_430_000, cacheWriteInputTokens: 30_000,
    outputTokens: 15_000, source: 'recorded_usage',
  });
  assert.equal(picker.models['z-ai/glm-5.3-flash'].estimateCents,
    modelCosts.estimateCents(modelCosts.publishedPricing('z-ai/glm-5.3-flash'), profile));
  const console_ = await modelCosts.adminPayload(pool, { days: 30 });
  assert.equal(console_.typicalChange.cachedInputTokens, 1_430_000);
  assert.equal(console_.typicalChange.changes, 22);
});
