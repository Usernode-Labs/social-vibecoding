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
  assert.match(p, /this is a new session\. Do not explore the repository: run\n`git diff --stat origin\/main\.\.\.HEAD` once/,
    'L1: it reads what the first version wrote, not the whole repository');
  assert.match(p, /"## Design" section/);
  assert.match(p, /after the screen's primary action was tapped once \("after tapping \.\.\."\)/);
  assert.match(p, /An issue on an "after tapping \.\.\." screen is about what the main action does/);
  assert.match(p, /boot the app and look at the screen each issue was on in the in-loop browser, at the size, look and state the\nissue names, and nowhere else/, 'its in-loop check');
});

test('L1: a fix turn checks only the screens its issues name, never the build\'s sweep or a first version\'s look rounds', () => {
  const designSkill = require('../src/services/design-skill');
  const issues = [issue('empty-state', 'blocker'), { ...issue('post'), screen: 'Phone 390×844, light look, after tapping "Post"' }];
  const p = review.fixPrompt({ seed: 'ISSUE #1', spec: '# Plant log', issues, round: 1, maxRounds: 3, readsImages: true });
  // The build's own visual sweep is not a fix turn's.
  for (const line of live.browserLines({ readsImages: true })) {
    if (/at 390x844 and at a desktop width, in both looks|EXPECTED, not optional, when the change is one a person will/.test(line)) {
      assert.ok(!p.includes(line), `not the build's sweep: ${line}`);
    }
  }
  // Nor the first version's look-and-fix rounds, in any of their words.
  for (const para of designSkill.FIRST_VERSION_LOOP.split(/\n\s*\n/)) assert.ok(!p.includes(para.trim()));
  assert.ok(!/Stop after five rounds/.test(p));
  assert.match(p, /check ONLY what the issues name/);
  assert.match(p, /Do not check other widths, looks or states, and do not run rounds of looking and polishing/);
  assert.match(p, /take a screenshot \(`browser_take_screenshot`\)/);
  assert.match(review.fixPrompt({ issues, readsImages: false }), /`browser_snapshot`; you read text, not images/);
  // The in-loop browser's own rules stay: how to boot the app, blank pages, the declared checks.
  assert.ok(p.includes(require('../src/services/in-loop-browser').IN_LOOP_BROWSER_GUIDANCE));
  // An "after tapping" issue is tried as a person would; a drag only when an issue is about one.
  assert.match(p, /do that action yourself, and check that the screen shows the result/);
  assert.ok(!p.includes(live.DRAG_TEST_LINES[1]));
  assert.ok(review.fixPrompt({ issues: [{ ...issue('order'), fix: 'make the drag move the row' }] }).includes(live.DRAG_TEST_LINES[1]));
  assert.ok(!review.fixPrompt({ issues: [issue('a')] }).includes('do that action yourself'), 'no tap issue, no tap check');
  // Its clock, when it has one: what it has, and that the fixes are all it is for.
  const started = Date.UTC(2026, 9, 12, 22, 26, 14);
  const timed = review.fixPrompt({ issues, clock: { startedAt: started, budgetMs: 10 * 60_000 } });
  assert.match(timed, /TIME\. This fix turn started at 22:26 UTC, and the platform stops it at 22:36 UTC \(10 minutes\)\. Make the fixes, check each issue's screen once, and finish/);
  assert.ok(!/TIME\./.test(p), 'no clock, no time line');
  // Each issue is one entry, its fix under it.
  assert.match(p, /1\. \[blocker\] phone, empty: empty-state is wrong\n {3}Fix: make empty-state right\n2\. \[major\] Phone 390×844/);
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

// ── A last look after the final fix (run seven, 14 Oct 2026) ─────────────
//
// Round 2 of run seven found one major issue left; its fix ran and went out
// unseen, though it had worked. A review stopped by its round limit now takes
// one last look at the final capture and records which of that round's
// issues were fixed, and nothing else changes.

test('a last look is due only after a round limit, on a final capture of the last fix that booted', async () => {
  const limit = loopHarness({ verdicts: ['fix', 'fix'], maxRounds: 2 });
  const out = await review.runReviewLoop(limit.opts);
  assert.equal(out.stop, 'round_limit');
  const due = review.finalLookDue(out);
  assert.equal(due.round, 2);
  assert.deepEqual(due.issues.map((i) => i.id), ['r2'], 'the last round\'s issues');
  assert.equal(due.capture, out.finalCapture);
  assert.equal(due.capture.shots[0].artifactId, 'a21', 'the capture after the last fix');
  // The loop itself took no look and recorded none.
  assert.deepEqual(limit.calls.review.map((r) => r.round), [1, 2]);
  assert.equal(out.finalLook, undefined);
  assert.deepEqual(review.summaryOf(out), { rounds: 2, stop: 'round_limit' });

  // Not due: a review that shipped, ran out of time, or rolled a fix back.
  const shipped = await review.runReviewLoop(loopHarness({ verdicts: ['fix', 'ship'] }).opts);
  assert.equal(review.finalLookDue(shipped), null);
  const timed = await review.runReviewLoop(loopHarness({ verdicts: ['fix', 'fix', 'fix'], budgetMinutes: 15, clockStep: 4 * 60_000 }).opts);
  assert.equal(timed.stop, 'time_budget');
  assert.equal(review.finalLookDue(timed), null);
  const regressed = await review.runReviewLoop(loopHarness({ verdicts: ['fix'], maxRounds: 1, captures: { 1: 'down' } }).opts);
  assert.equal(regressed.stop, 'regressed');
  assert.equal(review.finalLookDue(regressed), null);
  // A final capture that did not boot (its rollback failed), a fix that
  // pushed nothing, a round with no issues, an unfinished or looked-at review.
  const stuck = await review.runReviewLoop(loopHarness({ verdicts: ['fix'], maxRounds: 1, captures: { 1: 'down' }, rollback: 'fail' }).opts);
  assert.equal(stuck.stop, 'round_limit');
  assert.equal(review.finalLookDue(stuck), null);
  const clone = () => JSON.parse(JSON.stringify(out));
  const unpushed = clone();
  unpushed.rounds[1].fix.sha = null;
  assert.equal(review.finalLookDue(unpushed), null);
  const noIssues = clone();
  noIssues.rounds[1].issues = [];
  assert.equal(review.finalLookDue(noIssues), null);
  const failedFix = clone();
  failedFix.rounds[1].fix.ok = false;
  assert.equal(review.finalLookDue(failedFix), null);
  assert.equal(review.finalLookDue({ ...clone(), state: 'reviewing' }), null);
  assert.equal(review.finalLookDue({ ...clone(), finalLook: { fixed: [] } }), null);
  assert.equal(review.finalLookDue(null), null);
});

test('a last look records which of the last round\'s issues were fixed, and a failed one records why', async () => {
  const limit = loopHarness({ verdicts: ['fix', 'fix'], maxRounds: 2 });
  const out = await review.runReviewLoop(limit.opts);
  const due = review.finalLookDue({ ...out, rounds: [out.rounds[0], { ...out.rounds[1], issues: [issue('r2'), issue('check-home'), issue('r2b')] }] });
  let clock = 5_000;
  const asked = [];
  const look = await review.takeFinalLook({
    due,
    now: () => { clock += 1000; return clock; },
    review: async (args) => {
      asked.push(args);
      return {
        ok: true, verdict: 'fix', issues: [issue('check-home', 'blocker')], previousFixed: ['r2', 'check-home', 'never-raised'],
        costUsd: 0.21, ms: 38000, by: 'model',
      };
    },
  });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].round, 3, 'the reviewer is told it is the third look');
  assert.deepEqual(asked[0].previousIssues.map((i) => i.id), ['r2', 'check-home', 'r2b']);
  assert.equal(asked[0].capture, out.finalCapture);
  assert.equal(asked[0].timeoutMs, review.FINAL_LOOK_TIMEOUT_MS);
  assert.deepEqual(look.fixed, ['r2'], 'one it calls fixed but raises again is open');
  assert.deepEqual(look.open, ['check-home', 'r2b']);
  assert.equal(look.round, 2, 'the round whose fix it looked at');
  assert.equal(look.verdict, 'fix');
  assert.equal(look.costUsd, 0.21);
  assert.equal(look.ms, 38000);
  assert.equal(look.error, undefined);
  assert.match(look.at, /^\d{4}-\d\d-\d\dT/);

  const failed = await review.takeFinalLook({ due, review: async () => ({ ok: false, error: 'HTTP 502', costUsd: 0.05, ms: 100 }) });
  assert.deepEqual([failed.fixed, failed.open, failed.error, failed.costUsd], [[], [], 'HTTP 502', 0.05]);
  const threw = await review.takeFinalLook({ due, review: async () => { throw new Error('socket hang up'); } });
  assert.equal(threw.error, 'socket hang up');
  assert.deepEqual(threw.fixed, []);
});

function lookPool({ taken = false, row = true, updated = 1, fail = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (fail && fail.test(String(sql))) throw new Error('connection reset');
      if (/AS taken FROM homeroom_bot_runs/.test(sql)) return { rows: row ? [{ taken }] : [] };
      if (/UPDATE homeroom_bot_runs SET review = jsonb_set/.test(sql)) return { rowCount: updated, rows: [] };
      return { rows: [] };
    },
  };
}

