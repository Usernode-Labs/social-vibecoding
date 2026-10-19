'use strict';

// L2: a Homeroom bot build or review-fix turn is held to the app's own
// declared checks before it ends, the way run four's checks-fix turn did the
// checker's steps by hand (12 Oct 2026, Club Votes: the proposal's checks
// failed on the post-a-decision sheet, and a checks fix redid it in eleven
// more minutes after the proposal).
//
// The declared checks (dapp.json `tests`) run on every proposal, signed in,
// against its staging copy (capture/capture.js in a check Job), and a failing
// one blocks the merge. In the worker, a plain in-loop launch is signed out
// (an app behind the platform's identity answers 401 on every route), so
// `usernode-run-checks` against it says little. These pin:
//
//   - the screenshot step's script runs them signed in, with the capture's
//     semantics (worker/usernode-bench-capture.js runDeclaredChecks), in the
//     review's captures and, with BENCH_CAPTURE_MODE=checks, on its own;
//   - a review round turns a failing check into a blocker for its fix turn,
//     whatever the reviewer said (bot-review.js checkIssues), and tap targets
//     the capture measured under 44px into an issue of their own
//     (tapTargetIssue);
//   - the worker writes the check command before each bot build and fix turn
//     (worker.js writeAppCheck), and gives the stop guard its checks gate
//     (STOP_GUARD_CHECKS) for a Claude Code build that asks;
//   - the prompts say how to run it.
// The hook's own gate, and run-cc.sh with it, are pinned in
// tests/build-stop-hook.test.js.
//
// Run with: node --test tests/app-checks-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const step = require('../worker/usernode-bench-capture');
const captureMod = require('../src/services/bench/capture');
const review = require('../src/services/bot-review');
const live = require('../src/services/homeroom-bot-live');
const worker = require('../src/services/worker');

const OPUS = 'anthropic/claude-opus-5.5';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('the declared checks are read as the platform reads them, and opened signed in', () => {
  const list = step.declaredChecks({
    tests: [
      { name: 'Post a decision', path: '/?sheet=post', expectText: 'Posted' },
      { path: '/#/votes', expectSelector: '[data-votes]' },
      { name: 'Post a decision', path: '/?sheet=post', expectText: 'dup' },
      { name: 'bad', path: 'https://evil.example/' },
      { name: 'bad2', path: '//x' },
      null,
    ],
  });
  assert.deepEqual(list.map((t) => [t.name, t.path]), [['Post a decision', '/?sheet=post'], ['/#/votes', '/#/votes']]);
  assert.equal(list[1].expectSelector, '[data-votes]');
  assert.deepEqual(step.declaredChecks({}), []);
  assert.equal(step.checkUrl('http://localhost:3191', '/?sheet=post', 'tok'), 'http://localhost:3191/?sheet=post&token=tok');
  assert.equal(step.checkUrl('http://localhost:3191/', '/#/votes', 'tok'), 'http://localhost:3191/?token=tok#/votes', 'a hash route keeps its hash');
  assert.equal(step.checkUrl('http://localhost:3191', '/about', null), 'http://localhost:3191/about');
});

// A browser that serves each URL as `pages` says.
function fakeBrowser(pages) {
  const opened = [];
  return {
    opened,
    async newContext() {
      return {
        async newPage() {
          const handlers = {};
          let page = null;
          return {
            on(ev, fn) { handlers[ev] = fn; },
            async goto(url) {
              opened.push(url);
              const key = Object.keys(pages).find((k) => url.includes(k));
              page = pages[key] || { status: 404 };
              if (page.throws) throw new Error(`${page.throws} at ${url}`);
              for (const msg of page.errors || []) handlers.console?.({ type: () => 'error', text: () => msg });
              return { status: () => page.status || 200 };
            },
            async waitForLoadState() {},
            async $(sel) { return (page.selectors || []).includes(sel) ? {} : null; },
            async evaluate(_fn, text) { return String(page.text || '').toLowerCase().includes(String(text).toLowerCase()); },
          };
        },
        async close() {},
      };
    },
  };
}

