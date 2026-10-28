'use strict';

// What the clocks read about proposals from outside (src/services/
// proposal-scans.js): each scan lists every target with no LIMIT, skips a
// session somebody works on or a spent GitHub budget, and hands what it
// found to the machine that decides (a merge on GitHub to the proposal
// machine, through platform.prLooked; a head to pr-import-sync). The fixed-check
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
fakeModule('../src/services/active-workers', {
  isSessionBusyAnywhere: async (id) => busy.has(Number(id)),
  busySessionsAnywhere: async (ids) => new Set(ids.map(Number).filter((id) => busy.has(id))),
});
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
fakeModule('../src/workflow/platform.ts', { prLooked: async (m) => { merges.push(m); return true; } });
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

test('the targets are paged, so a list longer than a run takes is gone through and starts over', async () => {
  // 260 proposals, a run takes 200: the second run takes the 60 after them,
  // the third starts again from the first.
  const ids = Array.from({ length: 260 }, (_, i) => i + 1);
  const p = pool([[/FROM chat_sessions\s+WHERE/, (params) => ids.filter((id) => id > params[0]).slice(0, params[1]).map((id) => ({ id }))]]);
  for (const scan of [scans.importedTargets, scans.mergedByHandTargets, scans.revisionTargets]) {
    const one = await scan(p, { after: null, limit: 200 });
    assert.deepEqual([one.items.length, one.after, one.items[0]], [200, 200, { target: 'session:1', input: { sessionId: 1 } }]);
    const two = await scan(p, { after: one.after, limit: 200 });
    assert.deepEqual([two.items.length, two.after, two.items[0].input.sessionId], [60, null, 201]);
    const three = await scan(p, { after: two.after, limit: 200 });
    assert.equal(three.items[0].input.sessionId, 1);
  }
  assert.ok(p.seen.every((q) => /id > \$1 ORDER BY id LIMIT \$2/.test(q.sql)));
  assert.ok(!/\$\{where\}/.test(require('node:fs').readFileSync(require.resolve('../src/services/proposal-scans.js'), 'utf8')),
    'every query a complete literal, so the SQL check validates it');
});

test('a clock that lists proposals hands its last page on to its next run', () => {
  const clocks = require('node:fs').readFileSync(require.resolve('../src/workflow/clock/services.ts'), 'utf8');
  assert.match(clocks, /const page = \(ctx: WorkContext\) => \(\{ after: \(ctx\.input\.previous as any\)\?\.after \?\? null, limit: MAX_ITEMS \}\);/);
  for (const call of ['importedTargets(pool, githubPage(ctx, importedEveryMs()))', 'mergedByHandTargets(pool, githubPage(ctx, 6 * HOUR))',
    'revisionTargets(pool, githubPage(ctx, HOUR))', 'leftovers(config, page(ctx))']) {
    assert.ok(clocks.includes(call), call);
  }
});

test('the imported-PR clock reads at most its share of GitHub reads an hour, paging through the rest', async () => {
  // Every imported PR is a GitHub read: at 600 an hour and a run every three
  // minutes, a run hands back 30, and the runs after it the rest.
  const { JOBS, GITHUB_READS_PER_HOUR } = require('../src/workflow/clock/services.ts');
  assert.equal(GITHUB_READS_PER_HOUR, 600);
  const job = JOBS.find((j) => j.name === 'imported-prs');
  const ids = Array.from({ length: 500 }, (_, i) => i + 1);
  const p = { query: async (_sql, [after, limit]) => ({ rows: ids.filter((id) => id > after).slice(0, limit).map((id) => ({ id })) }) };
  const seen = new Set();
  let previous = null;
  for (let run = 0; run < 17; run++) {
    const out = await job.run({ input: { previous }, signal: new AbortController().signal }, { pool: p, config: {} });
    assert.ok(out.items.length <= 30, `run ${run}: ${out.items.length} reads`);
    for (const item of out.items) seen.add(item.input.sessionId);
    previous = out;
  }
  assert.equal(seen.size, 500, 'every PR within the hour\'s runs');
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

test('a native pull request merged by hand is reported to the proposal machine, from the status read; an open one is not', async () => {
  const row = { id: 8, app_id: 4, pr_number: 12, status: 'promoted', repo_url: 'https://github.com/acme/demo' };
  const p = pool([[/WHERE cs.id = \$1/, [row]]]);
  assert.deepEqual(await scans.lookMergedByHand(p, 8), { merged: false });
  github.getPR = async () => ({ merged: true, merge_commit_sha: 'c'.repeat(40), merged_at: '2026-10-19T09:00:00Z' });
  assert.deepEqual(await scans.lookMergedByHand(p, 8), { merged: true });
  // `base`: where it merged (src/workflow/rules/pr-base.ts); this answer
  // names none, which the machine reads as main.
  assert.deepEqual(merges, [{ sessionId: 8, appId: 4, from: 'promoted', merged: true, closed: false,
    mergeSha: 'c'.repeat(40), mergedAt: '2026-10-19T09:00:00Z', closedAt: null, base: null }]);
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