test('a last look is written into the run\'s stored review once, beside its rounds, and never twice', async () => {
  const out = await review.runReviewLoop(loopHarness({ verdicts: ['fix', 'fix'], maxRounds: 2 }).opts);
  let reviewed = 0;
  const reviewer = async () => {
    reviewed += 1;
    return { ok: true, verdict: 'ship', issues: [], previousFixed: ['r2'], costUsd: 0.2, ms: 3000, by: 'model' };
  };
  const pool = lookPool();
  const look = await review.startFinalLook({ pool, runId: 900, state: out, review: reviewer });
  assert.deepEqual([look.fixed, look.open, look.verdict], [['r2'], [], 'ship']);
  assert.equal(reviewed, 1);
  const [check, write] = pool.queries;
  assert.deepEqual(check.params, [900, out.startedAt], 'the review it was taken for');
  assert.match(write.sql, /SET review = jsonb_set\(review, '\{finalLook\}', \$3::jsonb\)/);
  assert.match(write.sql, /review->>'state' = 'done'/);
  assert.match(write.sql, /review->>'startedAt' = \$2/);
  assert.match(write.sql, /review->'finalLook' IS NULL/, 'never over one already there');
  assert.doesNotMatch(write.sql, /review_rounds|review_stop/, 'the rounds and the stop the listing shows are left as they are');
  assert.deepEqual(write.params.slice(0, 2), [900, out.startedAt]);
  assert.deepEqual(JSON.parse(write.params[2]).fixed, ['r2']);

  // A restart that hands the same finished review back: the run has its look,
  // so the reviewer is not called again.
  const again = lookPool({ taken: true });
  assert.equal(await review.startFinalLook({ pool: again, runId: 900, state: out, review: reviewer }), null);
  assert.equal(reviewed, 1);
  assert.equal(again.queries.length, 1);
  // Nor for a run whose review is not this one, or a look that is not due.
  assert.equal(await review.startFinalLook({ pool: lookPool({ row: false }), runId: 900, state: out, review: reviewer }), null);
  assert.equal(review.startFinalLook({ pool, runId: 900, state: { ...out, stop: 'ship' }, review: reviewer }), null);
  assert.equal(review.startFinalLook({ pool, runId: null, state: out, review: reviewer }), null, 'a bench trial takes none');
  assert.equal(reviewed, 1);

  // A reviewer that fails is recorded as the look's error; a write that fails
  // is logged, and nothing throws.
  const failing = lookPool();
  const failed = await review.startFinalLook({ pool: failing, runId: 900, state: out, review: async () => ({ ok: false, error: 'HTTP 503', ms: 5 }) });
  assert.equal(failed.error, 'HTTP 503');
  assert.equal(JSON.parse(failing.queries[1].params[2]).error, 'HTTP 503');
  assert.equal(await review.startFinalLook({ pool: lookPool({ fail: /jsonb_set/ }), runId: 900, state: out, review: reviewer }), null);
  await review.finalLooksSettled();
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

test('reviewCapture: the eight most telling screenshots go to the reviewer as images; a malformed answer, asked for twice, fails open', async () => {
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

  deps.callReviewer = async () => ({ ok: true, text: 'I think it is fine.', costUsd: 0.25, ms: 500 });
  const bad = await review.reviewCapture({ pool: {}, userId: 7, model: OPUS, capture: captureOf(0), round: 1, maxRounds: 3, deps });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /^the reviewer did not answer with a JSON object \(asked twice\)$/);
  assert.equal(bad.costUsd, 0.5, 'both calls');
  assert.equal(bad.retry, 'the reviewer did not answer with a JSON object');

  deps.callReviewer = async () => { throw new Error('should not be called'); };
  const boot = await review.reviewCapture({ pool: {}, userId: 7, model: OPUS, capture: captureOf(0, { booted: false }), round: 1, maxRounds: 3, deps });
  assert.deepEqual({ ok: boot.ok, verdict: boot.verdict, by: boot.by, costUsd: boot.costUsd }, { ok: true, verdict: 'fix', by: 'platform', costUsd: 0 });
  assert.equal(boot.issues[0].id, 'app-does-not-boot');
});

// App bench run 193: one reply in 18 was not the JSON asked for, and that
// first version went out unreviewed.
test('reviewCapture: a reply that cannot be used is asked for once more, with the same screens, while the call\'s time allows', async () => {
  const seen = [];
  const replies = [];
  const deps = {
    readArtifacts: async (_pool, ids) => new Map(ids.map((id) => [id, { id, content_type: 'image/png', data: PNG }])),
    callReviewer: async (args) => { seen.push(args); return replies.shift(); },
  };
  const ask = (extra = {}) => review.reviewCapture({
    pool: {}, config: {}, userId: 7, model: OPUS, seed: 'REQ', spec: 'SPEC', capture: captureOf(0), round: 1, maxRounds: 3, deps, ...extra,
  });

  replies.push({ ok: true, text: 'Looks good to me overall.', costUsd: 0.25, ms: 9_000 },
    { ok: true, text: '{"verdict":"fix","issues":[{"id":"gutter","severity":"major","screen":"desktop","problem":"rows run edge to edge","fix":"centre a column"}]}', costUsd: 0.5, ms: 21_000 });
  const out = await ask({ timeoutMs: 240_000 });
  assert.deepEqual({ ok: out.ok, verdict: out.verdict, ids: out.issues.map((i) => i.id), costUsd: out.costUsd, ms: out.ms, by: out.by },
    { ok: true, verdict: 'fix', ids: ['gutter'], costUsd: 0.75, ms: 30_000, by: 'model' });
  assert.equal(out.retry, 'the reviewer did not answer with a JSON object', 'what was wrong with the first reply');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].content.slice(0, -1), seen[0].content, 'the same request and screens');
  assert.match(seen[1].content.at(-1).text, /^Your earlier answer to this message could not be used: the reviewer did not answer with a JSON object\. Answer again with ONLY the JSON object/);
  assert.equal(seen[1].timeoutMs, 240_000 - 9_000, 'within what is left of the call\'s time');

  // A first reply that works is the only call, and carries no retry.
  seen.length = 0;
  replies.push({ ok: true, text: '{"verdict":"ship","issues":[]}', costUsd: 0.25, ms: 9_000 });
  const once = await ask({ timeoutMs: 240_000 });
  assert.equal(seen.length, 1);
  assert.equal(once.retry, undefined);

  // Too little time left for another call: it fails open as before.
  seen.length = 0;
  replies.push({ ok: true, text: 'no', costUsd: 0.25, ms: 20_000 });
  const late = await ask({ timeoutMs: 20_000 + review.MIN_REVIEW_RETRY_MS - 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual({ ok: late.ok, error: late.error, retry: late.retry }, { ok: false, error: 'the reviewer did not answer with a JSON object', retry: undefined });

  // A call that failed outright (no reply) is not asked again here.
  seen.length = 0;
  replies.push({ ok: false, error: 'HTTP 502', ms: 300 });
  const failed = await ask({ timeoutMs: 240_000 });
  assert.equal(seen.length, 1);
  assert.deepEqual({ ok: failed.ok, error: failed.error }, { ok: false, error: 'HTTP 502' });

  // The second call failing outright: its error, after both calls.
  seen.length = 0;
  replies.push({ ok: true, text: '```json\n{"verdict":"maybe"}\n```', costUsd: 0.25, ms: 9_000 }, { ok: false, error: 'HTTP 502', ms: 300 });
  const second = await ask({ timeoutMs: 240_000 });
  assert.equal(seen.length, 2);
  assert.deepEqual({ ok: second.ok, error: second.error, retry: second.retry, costUsd: second.costUsd, ms: second.ms },
    { ok: false, error: 'HTTP 502 (asked twice)', retry: 'the reviewer\'s verdict is neither ship nor fix', costUsd: 0.25, ms: 9_300 });
});

test('the loop records a round\'s retried reviewer call on the round', async () => {
  const h = loopHarness({ verdicts: ['ship'] });
  const reviewOf = h.opts.review;
  h.opts.review = async (args) => ({ ...(await reviewOf(args)), retry: 'the reviewer did not answer with a JSON object' });
  const out = await review.runReviewLoop(h.opts);
  assert.equal(out.stop, 'ship');
  assert.equal(out.rounds[0].reviewerRetry, 'the reviewer did not answer with a JSON object');
  const plain = loopHarness({ verdicts: ['ship'] });
  assert.equal((await review.runReviewLoop(plain.opts)).rounds[0].reviewerRetry, undefined);
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

// Run 196: two first versions built, then their fix turns were refused by
// OpenRouter for the key's spending limit, and their reviews stopped after
// one round. The refusal is in the turn's last lines, not its exit code.
test('a fix turn the provider refused keeps what it last did, so a review it cut short says why', async () => {
  const h = buildHarness({ verdicts: ['fix'] });
  const real = h.deps.worker.execInWorker;
  let builds = 0;
  h.deps.worker.execInWorker = async (id, opts) => {
    if (opts.mode === 'build' && ++builds === 2) {
      opts.onProgress?.('OpenRouter request #1: http_error after 0s, HTTP 403');
      opts.onProgress?.('Failed to authenticate. API Error: 403 Key limit exceeded (weekly limit).');
      return { agentHarness: 'claude', ccExit: 1, pushOk: false, ahead: 0, lastResultText: '' };
    }
    return real(id, opts);
  };
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, review: { reviewer: REVIEWER, owner: { botRunId: 900 } } });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.sha, 'sha1', 'what landed is kept');
  assert.equal(out.review.stop, 'fix_failed');
  assert.match(out.review.stopDetail, /^the fix turn failed \(the agent exited with code 1\); last activity: .*403 Key limit exceeded \(weekly limit\)/);
  assert.equal(out.review.rounds[0].fix.error, out.review.stopDetail);
  // The bench reads such a trial as the platform's fault (lane.js asPlatformFault).
  assert.equal(require('../src/services/bench/lane').asPlatformFault({ status: 'ok', parsed: { review: out.review } }).status, 'infra_fail');
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

test('run seven: a first version stopped by its round limit gets a last look that changes nothing and says nothing', async () => {
  const h = buildHarness();
  const reviewerCalls = [];
  h.deps.reviewDeps.callReviewer = async ({ content }) => {
    reviewerCalls.push(content[0].text);
    if (reviewerCalls.length <= 2) {
      return { ok: true, text: JSON.stringify({ verdict: 'fix', issues: [issue(`left-${reviewerCalls.length}`)] }), costUsd: 0.2, ms: 10 };
    }
    return { ok: true, text: JSON.stringify({ verdict: 'ship', issues: [], previousFixed: ['left-2'] }), costUsd: 0.15, ms: 12 };
  };
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/AS taken FROM homeroom_bot_runs/.test(sql)) return { rows: [{ taken: false }] };
      if (/jsonb_set\(review, '\{finalLook\}'/.test(sql)) return { rowCount: 1, rows: [] };
      return /INSERT INTO chat_sessions/.test(String(sql)) ? { rows: [{ id: 5001 }] } : { rows: [] };
    },
  };
  const states = [];
  const progress = [];
  const out = await live.buildAndPropose({
    pool, deps: h.deps, ...ARGS, harnessOf: live.recipeHarness, onProgress: (line) => progress.push(line),
    review: { reviewer: { ...REVIEWER, maxRounds: 2 }, owner: { botRunId: 900 }, onState: async (s) => { states.push(s); } },
  });
  assert.equal(out.ok, true, out.error);
  // The build went on as before: two rounds, the round limit, the last fix kept.
  assert.equal(out.sha, 'sha3');
  assert.equal(out.review.stop, 'round_limit');
  assert.equal(out.review.rounds.length, 2);
  assert.deepEqual(review.summaryOf(out.review), { rounds: 2, stop: 'round_limit' });
  assert.ok(Math.abs(out.review.costUsd - (0.2 + 0.13 + 0.2 + 0.13)) < 1e-9, 'the review\'s own cost, without the look');
  await review.finalLooksSettled();
  // Then the look: the final capture, with round 2's issue as PREVIOUS ISSUES.
  assert.equal(reviewerCalls.length, 3);
  assert.match(reviewerCalls[2], /^ROUND 3 of 3\./);
  assert.match(reviewerCalls[2], /==== PREVIOUS ISSUES ====[\s\S]*left-2/);
  const write = queries.find((q) => /jsonb_set\(review, '\{finalLook\}'/.test(q.sql));
  assert.equal(write.params[0], 900);
  const look = JSON.parse(write.params[2]);
  assert.deepEqual([look.round, look.fixed, look.open, look.verdict, look.costUsd], [2, ['left-2'], [], 'ship', 0.15]);
  // Recorded only: no state the build saved has it or a third round, no
  // stage or progress line names it, and the run's listing columns are
  // never written by it.
  assert.ok(states.every((s) => !s.finalLook && s.rounds.length <= 2));
  assert.equal(out.review.finalLook, undefined);
  const stages = queries.filter((q) => Array.isArray(q.params) && q.params[2] === 'first_version_stage')
    .map((q) => JSON.parse(q.params[3])).filter((d) => d.stage === 'review_round');
  assert.deepEqual(stages.map((d) => d.round), [1, 2], 'no "round 3 of 2"');
  assert.ok(!progress.some((line) => /round 3/.test(line)), progress.join('\n'));
  assert.ok(!queries.some((q) => /review_rounds|review_stop/.test(q.sql) && /finalLook/.test(q.sql)));
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