test('runDeclaredChecks: one load per route, signed in; status, element, text and console errors as the proposal\'s checks judge them', async () => {
  const tests = step.declaredChecks({
    tests: [
      { name: 'home loads', path: '/' },
      { name: 'post sheet', path: '/?sheet=post', expectText: 'Posted' },
      { name: 'post sheet field', path: '/?sheet=post', expectSelector: 'form[data-post]' },
      { name: 'votes', path: '/#/votes', expectSelector: '[data-votes]' },
      { name: 'noisy but allowed', path: '/noisy', allowConsoleErrors: true },
      { name: 'noisy', path: '/loud' },
      { name: 'locked', path: '/admin' },
      { name: 'gone', path: '/crash' },
    ],
  });
  const browser = fakeBrowser({
    '/?sheet=post': { text: '[object HTMLFormElement]', selectors: ['form[data-post]'] },
    '/?token=': { text: 'Club Votes', selectors: ['[data-votes]'] },
    '/noisy': { errors: ['x is undefined'] },
    '/loud': { errors: ['TypeError: cannot read properties of null'] },
    '/admin': { status: 401 },
    '/crash': { throws: 'net::ERR_CONNECTION_RESET' },
  });
  const FAST = { settleMs: 1, assertMs: 30, pollMs: 5 };
  const out = await step.runDeclaredChecks(browser, 'http://localhost:3191', 'SECRET-TOKEN', tests, { secrets: ['SECRET-TOKEN'], ...FAST });
  assert.equal(out.total, 8);
  assert.equal(out.ran, 8);
  assert.equal(new Set(browser.opened).size, browser.opened.length, 'checks on one route share one load');
  assert.equal(browser.opened.length, 7);
  assert.ok(browser.opened.every((u) => u.includes('token=SECRET-TOKEN')), 'signed in, every one');
  const failed = Object.fromEntries(out.failed.map((f) => [f.name, f.reason]));
  assert.deepEqual(Object.keys(failed).sort(), ['gone', 'locked', 'noisy', 'post sheet']);
  assert.match(failed['post sheet'], /the text "Posted" it expects was not on the page/);
  assert.match(failed.locked, /HTTP 401/);
  assert.match(failed.noisy, /1 console error on load: TypeError/);
  assert.match(failed.gone, /the page failed to load: net::ERR_CONNECTION_RESET/);
  assert.ok(!JSON.stringify(out).includes('SECRET-TOKEN'), 'the viewer\'s token never comes back');
  assert.equal(out.passed, 4);
  // What an agent running the command reads.
  const lines = step.checksReport(out);
  assert.match(lines[0], /^Ran 8 of the 8 checks dapp\.json declares, signed in, on a fresh copy of the app:/);
  assert.ok(lines.some((l) => /^ {2}FAIL {2}post sheet \(\/\?sheet=post\): the text "Posted"/.test(l)));
  assert.equal(lines.at(-1), '4 passed, 4 failed.');
  assert.deepEqual(step.checksReport({ total: 0 }), ['This app declares no checks in dapp.json: nothing to run.']);
  assert.match(step.checksReport(null, { booted: false, error: 'npm run build failed' })[0], /did not boot, so no check ran: npm run build failed/);
  // A suite past its bound is cut, and says so.
  const many = step.declaredChecks({ tests: Array.from({ length: step.MAX_DECLARED_CHECKS + 3 }, (_, i) => ({ path: `/p${i}` })) });
  const cut = await step.runDeclaredChecks(fakeBrowser({ '/p': {} }), 'http://localhost:3191', 't', many, FAST);
  assert.equal(cut.cut, 3);
  assert.match(step.checksReport(cut).at(-1), /3 not run \(past the bound or the time\)/);
});

