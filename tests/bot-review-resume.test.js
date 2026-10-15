'use strict';

// R5: a first version's review survives a platform restart
// (src/services/bot-review.js runReviewLoop's `resumeFrom`). Releases restart
// the platform many times a day; in run four (12 Oct 2026, Club Votes) one
// came two minutes into a review, while its fix turn was running, and
// recovery rolled the six fixes back and proposed the build as it stood,
// whose checks then failed on the very bug the review had fixed.
//
// Each step of the loop saves the state before it starts and after it ends,
// stamped with the process that ran it (a build keeps it on its durable
// steps, docs/plans/bot-build-workflow.md); carried on from that state, the
// loop takes the step that was cut and goes on as it would have:
//   - a capture under way is harvested (its id goes to capture() as
//     `prior`), or taken again;
//   - a reviewer call under way is asked again for the same round, its cost
//     recorded once;
//   - a fix turn under way is asked for again (a build's fix is a durable
//     turn, services/durable-turn.js, which follows the turn the restart
//     caught rather than run it twice), or recorded from `recoveredFix`
//     when one is handed in;
//   - the time the restart cost is given back on the budget, and the
//     resumes are counted;
//   - once the build is no longer this process's (the durable context's
//     `fence` throws), no further step is taken: the stop is thrown to the
//     build's handler, and the next owner carries the review on.
// Then the detached capture itself (bench/capture.js runDetached, worker.js
// startDetachedCapture and its status script), with the worker handed in.
//
// Run with: node --test tests/bot-review-resume.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const review = require('../src/services/bot-review');
const captureMod = require('../src/services/bench/capture');
const durableSteps = require('../src/services/durable-steps');
const worker = require('../src/services/worker');

const OPUS = 'anthropic/claude-opus-5.5';
const MIN = 60_000;

function shot(id, artifactId) {
  const [viewport, look, state] = id.split('-');
  return { id, viewport, look, state, sha256: `${artifactId}`.padEnd(64, '0').slice(0, 64), artifactId };
}

function captureOf(n, { booted = true } = {}) {
  return {
    booted,
    error: booted ? null : 'npm run build failed',
    steps: { boot: { command: 'node server.js', log: 'Error: Cannot find module x' } },
    shots: booted ? [
      shot('phone-light-populated', `a${n}1`), shot('phone-dark-populated', `a${n}2`),
      { ...shot('phone-light-result', `a${n}3`), action: { label: 'Post', rule: 'form-submit' } },
    ] : [],
    checks: { consoleErrors: { count: 2, samples: ['TypeError: x is undefined'] } },
    tells: { emojiIcons: { count: 1 } },
    ms: 1000,
  };
}

const issue = (id, severity = 'major') => ({ id, severity, screen: 'phone, empty', problem: `${id} is wrong`, fix: `make ${id} right` });

/**
 * The loop with everything handed in, as tests/bot-review.test.js has it,
 * carried on from `prior` with the clock at `now`.
 */
function harness({ prior = null, recoveredFix = null, verdicts = [], fixes = [], captures = {}, now = 10_000_000, clockStep = 0 } = {}) {
  let clock = now;
  const calls = { capture: [], review: [], fix: [], states: [], rollback: [] };
  const opts = {
    reviewer: { model: OPUS, maxRounds: 3, budgetMinutes: 25 },
    start: { sha: 'sha0', commits: 1, costUsd: 0.7, buildText: 'built it' },
    now: () => clock,
    resumeFrom: prior,
    recoveredFix,
    leader: 'this-process',
    capture: async (index, { prior: pending = null, onStarted = null } = {}) => {
      calls.capture.push({ index, prior: pending });
      if (!pending && onStarted) await onStarted({ id: `c${index}`.padEnd(16, '0'), startedAt: new Date(clock).toISOString() });
      clock += clockStep;
      const c = captures[index];
      if (c === 'fail') return { ok: false, error: 'worker gone', ms: 5 };
      if (c === 'down') return { ok: true, capture: captureOf(index, { booted: false }), ms: 2000 };
      return { ok: true, capture: captureOf(index), ms: 2000 };
    },
    review: async ({ round, capture, previousIssues }) => {
      calls.review.push({ round, capture, previous: previousIssues ? previousIssues.map((i) => i.id) : null });
      clock += clockStep;
      const v = verdicts.shift();
      if (v === 'ship' || v === undefined) return { ok: true, verdict: 'ship', issues: [], previousFixed: [], costUsd: 0.3, ms: 3000, by: 'model' };
      return { ok: true, verdict: 'fix', issues: [issue(`r${round}`)], previousFixed: [], costUsd: 0.3, ms: 3000, by: 'model' };
    },
    fix: async ({ round, issues }) => {
      calls.fix.push({ round, ids: issues.map((i) => i.id) });
      clock += clockStep;
      const f = fixes.shift();
      if (f === 'fail') return { ok: false, error: 'the fix turn failed (agent exited 1)', costUsd: 0.05, ms: 100 };
      return { ok: true, sha: `fix${round}`, commits: 1 + round, costUsd: 0.13, ms: 60_000 };
    },
    rollback: async (args) => { calls.rollback.push(args); },
    onState: async (s) => { calls.states.push(s); },
  };
  return { opts, calls, advance: (ms) => { clock += ms; }, now: () => clock };
}

