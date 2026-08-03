// Behavioural tests for capture/capture.js captureTarget — how many page
// loads a target costs, and whether it starts a recording that cannot
// produce anything. Both were measured regressions in the proposal-checks
// slowdown (production, 2026-07-26 → 2026-08-03):
//
//   - the phone frame was a SECOND capture target, so every path cost a
//     fresh page + cold networkidle2 navigation per side: a two-route
//     proposal loaded 8 pages instead of 4;
//   - the recording pass ran on pages that fit their viewport, where
//     Chromium's change-driven screencast emits no frames — ~270 "empty
//     webm" failures in two weeks, each after ~6s of holds plus an ffmpeg
//     attempt, storing nothing.
//
// A fake browser stands in for Chromium: captureTarget takes its page from
// the browser it is handed, so the navigation count, the screencast calls and
// the emitted frames are all observable without a real renderer.
//
// Run with: node --test tests/capture-target-behaviour.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { captureTarget, setFrameSink } = require('../capture/capture');

// Fake page. `scrollable` controls what the in-page scrollability probe
// reports; `log` records every interesting call in order.
function makePage({ scrollable = true, log } = {}) {
  const page = {
    on() {},
    async setViewport(v) { log.push({ call: 'setViewport', viewport: { ...v } }); },
    async setCookie() { log.push({ call: 'setCookie' }); },
    async goto(url) { log.push({ call: 'goto', url }); return { status: () => 200 }; },
    async reload() { log.push({ call: 'reload' }); return { status: () => 200 }; },
    async screenshot() { log.push({ call: 'screenshot' }); return Buffer.from('PNGDATA'); },
    async evaluate(fn) {
      // Two evaluates exist: the scrollability probe (returns a boolean) and
      // the repaint wait / scroll pass (return undefined). Distinguish by
      // source text rather than call order, which the fix reorders.
      const src = String(fn);
      if (/scrollHeight/.test(src) && /innerHeight/.test(src) && />= 8/.test(src)) {
        log.push({ call: 'scrollProbe' });
        return scrollable;
      }
      if (/requestAnimationFrame/.test(src)) { log.push({ call: 'awaitRepaint' }); return undefined; }
      log.push({ call: 'evaluate' });
      return undefined;
    },
    async screencast() {
      log.push({ call: 'screencast' });
      return { async stop() { log.push({ call: 'screencast.stop' }); } };
    },
    async close() { log.push({ call: 'close' }); },
  };
  return page;
}

function makeBrowser(opts = {}) {
  const log = opts.log;
  return {
    pagesOpened: 0,
    async newPage() { log.push({ call: 'newPage' }); this.pagesOpened++; return makePage({ ...opts, log }); },
  };
}

// Collect the emitted frames via the module's frame sink (NOT by patching
// process.stdout — that would swallow the test runner's own TAP output).
async function collect(fn) {
  const written = [];
  setFrameSink((chunk) => { written.push(String(chunk)); });
  try { await fn(); } finally { setFrameSink(null); }
  return written.join('').split('\n')
    .filter((l) => /^__USERNODE_(SHOT|SHOT_FAIL|CONSOLE)/.test(l));
}

// Run captureTarget, returning the emitted frame lines plus the ordered
// call log.
async function run(args, opts = {}) {
  const log = [];
  const browser = makeBrowser({ ...opts, log });
  const frames = await collect(() => captureTarget(
    browser, args.kind || 'after', args.url || 'http://staging/',
    args.fallbackUrl || '', args.cookie || null, args.index != null ? args.index : 0,
    args.opts || {}));
  return { frames, log, browser };
}

const calls = (log, name) => log.filter((c) => c.call === name);
const failFrames = (frames) => frames.filter((l) => l.startsWith('__USERNODE_SHOT_FAIL__'));
const shotFrames = (frames) => frames.filter((l) => l.startsWith('__USERNODE_SHOT__'));