// App bench run 191: both checks-gate send-backs were a `?demo=1` check whose
// demo stored the viewer's rows and a `/` check of the empty state, which a
// proposal's checks run on one database as one viewer. Here the `?demo=1`
// routes go first, so that pair fails every time, and says why.
test('runDeclaredChecks: the ?demo=1 routes run first, and a plain route failing after them is told why', async () => {
  assert.equal(step.isDemoPath('/?demo=1'), true);
  assert.equal(step.isDemoPath('/feeds?sort=new&demo=1'), true);
  assert.equal(step.isDemoPath('/'), false);
  assert.equal(step.isDemoPath('/?demo=0'), false);
  const tests = step.declaredChecks({
    tests: [
      { name: 'Empty state', path: '/', expectText: 'Add your first feed' },
      { name: 'Settings', path: '/settings' },
      { name: 'Demo list', path: '/?demo=1', expectSelector: '[data-post]' },
      { name: 'Demo label', path: '/?demo=1', expectText: 'Staging demo' },
      { name: 'Demo feeds', path: '/feeds?demo=1' },
    ],
  });
  // The demo stores the viewer's rows: once it has loaded, `/` shows them.
  let demoLoaded = false;
  const opened = [];
  const browser = {
    async newContext() {
      return {
        async newPage() {
          let url = '';
          return {
            on() {},
            async goto(u) {
              url = u;
              opened.push(new URL(u).pathname + new URL(u).search.replace(/[?&]token=[^&]*/, ''));
              if (/demo=1/.test(u)) demoLoaded = true;
              return { status: () => 200 };
            },
            async waitForLoadState() {},
            async $(sel) { return sel === '[data-post]' ? {} : null; },
            async evaluate(_fn, text) {
              const body = /demo=1/.test(url) ? 'Staging demo · 14 posts' : (demoLoaded ? '14 posts' : 'Add your first feed');
              return body.toLowerCase().includes(String(text).toLowerCase());
            },
          };
        },
        async close() {},
      };
    },
  };
  const out = await step.runDeclaredChecks(browser, 'http://localhost:3191', 't', tests, { settleMs: 1, assertMs: 20, pollMs: 5 });
  assert.deepEqual(opened.slice(0, 2).sort(), ['/?demo=1', '/feeds?demo=1'], 'the demo routes first, together');
  assert.deepEqual(opened.slice(2).sort(), ['/', '/settings']);
  assert.equal(out.ran, 5);
  assert.deepEqual(out.failed.map((f) => f.name), ['Empty state'], 'every time, not now and then');
  assert.match(out.failed[0].reason, /^the text "Add your first feed" it expects was not on the page \(It ran after the \?demo=1 checks, as the same viewer on the same database, as on the platform: demo rows stored for the viewer are there\.\)$/);
  assert.ok(out.failed[0].reason.length <= 300, 'within what the gate shows of a reason');
  // A long reason keeps the note whole.
  const long = await step.runDeclaredChecks(fakeBrowser({ '/?demo=1': {}, '/x': { errors: ['E'.repeat(400)] } }), 'http://localhost:3191', 't',
    step.declaredChecks({ tests: [{ path: '/x' }, { path: '/?demo=1' }] }), { settleMs: 1, assertMs: 5, pollMs: 1 });
  assert.ok(long.failed[0].reason.endsWith(step.AFTER_DEMO_NOTE));
  // With no demo route, nothing is said of one.
  const plain = await step.runDeclaredChecks(fakeBrowser({ '/x': { errors: ['E'] } }), 'http://localhost:3191', 't',
    step.declaredChecks({ tests: [{ path: '/x' }] }), { settleMs: 1, assertMs: 5, pollMs: 1 });
  assert.ok(!plain.failed[0].reason.includes('?demo=1'));
});

