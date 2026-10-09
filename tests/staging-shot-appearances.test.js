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
