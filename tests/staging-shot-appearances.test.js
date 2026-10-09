'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const seed = require('../src/services/staging-shot-appearances');
const files = require('../src/services/shots-files');
const contract = require('../src/services/visible-changes');
const AppView = require('../public/js/app-view');
const view = require('../src/services/shots-view');
const state = require('../src/services/shots-state');

test('photo appearance sample never writes outside staging', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production';
  try {
    await seed.seed({ query: () => { throw new Error('Production must not be queried'); } }, { selfAppSlug: 'demo' });
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }
});

test('sample images traverse the real shots contracts and reviewer model with both sizes and modes', async () => {
  const { intent, summary } = await seed.fixture('demo');
  assert.doesNotThrow(() => contract.parseIntent(intent));
  assert.equal(summary.readyCount, 1);
  assert.equal(summary.files.length, 8);
  assert.equal(summary.verdict.screens.length, 4);
  for (const file of summary.files) assert.deepEqual(files.inspectImage(file.data).sha256, file.sha256);
  const artifacts = summary.files.map((file, i) => ({ ...file, id: String(i + 1).repeat(32) }));
  const run = state.runSummary({ state: 'verified', base_sha: seed.BASE, head_sha: seed.HEAD,
    intent, hard_verdict: summary.verdict, plan_hash: summary.manifestHash }, artifacts);
  const shots = view.serialize(run, { id: seed.SESSION_ID, reviewed_head_sha: seed.HEAD, shots_detail: { impact: 'ui' } }, 'demo', seed.HEAD);
  const html = AppView.shotsHtml(shots, { sessionId: seed.SESSION_ID, thread: true });
  assert.equal((html.match(/<figure class="shots-view"/g) || []).length, 2);
  assert.match(html, /shots-photo-dark/);
  assert.match(html, /shots-photo-light/);
  assert.match(html, /shots-appearance-auto[^>]*checked/);
  const migrated = fs.readFileSync(require.resolve('../src/db/migrate'), 'utf8');
  assert.match(migrated, /require\('\.\.\/services\/staging-shot-appearances'\)\.seed\(pool, config\)/);
});


test('existing five- and six-column shot slots upgrade without losing legacy captures', async (t) => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres', connectionTimeoutMillis: 1000 });
  try { await client.connect(); } catch (err) {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this upgrade check');
  }
  try {
    const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    const migration = schema.slice(schema.indexOf('-- Photo appearance is independent'),
      schema.indexOf('CREATE INDEX IF NOT EXISTS idx_shot_artifacts_run'));
    for (const oldColumns of ['run_id, story_id, viewport, side, variant', 'run_id, story_id, viewport, side, variant, media']) {
      await client.query(`CREATE TEMP TABLE shot_artifacts (id TEXT PRIMARY KEY, run_id TEXT, story_id TEXT,
        viewport TEXT, side TEXT, variant TEXT, media TEXT, UNIQUE (${oldColumns}), UNIQUE (id, media))`);
      await client.query("INSERT INTO shot_artifacts VALUES ('legacy', 'run', 'claim', 'phone', 'base', 'context', 'png')");
      await client.query(migration);
      await client.query(migration);
      const remaining = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='shot_artifacts'::regclass AND contype IN ('p','u')")).rows.map((r) => r.definition).sort();
      assert.deepEqual(remaining, ['PRIMARY KEY (id)', 'UNIQUE (id, media)'], 'only legacy slot constraints are removed');
      assert.equal((await client.query("SELECT color_scheme FROM shot_artifacts WHERE id='legacy'")).rows[0].color_scheme, 'light');
      await client.query("INSERT INTO shot_artifacts VALUES ('dark', 'run', 'claim', 'phone', 'base', 'context', 'png', 'dark')");
      assert.equal((await client.query('SELECT count(*)::int AS n FROM shot_artifacts')).rows[0].n, 2);
      await assert.rejects(client.query("INSERT INTO shot_artifacts VALUES ('duplicate', 'run', 'claim', 'phone', 'base', 'context', 'png', 'light')"), { code: '23505' });
      await client.query('DROP TABLE shot_artifacts');
    }
  } finally { await client.end(); }
});