// ── Fix 3: don't record what cannot be recorded ────────────────────────

test('a non-scrollable page skips the recording entirely, with its own reason', async () => {
  const { frames, log } = await run({ opts: { media: true } }, { scrollable: false });

  // No screencast started, so no ffmpeg transcode either.
  assert.equal(calls(log, 'screencast').length, 0, 'no recording is attempted');
  assert.equal(calls(log, 'awaitRepaint').length, 0, 'not even the pre-recording viewport switch');

  // The PNG still ships — the still was never the problem.
  assert.equal(shotFrames(frames).length, 1);
  assert.match(shotFrames(frames)[0], /media=png/);

  // And the absence is attributed distinctly from a broken recording, so the
  // recording-loss rate stays queryable in capture_detail.failures.
  const fails = failFrames(frames);
  assert.equal(fails.length, 2, 'webm + gif reported');
  assert.ok(fails.every((f) => /reason=page-not-scrollable/.test(f)), fails.join('\n'));
  assert.ok(fails.some((f) => /media=webm/.test(f)));
  assert.ok(fails.some((f) => /media=gif/.test(f)));
  assert.ok(!fails.some((f) => /empty%20webm|no%20webm/.test(f)),
    'the old empty-webm / no-webm-to-transcode pair is not what a short page reports');
});

test('the scrollability probe runs BEFORE any recording setup', async () => {
  const { log } = await run({ opts: { media: true } }, { scrollable: true });
  const probeAt = log.findIndex((c) => c.call === 'scrollProbe');
  const castAt = log.findIndex((c) => c.call === 'screencast');
  assert.ok(probeAt >= 0, 'the probe ran');
  assert.ok(castAt > probeAt, 'the probe gates the screencast, it does not follow it');
});

test('a scrollable page still records, and waits for a real repaint first', async () => {
  const { log } = await run({ opts: { media: true } }, { scrollable: true });
  assert.equal(calls(log, 'screencast').length, 1, 'the recording still happens');
  // The fixed 300ms sleep after the viewport switch was a guess at how long
  // the compositor takes; a screencast attached too early never gets a frame.
  const repaintAt = log.findIndex((c) => c.call === 'awaitRepaint');
  const castAt = log.findIndex((c) => c.call === 'screencast');
  assert.ok(repaintAt >= 0, 'the repaint-confirmed wait ran');
  assert.ok(repaintAt < castAt, 'and it precedes the screencast');
});

test('a console-only run (MEDIA=0) touches neither probe nor recording', async () => {
  const { frames, log } = await run({ opts: { media: false, collectConsole: true } });
  assert.equal(calls(log, 'screencast').length, 0);
  assert.equal(calls(log, 'scrollProbe').length, 0);
  assert.equal(shotFrames(frames).length, 0, 'no media frames at all');
  assert.ok(frames.some((f) => f.startsWith('__USERNODE_CONSOLE__')), 'the console check still reports');
});

// ── Fix 2: one navigation per side, companion reloads the same page ────

test('the phone companion reuses the loaded page instead of opening a second one', async () => {
  const { frames, log, browser } = await run({
    opts: { media: true, companion: { index: 1, viewport: { width: 390, height: 844 } } },
  }, { scrollable: true });

  // The regression this guards: one page, one cold navigation.
  assert.equal(browser.pagesOpened, 1, 'exactly one page is opened for the pair');
  assert.equal(calls(log, 'goto').length, 1, 'exactly one cold navigation');
  assert.equal(calls(log, 'reload').length, 1, 'the phone frame is a warm reload');

  // Both frames are stored, under their own capture indexes.
  const shots = shotFrames(frames);
  assert.ok(shots.some((f) => /media=png/.test(f) && /index=0/.test(f)), 'desktop still at index 0');
  assert.ok(shots.some((f) => /media=png/.test(f) && /index=1/.test(f)), 'phone still at index 1');
});