// App bench run 191: a check command piped to `head` died on the closed pipe
// before it stopped its app, and the next run checked that app's old code.
test('the step stops an earlier run\'s app on its port before it boots, and checks nothing it did not start', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'app-check-port-'));
  const launcher = path.join(dir, 'launcher');
  const log = path.join(dir, 'calls');
  fs.writeFileSync(launcher, `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + ' port=' + process.env.INLOOP_PORT + '\\n');`);
  const cleared = await step.clearPort({ env: { PATH: process.env.PATH }, port: 3191, launcher, answers: async () => 0 });
  assert.deepEqual(cleared, { ok: true });
  assert.equal(fs.readFileSync(log, 'utf8'), '--stop port=3191\n', 'the launcher stops what it recorded there');
  const busy = await step.clearPort({ env: {}, port: 3191, launcher, answers: async () => 200 });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /port 3191 is held by a process this step did not start, so it was not checked/);
  // And a closed output does not end the step before it stops its app.
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'usernode-bench-capture.js'), 'utf8');
  assert.match(src, /async function main\(\) \{\n[^]*?process\.stdout\.on\('error', \(\) => \{\}\);/);
  assert.match(src, /const cleared = await clearPort\(\{ env: appEnv, port \}\);[^]*?const booted = await bootApp\(/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the capture keeps what the declared checks came to, bounded', () => {
  const summary = captureMod.summarize({
    booted: true,
    declaredChecks: { total: 3, ran: 3, passed: 2, failed: [{ name: 'post sheet', path: '/?sheet=post', reason: 'x'.repeat(900) }], cut: 0, ms: 9 },
  });
  assert.deepEqual(Object.keys(summary.declaredChecks).sort(), ['cut', 'failed', 'passed', 'ran', 'total']);
  assert.equal(summary.declaredChecks.failed[0].reason.length, 300);
  assert.equal(captureMod.summarize({ booted: true }).declaredChecks, null, 'a capture that ran none');
});

const failingCapture = () => ({
  booted: true,
  shots: [{ id: 'phone-light-populated', viewport: 'phone', look: 'light', state: 'populated', sha256: 'a'.repeat(64), artifactId: 'a'.repeat(32) }],
  declaredChecks: {
    total: 2, ran: 2, passed: 1, cut: 0,
    failed: [{ name: 'post a decision', path: '/?sheet=post', reason: 'the text "Posted" it expects was not on the page' }],
  },
});

test('a review round makes each failing declared check a blocker for its fix turn, whatever the reviewer saw', async () => {
  const issues = review.checkIssues(failingCapture());
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'blocker');
  assert.equal(issues[0].id, 'check-post-a-decision');
  assert.match(issues[0].screen, /^the declared check "post a decision" \(\/\?sheet=post\)$/);
  assert.match(issues[0].problem, /fails on a fresh copy of the app, signed in, as the proposal's checks will run it, and a failing check blocks the merge: the text "Posted"/);
  assert.match(issues[0].fix, /never loosen, skip or delete it/);
  assert.deepEqual(review.checkIssues({ booted: true }), []);
  const many = { declaredChecks: { failed: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, path: `/p${i}`, reason: 'r' })) } };
  assert.equal(review.checkIssues(many).length, review.MAX_CHECK_ISSUES);

  const call = async (verdict) => review.reviewCapture({
    pool: {}, config: {}, userId: 1, model: OPUS, seed: 's', spec: 'p', capture: failingCapture(), round: 1, maxRounds: 3,
    deps: {
      readArtifacts: async (_p, ids) => new Map(ids.map((id) => [id, { content_type: 'image/png', data: PNG }])),
      callReviewer: async () => ({
        ok: true, costUsd: 0.1, ms: 1,
        text: JSON.stringify(verdict === 'ship' ? { verdict: 'ship', issues: [] }
          : { verdict: 'fix', issues: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, severity: 'minor', screen: 's', problem: 'p', fix: 'f' })) }),
      }),
    },
  });
  const shipped = await call('ship');
  assert.equal(shipped.verdict, 'fix', 'a ship with a failing check is a fix');
  assert.deepEqual(shipped.issues.map((i) => i.id), ['check-post-a-decision']);
  assert.equal(shipped.checksFailing, 1);
  const fixed = await call('fix');
  assert.equal(fixed.issues[0].id, 'check-post-a-decision', 'first');
  assert.equal(fixed.issues.length, review.MAX_ISSUES, 'and the reviewer\'s after it, eight in all');
  // A capture carried over a restart keeps them.
  assert.deepEqual(review.reviewForm(failingCapture()).declaredChecks.failed.length, 1);
});

