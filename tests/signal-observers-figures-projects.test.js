'use strict';

// Two wave 2 observers of the platform signals (services/signal-observers/):
// a topic figure off its target, and one project whose deploy keeps
// failing, which files on that project's own board, held for its people.

const test = require('node:test');
const assert = require('node:assert/strict');

const offTarget = require('../src/services/signal-observers/figures-off-target');
const projectDown = require('../src/services/signal-observers/project-down');
const signals = require('../src/services/platform-signals');

test('a figure off its target is a problem; one on target, or a split one with no side off, is not', async () => {
  assert.equal(offTarget.isOff({ state: 'warn' }), true);
  assert.equal(offTarget.isOff({ state: 'ok' }), false);
  assert.equal(offTarget.isOff({ state: 'calm', sides: [{ state: 'ok' }, { state: 'warn' }] }), true);
  assert.equal(offTarget.isOff(null), false);

  const pool = { query: async () => ({ rows: [
    { category_key: 'infra', label: 'Infra', topic_figures: ['infra.apps-up', 'infra.restarts'] },
    { category_key: 'project-workflows', label: 'Project workflows', topic_figures: [] },
  ] }) };
  const figures = {
    knownFigureIds: (ids) => (Array.isArray(ids) ? ids : []),
    figuresFor: async (_pool, ids) => ({ figures: ids.map((id) => (id === 'infra.apps-up'
      ? { id, label: 'App opens that worked', state: 'warn', value: '95%', sub: '95 of 100 opens · below 99% target', tip: 'The share…' }
      : { id, label: 'Apps restarted', state: 'calm', value: '4 times', sub: '' })) }),
  };
  const items = await offTarget.run(pool, { figures });
  assert.deepEqual(items.map((i) => [i.key, i.topic, i.title]), [
    ['infra/infra.apps-up', 'infra', 'Off target: App opens that worked (Infra)'],
  ]);
  const it = signals.normalizeItem(items[0]);
  assert.deepEqual([it.fixer, it.fileAfterMs], ['person', signals.KINDS.figure_off_target.fileAfterMs], 'a person\'s, after a day');
  assert.match(it.evidence.lines[0], /^Now: 95% \(95 of 100 opens/);
});

test('a project still carrying a failed deploy files on its own board, after a day, held for a person', async () => {
  const pool = { query: async (sql) => {
    assert.match(sql, /self_hosted IS NOT TRUE/, 'never Homeroom itself');
    return { rows: [{ id: 312, slug: 'goalio-4c1f2a', last_failure: {
      stage: 'deploy', sha: 'abcdef1234567', at: '2026-10-15T09:00:00Z',
      reason: 'container refused: runs as root, contact admin@example.com', log: 'x'.repeat(9000),
    } }] };
  } };
  const [item] = await projectDown.run(pool);
  assert.deepEqual([item.kind, item.key, item.appId], ['project_down', 'goalio-4c1f2a', 312]);
  assert.equal(item.fileAfterMs, 24 * 60 * 60 * 1000);
  const it = signals.normalizeItem(item);
  assert.equal(it.fixer, 'person', 'held from the bot until somebody in the project asks');
  assert.equal(it.appId, 312, 'on the project\'s board');
  assert.match(it.evidence.lines[0], /failed at the deploy step on abcdef1/);
  assert.match(it.evidence.excerpts[0].text, /runs as root, contact \[email\]/, 'its reason, scrubbed');
  assert.equal(item.evidencePrivate.log.length, 4000);
});

test('a project_down request tells nobody but the project (no admin push)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/platform-signals'), 'utf8');
  assert.match(src, /if \(row\.app_self_hosted !== true\) return;/);
});