/** A review state as the loop saved it, `minutesAgo` before the resume, with the round-0 capture taken. */
function savedState({ startedMinutesAgo = 10, savedMinutesAgo = 2, now = 10_000_000, ...rest } = {}) {
  const r0 = captureOf(0);
  return {
    state: 'reviewing',
    reviewer: { model: OPUS, maxRounds: 3, budgetMinutes: 25 },
    startedAt: new Date(now - startedMinutesAgo * MIN).toISOString(),
    updatedAt: new Date(now - savedMinutesAgo * MIN).toISOString(),
    leader: 'a-process-that-is-gone',
    round0: { sha: 'sha0', commits: 1, capture: review.slimCapture(r0), captureMs: 2000, captureError: null, costUsd: 0.7, activeMs: 1000 },
    latest: { index: 0, sha: 'sha0', capture: review.reviewForm(r0) },
    lastBooted: { sha: 'sha0', commits: 1 },
    lastBootedCapture: review.slimCapture(r0),
    rounds: [],
    stop: null,
    stopDetail: null,
    finalSha: 'sha0',
    finalCommits: 1,
    finalCapture: null,
    costUsd: 0,
    buildText: 'built it',
    ...rest,
  };
}

test('a reviewer call a restart cut short is asked again for the same round, and its cost is recorded once', async () => {
  const prior = savedState({
    rounds: [{
      round: 1, sha: 'sha0', captureIndex: 0, artifactIds: ['a01', 'a02', 'a03'], booted: true,
      verdict: null, issues: [], previousFixed: [], reviewedBy: null, reviewerCostUsd: null, reviewerMs: null, fix: null,
    }],
    inFlight: { step: 'review', round: 1, at: new Date(10_000_000 - 2 * MIN).toISOString() },
  });
  const h = harness({ prior, verdicts: ['ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'ship');
  assert.deepEqual(h.calls.review.map((r) => r.round), [1], 'round 1 again, not round 2');
  assert.equal(out.rounds.length, 1, 'the same round, not a second entry');
  assert.equal(out.rounds[0].reissued, 1);
  assert.equal(out.rounds[0].reviewerCostUsd, 0.3);
  assert.equal(out.costUsd, 0.3, 'its cost is the call that answered, once');
  assert.deepEqual(h.calls.capture, [], 'the round-0 capture it saved is not taken again');
  // The reviewer sees what the first call would have: the screenshots by
  // their artifacts, the tapped control's caption and the signals.
  const seen = h.calls.review[0].capture;
  assert.deepEqual(seen.shots.map((s) => s.artifactId), ['a01', 'a02', 'a03']);
  assert.deepEqual(seen.shots[2].action, { label: 'Post', rule: 'form-submit' });
  assert.equal(seen.signals.automaticChecks.consoleErrors.count, 2);
  assert.equal(out.finalCapture, seen, 'the capture it carried is the final one: nothing moved');
  assert.equal(out.resumes, 1);
  assert.equal(out.state, 'done');
  assert.equal(out.inFlight, null);
});

test('the run-four restart: a fix turn recovery followed to its end is recorded on its round and captured, never rolled back unseen', async () => {
  const prior = savedState({
    rounds: [{
      round: 1, sha: 'sha0', captureIndex: 0, artifactIds: ['a01'], booted: true,
      verdict: 'fix', issues: [issue('post-sheet', 'blocker')], previousFixed: [], reviewedBy: 'model', reviewerCostUsd: 0.4, reviewerMs: 15_000, fix: null,
    }],
    inFlight: { step: 'fix', round: 1, at: new Date(10_000_000 - 12 * MIN).toISOString() },
    costUsd: 0.4,
  });
  const recoveredFix = review.recoveredFixOf({
    result: { pushOk: true, ahead: 2, sha: '394d7494', lastResultText: 'Fixed all six.' }, costUsd: 0.21, ms: 744_000,
  });
  const h = harness({ prior, recoveredFix, verdicts: ['ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(h.calls.fix.length, 0, 'the fix turn is not run again');
  assert.deepEqual(out.rounds[0].fix, { ok: true, sha: '394d7494', commits: 2, costUsd: 0.21, ms: 744_000, recovered: true });
  assert.deepEqual(h.calls.capture.map((c) => c.index), [1], 'the fix is looked at');
  assert.deepEqual(h.calls.review.map((r) => [r.round, r.previous]), [[2, ['post-sheet']]], 'and reviewed, with the issues it fixed');
  assert.equal(out.stop, 'ship');
  assert.equal(out.finalSha, '394d7494', 'proposed with the fix');
  assert.deepEqual(out.lastBooted, { sha: '394d7494', commits: 2 });
  assert.deepEqual(h.calls.rollback, []);
  assert.ok(Math.abs(out.costUsd - (0.4 + 0.21 + 0.3)) < 1e-9, 'the round-1 call, the fix, the round-2 call');
});

test('a fix turn that was lost with the restart is run again; one that failed or ran out of time stops as it would have', async () => {
  const awaiting = () => savedState({
    rounds: [{ round: 1, sha: 'sha0', captureIndex: 0, artifactIds: [], booted: true, verdict: 'fix', issues: [issue('a')], reviewerCostUsd: 0.4, fix: null }],
    inFlight: { step: 'fix', round: 1, at: new Date(10_000_000 - 3 * MIN).toISOString() },
  });
  const lost = harness({ prior: awaiting(), verdicts: ['ship'] });
  const l = await review.runReviewLoop(lost.opts);
  assert.deepEqual(lost.calls.fix, [{ round: 1, ids: ['a'] }], 'run again, on the same issues');
  assert.equal(l.rounds[0].fix.recovered, undefined);
  assert.equal(l.finalSha, 'fix1');
  assert.equal(l.stop, 'ship');

  const failed = harness({ prior: awaiting(), recoveredFix: review.recoveredFixOf({ result: { agentHarness: 'claude', ccExit: 1, lastResultText: 'It stopped.' } }) });
  const f = await review.runReviewLoop(failed.opts);
  assert.equal(failed.calls.fix.length, 0);
  assert.equal(f.rounds[0].fix.ok, false);
  assert.equal(f.stop, 'fix_failed');
  assert.equal(f.finalSha, 'sha0');

  const late = harness({ prior: awaiting(), recoveredFix: review.recoveredFixOf({ result: {}, timedOut: true }) });
  const t = await review.runReviewLoop(late.opts);
  assert.equal(t.stop, 'time_budget');
  assert.equal(t.rounds[0].fix.stopped, true);
  // A recovered result is never applied to a round that is not waiting on its fix.
  const notWaiting = harness({ prior: savedState(), recoveredFix: { ok: true, sha: 'stale', commits: 9 }, verdicts: ['ship'] });
  const n = await review.runReviewLoop(notWaiting.opts);
  assert.equal(n.finalSha, 'sha0');
  assert.ok(!JSON.stringify(n.rounds).includes('stale'));
});

test('a capture a restart left running is harvested by its id; a fix landed but not yet captured is captured', async () => {
  const prior = savedState({
    rounds: [{
      round: 1, sha: 'sha0', captureIndex: 0, artifactIds: ['a01'], booted: true, verdict: 'fix', issues: [issue('a')],
      reviewerCostUsd: 0.3, fix: { ok: true, sha: 'fix1', commits: 2, costUsd: 0.1, ms: 1000 },
    }],
    finalSha: 'fix1', finalCommits: 2,
    inFlight: { step: 'capture', index: 1, at: '2026-10-12T22:27:00.000Z', id: 'feedfacecafebeef', startedAt: '2026-10-12T22:27:00.000Z' },
  });
  const h = harness({ prior, verdicts: ['ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.deepEqual(h.calls.capture, [{ index: 1, prior: { id: 'feedfacecafebeef', startedAt: '2026-10-12T22:27:00.000Z' } }], 'harvested, not started again');
  assert.deepEqual(h.calls.review.map((r) => r.round), [2]);
  assert.equal(out.stop, 'ship');
  assert.equal(out.finalSha, 'fix1');
  // With no capture under way, the fix's capture is simply taken.
  const fresh = harness({ prior: { ...prior, inFlight: null }, verdicts: ['ship'] });
  await review.runReviewLoop(fresh.opts);
  assert.deepEqual(fresh.calls.capture.map((c) => [c.index, c.prior]), [[1, null]]);
  // The round-0 capture, likewise, when the restart came before it was saved.
  const r0 = harness({
    prior: savedState({ round0: null, latest: null, lastBooted: null, lastBootedCapture: null, inFlight: { step: 'capture', index: 0, id: 'abcdefabcdef0123', startedAt: '2026-10-12T22:25:30.000Z' } }),
    verdicts: ['ship'],
  });
  const o0 = await review.runReviewLoop(r0.opts);
  assert.deepEqual(r0.calls.capture.map((c) => [c.index, c.prior?.id || null]), [[0, 'abcdefabcdef0123']]);
  assert.equal(o0.round0.sha, 'sha0');
  assert.equal(o0.round0.capture.booted, true);
  assert.equal(o0.stop, 'ship');
});

test('every step is saved before it starts, with this process\'s stamp, so a restart finds where it was', async () => {
  const h = harness({ verdicts: ['fix', 'ship'] });
  h.opts.resumeFrom = null;
  await review.runReviewLoop(h.opts);
  const steps = h.calls.states.map((s) => (s.inFlight ? `${s.inFlight.step}:${s.inFlight.round ?? s.inFlight.index}${s.inFlight.id ? '+id' : ''}` : '-'));
  assert.deepEqual(steps, ['-', 'capture:0+id', '-', 'review:1', '-', 'fix:1', '-', 'capture:1+id', '-', 'review:2', '-', '-']);
  assert.ok(h.calls.states.every((s) => s.leader === 'this-process'));
  const afterCapture = h.calls.states[7 + 1];
  assert.equal(afterCapture.latest.index, 1, 'the fix\'s capture is saved before the next review');
  assert.equal(afterCapture.latest.sha, 'fix1');
  assert.ok(!JSON.stringify(afterCapture.latest).includes('Cannot find module'), 'never the boot log');
  assert.equal(review.PROCESS_ID.length, 16);
});

test('the time a restart cost is given back on the budget, and the resumes are counted', async () => {
  // Started 30 minutes ago with a 25-minute budget; the last step was saved
  // 22 minutes ago (8 minutes in). Without the restart's 22 minutes back,
  // the budget would be spent; with them, 17 minutes are left.
  const prior = savedState({
    startedMinutesAgo: 30, savedMinutesAgo: 22, resumes: 1, pausedMs: 0,
    rounds: [{ round: 1, sha: 'sha0', captureIndex: 0, artifactIds: [], booted: true, verdict: null, issues: [], fix: null }],
  });
  const h = harness({ prior, verdicts: ['fix', 'ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.resumes, 2);
  assert.equal(out.pausedMs, 22 * MIN);
  assert.equal(h.calls.fix.length, 1, 'a fix still fits');
  assert.equal(out.stop, 'ship');
  // A second restart adds its own.
  const again = harness({ prior: { ...prior, pausedMs: 5 * MIN }, verdicts: ['ship'] });
  assert.equal((await review.runReviewLoop(again.opts)).pausedMs, 27 * MIN);
  // Past the budget even so: the time stop, as without a restart.
  const spent = harness({ prior: savedState({ startedMinutesAgo: 40, savedMinutesAgo: 1, rounds: [{ round: 1, verdict: null, issues: [], fix: null }] }) });
  const s = await review.runReviewLoop(spent.opts);
  assert.equal(s.stop, 'time_budget');
  assert.equal(spent.calls.review.length, 0);
});

test('a stop the review saved goes straight to its final capture; a fix the final capture finds broken is rolled back to the last that booted', async () => {
  // The round limit, the last fix landed, the final capture under way.
  const prior = savedState({
    rounds: [1, 2, 3].map((round) => ({
      round, sha: round === 1 ? 'sha0' : `fix${round - 1}`, captureIndex: round - 1, verdict: 'fix', issues: [issue(`r${round}`)],
      reviewerCostUsd: 0.3, fix: { ok: true, sha: `fix${round}`, commits: 1 + round, costUsd: 0.1, ms: 1 },
    })),
    latest: { index: 2, sha: 'fix2', capture: review.reviewForm(captureOf(2)) },
    lastBooted: { sha: 'fix2', commits: 3 },
    lastBootedCapture: review.slimCapture(captureOf(2)),
    finalSha: 'fix3', finalCommits: 4,
    stop: 'round_limit',
    inFlight: { step: 'capture', index: 3, id: '0123456789abcdef', startedAt: '2026-10-12T22:40:00.000Z' },
  });
  const h = harness({ prior, captures: { 3: 'down' } });
  const out = await review.runReviewLoop(h.opts);
  assert.deepEqual(h.calls.capture.map((c) => [c.index, c.prior?.id || null]), [[3, '0123456789abcdef']], 'harvested');
  assert.equal(h.calls.review.length + h.calls.fix.length, 0);
  assert.equal(out.stop, 'regressed');
  assert.deepEqual(h.calls.rollback, [{ sha: 'fix2', from: 'fix3' }]);
  assert.equal(out.finalSha, 'fix2');
  assert.equal(out.finalCapture.shots[0].artifactId, 'a21', 'the last capture that booted, carried over the restart');
  assert.equal(out.rolledBack.stopBefore, 'round_limit');
  // A request stopped before the restart is neither captured nor rolled back.
  const skipped = harness({ prior: savedState({ stop: 'skipped', stopDetail: 'skipped: the request was closed' }) });
  const k = await review.runReviewLoop(skipped.opts);
  assert.equal(k.stop, 'skipped');
  assert.deepEqual(skipped.calls.capture, []);
});

test('once the build is no longer this process\'s, the loop takes no further step: the stop is thrown, and the next owner carries it on', async () => {
  // The durable context's fence (services/durable-steps.js) throws once the
  // build's work item is no longer this process's: its lease is gone, or the
  // process is stopping.
  let stopping = false;
  const fence = () => { if (stopping) throw new durableSteps.StepsStopped(); };
  const h = harness({ verdicts: ['fix'] });
  h.opts.resumeFrom = null;
  h.opts.fence = fence;
  const inner = h.opts.review;
  h.opts.review = async (args) => { const out = await inner(args); stopping = true; return out; };
  await assert.rejects(review.runReviewLoop(h.opts), (err) => durableSteps.isStopped(err),
    'the stop reaches the build\'s handler, past every catch in the loop');
  assert.equal(h.calls.fix.length, 0, 'no fix turn is started');
  assert.deepEqual(h.calls.rollback, []);
  assert.deepEqual(h.calls.capture.map((c) => c.index), [0], 'nor a final capture');
  const last = h.calls.states.at(-1);
  assert.equal(last.rounds[0].verdict, 'fix', 'what it got is saved, for the next owner');
  assert.equal(last.state, 'reviewing');
  // A detached capture is left where it runs, unread and uncleared.
  const w = fakeWorker({ states: ['done'] });
  await assert.rejects(captureMod.runDetached({
    worker: w, containerName: 'w', appId: 1, prior: { id: 'feedfacecafebeef', startedAt: new Date().toISOString() },
    fence: () => { throw new durableSteps.StepsStopped(); }, sleep: async () => {},
  }), (err) => durableSteps.isStopped(err));
  assert.deepEqual([w.calls.read.length, w.calls.cleared.length, w.calls.started.length], [0, 0, 0]);
  // And one it would start is not started.
  const fresh = fakeWorker();
  await assert.rejects(captureMod.runDetached({
    worker: fresh, containerName: 'w', appId: 1, fence: () => { throw new durableSteps.StepsStopped(); }, sleep: async () => {},
  }), (err) => durableSteps.isStopped(err));
  assert.deepEqual(fresh.calls.started, []);
});

test('canResume counts the restarts; recoveredFixOf reads a recovered turn as a fix turn\'s result; a done review is not carried on', async () => {
  assert.equal(review.MAX_REVIEW_RESUMES, 3);
  assert.equal(review.canResume({ state: 'reviewing' }), true);
  assert.equal(review.canResume({ state: 'capturing', resumes: 2 }), true);
  assert.equal(review.canResume({ state: 'reviewing', resumes: 3 }), false);
  assert.equal(review.canResume({ state: 'done' }), false);
  assert.equal(review.canResume(null), false);
  assert.deepEqual(review.recoveredFixOf({ result: { pushOk: true, ahead: 3, sha: 'abc' }, costUsd: 0.2, ms: 5 }),
    { ok: true, sha: 'abc', commits: 3, costUsd: 0.2, ms: 5 });
  assert.deepEqual(review.recoveredFixOf({ result: { pushOk: false, ahead: 0 } }), { ok: true, sha: null, commits: null, costUsd: null, ms: null },
    'a fix that changed nothing is a fix that landed nothing, as on the live path');
  assert.equal(review.recoveredFixOf({ result: {}, timedOut: true }).stopped, true);
  // A done review handed in is not resumed: the loop starts fresh.
  const h = harness({ prior: { ...savedState(), state: 'done' }, verdicts: ['ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.resumes, undefined);
  assert.deepEqual(h.calls.capture.map((c) => c.index), [0]);
});

test('reviewForm keeps what the reviewer needs and nothing private; reviewCapture reads its signals', async () => {
  const form = review.reviewForm(captureOf(4));
  assert.deepEqual(Object.keys(form).sort(), ['booted', 'error', 'ms', 'shots', 'signals']);
  assert.deepEqual(form.shots.map((s) => Object.keys(s).length), [6, 6, 7], 'the result shot keeps its tapped control');
  assert.ok(!JSON.stringify(form).includes('Cannot find module'));
  assert.equal(review.reviewForm(form).signals, form.signals, 'one already in this form keeps its signals');
  assert.equal(review.reviewForm(null), null);
  let sent = null;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const out = await review.reviewCapture({
    pool: {}, config: {}, userId: 1, model: OPUS, seed: 'x', spec: 'y', capture: form, round: 2, maxRounds: 3,
    deps: {
      readArtifacts: async (_p, ids) => new Map(ids.map((id) => [id, { content_type: 'image/png', data: PNG }])),
      callReviewer: async ({ content }) => { sent = content; return { ok: true, text: '{"verdict":"ship"}', costUsd: 0.1, ms: 1 }; },
    },
  });
  assert.equal(out.verdict, 'ship');
  assert.match(sent[0].text, /"count": 2/, 'the signals it kept');
  assert.ok(sent.some((c) => c.type === 'text' && /after tapping "Post"/.test(c.text)), 'the tapped control in its caption');
});

// ── The detached capture ─────────────────────────────────────────────────

function fakeWorker({ states = [], out = 'line\n__USERNODE_BENCH_CAPTURE__ {"booted":true,"shots":[]}\n', running = true } = {}) {
  const calls = { started: [], status: [], read: [], stopped: [], cleared: [], touched: 0, ensured: 0 };
  const queue = [...states];
  return {
    calls,
    workerRuntimeName: (id) => `sv-worker-s${id}`,
    async startDetachedCapture(where, args) { calls.started.push({ where, id: args.id, env: args.env, hasSource: !!args.source }); },
    async detachedCaptureStatus(where, id) {
      calls.status.push({ where, id });
      const next = queue.length ? queue.shift() : (running ? 'running' : 'done');
      if (next === 'throw') throw new Error('pod not found');
      return next === 'done' ? { state: 'done', code: 0 } : { state: next };
    },
    async readDetachedCapture(where, id) { calls.read.push({ where, id }); return out; },
    async stopDetachedCapture(where, id) { calls.stopped.push({ where, id }); },
    async clearDetachedCapture(where, id) { calls.cleared.push({ where, id }); },
    touchWorker() { calls.touched += 1; },
  };
}

test('runDetached: a new step is saved before it starts, polled until it is over, read once and cleared', async () => {
  const w = fakeWorker({ states: ['running', 'running', 'done'] });
  const order = [];
  w.startDetachedCapture = async (where, args) => { order.push(['start', where, args.id]); };
  const stdout = await captureMod.runDetached({
    worker: w, containerName: 'w1', sessionId: 7, appId: 3, sleep: async () => {},
    onStarted: async (info) => { order.push(['saved', info.id]); },
  });
  assert.match(stdout, /__USERNODE_BENCH_CAPTURE__/);
  assert.equal(order[0][0], 'saved', 'its id is saved first, so a restart can find it');
  assert.equal(order[1][0], 'start');
  assert.equal(order[0][1], order[1][2]);
  assert.match(order[0][1], /^[0-9a-f]{16}$/);
  assert.equal(w.calls.status.length, 3);
  assert.deepEqual(w.calls.read, [{ where: 'w1', id: order[0][1] }]);
  assert.deepEqual(w.calls.cleared, [{ where: 'w1', id: order[0][1] }]);
  assert.equal(w.calls.touched, 2, 'the worker is kept from the idle sweeper while it runs');
});

test('runDetached: a step a restart left running is harvested where it runs, on its own clock; a gone one is taken again', async () => {
  const running = fakeWorker({ states: ['running', 'running', 'done'] });
  let ensured = 0;
  const out = await captureMod.runDetached({
    worker: running, sessionId: 42, appId: 1, sleep: async () => {},
    prior: { id: 'feedfacecafebeef', startedAt: new Date().toISOString() },
    ensure: async () => { ensured += 1; return 'never'; },
  });
  assert.match(out, /BENCH_CAPTURE/);
  assert.equal(running.calls.started.length, 0, 'not started again');
  assert.equal(ensured, 0, 'the worker is not made sure first: a new image would replace it, and the step with it');
  assert.ok(running.calls.status.every((s) => s.where === 'sv-worker-s42' && s.id === 'feedfacecafebeef'));

  for (const lost of ['gone', 'throw']) {
    const w = fakeWorker({ states: [lost, 'done'] });
    let saved = null;
    // eslint-disable-next-line no-await-in-loop
    await captureMod.runDetached({
      worker: w, sessionId: 42, appId: 1, sleep: async () => {},
      prior: { id: 'feedfacecafebeef', startedAt: new Date().toISOString() },
      ensure: async () => 'sv-worker-s42-new', onStarted: async (info) => { saved = info.id; },
    });
    assert.equal(w.calls.started.length, 1, `${lost}: taken again`);
    assert.equal(w.calls.started[0].where, 'sv-worker-s42-new', 'in the worker made sure');
    assert.notEqual(saved, 'feedfacecafebeef');
  }

  // Its clock counts from when it first started, the restart included.
  const slow = fakeWorker({ running: true });
  let t = 1_000_000;
  await assert.rejects(captureMod.runDetached({
    worker: slow, containerName: 'w', sessionId: 1, appId: 1, timeoutMs: 12 * MIN, now: () => t, sleep: async () => { t += MIN; },
    prior: { id: 'feedfacecafebeef', startedAt: new Date(1_000_000 - 11 * MIN).toISOString() },
  }), /ran past 12 minutes/);
  assert.deepEqual(slow.calls.stopped, [{ where: 'w', id: 'feedfacecafebeef' }], 'and is stopped');
  // One that vanishes once started is a failed step.
  const vanished = fakeWorker({ states: ['running', 'gone'] });
  await assert.rejects(captureMod.runDetached({ worker: vanished, containerName: 'w', appId: 1, sleep: async () => {} }), /stopped before it wrote a result/);
});

test('captureTrial runs a review round\'s step detached, and anything else over one exec as before', async () => {
  const out = JSON.stringify({ booted: false, error: 'it did not start', shots: [] });
  const w = fakeWorker({ states: ['done'], out: `${captureMod.MARKER} ${out}\n` });
  w.runBenchCapture = async () => { throw new Error('not over an exec'); };
  const stored = [];
  const res = await captureMod.captureTrial({
    pool: {}, worker: w, containerName: 'w', appId: 2, store: async (kept) => { stored.push(kept.length); return {}; },
    detached: { sessionId: 9, prior: null, onStarted: null },
  });
  assert.equal(res.ok, true);
  assert.equal(res.capture.booted, false);
  assert.equal(w.calls.started[0].env.INLOOP_PORT, captureMod.CAPTURE_PORT);
  assert.deepEqual(stored, [0]);
  // A worker without the detached step (a guarded bench worker): over an exec.
  const attached = { async runBenchCapture() { return `${captureMod.MARKER} ${out}\n`; } };
  const a = await captureMod.captureTrial({ pool: {}, worker: attached, containerName: 'w', appId: 2, store: async () => ({}), detached: { sessionId: 9 } });
  assert.equal(a.ok, true);
  const failing = fakeWorker({ states: ['gone'] });
  failing.startDetachedCapture = async () => { throw new Error('exec refused'); };
  const f = await captureMod.captureTrial({ pool: {}, worker: failing, containerName: 'w', appId: 2, store: async () => ({}), detached: { sessionId: 9 } });
  assert.deepEqual(f, { ok: false, error: 'the screenshot step did not run: exec refused' });
});

test('the worker\'s detached step: started in the background with its own files, its state read from them', () => {
  const script = worker.buildDetachedCaptureScript({ id: 'feedfacecafebeef', env: { INLOOP_PORT: 3190, BENCH_APP_ID: 7 } });
  assert.match(script, /mkdir -p \/tmp\/usernode-capture/);
  assert.match(script, /nohup sh -c '.*> \/tmp\/usernode-capture\/feedfacecafebeef\.out 2> \/tmp\/usernode-capture\/feedfacecafebeef\.err; echo \$\? > \/tmp\/usernode-capture\/feedfacecafebeef\.exit\.tmp; mv /);
  assert.match(script, /node \/tmp\/usernode-bench-capture\.js/);
  assert.match(script, /echo \$! > \/tmp\/usernode-capture\/feedfacecafebeef\.pid\n$/);
  assert.throws(() => worker.buildDetachedCaptureScript({ id: '../../etc' }), /invalid id/);
  assert.throws(() => worker.buildDetachedCaptureStatusScript('x; rm -rf /'), /invalid id/);
  assert.deepEqual(worker.parseDetachedCaptureStatus('exit 0\n'), { state: 'done', code: 0 });
  assert.deepEqual(worker.parseDetachedCaptureStatus('exit 137'), { state: 'done', code: 137 });
  assert.deepEqual(worker.parseDetachedCaptureStatus('running\n'), { state: 'running' });
  assert.deepEqual(worker.parseDetachedCaptureStatus(''), { state: 'gone' });
});

test('the status script, run in a shell: done once its exit file is there, running while its pid lives, gone otherwise', { skip: spawnSync('sh', ['-c', 'true']).status !== 0 }, () => {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = worker.DETACHED_CAPTURE_DIR;
  const status = () => worker.parseDetachedCaptureStatus(spawnSync('sh', ['-c', worker.buildDetachedCaptureStatusScript(id)], { encoding: 'utf8' }).stdout);
  fs.mkdirSync(dir, { recursive: true });
  try {
    assert.deepEqual(status(), { state: 'gone' }, 'nothing there');
    fs.writeFileSync(`${dir}/${id}.pid`, String(process.pid));
    assert.deepEqual(status(), { state: 'running' }, 'its process lives');
    fs.writeFileSync(`${dir}/${id}.pid`, '999999');
    assert.deepEqual(status(), { state: 'gone' }, 'its process is gone, with no exit file');
    fs.writeFileSync(`${dir}/${id}.exit`, '0\n');
    assert.deepEqual(status(), { state: 'done', code: 0 });
  } finally {
    for (const ext of ['pid', 'exit']) fs.rmSync(`${dir}/${id}.${ext}`, { force: true });
  }
});