// App bench run 216 (19 Oct 2026): first versions built on DeepSeek V4.1
// Flash 1017 kept 0.8 tap targets under 44px a build, GLM's none, and the
// reviewer passed every one.
const smallTaps = (small = 2) => ({
  smallTapTargets: {
    small, checked: 9,
    samples: [{ tag: 'button', text: 'Remove', width: 28, height: 28 }, { tag: 'a', text: 'Edit', width: 60, height: 32 }].slice(0, small),
  },
});

test('a review round makes tap targets measured under 44px an issue for its fix turn, whatever the reviewer saw', async () => {
  const issue = review.tapTargetIssue({ booted: true, checks: smallTaps() });
  assert.equal(issue.id, 'tap-targets-under-44px');
  assert.equal(issue.severity, 'major');
  assert.match(issue.problem, /^2 tappable controls are smaller than 44px wide or tall, as the platform measured on the phone screen: "Remove" \(28x28px\), "Edit" \(60x32px\)\./);
  assert.match(issue.fix, /at least 44px wide and 44px tall[^]*without changing how the screen looks/);
  assert.match(review.tapTargetIssue({ checks: smallTaps(1) }).problem, /^1 tappable control is smaller/);
  assert.equal(review.tapTargetIssue({ booted: true }), null, 'nothing measured');
  assert.equal(review.tapTargetIssue({ checks: smallTaps(0) }), null, 'none small');
  assert.equal(review.tapTargetIssue({ checks: { smallTapTargets: { small: null, checked: 0, samples: [] } } }), null, 'no phone screen measured');
  // A capture carried over a restart has them in its signals.
  const carried = review.reviewForm({ ...failingCapture(), declaredChecks: null, checks: smallTaps() });
  assert.equal(carried.checks, undefined, 'its checks stay in the private stores');
  assert.match(review.tapTargetIssue(carried).problem, /^2 tappable controls[^]*"Remove" \(28x28px\)/);
  assert.match(review.tapTargetIssue({
    signals: { automaticChecks: { tapTargetsUnder44px: { small: 1, checked: 4, examples: [{ text: '' }] } } },
  }).problem, /^1 tappable control is smaller[^]*: "a control with no label"\./, 'no size, no label');

  const call = async (capture, verdict) => review.reviewCapture({
    pool: {}, config: {}, userId: 1, model: OPUS, seed: 's', spec: 'p', capture, round: 1, maxRounds: 2,
    deps: {
      readArtifacts: async (_p, ids) => new Map(ids.map((id) => [id, { content_type: 'image/png', data: PNG }])),
      callReviewer: async () => ({
        ok: true, costUsd: 0.1, ms: 1,
        text: JSON.stringify(verdict === 'ship' ? { verdict: 'ship', issues: [] }
          : { verdict: 'fix', issues: [{ id: 'r1', severity: 'minor', screen: 's', problem: 'p', fix: 'f' }] }),
      }),
    },
  });
  const tapOnly = { ...failingCapture(), declaredChecks: null, checks: smallTaps(1) };
  const shipped = await call(tapOnly, 'ship');
  assert.equal(shipped.verdict, 'fix', 'a ship with a tap target under 44px is a fix');
  assert.deepEqual(shipped.issues.map((i) => i.id), ['tap-targets-under-44px']);
  assert.equal(shipped.tapTargetsSmall, 1);
  assert.equal(shipped.checksFailing, undefined, 'no check failed');
  const both = await call({ ...failingCapture(), checks: smallTaps() }, 'fix');
  assert.deepEqual(both.issues.map((i) => i.id), ['check-post-a-decision', 'tap-targets-under-44px', 'r1'], 'checks, then taps, then the reviewer\'s');
  assert.deepEqual([both.checksFailing, both.tapTargetsSmall], [1, 2]);
  const clean = await call({ ...failingCapture(), declaredChecks: null, checks: smallTaps(0) }, 'ship');
  assert.deepEqual([clean.verdict, clean.issues], ['ship', []], 'nothing measured small: the reviewer\'s ship stands');
});

