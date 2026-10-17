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
  noteIssuesClosed() {}, unsuppressIssues() {}, invalidateIssuesCache() {},
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
  // An item queued before the looks (no look in its input) is a first
  // look: it has not waited for GitHub's own `Closes #N` yet, so the platform
  // does not close the requests at once (review, 2026-10-17).
  await run({ ...base, linkedIssues: [4], closeOnly: false });
  assert.equal(watch.asked[1].look, 1);
  assert.deepEqual([watch.asked[1].owner, watch.asked[1].repo, watch.asked[1].prNumber, watch.asked[1].appId, watch.asked[1].pool],
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
const seen = { bot: null, dm: null, journey: null };
stub('../src/services/homeroom-bot', { async noteRequestMerged(p, s, deps) { seen.bot = deps; return {}; } });
stub('../src/services/homeroom-bot-dm', { async noteProposalMerged(p, s, opts) { seen.dm = opts; return true; } });
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

test('a preview.teardown item an older release queued only reports: the preview machine retires the preview', async () => {
  stub('../src/services/staging', { async teardownStaging() { throw new Error('the preview is the preview machine\'s'); } });
  const { asked, handlers: h } = withRows(() => { throw new Error('nothing is read'); });
  assert.deepEqual(await call(h, WORK.teardown, { sessionId: 15 }), { handedOff: true });
  assert.equal(asked.length, 0);
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
  assert.deepEqual(out, { ids: [3, 4], found: [{ id: 3, head: 'c'.repeat(40) }, { id: 4, head: 'd'.repeat(40) }] });
});

test('the journey runs strict, so a failure is retried', async () => {
  const { handlers: h } = withRows((sql) => (/FROM apps/.test(sql) ? [{ id: 2 }] : [{ id: 5, app_id: 2 }]));
  await call(h, WORK.journey, { sessionId: 5, sha: 'a'.repeat(40), at: '2026-10-09T00:00:00.000Z' });
  assert.equal(seen.journey.strict, true);
});

test('a main.check item an older release queued only reports: its transition asks the main-check machine', async () => {
  const { asked, handlers: h } = withRows(() => []);
  assert.deepEqual(await call(h, WORK.mainCheck, { appId: 2, sessionId: 5, prNumber: 8, mergeSha: 'a'.repeat(40) }), { handedOff: true });
  assert.deepEqual(asked, [], 'it reads and runs nothing');
});

test('the bot\'s items an older release queued hand the merge and the live to its change machine, keyed by the item', async () => {
  const told = [];
  const h = mergeFollowupsServices({ config: {}, pool, botNote: async (...args) => { told.push(args); return 1; } });
  const run = (kind, input) => h[kind].run({ input, workId: `w-${kind}`, key: kind, attempt: 1, resumeFrom: null, checkpoint: async () => {} });
  await run(WORK.bot, { sessionId: 5, before: '2026-10-09T00:00:00.000Z' });
  await run(WORK.dm, { sessionId: 5, sha: 'a'.repeat(40) });
  await run(WORK.live, { sessionId: 5 });
  assert.deepEqual(told, [
    [5, 'Merged', { before: '2026-10-09T00:00:00.000Z' }, { requestKey: `shim:w-${WORK.bot}` }],
    [5, 'Live', {}, { requestKey: `shim:w-${WORK.dm}` }],
    [5, 'Live', {}, { requestKey: `shim:w-${WORK.live}` }],
  ]);
  assert.equal(seen.bot, null, 'the bot\'s own code is the change machine\'s to call now');
});

test('an app.deliver item left from before asks app-delivery for its deploy itself, keyed by the item', async () => {
  // Whichever release applies its result (an older Pod's code would not
  // ask), the deploy it stood for is asked here.
  const asked = [];
  const h = mergeFollowupsServices({ config: {}, pool, requestDeploy: async (...args) => { asked.push(args); return 1; } });
  const reuse = { imageRef: 'img', buildRef: 'b', commitSha: 'c'.repeat(40), owner: 'acme', repo: 'shop' };
  const out = await h[WORK.deliver].run({ input: { appId: 2, sessionId: 5, mergeSha: 'a'.repeat(40), prNumber: 8, reuse },
    workId: 'w-1', key: 'deliver', attempt: 1, resumeFrom: null, checkpoint: async () => {} });
  assert.deepEqual(out, { handOff: true });
  assert.deepEqual(asked, [[2, 'merge', { prNumber: 8, revision: 'a'.repeat(40), reuse, requestKey: 'handoff:w-1' }]]);
});
