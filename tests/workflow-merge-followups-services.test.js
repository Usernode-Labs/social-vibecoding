'use strict';

// The merge-followups machine's work handlers (src/workflow/merge-followups/
// services.ts): a handler that could not finish must throw, so the kernel
// retries it, rather than report success over a failure it swallowed.
// GitHub, the worker and the database are stubbed; the watcher is the real
// one but for a merge's look.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const gh = {
  closes: new Map(),   // issue number -> error status, or absent to succeed
  isEnabled: () => true,
  async closeIssue(owner, repo, n) {
    const status = gh.closes.get(n);
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
  },
};
stub('../src/services/github', gh);
// The bot's proposals for a closed request: recorded, strict or not.
const records = { fail: false, strict: [] };
stub('../src/services/homeroom-bot-closed-requests', {
  async noteRequestsClosed(pool, args) { records.strict.push(args.strict); return { withdrawn: [] }; },
});
// The watcher is the real one (an included change's closes run through it);
// a merge's look answers what the test says.
const watch = { result: { closed: [], skipped: [], stillOpen: [], waiting: false, targets: [] }, asked: [] };
const realWatcher = require('../src/services/issue-close-watcher');
stub('../src/services/issue-close-watcher', {
  ...realWatcher,
  async closeAfterMerge(args) { watch.asked.push(args); return watch.result; },
});
const realWs = require('../src/services/ws');
stub('../src/services/ws', { ...realWs, pushIssueUpdate() {} });

const { mergeFollowupsServices } = require('../src/workflow/merge-followups/services.ts');
const { WORK } = require('../src/workflow/merge-followups/machine.ts');

// A twin row's close fails while `records.fail`; the close proposals read
// for the targets are #3's (id 31).
const pool = {
  async query(sql, params) {
    if (records.fail && /UPDATE issues/.test(sql)) throw new Error('db down');
    if (/kind = 'close_issue'/.test(sql)) return { rows: params[1].includes(3) ? [{ id: 31, number: 3 }] : [] };
    return { rows: [] };
  },
};
const handlers = mergeFollowupsServices({ config: {}, pool });
const run = (input) => handlers[WORK.issues].run({ input, key: 'issues', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
const base = { sessionId: 5, appId: 2, appSlug: 'shop', prNumber: 8, owner: 'acme', repo: 'shop' };

test('an included change\'s requests: a close GitHub refused is retried, a request that is gone is not (review finding 4)', async () => {
  gh.closes = new Map([[4, 503]]);
  await assert.rejects(run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), /Could not close request #4 on GitHub/);
  gh.closes = new Map([[4, 404]]);
  const target = [{ issueId: 31, number: 3 }];
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), { closed: [3], targets: target });
  gh.closes = new Map();
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: true, carrierPrNumber: 9 }), { closed: [3, 4], targets: target });
  assert.equal(watch.asked.length, 0, 'an included change is not looked at: its own pull request never merged');
});