test('the worker writes the check command for the app, and gives the checks gate only to a Claude Code build that asks', () => {
  const cmd = worker.buildAppCheckCommand(42);
  assert.match(cmd, /^#!\/bin\/sh\n/);
  assert.match(cmd, /cd "\$\{1:-\/home\/node\/workspace\}"/);
  assert.match(cmd, new RegExp(`BENCH_CAPTURE_MODE=checks INLOOP_PORT=${worker.APP_CHECK_PORT} INLOOP_DATABASE_URL=postgres://postgres:postgres@127\\.0\\.0\\.1:5432/inloop_checks BENCH_INLOOP_DB_SCRIPT=/nonexistent BENCH_APP_ID=42 node /home/node/\\.claude/usernode-app-check\\.js`));
  assert.notEqual(worker.APP_CHECK_PORT, require('../src/services/in-loop-browser').INLOOP_PORT, 'not the agent\'s own launch');
  assert.notEqual(worker.APP_CHECK_PORT, captureMod.CAPTURE_PORT, 'nor the screenshot step\'s');
  assert.throws(() => worker.buildAppCheckCommand('1; rm -rf /'), /invalid app id/);
  assert.throws(() => worker.buildAppCheckCommand(0), /invalid app id/);
  const src = require('node:fs').readFileSync(require.resolve('../src/services/worker'), 'utf8');
  const gate = src.slice(src.indexOf("if (stopGuard === true && mode === 'build' && runsClaude) {"));
  assert.match(gate.slice(0, 600), /safeEnv\.STOP_GUARD = '1';\s*if \(checksGate && typeof checksGate === 'object'\) \{\s*safeEnv\.STOP_GUARD_CHECKS = APP_CHECK_COMMAND_PATH;/);
  assert.match(gate.slice(0, 900), /if \(checksGate\.requireTests === true\) safeEnv\.STOP_GUARD_REQUIRE_TESTS = '1';/);
});

test('the prompts say how to run the app\'s checks, signed in, when the runner holds the turn to them', () => {
  const lines = live.appChecksLines().join('\n');
  assert.match(lines, /sh \/home\/node\/\.claude\/usernode-app-check/);
  assert.match(lines, /signed in as the proposal's checks are, runs every declared\scheck/);
  // Run 191: three builds wrote their checks under `checks`, which the platform never reads.
  assert.match(lines, /Every check in dapp\.json's top-level `tests` array runs on the proposal/);
  assert.ok(!lines.includes('A first version declares'), 'a later change is not told a first version\'s rule');
  const build = live.buildPrompt({ seed: 'ISSUE #1', buildNote: 'x', appChecks: true });
  assert.ok(build.includes(lines));
  // A first version's: the key, that a turn with none is sent back, and the
  // checks sharing one account and one database with the `?demo=1` demo.
  const first = live.appChecksLines({ firstVersion: true }).join('\n');
  assert.ok(first.startsWith(lines));
  assert.match(first, /A first version declares two or three checks there \(the platform reads no other key: checks under `checks` never run\),\nand a turn that ends with none is sent back\./);
  assert.match(first, /The checks run at the same time, signed in as one account, on one\ndatabase: rows the `\?demo=1` demo stores for the viewer are there when a check of a plain route runs\./);
  assert.match(first, /add them to the `\?demo=1` answers\nwithout storing them, or store them marked as demo and leave those out of every answer without `\?demo=1`\./);
  assert.ok(live.buildPrompt({ seed: 'ISSUE #1', buildNote: 'x', appChecks: true, firstVersion: true }).includes(first));
  assert.ok(live.appChecksLines({ lean: true, firstVersion: true }).join('\n').endsWith(live.FIRST_VERSION_CHECKS_LINES.join('\n')));
  for (const line of live.FIRST_VERSION_CHECKS_LINES) assert.ok(!/—/.test(line), line);
  assert.ok(!live.buildPrompt({ seed: 'ISSUE #1', buildNote: 'x' }).includes('THE APP\'S OWN CHECKS'));
  const fix = review.fixPrompt({ issues: [], appChecks: true });
  assert.ok(fix.includes(first), 'a review\'s fix is a first version\'s');
  assert.ok(!review.fixPrompt({ issues: [] }).includes('THE APP\'S OWN CHECKS'));
});

test('the bot\'s runner writes the check before each turn and turns the gate on; not for the platform\'s own repository', async () => {
  const written = [];
  const dispatched = [];
  const make = (checksGate, firstVersion = false) => live.buildTurnRunner({
    pool: { async query() { return { rows: [], rowCount: 1 }; } },
    config: {}, bot: { id: 7 }, session: { id: 5001, app_id: 42 }, model: 'z-ai/glm-5.3-flash', branchName: 'dev/b', containerName: 'w',
    checksGate, firstVersion,
    deps: {
      worker: {
        async writeAppCheck(id, { source, appId }) { written.push([id, appId, source.includes('runDeclaredChecks')]); },
        async execInWorker(_id, opts) { dispatched.push(opts); return { pushOk: true, ahead: 1, sha: 'x' }; },
        async stopTurn() {},
      },
      sessions: { async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}) }; } },
      agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
      activeWorkers: new Set(),
    },
  });
  const before = Date.now();
  await make(true)({ prompt: 'p', budgetMs: 600_000, commitMsg: 'm', progress: { note() {} } });
  assert.deepEqual(written, [[5001, 42, true]], 'the platform\'s current script, for this app');
  assert.ok(dispatched[0].checksGate.deadlineMs >= before + 600_000, 'with the turn\'s own deadline');
  assert.equal(dispatched[0].stopGuard, true);
  assert.equal(dispatched[0].checksGate.requireTests, undefined, 'a later change\'s dapp.json is left as it is');
  await make(false)({ prompt: 'p', budgetMs: 600_000, commitMsg: 'm', progress: { note() {} } });
  assert.equal(written.length, 1);
  assert.equal(dispatched[1].checksGate, undefined);
  // A first version's turns must declare their checks under `tests` too.
  await make(true, true)({ prompt: 'p', budgetMs: 600_000, commitMsg: 'm', progress: { note() {} } });
  assert.equal(dispatched.pop().checksGate.requireTests, true);
  // A write that fails runs the turn without the gate.
  const failing = live.buildTurnRunner({
    pool: { async query() { return { rows: [], rowCount: 1 }; } },
    config: {}, bot: { id: 7 }, session: { id: 5002, app_id: 42 }, model: 'm', branchName: 'dev/b', containerName: 'w', checksGate: true,
    deps: {
      worker: { async writeAppCheck() { throw new Error('exec refused'); }, async execInWorker(_id, opts) { dispatched.push(opts); return {}; }, async stopTurn() {} },
      sessions: { async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}) }; } },
      agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
      activeWorkers: new Set(),
    },
  });
  await failing({ prompt: 'p', budgetMs: 1000, commitMsg: 'm', progress: { note() {} } });
  assert.equal(dispatched[2].checksGate, undefined);
  // And the build's runner, which its review's fix turns share (also after a
  // restart: the build carries on from its saved steps), asks for it unless
  // the repository is the platform's own.
  const liveSrc = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot-live'), 'utf8');
  assert.match(liveSrc, /harness: buildHarness, telemetry, onProgress, checksGate: appChecksOn\(platformRepo\),/);
});

test('the gate and the detached capture each have an off switch', () => {
  assert.equal(live.appChecksOn(false, {}), true);
  assert.equal(live.appChecksOn(true, {}), false, 'never the platform\'s own repository');
  assert.equal(live.appChecksOn(false, { HOMEROOM_BOT_CHECKS_GATE: '0' }), false);
  assert.equal(live.appChecksOn(false, { HOMEROOM_BOT_CHECKS_GATE: '1' }), true);
  assert.equal(live.detachedCaptureOn({}), true);
  assert.equal(live.detachedCaptureOn({ HOMEROOM_BOT_DETACHED_CAPTURE: '0' }), false);
});
