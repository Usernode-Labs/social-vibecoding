'use strict';

// The reviewer loop of a first version (src/services/bot-review.js): its
// prompt and the strict JSON it asks for (a malformed answer fails open), the
// fix turn's prompt, and the loop's control flow with every worker and model
// call handed in: it stops on `ship`, the round limit, the time budget, the
// bot's budget, the request being stopped or any error; it records the
// round-0 snapshot and every round; and the final state is captured once.
// A fix that breaks the app is rolled back to the last commit that booted;
// no fix turn or capture starts with too little of the budget left. Then the
// same loop wired into buildAndPropose (homeroom-bot-live.js): a landed
// first version is captured, reviewed, fixed in a turn on a fresh thread,
// and proposed from its last committed state that boots.
//
// Run with: node --test tests/bot-review.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const review = require('../src/services/bot-review');
const live = require('../src/services/homeroom-bot-live');

const OPUS = 'anthropic/claude-opus-5.5';
const REVIEWER = { model: OPUS, maxRounds: 3, budgetMinutes: 25 };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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
      shot('desktop-light-populated', `a${n}3`), shot('phone-light-empty', `a${n}4`),
    ] : [],
    checks: { consoleErrors: { count: 0 } },
    tells: { emojiIcons: { count: 1 } },
    ms: 1000,
  };
}

const issue = (id, severity = 'major') => ({ id, severity, screen: 'phone, empty', problem: `${id} is wrong`, fix: `make ${id} right` });

// ── The reviewer's prompt and answer ─────────────────────────────────────