test('the companion is shot at the phone frame, after the desktop artifacts', async () => {
  const { log } = await run({
    opts: { media: true, companion: { index: 1, viewport: { width: 390, height: 844 } } },
  }, { scrollable: true });

  const reloadAt = log.findIndex((c) => c.call === 'reload');
  const castAt = log.findIndex((c) => c.call === 'screencast');
  assert.ok(castAt >= 0 && castAt < reloadAt,
    'the desktop recording completes before the frame changes under it');

  const phoneSet = log.filter((c) => c.call === 'setViewport' && c.viewport.width === 390);
  assert.equal(phoneSet.length, 1, 'the phone frame is set once');
  assert.ok(log.indexOf(phoneSet[0]) < reloadAt, 'and set before the reload, so the app boots narrow');
});

test('a still-only target also gets its companion, and no recording', async () => {
  // The legacy sibling-target shape: still:true carries no recording. It must
  // keep working (rolling deploy) and still honour a companion if one comes.
  const { frames, log } = await run({
    opts: { media: true, stillOnly: true, companion: { index: 3, viewport: { width: 390, height: 844 } } },
  });
  assert.equal(calls(log, 'screencast').length, 0, 'still-only never records');
  assert.equal(calls(log, 'scrollProbe').length, 0, 'and never probes for one');
  const shots = shotFrames(frames);
  assert.equal(shots.length, 2);
  assert.ok(shots.some((f) => /index=3/.test(f)));
});

test('no companion means no extra load — the plain single-frame target is unchanged', async () => {
  const { frames, log, browser } = await run({ opts: { media: true } }, { scrollable: true });
  assert.equal(browser.pagesOpened, 1);
  assert.equal(calls(log, 'goto').length, 1);
  assert.equal(calls(log, 'reload').length, 0, 'nothing is reloaded');
  // Every frame this target emits belongs to index 0 — no second group is
  // invented when there is no companion. (The fake page writes no real webm
  // to disk, so the recording reports a failure frame here rather than a
  // shot; the recording path itself is covered above.)
  const all = [...shotFrames(frames), ...failFrames(frames)];
  assert.equal(all.length, 3, 'png + the webm/gif outcome, nothing else');
  assert.ok(all.every((f) => /index=0/.test(f)), all.join('\n'));
});

test('a companion failure is reported but never costs the target its own shots', async () => {
  const log = [];
  const browser = {
    async newPage() {
      log.push({ call: 'newPage' });
      const page = makePage({ scrollable: true, log });
      page.reload = async () => { throw new Error('phone reload blew up'); };
      return page;
    },
  };
  const frames = await collect(() => captureTarget(
    browser, 'after', 'http://staging/', '', null, 0,
    { media: true, companion: { index: 1, viewport: { width: 390, height: 844 } } }));
  assert.ok(shotFrames(frames).some((f) => /media=png/.test(f) && /index=0/.test(f)),
    'the desktop still survived');
  assert.ok(failFrames(frames).some((f) => /index=1/.test(f) && /reload/.test(f)),
    'the companion failure is attributed to its own index');
});

test('a dead navigation reports the companion index too, so no group goes unaccounted', async () => {
  const log = [];
  const browser = {
    async newPage() {
      const page = makePage({ scrollable: true, log });
      page.goto = async () => { throw new Error('ERR_NAME_NOT_RESOLVED'); };
      return page;
    },
  };
  const frames = await collect(() => captureTarget(
    browser, 'before', 'http://prod/', '', null, 0,
    { media: true, companion: { index: 1, viewport: { width: 390, height: 844 } } }));
  const fails = failFrames(frames);
  assert.ok(fails.some((f) => /index=0/.test(f) && /media=png/.test(f)));
  assert.ok(fails.some((f) => /index=1/.test(f) && /media=png/.test(f)),
    'the companion rides the same dead page, and says so');
});
