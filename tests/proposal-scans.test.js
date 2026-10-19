'use strict';

// What the clocks read about proposals from outside (src/services/
// proposal-scans.js): each scan lists every target with no LIMIT, skips a
// session somebody works on or a spent GitHub budget, and hands what it
// found to the machine that decides (a merge on GitHub to merge-followups,
// through platform.mergeObserved; a head to pr-import-sync). The fixed-check
// sync logs a decline once, from the previous run's result rather than a
// process's memory.

const test = require('node:test');
const assert = require('node:assert/strict');

function fakeModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return exports;
}

const busy = new Set();
fakeModule('../src/services/active-workers', { isSessionBusy: (id) => busy.has(Number(id)) });
const budget = { allows: true };
fakeModule('../src/services/github-budget', {
  budgetAllows: () => budget.allows,
  isRateLimitError: (err) => /rate limit/.test(String(err?.message)),
});
const github = fakeModule('../src/services/github', { isEnabled: () => true, getPR: async () => ({ merged: false }) });
const synced = [];
fakeModule('../src/services/pr-import-sync', {
  syncImportedProposal: async ({ session }) => { synced.push(session.id); return 'unchanged'; },
});
const merges = [];
fakeModule('../src/workflow/platform.ts', { mergeObserved: async (m) => { merges.push(m); return 1; } });
const sweeps = [];
const fixed = fakeModule('../src/services/fixed-check-sync', {
  isEnabled: () => true,
  sweep: async () => sweeps.shift(),
  freshDeclines: require('../src/services/fixed-check-sync').freshDeclines,
  declinedWords: (why) => `words for ${why}`,
});
const logged = [];
fakeModule('../src/services/logger', {
  info: (scope, msg, data) => logged.push({ scope, msg, data }), warn: () => {}, error: () => {},
});

const scans = require('../src/services/proposal-scans');

// A pool that answers each query from a script of [pattern, rows].
function pool(script) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push({ sql, params });
      for (const [re, rows] of script) if (re.test(sql)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      return { rows: [] };
    },
  };
}

test('the targets are every open proposal of the kind, with no limit', async () => {
  const ids = Array.from({ length: 260 }, (_, i) => ({ id: i + 1 }));
  const p = pool([[/source = 'imported'/, ids], [/source IS DISTINCT FROM 'imported'/, ids], [/is_headless = FALSE/, ids]]);
  const imported = await scans.importedTargets(p);
  assert.equal(imported.items.length, 260, 'the leader looked at 50');
  assert.deepEqual(imported.items[0], { target: 'session:1', input: { sessionId: 1 } });
  assert.equal((await scans.mergedByHandTargets(p)).items.length, 260);
  assert.equal((await scans.revisionTargets(p)).items.length, 260);
  assert.ok(p.seen.every((q) => !/LIMIT/.test(q.sql)));
});

test('an imported look skips a session worked on or a spent budget, and otherwise syncs it', async () => {
  const row = { id: 7, app_id: 2, source: 'imported', status: 'promoted', pr_number: 3 };
  const p = pool([[/WHERE cs.id = \$1/, [row]]]);
  busy.add(7);
  assert.deepEqual(await scans.lookImported({}, p, 7), { skipped: 'busy' });
  busy.delete(7);
  budget.allows = false;
  assert.deepEqual(await scans.lookImported({}, p, 7), { skipped: 'budget' });
  budget.allows = true;
  assert.deepEqual(await scans.lookImported({}, p, 7), { outcome: 'unchanged' });
  assert.deepEqual(synced, [7]);
  assert.deepEqual(await scans.lookImported({}, pool([[/WHERE cs.id = \$1/, [{ ...row, status: 'archived' }]]]), 7), { skipped: 'gone' });
});

test('a native pull request merged by hand is handed to merge-followups; an open one is not', async () => {
  const row = { id: 8, app_id: 4, pr_number: 12, status: 'promoted', repo_url: 'https://github.com/acme/demo' };
  const p = pool([[/WHERE cs.id = \$1/, [row]]]);
  assert.deepEqual(await scans.lookMergedByHand(p, 8), { merged: false });
  github.getPR = async () => ({ merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: '2026-10-19T09:00:00Z' });
  assert.deepEqual(await scans.lookMergedByHand(p, 8), { merged: true });
  assert.deepEqual(merges, [{ sessionId: 8, appId: 4, mergeSha: 'c'.repeat(40), mergedAt: '2026-10-19T09:00:00Z' }]);
  github.getPR = async () => { throw new Error('API rate limit exceeded'); };
  assert.deepEqual(await scans.lookMergedByHand(p, 8), { skipped: 'budget' }, 'a refusal for the limit is a look skipped');
});

test('the fixed-check sync says a decline once, carried in the run\'s result', async () => {
  sweeps.push({ apps: 1, candidates: 2, synced: [], skipped: { 5: 'conflict', 6: 'level' } });
  const first = await scans.fixedCheckSync({}, {}, { previous: null });
  assert.deepEqual(first.declined, { 5: 'conflict', 6: 'level' });
  const said = logged.filter((l) => /not synced/.test(l.msg));
  assert.deepEqual(Object.keys(said[0].data.declined), ['5', '6']);
  logged.length = 0;
  sweeps.push({ apps: 1, candidates: 2, synced: [], skipped: { 5: 'conflict', 6: 'busy' } });
  const second = await scans.fixedCheckSync({}, {}, { previous: first });
  assert.deepEqual(Object.keys(logged.find((l) => /not synced/.test(l.msg)).data.declined), ['6'], 'only the reason that changed');
  assert.deepEqual(second.declined, { 5: 'conflict', 6: 'busy' });
  fixed.isEnabled = () => false;
  assert.deepEqual(await scans.fixedCheckSync({}, {}, {}), { off: true });
});