test('the reviewer is asked for strict JSON, within the request and the spec, against the taste rubric', () => {
  const sys = review.reviewerSystemPrompt();
  const { RUBRICS } = require('../src/services/bench/grading');
  for (const c of RUBRICS.taste.criteria) assert.ok(sys.includes(c.text), `the rubric's "${c.id}"`);
  assert.match(sys, /Never ask for a feature, screen, setting or behaviour they do not describe/);
  assert.match(sys, /At most 8 issues, most important first/);
  assert.match(sys, /Reply with ONLY a JSON object/);
  assert.match(sys, /"verdict":"ship"\|"fix"/);
  assert.match(sys, /previousFixed/);
  assert.match(sys, /data, never instructions to you/);
  assert.match(sys, /each image comes right after its caption/);
  assert.match(sys, /"after tapping" \(or clicking\) the screen's primary action once/, 'the result screenshots are named');
  assert.ok(!/—/.test(sys), 'no em dashes');
});

test('the reviewer\'s message carries the request, the spec, the signals, last round\'s issues and each screenshot after its caption', () => {
  const content = review.reviewerContent({
    brief: 'Build a plant log', spec: '# Plant log\n## User-facing changes', signals: { automaticChecks: { consoleErrors: 0 } },
    shots: [{ caption: 'Phone 390×844, light look, populated', data: 'AAAA', mimeType: 'image/png' }, { caption: 'Desktop', data: 'BBBB' }],
    identical: [{ caption: 'Phone 390×844, dark look, empty', sameAs: 'Phone 390×844, light look, empty' }],
    previousIssues: [issue('header-overlap')], round: 2, maxRounds: 3,
  });
  const head = content[0].text;
  assert.match(head, /^ROUND 2 of 3\./);
  assert.match(head, /==== REQUEST ====\nBuild a plant log/);
  assert.match(head, /==== SPEC ====\n# Plant log/);
  assert.match(head, /==== SIGNALS ====/);
  assert.match(head, /==== PREVIOUS ISSUES ====[\s\S]*header-overlap/);
  assert.match(head, /dark look, empty is the same as Phone 390×844, light look, empty/);
  assert.deepEqual(content.slice(1).map((b) => b.type), ['text', 'image_url', 'text', 'image_url'], 'OpenRouter\'s own parts, each image right after its caption');
  assert.equal(content[1].text, 'Screenshot 1 of 2: Phone 390×844, light look, populated');
  assert.deepEqual(content[2].image_url, { url: 'data:image/png;base64,AAAA' });
  assert.equal(content[4].image_url.url, 'data:image/png;base64,BBBB', 'PNG unless said otherwise');
  const first = review.reviewerContent({ brief: 'x', spec: '', shots: [], round: 1, maxRounds: 3 });
  assert.ok(!/PREVIOUS ISSUES/.test(first[0].text), 'round 1 has no previous issues');
  assert.match(first[0].text, /no spec/);
});

test('the reviewer\'s answer is read strictly; anything else fails open', () => {
  const fix = review.parseReview(JSON.stringify({
    verdict: 'fix',
    issues: [
      { id: 'Empty State!', severity: 'BLOCKER', screen: 'phone, empty', problem: 'Blank screen', fix: 'Add an empty state with a primary action' },
      { id: 'contrast', severity: 'weird', screen: '', problem: 'Grey on grey', fix: 'Use the ink token' },
      { id: 'no-fix', problem: 'Something' },
    ],
    previousFixed: ['Header Overlap', '', 3],
  }));
  assert.equal(fix.ok, true);
  assert.equal(fix.verdict, 'fix');
  assert.deepEqual(fix.issues.map((i) => [i.id, i.severity, i.screen]), [['empty-state', 'blocker', 'phone, empty'], ['contrast', 'major', 'every screen']]);
  assert.deepEqual(fix.previousFixed, ['header-overlap'], 'ids only, cleaned');
  // Fenced, or with prose around it.
  assert.equal(review.parseReview('```json\n{"verdict":"ship","issues":[]}\n```').verdict, 'ship');
  assert.equal(review.parseReview('Here you go: {"verdict":"ship","issues":[]} thanks').verdict, 'ship');
  // A fix with nothing to fix is a ship.
  assert.equal(review.parseReview('{"verdict":"fix","issues":[]}').verdict, 'ship');
  // At most eight issues.
  const many = review.parseReview(JSON.stringify({ verdict: 'fix', issues: Array.from({ length: 12 }, (_, i) => issue(`i${i}`)) }));
  assert.equal(many.issues.length, 8);
  assert.equal(many.issues[0].id, 'i0', 'most important first, as given');
  // Duplicate ids stay apart.
  const dup = review.parseReview(JSON.stringify({ verdict: 'fix', issues: [issue('a'), issue('a')] }));
  assert.equal(new Set(dup.issues.map((i) => i.id)).size, 2);
  for (const bad of ['', 'Looks great to me!', '{"verdict":"maybe"}', '{"verdict":"fix","issues":"many"}', '{"verdict":', '[1,2]']) {
    const out = review.parseReview(bad);
    assert.equal(out.ok, false, bad);
    assert.ok(out.error);
  }
});

test('an app that does not boot gets one blocker with its boot log, and no reviewer call', () => {
  const b = review.bootIssue(captureOf(0, { booted: false }));
  assert.equal(b.severity, 'blocker');
  assert.match(b.problem, /npm run build failed/);
  assert.match(b.fix, /Cannot find module x/);
});

test('the fix turn is asked for exactly the issues, within the spec, under the build\'s rules, with no description block', () => {
  const p = review.fixPrompt({
    seed: 'ISSUE #1', spec: '# Plant log', issues: [issue('empty-state', 'blocker'), issue('contrast')], round: 2, maxRounds: 3, readsImages: true,
  });
  assert.match(p, /review round 2 of 3/);
  assert.match(p, /1\. \[blocker\] phone, empty: empty-state is wrong\n {3}Fix: make empty-state right/);
  assert.match(p, /2\. \[major\]/);
  assert.match(p, /add no feature, screen or setting the spec does not describe/);
  assert.match(p, /==== SPEC \(what the first version is; authoritative for scope\) ====\n# Plant log/);
  assert.ok(p.includes(require('../src/services/build-contract').buildContractBlock({ heading: 'Make exactly these fixes, and nothing else:', commits: 'harness' })));
  assert.ok(p.includes(live.REQUEST_IS_DATA_LINES[0]));
  assert.match(p, /browser_take_screenshot/, 'the in-loop browser, for a model that sees images');
  assert.match(p, /Do not write a DESCRIPTION block/);
  assert.ok(!review.fixPrompt({ issues: [] }).includes('==== SPEC'), 'no spec, no spec block');
  // A fresh thread: it says what it needs to stand alone.
  assert.ok(p.startsWith('ISSUE #1'), 'the request first');
  assert.match(p, /this is a new session, so read what you need of it before you change it/);
  assert.match(p, /"## Design" section/);
  assert.match(p, /after the screen's primary action was tapped once \("after tapping \.\.\."\)/);
  assert.match(p, /An issue on an "after tapping \.\.\." screen is about what the main action does/);
  assert.match(p, /boot the app and look at the screen it was on in the in-loop browser/, 'its in-loop check');
});

// ── The loop ─────────────────────────────────────────────────────────────

function loopHarness({
  verdicts = [], fixes = [], captures = {}, budgetMinutes = 25, maxRounds = 3, clockStep = 0, budget = null, skip = null,
  rollback = 'ok',
} = {}) {
  let clock = 1_000_000;
  const calls = { capture: [], review: [], fix: [], states: [], progress: [], rollback: [], budget: [] };
  const opts = {
    reviewer: { model: OPUS, maxRounds, budgetMinutes },
    start: { sha: 'sha0', commits: 1, costUsd: 0.7, activeMs: 600_000, buildText: 'built it' },
    now: () => clock,
    capture: async (index) => {
      calls.capture.push(index);
      clock += clockStep;
      const c = Array.isArray(captures[index]) ? captures[index].shift() : captures[index];
      if (c === 'fail') return { ok: false, error: 'worker gone', ms: 5 };
      if (c === 'down') return { ok: true, capture: captureOf(index, { booted: false }), ms: 2000 };
      return { ok: true, capture: c || captureOf(index), ms: 2000 };
    },
    review: async ({ round, capture, previousIssues, timeoutMs }) => {
      calls.review.push({ round, booted: capture?.booted, previous: previousIssues ? previousIssues.map((i) => i.id) : null, timeoutMs });
      clock += clockStep;
      const v = verdicts[round - 1];
      if (v === 'error') return { ok: false, error: 'HTTP 502', costUsd: 0.05, ms: 100 };
      if (v === 'ship') return { ok: true, verdict: 'ship', issues: [], previousFixed: ['x'], costUsd: 0.2, ms: 3000, by: 'model' };
      return { ok: true, verdict: 'fix', issues: [issue(`r${round}`)], previousFixed: [], costUsd: 0.2, ms: 3000, by: 'model' };
    },
    fix: async ({ round, issues, budgetMs }) => {
      calls.fix.push({ round, ids: issues.map((i) => i.id), budgetMs });
      clock += clockStep;
      const f = fixes[round - 1];
      if (f === 'fail') return { ok: false, error: 'the fix turn failed (agent exited 1)', costUsd: 0.05, ms: 100 };
      if (f === 'stopped') return { ok: false, stopped: true, costUsd: 0.05, ms: 100 };
      return { ok: true, sha: `sha${round}`, commits: 1 + round, costUsd: 0.13, ms: 60_000 };
    },
    rollback: rollback === 'none' ? null : async (args) => {
      calls.rollback.push(args);
      if (rollback === 'fail') throw new Error('GitHub said 422');
    },
    budgetCheck: budget ? async (spent) => { calls.budget.push(spent); return typeof budget === 'function' ? budget(spent) : budget; } : null,
    skipCheck: skip ? async () => skip : null,
    onState: async (s) => { calls.states.push(s); },
    onProgress: (line) => calls.progress.push(line),
  };
  return { opts, calls, advance: (ms) => { clock += ms; } };
}

test('ship early: one review, no fix, and the round-0 capture is the final one', async () => {
  const h = loopHarness({ verdicts: ['ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'ship');
  assert.equal(out.state, 'done');
  assert.deepEqual(h.calls.capture, [0], 'captured once');
  assert.equal(h.calls.fix.length, 0);
  assert.equal(out.finalSha, 'sha0');
  assert.equal(out.finalCapture, h.calls.capture.length && out.round0.capture, 'the round-0 capture serves');
  assert.equal(out.roundsUsed, 1);
  assert.equal(out.costUsd, 0.2);
  // The round-0 snapshot: the first build's commit, capture, cost and time.
  assert.equal(out.round0.sha, 'sha0');
  assert.equal(out.round0.costUsd, 0.7);
  assert.equal(out.round0.activeMs, 600_000 + 2000, 'its time includes its capture, as a side build\'s does');
  assert.equal(out.round0.capture.booted, true);
  assert.equal(out.buildText, 'built it');
  assert.deepEqual(h.calls.progress, ['Reviewing the screens (round 1 of 3)', 'Reviewing the screens (round 1 of 3)']);
  assert.equal(h.calls.states[0].state, 'reviewing', 'recorded as reviewing from the start');
  assert.equal(h.calls.states.at(-1).state, 'done');
});

test('the round limit: three reviews and three fixes, each round recorded, and the final state captured once more', async () => {
  const h = loopHarness({ verdicts: ['fix', 'fix', 'fix'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'round_limit');
  assert.deepEqual(h.calls.capture, [0, 1, 2, 3], 'after the build, after each fix, and the final state');
  assert.deepEqual(h.calls.fix.map((f) => f.round), [1, 2, 3]);
  assert.deepEqual(h.calls.review.map((r) => r.previous), [null, ['r1'], ['r2']], 'from round 2, the previous round\'s issues');
  assert.equal(out.finalSha, 'sha3');
  assert.equal(out.finalCommits, 4);
  assert.equal(out.finalCapture.shots[0].artifactId, 'a31', 'the final capture is of the final state');
  assert.equal(out.rounds.length, 3);
  const [r1, r2] = out.rounds;
  assert.equal(r1.sha, 'sha0');
  assert.equal(r2.sha, 'sha1', 'each round reviews the commit before its fix');
  assert.deepEqual(r2.artifactIds, ['a11', 'a12', 'a13', 'a14']);
  assert.equal(r1.verdict, 'fix');
  assert.deepEqual(r1.issues.map((i) => i.id), ['r1']);
  assert.equal(r1.reviewerCostUsd, 0.2);
  assert.equal(r1.reviewerMs, 3000);
  assert.deepEqual(r1.fix, { ok: true, sha: 'sha1', commits: 2, costUsd: 0.13, ms: 60_000 });
  assert.ok(Math.abs(out.costUsd - 3 * (0.2 + 0.13)) < 1e-9, 'reviewer calls and fix turns');
  assert.equal(out.roundsUsed, 3);
});

test('the time budget: the loop stops when the minutes are up, and keeps what is committed', async () => {
  // Each step takes four minutes of a fifteen-minute budget: the first
  // capture, a review and a fix (12 minutes), then 3 left, a review, and
  // no time for another fix.
  const h = loopHarness({ verdicts: ['fix', 'fix', 'fix'], budgetMinutes: 15, clockStep: 4 * 60_000 });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'time_budget');
  assert.equal(h.calls.fix.length, 1);
  assert.ok(h.calls.fix.every((f) => f.budgetMs <= 15 * 60_000), 'a fix turn gets at most what is left');
  assert.equal(h.calls.fix[0].budgetMs, 7 * 60_000);
  assert.equal(out.finalCapture?.booted, true, 'the final state is captured even past the budget');
  assert.equal(out.finalSha, 'sha1');
  assert.deepEqual(h.calls.capture, [0, 1], 'the fix was looked at once; nothing more');
});

test('no fix turn or capture starts with less than three minutes of the budget left, and a reviewer call gets what is left', async () => {
  assert.equal(review.MIN_STEP_MINUTES, 3);
  // Ten minutes: the capture and the review take four each, two are left.
  const h = loopHarness({ verdicts: ['fix'], budgetMinutes: 10, clockStep: 4 * 60_000 });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'time_budget');
  assert.match(out.stopDetail, /less than 3 minutes of the review's time were left for a fix/);
  assert.equal(h.calls.fix.length, 0, 'no fix turn that cannot finish');
  assert.equal(out.rounds[0].verdict, 'fix', 'the review itself is kept');
  assert.equal(h.calls.review[0].timeoutMs, 6 * 60_000 + review.REVIEW_TIMEOUT_MARGIN_MS, 'what is left of the budget, and a minute');
  // A fix that leaves under three minutes: its state is not looked at for
  // another round, only captured once as the final state.
  const late = loopHarness({ verdicts: ['fix', 'fix'], budgetMinutes: 11, clockStep: 3 * 60_000 });
  const l = await review.runReviewLoop(late.opts);
  assert.equal(l.stop, 'time_budget');
  assert.match(l.stopDetail, /left to look again/);
  assert.deepEqual(late.calls.capture, [0, 1], 'the final capture only');
  assert.equal(l.finalSha, 'sha1');
  assert.equal(l.finalCapture.booted, true);
});

test('a reviewer call\'s timeout is its own, cut to what is left of the review', async () => {
  const seen = [];
  const deps = {
    credentialStore: {
      async readMetadata() { return { status: 'valid', revision: 3, metadata: {} }; },
      async readSecret() { return 'sk-or-bot'; },
    },
    agentModels: { async resolveModelPricing() { return { id: OPUS, supportsImages: true }; } },
    managedOpenRouter: { MANAGED_SOURCE: 'managed' },
    openrouterMayor: {
      createClient(opts) {
        seen.push(opts.timeoutMs);
        return { async streamChat() { return { text: '{"verdict":"ship"}', usage: {} }; }, estimateCostCents() { return 0; } };
      },
    },
  };
  await review.callReviewer({ pool: {}, userId: 5, model: OPUS, system: 'S', content: [], deps });
  await review.callReviewer({ pool: {}, userId: 5, model: OPUS, system: 'S', content: [], timeoutMs: 90_000, deps });
  await review.callReviewer({ pool: {}, userId: 5, model: OPUS, system: 'S', content: [], timeoutMs: 60 * 60_000, deps });
  assert.deepEqual(seen, [review.REVIEW_TIMEOUT_MS, 90_000, review.REVIEW_TIMEOUT_MS]);
});

test('a fix turn stopped on the review\'s clock leaves the branch as it was', async () => {
  const h = loopHarness({ verdicts: ['fix'], fixes: ['stopped'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'time_budget');
  assert.equal(out.finalSha, 'sha0');
  assert.deepEqual(h.calls.capture, [0], 'its state is the one already captured');
  assert.equal(out.rounds[0].fix.ok, false);
});

test('fail open: a reviewer error, a failed fix, a failed capture or a thrown error stop the loop and keep what is built', async () => {
  const err = loopHarness({ verdicts: ['error'] });
  const e = await review.runReviewLoop(err.opts);
  assert.equal(e.stop, 'reviewer_error');
  assert.equal(e.stopDetail, 'HTTP 502');
  assert.equal(e.finalSha, 'sha0');
  assert.equal(e.rounds[0].reviewerError, 'HTTP 502');
  assert.equal(e.costUsd, 0.05, 'what the failed call cost is still counted');
  assert.equal(err.calls.fix.length, 0);

  const fixFail = loopHarness({ verdicts: ['fix', 'fix'], fixes: [undefined, 'fail'] });
  const f = await review.runReviewLoop(fixFail.opts);
  assert.equal(f.stop, 'fix_failed');
  assert.equal(f.finalSha, 'sha1', 'the last committed state');
  assert.deepEqual(fixFail.calls.capture, [0, 1], 'sha1 was captured already');

  const cap = loopHarness({ verdicts: ['fix'], captures: { 0: 'fail' } });
  const c = await review.runReviewLoop(cap.opts);
  assert.equal(c.stop, 'capture_error');
  assert.equal(cap.calls.review.length, 0, 'nothing to review');
  assert.equal(c.round0.capture, null);
  assert.equal(c.round0.captureError, 'worker gone');
  assert.equal(c.finalCapture, null);

  const threw = loopHarness({ verdicts: ['fix'] });
  threw.opts.review = async () => { throw new Error('boom'); };
  const t = await review.runReviewLoop(threw.opts);
  assert.equal(t.stop, 'error');
  assert.equal(t.state, 'done');
  assert.equal(t.finalCapture, t.round0.capture, 'what it stopped on is still the final state');
});

test('the bot\'s budget and a stopped request end the loop', async () => {
  const b = loopHarness({ verdicts: ['fix'], budget: 'weekly limit reached' });
  const out = await review.runReviewLoop(b.opts);
  assert.equal(out.stop, 'budget');
  assert.equal(b.calls.fix.length, 0, 'no fix turn is spent past the budget');
  assert.equal(out.finalCapture.booted, true);
  // The check is told what the review has spent so far: the bot's
  // allowance is debited only once the build is over.
  const later = loopHarness({ verdicts: ['fix', 'fix'], budget: (spent) => (spent.spentUsd > 0.3 ? 'over' : null) });
  const o2 = await review.runReviewLoop(later.opts);
  assert.equal(o2.stop, 'budget');
  assert.deepEqual(later.calls.budget.map((x) => Math.round(x.spentUsd * 100) / 100), [0.2, 0.53]);
  assert.equal(later.calls.fix.length, 1);

  const s = loopHarness({ verdicts: ['fix'], skip: 'skipped: the request was closed before it was proposed' });
  const skipped = await review.runReviewLoop(s.opts);
  assert.equal(skipped.stop, 'skipped');
  assert.equal(s.calls.review.length, 0);
  assert.equal(skipped.finalCapture, null, 'a stopped request is not captured again');
});

test('a fix that stops the app booting is rolled back to the last commit that booted, and recorded as regressed', async () => {
  // Round 1's fix (sha1) boots; round 2's (sha2) does not, and round 3's
  // review is the platform's boot issue; its fix (sha3) still does not boot.
  const h = loopHarness({ verdicts: ['fix', 'fix', 'fix'], captures: { 2: 'down', 3: 'down' } });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'regressed');
  assert.deepEqual(h.calls.rollback, [{ sha: 'sha1', from: 'sha3' }], 'the branch goes back, through the caller');
  assert.equal(out.finalSha, 'sha1', 'what is proposed is the last commit that booted');
  assert.equal(out.finalCommits, 2);
  assert.equal(out.finalCapture.booted, true, 'and its capture is the final one');
  assert.equal(out.finalCapture.shots[0].artifactId, 'a11');
  assert.deepEqual(out.rolledBack, { from: 'sha3', to: 'sha1', why: 'did not boot', stopBefore: 'round_limit' });
  assert.match(out.stopDetail, /the last fix did not boot \(sha3\); back to sha1/);
  assert.deepEqual(out.lastBooted, { sha: 'sha1', commits: 2 });
  assert.equal(h.calls.states.at(-1).stop, 'regressed', 'recorded as it stands');
});

test('no regression: a fix that boots is kept, and nothing is rolled back', async () => {
  const h = loopHarness({ verdicts: ['fix', 'ship'] });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'ship');
  assert.equal(out.finalSha, 'sha1');
  assert.deepEqual(h.calls.rollback, []);
  assert.equal(out.rolledBack, undefined);
  assert.deepEqual(out.lastBooted, { sha: 'sha1', commits: 2 });
  // A first build that never booted has nothing to go back to: the fixes stand.
  const never = loopHarness({ verdicts: ['fix'], maxRounds: 1, captures: { 0: 'down', 1: 'down' } });
  const n = await review.runReviewLoop(never.opts);
  assert.equal(n.stop, 'round_limit');
  assert.equal(n.finalSha, 'sha1');
  assert.deepEqual(never.calls.rollback, []);
  assert.equal(n.lastBooted, null);
});

test('a loop that stops right after a fix looks at it once more, and rolls it back when it cannot be seen to boot', async () => {
  // The round limit, right after a fix: the final capture is its check.
  const limit = loopHarness({ verdicts: ['fix'], maxRounds: 1, captures: { 1: 'down' } });
  const l = await review.runReviewLoop(limit.opts);
  assert.deepEqual(limit.calls.capture, [0, 1]);
  assert.equal(l.stop, 'regressed');
  assert.equal(l.finalSha, 'sha0', 'back to the first build, which booted');
  assert.equal(l.finalCommits, 1);
  assert.equal(l.finalCapture, l.round0.capture);
  // The time budget, right after a fix, and the capture fails: unchecked is
  // not proposed either.
  const time = loopHarness({ verdicts: ['fix', 'fix'], budgetMinutes: 11, clockStep: 3 * 60_000, captures: { 1: 'fail' } });
  const t = await review.runReviewLoop(time.opts);
  assert.equal(t.stop, 'regressed');
  assert.equal(t.rolledBack.why, 'could not be captured');
  assert.equal(t.rolledBack.stopBefore, 'time_budget');
  assert.equal(t.finalCaptureError, 'worker gone');
  assert.equal(t.finalSha, 'sha0');
  // The bot's budget after a fix whose capture failed in the loop: it is
  // captured again for the final state, and kept when that one boots.
  const budget = loopHarness({ verdicts: ['fix', 'fix'], captures: { 1: ['fail', undefined] } });
  const b = await review.runReviewLoop(budget.opts);
  assert.equal(b.stop, 'capture_error');
  assert.deepEqual(budget.calls.capture, [0, 1, 1]);
  assert.equal(b.finalSha, 'sha1');
  assert.deepEqual(budget.calls.rollback, []);
  // A rollback that fails leaves what is committed, and says so.
  const stuck = loopHarness({ verdicts: ['fix'], maxRounds: 1, captures: { 1: 'down' }, rollback: 'fail' });
  const s = await review.runReviewLoop(stuck.opts);
  assert.equal(s.stop, 'round_limit');
  assert.equal(s.finalSha, 'sha1');
  assert.equal(s.rollbackError, 'GitHub said 422');
  const none = loopHarness({ verdicts: ['fix'], maxRounds: 1, captures: { 1: 'down' }, rollback: 'none' });
  assert.match((await review.runReviewLoop(none.opts)).rollbackError, /no way to move the branch/);
  // A stopped request is neither captured again nor rolled back.
  const skipped = loopHarness({ verdicts: ['fix', 'fix'], captures: { 1: 'down' } });
  let asks = 0;
  skipped.opts.skipCheck = async () => { asks += 1; return asks > 1 ? 'skipped: the request was closed' : null; };
  const k = await review.runReviewLoop(skipped.opts);
  assert.equal(k.stop, 'skipped');
  assert.deepEqual(skipped.calls.rollback, []);
});

test('no rounds: the first build is only captured, for the side builds it is compared with', async () => {
  const h = loopHarness({ maxRounds: 0 });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'no_rounds');
  assert.equal(h.calls.states[0].state, 'capturing');
  assert.equal(h.calls.review.length, 0);
  assert.equal(out.finalCapture, out.round0.capture);
  assert.deepEqual(h.calls.progress, [], 'nothing says "reviewing"');
});

test('a run keeps its review slim: where each screenshot is, never the checks\' samples or the boot log', () => {
  const state = { state: 'done', rounds: [{ verdict: 'fix' }, { verdict: null }], stop: 'round_limit', round0: { capture: captureOf(0) }, finalCapture: captureOf(1) };
  const slim = review.slimState(state);
  assert.deepEqual(Object.keys(slim.round0.capture).sort(), ['booted', 'error', 'ms', 'shots']);
  assert.deepEqual(Object.keys(slim.finalCapture.shots[0]).sort(), ['artifactId', 'id', 'look', 'sha256', 'state', 'viewport']);
  assert.ok(!JSON.stringify(slim).includes('Cannot find module'));
  assert.deepEqual(review.summaryOf(state), { rounds: 1, stop: 'round_limit' });
  assert.deepEqual(review.summaryOf(null), { rounds: null, stop: null });
  assert.equal(review.inProgress({ state: 'reviewing' }), true);
  assert.equal(review.inProgress({ state: 'capturing' }), true);
  assert.equal(review.inProgress({ state: 'done' }), false);
  assert.equal(review.inProgress(null), false);
  assert.equal(review.slimCapture(null), null);
});

// ── One review, against a capture ────────────────────────────────────────

test('reviewCapture: the eight most telling screenshots go to the reviewer as images; a malformed answer fails open', async () => {
  const seen = [];
  const deps = {
    readArtifacts: async (_pool, ids) => new Map(ids.map((id) => [id, { id, content_type: 'image/png', data: PNG }])),
    callReviewer: async (args) => { seen.push(args); return { ok: true, text: '{"verdict":"ship","issues":[]}', costUsd: 0.21, ms: 900 }; },
  };
  const out = await review.reviewCapture({
    pool: {}, config: {}, userId: 7, model: OPUS, seed: 'REQ', spec: 'SPEC', capture: captureOf(0), round: 1, maxRounds: 3, appId: 2, sessionId: 3, deps,
  });
  assert.deepEqual({ ok: out.ok, verdict: out.verdict, costUsd: out.costUsd, by: out.by }, { ok: true, verdict: 'ship', costUsd: 0.21, by: 'model' });
  assert.equal(seen[0].userId, 7, 'the key of the user the build runs as');
  assert.equal(seen[0].model, OPUS);
  const images = seen[0].content.filter((b) => b.type === 'image_url');
  assert.equal(images.length, 4);
  assert.equal(images[0].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  assert.match(seen[0].content[1].text, /Phone 390×844, light look, populated/);

  deps.callReviewer = async () => ({ ok: true, text: 'I think it is fine.', costUsd: 0.2, ms: 500 });
  const bad = await review.reviewCapture({ pool: {}, userId: 7, model: OPUS, capture: captureOf(0), round: 1, maxRounds: 3, deps });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON/);
  assert.equal(bad.costUsd, 0.2);

  deps.callReviewer = async () => { throw new Error('should not be called'); };
  const boot = await review.reviewCapture({ pool: {}, userId: 7, model: OPUS, capture: captureOf(0, { booted: false }), round: 1, maxRounds: 3, deps });
  assert.deepEqual({ ok: boot.ok, verdict: boot.verdict, by: boot.by, costUsd: boot.costUsd }, { ok: true, verdict: 'fix', by: 'platform', costUsd: 0 });
  assert.equal(boot.issues[0].id, 'app-does-not-boot');
});

test('callReviewer: the bot\'s own key, an image-reading model, and OpenRouter\'s own figure for the cost', async () => {
  const sent = [];
  const deps = {
    credentialStore: {
      async readMetadata() { return { status: 'valid', revision: 3, metadata: { source: 'managed' } }; },
      async readSecret() { return 'sk-or-bot'; },
    },
    agentModels: { async resolveModelPricing({ modelId }) { return modelId === OPUS ? { id: OPUS, supportsImages: true } : { id: modelId, supportsImages: false }; } },
    managedOpenRouter: { MANAGED_SOURCE: 'managed' },
    openrouterMayor: {
      createClient(opts) {
        sent.push(opts);
        return {
          async streamChat(req) { sent.push(req); return { text: '{"verdict":"ship"}', usage: { input_tokens: 9000, output_tokens: 300, cost_usd: 0.1934 } }; },
          estimateCostCents(usage) { return usage.cost_usd * 100; },
        };
      },
    },
  };
  const ok = await review.callReviewer({ pool: {}, config: {}, userId: 5, model: OPUS, system: 'S', content: [{ type: 'text', text: 'x' }], appId: 1, sessionId: 9, deps });
  assert.equal(ok.ok, true);
  assert.ok(Math.abs(ok.costUsd - 0.1934) < 1e-9);
  assert.equal(sent[0].apiKey, 'sk-or-bot');
  assert.equal(sent[0].billingPath, 'platform', 'the included key is the platform\'s spend');
  assert.equal(sent[0].catalogModel.supportsImages, true);
  assert.equal(sent[0].imageFallback, false, 'a refused picture is an error, never a review without it');
  assert.deepEqual(sent[1].chatMessages, [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], 'one user message, sent as built');
  assert.equal(sent[1].messages, undefined);
  assert.equal(sent[1].telemetryContext.component, review.TELEMETRY_COMPONENT);

  const textOnly = await review.callReviewer({ pool: {}, userId: 5, model: 'z-ai/glm-5.3-flash-text', system: 'S', content: [], deps });
  assert.equal(textOnly.ok, false);
  assert.match(textOnly.error, /cannot read images/);
  deps.credentialStore.readMetadata = async () => null;
  const noKey = await review.callReviewer({ pool: {}, userId: 5, model: OPUS, system: 'S', content: [], deps });
  assert.deepEqual([noKey.ok, noKey.error], [false, 'no usable OpenRouter key']);
  deps.credentialStore.readMetadata = async () => { throw new Error('db down'); };
  assert.equal((await review.callReviewer({ pool: {}, userId: 5, model: OPUS, system: 'S', content: [], deps })).ok, false, 'never throws');
  assert.match(require('node:fs').readFileSync(require.resolve('../src/services/llm-telemetry'), 'utf8'), /'homeroom_bot_review',/,
    'its telemetry component is one the ledger knows');
});

test('the request the reviewer sends: every caption right before its image; a refused image fails the call, never a blind review', async () => {
  const bodies = [];
  let status = 200;
  const deps = {
    credentialStore: {
      async readMetadata() { return { status: 'valid', revision: 3, metadata: {} }; },
      async readSecret() { return 'sk-or-bot'; },
    },
    agentModels: { async resolveModelPricing() { return { id: OPUS, supportsImages: true, inputPricePerMillion: 5, outputPricePerMillion: 25 }; } },
    managedOpenRouter: { MANAGED_SOURCE: 'managed' },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (status !== 200) return { ok: false, status, async text() { return '{"error":{"message":"bad image"}}'; } };
      return {
        ok: true, status: 200,
        async text() { return JSON.stringify({ choices: [{ message: { content: '{"verdict":"ship","issues":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9000, completion_tokens: 200, cost: 0.11 } }); },
      };
    },
  };
  const out = await review.reviewCapture({
    pool: {}, config: {}, userId: 7, model: OPUS, seed: 'REQ', spec: 'SPEC', capture: captureOf(0), round: 1, maxRounds: 2,
    deps: { ...deps, readArtifacts: async (_pool, ids) => new Map(ids.map((id) => [id, { id, content_type: 'image/png', data: PNG }])) },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.verdict, 'ship');
  assert.equal(bodies.length, 1);
  const [system, user] = bodies[0].messages;
  assert.equal(system.role, 'system');
  assert.equal(user.role, 'user');
  const types = user.content.map((p) => p.type);
  assert.deepEqual(types, ['text', 'text', 'image_url', 'text', 'image_url', 'text', 'image_url', 'text', 'image_url']);
  for (let i = 1; i < user.content.length; i += 2) {
    assert.match(user.content[i].text, new RegExp(`^Screenshot ${(i + 1) / 2} of 4: `), 'a caption');
    assert.match(user.content[i + 1].image_url.url, /^data:image\/png;base64,/, 'and its image right after it');
  }
  assert.match(user.content[0].text, /==== REQUEST ====\nREQ/);

  // The provider refuses the images: no second request without them.
  status = 400;
  bodies.length = 0;
  const refused = await review.callReviewer({
    pool: {}, config: {}, userId: 7, model: OPUS, system: 'S',
    content: [{ type: 'text', text: 'Screenshot 1 of 1: Phone' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], deps,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /refused the request's images/);
  assert.equal(bodies.length, 1, 'never sent again with "[image omitted]" in their place');
  assert.ok(!JSON.stringify(bodies).includes('image omitted'));
});

test('another caller of the same client still gets its images-omitted retry', async () => {
  const mayor = require('../src/services/openrouter-mayor');
  const bodies = [];
  const client = mayor.createClient({
    apiKey: 'k', model: OPUS, catalogModel: { supportsImages: true },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return { ok: false, status: 400, async text() { return '{}'; } };
      return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }); } };
    },
  });
  const out = await client.streamChat({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
  });
  assert.equal(out.text, 'ok');
  assert.equal(bodies.length, 2);
  assert.match(JSON.stringify(bodies[1]), /image omitted: the model provider could not read it/);
});

// ── Through buildAndPropose ──────────────────────────────────────────────

function buildHarness({ verdicts = ['fix', 'ship'] } = {}) {
  const calls = { turns: [], captures: [], states: [], queries: [] };
  let n = 0;
  const pool = {
    async query(sql, params) {
      calls.queries.push(String(sql));
      return /INSERT INTO chat_sessions/.test(String(sql)) ? { rows: [{ id: 5001 }] } : { rows: [] };
    },
  };
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker(_id, opts) {
        calls.turns.push({ mode: opts.mode, resume: opts.resumeSessionId || null, prompt: opts.prompt, commitMsg: opts.commitMsg });
        if (opts.mode === 'scout') return { lastResultText: '# Plant log\n\n## User-facing changes\nIt logs plants.' };
        n += 1;
        return { pushOk: true, ahead: n, sha: `sha${n}`, agentThreadId: `thread-${n}`, lastResultText: n === 1 ? 'Built.\n==== DESCRIPTION ====\nLogs plants.\n==== END DESCRIPTION ====' : 'Fixed.' };
      },
      stopTurn() { return Promise.resolve(); },
      clearPendingStop() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        await args.resolveRuntime();
        return { result: await args.dispatchOnce({ resumeSessionId: args.resumeThreadId || null }), estimatedCostUsd: args.mode === 'scout' ? 0.65 : 0.13 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext(args) { calls.turns.push({ harness: args.harness, model: args.model }); return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `b${sessionId}` }; } },
    activeWorkers: new Set(),
    seesImages: true,
    captureRound: async ({ store }) => {
      calls.captures.push(true);
      return { ok: true, capture: captureOf(calls.captures.length - 1) };
    },
    reviewDeps: {
      readArtifacts: async (_pool, ids) => new Map(ids.map((id) => [id, { id, content_type: 'image/png', data: PNG }])),
      callReviewer: async () => {
        const v = verdicts.shift() || 'ship';
        return { ok: true, text: JSON.stringify(v === 'ship' ? { verdict: 'ship', issues: [] } : { verdict: 'fix', issues: [issue('empty-state')] }), costUsd: 0.2, ms: 10 };
      },
    },
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: { dataEncryptionKey: 'k' }, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' },
  repo: { owner: 'o', repo: 'r' }, issueNumber: 1, issue: { title: 'Plant log' }, seed: 'ISSUE #1: a plant log',
  buildNote: 'x', turnBudgetMs: 60_000, propose: false, firstVersion: true,
  model: 'z-ai/glm-5.3-flash', specModel: OPUS,
};

test('a landed first version is reviewed and fixed in the same session before anything else happens to it', async () => {
  const h = buildHarness({ verdicts: ['fix', 'ship'] });
  const states = [];
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS, harnessOf: live.recipeHarness,
    review: { reviewer: REVIEWER, owner: { botRunId: 900 }, onState: async (s) => { states.push(s); } },
  });
  assert.equal(out.ok, true, out.error);
  const turns = h.calls.turns.filter((t) => t.mode);
  assert.deepEqual(turns.map((t) => t.mode), ['scout', 'build', 'build'], 'the spec, the build, one fix turn');
  const harnesses = h.calls.turns.filter((t) => t.harness);
  assert.deepEqual(harnesses.map((t) => [t.model, t.harness]), [[OPUS, 'claude'], ['z-ai/glm-5.3-flash', 'auto'], ['z-ai/glm-5.3-flash', 'auto']],
    'the Opus spec runs in Claude Code; GLM keeps the platform\'s choice');
  assert.equal(turns[2].resume, null, 'the fix starts a fresh thread: its prompt stands alone');
  assert.match(turns[2].prompt, /\[major\] phone, empty: empty-state is wrong/);
  assert.equal(turns[2].commitMsg, 'Homeroom bot: review fixes, round 1');
  assert.equal(h.calls.captures.length, 2, 'after the build, after the fix; the second is the final state');
  assert.equal(out.sha, 'sha2', 'the result is the last committed state');
  assert.equal(out.commits, 2);
  assert.equal(out.review.stop, 'ship');
  assert.equal(out.review.round0.sha, 'sha1');
  assert.ok(Math.abs(out.review.round0.costUsd - 0.78) < 1e-9, 'the spec and the build, before any review');
  assert.ok(Math.abs(out.costUsd - (0.65 + 0.13 + 0.2 + 0.13 + 0.2)) < 1e-9, 'the build\'s cost carries the review\'s');
  assert.equal(states[0].state, 'reviewing');
  assert.equal(states.at(-1).state, 'done');
  assert.equal(states.at(-1).buildText.startsWith('Built.'), true, 'kept for a restart to describe the proposal from');
});

test('a reviewer that fails leaves the build exactly as it landed, and a build with no review option is untouched', async () => {
  const h = buildHarness();
  h.deps.reviewDeps.callReviewer = async () => ({ ok: false, error: 'HTTP 503', ms: 5 });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, review: { reviewer: REVIEWER, owner: { botRunId: 900 } } });
  assert.equal(out.ok, true);
  assert.equal(out.sha, 'sha1');
  assert.equal(out.review.stop, 'reviewer_error');
  assert.equal(h.calls.turns.filter((t) => t.mode === 'build').length, 1, 'no fix turn');

  const plain = buildHarness();
  const p = await live.buildAndPropose({ pool: plain.pool, deps: plain.deps, ...ARGS });
  assert.equal(p.ok, true);
  assert.equal(p.review, undefined);
  assert.equal(plain.calls.captures.length, 0, 'nothing is captured');
  assert.deepEqual(plain.calls.turns.filter((t) => t.harness).map((t) => t.harness), ['auto', 'auto'], 'every turn keeps the platform\'s CLI');
});

test('a review fix that broke the app is rolled back on the session branch before the first version goes on', async () => {
  // The fix turn lands sha2, whose capture does not boot.
  const h = buildHarness({ verdicts: ['fix'] });
  const moved = [];
  h.deps.github = { async forceBranchToSha(...args) { moved.push(args); return { updated: true }; } };
  h.deps.captureRound = async () => {
    h.calls.captures.push(true);
    return { ok: true, capture: captureOf(h.calls.captures.length - 1, { booted: h.calls.captures.length === 1 }) };
  };
  const out = await live.buildAndPropose({
    pool: h.pool, deps: h.deps, ...ARGS, review: { reviewer: { ...REVIEWER, maxRounds: 1 }, owner: { botRunId: 900 } },
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(moved, [['o', 'r', 'b5001', 'sha1']], 'the session\'s own branch, back to the build that booted');
  assert.equal(out.sha, 'sha1', 'what goes on is the commit that booted');
  assert.equal(out.commits, 1);
  assert.equal(out.review.stop, 'regressed');
  // A bench trial's branch goes through its guarded client's own door.
  const benchMoves = [];
  await live.rollbackReviewBranch({ github: { async resetBenchBranch(...a) { benchMoves.push(a); } }, repo: { owner: 'o', repo: 'r' }, branchName: 'bench/r3-t44', sha: 'a'.repeat(40) });
  assert.deepEqual(benchMoves, [['o', 'r', 'bench/r3-t44', 'a'.repeat(40)]]);
  await assert.rejects(live.rollbackReviewBranch({ github: {}, repo: { owner: 'o', repo: 'r' }, branchName: 'main', sha: 'a'.repeat(40) }), /will not move the branch main/);
  await assert.rejects(live.rollbackReviewBranch({ github: null, repo: { owner: 'o', repo: 'r' }, branchName: 'b1', sha: 'a'.repeat(40) }), /no GitHub client/);
});

test('recipeHarness: an Anthropic model runs in Claude Code; everything else keeps the platform\'s choice', () => {
  assert.equal(live.recipeHarness(OPUS), 'claude');
  assert.equal(live.recipeHarness('Anthropic/claude-sonnet-5'), 'claude');
  assert.equal(live.recipeHarness('z-ai/glm-5.3-flash'), 'auto');
  assert.equal(live.recipeHarness(null), 'auto');
  // The operator's switch wins: OPENROUTER_MODEL_HARNESSES=none sends every
  // model to Codex, a recipe's Opus included.
  const registry0 = require('../src/agents/registry');
  assert.equal(live.recipeHarness(OPUS, { openrouterModelHarnesses: registry0.parseOpenRouterHarnessMap('none') }), 'auto');
  assert.equal(live.recipeHarness(OPUS, { openrouterModelHarnesses: registry0.parseOpenRouterHarnessMap('deepseek/deepseek-v4.1-flash=codex') }), 'auto');
  assert.equal(live.recipeHarness(OPUS, { openrouterModelHarnesses: registry0.parseOpenRouterHarnessMap('z-ai/glm-5.3-flash=claude') }), 'claude');
  // And a configuration's Opus spec thinks harder than the session's `low`.
  assert.equal(live.recipeSpecEffort(OPUS), 'medium');
  assert.equal(live.recipeSpecEffort('z-ai/glm-5.3-flash'), null, 'a GLM spec keeps the session\'s');
  // Why it is needed: the platform's own map does not list Opus.
  const registry = require('../src/agents/registry');
  assert.equal(registry.openRouterHarnessForModel(OPUS, {
    openrouterModelHarnesses: registry.parseOpenRouterHarnessMap('z-ai/glm-5.3-flash=claude,deepseek/deepseek-v4.1-flash=codex'),
  }), 'codex');
});