test('a merge\'s requests: a linked one still open after the second look is retried; one only the body names is not', async () => {
  watch.result = { closed: [3], skipped: [], stillOpen: [4], waiting: false, targets: [] };
  await assert.rejects(run({ ...base, linkedIssues: [3, 4], closeOnly: false, look: 2 }), /Linked request #4 still open on GitHub/);
  watch.result = { closed: [3], skipped: [], stillOpen: [12], waiting: false, targets: [] };
  assert.deepEqual(await run({ ...base, linkedIssues: [3, 4], closeOnly: false, look: 2 }), watch.result);
});

test('a merge\'s first look that leaves a linked request to GitHub reports it waiting, not failed', async () => {
  watch.asked = [];
  watch.result = { closed: [], skipped: [], stillOpen: [4], waiting: true, targets: [] };
  assert.deepEqual(await run({ ...base, linkedIssues: [4], closeOnly: false, look: 1 }), watch.result,
    'the machine asks for the second look (machine.ts)');
  assert.equal(watch.asked[0].look, 1);
  assert.deepEqual([watch.asked[0].owner, watch.asked[0].repo, watch.asked[0].prNumber, watch.asked[0].appId, watch.asked[0].pool],
    ['acme', 'shop', 8, 2, pool]);
});

test('recording a close is part of the work: a database failure there is retried (review finding, second pass)', async () => {
  gh.closes = new Map();
  records.fail = true;
  records.strict = [];
  await assert.rejects(run({ ...base, linkedIssues: [7], closeOnly: true, carrierPrNumber: 9 }), /db down/);
  records.fail = false;
  await run({ ...base, linkedIssues: [7], closeOnly: true, carrierPrNumber: 9 });
  assert.deepEqual(records.strict, [true], 'the bot\'s proposals are withdrawn strictly too, once the twin is closed');
});

// ── Read only durable state, and report a failure as one (steps 1-2 fix) ──

// The worker goes through the fenced, strict removal (removeCcVolume): the
// unfenced destroyCcVolume would report success over a removal the runtime
// refused.
const removal = { calls: [], refuse: null, between: null };
stub('../src/services/worker', {
  async removeCcVolume(id, { proceed, renew }) {
    removal.calls.push(id);
    await renew();
    if (removal.between) await removal.between();
    if (!(await proceed())) return { skipped: true };
    if (removal.refuse) throw new Error(removal.refuse);
    return { removed: true };
  },
  async destroyCcVolume() { throw new Error('the unfenced removal is not used'); },
  retireWorker() { throw new Error('the in-memory hold is not read'); },
});
const seen = { journey: null };
stub('../src/services/journey-events', { async recordChangeLive(p, args) { seen.journey = args; return {}; } });
// The main check is the main-check machine's: nothing here reaches main-watch.
stub('../src/services/main-watch', {});

function withRows(answer) {
  const asked = [];
  const db = { async query(sql, params) { asked.push({ sql, params }); return { rows: answer(sql, params) }; } };
  return { asked, handlers: mergeFollowupsServices({ config: {}, pool: db }) };
}
const checkpoints = [];
const call = (h, kind, input) => h[kind].run({ input, key: kind, attempt: 1, resumeFrom: null,
  checkpoint: async (c) => { checkpoints.push(c); } });

test('worker.retire waits for a shots run the shots machine has under way, then removes the worker, fenced', async () => {
  removal.calls = [];
  checkpoints.length = 0;
  let live = true;
  const { asked, handlers: h } = withRows((sql) => (/FROM wf_instances/.test(sql) && live ? [{ id: 'b'.repeat(32) }] : []));
  assert.deepEqual(await call(h, WORK.retire, { sessionId: 12 }), { waiting: 'b'.repeat(32) });
  assert.deepEqual(removal.calls, [], 'kept while the run is under way');
  assert.match(asked[0].sql, /w\.machine = 'shots'/, 'read from the shots machine\'s instance, in any process');
  assert.deepEqual(asked[0].params[0], 'session:12');
  live = false;
  const reads = asked.length;
  assert.deepEqual(await call(h, WORK.retire, { sessionId: 12 }), { retired: true });
  assert.deepEqual(removal.calls, [12]);
  assert.equal(asked.length - reads, 2, 'the shots run is read again between reading what to remove and removing it');
  assert.ok(checkpoints.length >= 2 && checkpoints.every((c) => c.removing === true), 'its claim is renewed while it removes');
});

test('worker.retire: a shots run that starts before the removal keeps the worker, and is waited for', async () => {
  removal.calls = [];
  let live = false;
  removal.between = async () => { live = true; };
  try {
    const { handlers: h } = withRows((sql) => (/FROM wf_instances/.test(sql) && live ? [{ id: 'c'.repeat(32) }] : []));
    assert.deepEqual(await call(h, WORK.retire, { sessionId: 13 }), { waiting: 'c'.repeat(32) },
      'the machine asks again later (machine.ts RETIRE_RECHECK_MS)');
  } finally { removal.between = null; }
});

test('worker.retire: a removal the runtime refuses fails the work, to be retried, never reported retired', async () => {
  removal.refuse = 'worker_removal_failed';
  try {
    const { handlers: h } = withRows(() => []);
    await assert.rejects(call(h, WORK.retire, { sessionId: 14 }), /worker_removal_failed/);
    assert.equal(h[WORK.retire].maxAttempts > 1, true, 'and it is retried');
  } finally { removal.refuse = null; }
});

test('included.find names each carried change with the head that matched', async () => {
  const candidates = [
    { id: 3, source: 'native', reviewed_head_sha: 'c'.repeat(40), imported_pr_head_sha: null },
    { id: 4, source: 'imported', reviewed_head_sha: null, imported_pr_head_sha: 'D'.repeat(40) },
    { id: 5, source: 'native', reviewed_head_sha: 'e'.repeat(40), imported_pr_head_sha: null },
  ];
  gh.listPullRequestCommitShas = async () => ({ shas: ['c'.repeat(40), 'd'.repeat(40)] });
  // Who works on a change is the preview machine's record, which the
  // Included guard reads under the change's lock (machine.ts notIncludable):
  // the search names every change whose head matched.
  const { handlers: h } = withRows(() => candidates);
  const out = await call(h, WORK.find, { sessionId: 1, appId: 2, prNumber: 8, owner: 'acme', repo: 'shop' });
  assert.deepEqual(out, { found: [{ id: 3, head: 'c'.repeat(40) }, { id: 4, head: 'd'.repeat(40) }] });
});

test('carried.find names the later merge whose pull request lists the commit and whose merge the build contains', async (t) => {
  const day = Date.now() - 24 * 60 * 60 * 1000;
  const row = (id, pr, sha, { carrier = { id, pr, title: `PR ${pr}` }, at = day + id * 60 * 1000 } = {}) => ({ id, pr_number: pr,
    merge_commit_sha: sha, merged_at: new Date(at), carrier_id: carrier.id, carrier_pr_number: carrier.pr, carrier_pr_title: carrier.title });
  let candidates = [row(6, 9, 'd'.repeat(40)), row(7, 10, 'e'.repeat(40)), row(8, 11, 'F'.repeat(40), { carrier: { id: 12, pr: 14, title: 'Main' } })];
  const lists = new Map([[9, { shas: ['c'.repeat(40)], complete: true }]]);
  gh.listPullRequestCommitShas = async (_o, _r, n) => {
    const l = lists.get(n);
    if (l instanceof Error) throw l;
    return l || { shas: ['B'.repeat(40)], complete: true };
  };
  const compared = [];
  gh.compareCommitAncestry = async (_o, _r, base) => { compared.push(base); return { status: base === 'f'.repeat(40) ? 'ahead' : 'diverged' }; };
  t.after(() => { delete gh.compareCommitAncestry; });
  const { asked, handlers: h } = withRows(() => candidates);
  const input = { sessionId: 5, appId: 2, owner: 'acme', repo: 'shop', mergeSha: 'b'.repeat(40),
    mergedAt: new Date(day).toISOString(), release: '1'.repeat(40), after: null };
  const at = (r) => r.merged_at.toISOString();
  // #8 lists it and is in the build; it went to main inside #12 (carried
  // or included there), which is the carrier.
  assert.deepEqual((await call(h, WORK.carrier, input)).carrier, { sessionId: 12, prNumber: 14, prTitle: 'Main', mergeSha: 'f'.repeat(40) });
  assert.deepEqual(asked[0].params, [2, 5, input.mergedAt, 0, []]);
  assert.deepEqual(compared, ['e'.repeat(40), 'f'.repeat(40)], 'only a pull request that lists the commit is compared');
  // None in this build: #6 is ruled out for good; #7 and #8 list it, so
  // they are read again, and the next look goes on past #8.
  gh.compareCommitAncestry = async () => ({ status: 'diverged' });
  const none = await call(h, WORK.carrier, input);
  assert.deepEqual(none, { carrier: null, scanned: { mergedAt: at(candidates[2]), id: 8, recheck: [7, 8] } });
  await call(h, WORK.carrier, { ...input, after: none.scanned });
  assert.deepEqual(asked.at(-1).params, [2, 5, at(candidates[2]), 8, [7, 8]]);
  // A list cut short, or one GitHub would not show (a 404 is also what a
  // token without access gets), rules nothing out either; a merge commit
  // GitHub no longer has is not the carrier.
  lists.set(9, { shas: [], complete: false });
  lists.set(10, Object.assign(new Error('HTTP 404'), { status: 404 }));
  gh.compareCommitAncestry = async () => { throw Object.assign(new Error('HTTP 404'), { status: 404 }); };
  assert.deepEqual((await call(h, WORK.carrier, input)).scanned.recheck, [6, 7, 8]);
  // What it read again and now rules out is dropped; the cursor stays.
  lists.set(9, { shas: ['c'.repeat(40)], complete: true });
  assert.deepEqual((await call(h, WORK.carrier, { ...input, after: { mergedAt: at(candidates[2]), id: 8, recheck: [6] } })).scanned,
    { mergedAt: at(candidates[2]), id: 8, recheck: [7, 8] });
  // It reads a merge of the last hour, but leaves it for a later look: a
  // merge recorded late could still come before it.
  lists.delete(10);
  candidates = [row(6, 9, 'd'.repeat(40)), row(20, 21, 'a'.repeat(40), { at: Date.now() - 5 * 60 * 1000 })];
  assert.deepEqual((await call(h, WORK.carrier, input)).scanned, { mergedAt: at(candidates[0]), id: 6, recheck: [] });
  // A pull request GitHub no longer has is passed by; any other failure is retried.
  candidates = [row(7, 10, 'e'.repeat(40)), row(8, 11, 'F'.repeat(40))];
  lists.set(10, Object.assign(new Error('HTTP 404'), { status: 404 }));
  gh.compareCommitAncestry = async () => ({ status: 'ahead' });
  assert.equal((await call(h, WORK.carrier, input)).carrier.sessionId, 8);
  gh.compareCommitAncestry = async () => { throw Object.assign(new Error('HTTP 502'), { status: 502 }); };
  await assert.rejects(call(h, WORK.carrier, input), /HTTP 502/);
});

test('the journey runs strict, so a failure is retried', async () => {
  const { handlers: h } = withRows((sql) => (/FROM apps/.test(sql) ? [{ id: 2 }] : [{ id: 5, app_id: 2 }]));
  await call(h, WORK.journey, { sessionId: 5, sha: 'a'.repeat(40), at: '2026-10-09T00:00:00.000Z' });
  assert.equal(seen.journey.strict, true);
});

test('every work kind has its handler, and none is left for the kinds older releases queued', () => {
  // A retry queues only a kind with a handler (machine.ts RETRYABLE, read
  // off WORK): the two lists are one.
  assert.deepEqual(Object.keys(handlers).sort(), Object.values(WORK).sort());
  for (const old of ['app.deliver', 'bot.requestMerged', 'bot.dmMerged', 'bot.announceLive', 'main.check', 'preview.teardown']) {
    assert.equal(handlers[old], undefined, `${old} has no handler`);
  }
});
