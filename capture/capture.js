'use strict';

// One-shot before/after capture for UI-affecting proposals (issue #195).
//
// Runs inside the usernode-capture:latest container (see Dockerfile). For
// each target URL it produces up to three artifacts:
//   png  — viewport screenshot after load + settle
//   webm — ~5-9s load-and-scroll recording (page.screencast via ffmpeg)
//   gif  — the webm downscaled to 640px @ 10fps (palette-optimized) so it
//          embeds inline in GitHub PR bodies (camo only proxies images)
//
// Env (#270 — a proposal can point its screenshots at a short ordered
// list of routes, so capture shoots one before/after pair per route):
//   TARGETS             JSON array of capture targets, each:
//                         { index, beforeUrl, afterUrl, beforeFallbackUrl,
//                           beforeCookie, afterCookie, viewport?,
//                           companion? }
//                       Looped over sequentially; `index` tags every shot
//                       frame so the orchestrator attributes each artifact
//                       to its route. Per-target failures stay independent.
//                       `viewport` ({ width, height }, #768) overrides the
//                       default 1280x800 frame for BOTH sides of that
//                       target's pair (a `@mobile` testing path); absent /
//                       malformed → the desktop default.
//                       `companion` ({ index, viewport }) asks for one
//                       extra PNG still from the SAME page at a second
//                       frame — the automatic phone shot. It reloads the
//                       already-loaded page instead of opening a second
//                       one, which is what keeps a two-route proposal at
//                       4 page loads instead of 8; the still is emitted
//                       under the companion's own index. Absent → no
//                       companion (an older orchestrator sends a separate
//                       `still: true` target instead, still supported).
//   BEFORE_URL          single-target fallback when TARGETS is unset/empty
//   AFTER_URL           (an older orchestrator, or a rolling deploy). Each
//   BEFORE_FALLBACK_URL of these mirrors the same-named TARGETS field for a
//   BEFORE_COOKIE       lone target at index 0.
//   AFTER_COOKIE
//
// Per-field meaning (same as the legacy scalars):
//   beforeUrl           production target ('' = skip "before")
//   afterUrl            staging target    ('' = skip "after")
//   beforeFallbackUrl   retried once when beforeUrl answers HTTP >= 400
//                       (a newly-added page 404s on prod; fall back to /)
//   beforeCookie        optional `name=value` cookie set on the "before"
//                       page before navigation (self-app prod auth — the
//                       platform never honours query tokens in prod)
//   afterCookie         same for "after"; plumbed for symmetry, unused
//                       today (the after side authenticates via ?token=)
//
// Output protocol (stdout), mirroring the worker's __USERNODE_*__ style —
// one frame per artifact:
//   __USERNODE_SHOT__ kind=<before|after> media=<png|webm|gif> status=<n> bytes=<n> index=<n>
//   <base64 payload, single line>
//   __USERNODE_SHOT_END__
// A failed step emits instead:
//   __USERNODE_SHOT_FAIL__ kind=... media=... index=<n> reason=<encoded>
// Failures are independent: a dead recording still ships the PNG, a dead
// "before" page still ships every "after" artifact, and a dead target
// still leaves every other target's frames intact. The process always
// exits 0 — the platform treats missing frames as the failure signal.

const fs = require('fs');
const { execFile } = require('child_process');

// Pixel density of the captured shots. Default 2× (HiDPI/retina) so the
// whole class of "only broken on retina" bugs surfaces as a visible
// before/after diff for free (#360). Apps that genuinely want 1× (pixel
// art, deliberately low-res canvases) opt out via dapp.json's
// `screenshot.deviceScaleFactor`, which the orchestrator plumbs in as
// DEVICE_SCALE_FACTOR. Only 1 and 2 are accepted; anything else (unset,
// garbage, out of range) falls back to 2 — so even an old orchestrator
// that doesn't set the var still gets 2× from a freshly-built image.
// Chromium launch flags for the headless capture browser.
//
// Software WebGL: apps that use WebGL / Three.js / a <canvas> 3D context
// must be able to create a context here, or they crash on load with
// "Could not create a WebGL context" — a console error that fails their
// proposal checks (see runTest) and leaves the before/after screenshots
// blank. The distro Chromium has no GPU in the container, so the fix is
// SwiftShader, Chromium's bundled CPU rasterizer, routed through ANGLE:
//   --use-gl=angle --use-angle=swiftshader
// On modern Chromium (bookworm ships a recent stable) unaccelerated
// SwiftShader for WebGL is gated behind an explicit opt-in, without which
// getContext() still returns null and logs a deprecation error:
//   --enable-unsafe-swiftshader
// This REPLACES the old --disable-gpu flag, which turned the GPU stack off
// entirely and made any WebGL context (hardware or software) impossible.
// Rendering is CPU-bound and deterministic across runs; non-WebGL pages
// are unaffected.
const CHROMIUM_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--force-color-profile=srgb',
];

function resolveDeviceScaleFactor(raw) {
  return parseInt(raw, 10) === 1 ? 1 : 2;
}
const VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: resolveDeviceScaleFactor(process.env.DEVICE_SCALE_FACTOR),
};

// #768: optional per-target viewport override ({ width, height } from the
// TARGETS entry — a `@mobile` testing path). Bounds keep a corrupted value
// from asking Chromium for a degenerate or absurd frame; anything invalid
// falls back to the desktop default. deviceScaleFactor is NOT part of the
// override — the run's global density (DEVICE_SCALE_FACTOR) applies to
// every frame.
function parseTargetViewport(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const width = parseInt(raw.width, 10);
  const height = parseInt(raw.height, 10);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 200 || width > 4000 || height < 200 || height > 4000) return null;
  return { width, height };
}
// Companion frame descriptor (the automatic phone-sized still). Shares
// parseTargetViewport's bounds for the frame itself and requires an
// integer capture index, because that index is what attributes the stored
// artifact to its rendered row. Anything invalid → null (no companion),
// never a throw: a malformed field must not cost the target its real shots.
function parseCompanion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const viewport = parseTargetViewport(raw.viewport);
  if (!viewport) return null;
  const index = parseInt(raw.index, 10);
  if (!Number.isInteger(index) || index < 0) return null;
  return { index, viewport };
}

const NAV_TIMEOUT_MS = 30000;
const SETTLE_MS = 500;
const PRE_SCROLL_HOLD_MS = 1500;
const SHORT_PAGE_HOLD_MS = 4000;
const GIF_WIDTH = 640;
const GIF_FPS = 10;

// Recording-size bounds (screenshot-reliability spec). Screencast bitrate
// is the artifact-size driver, and the platform silently dropped any webm
// over its 8 MB storage cap — production showed ~40% of capture groups
// with a PNG but no recording. Two fixes at the source:
//   - the scroll pass is DISTANCE-bounded (MAX_SCROLL_VIEWPORTS viewport
//     heights) so a very tall / infinite-scroll page can't produce a
//     minutes-long, tens-of-MB recording;
//   - an over-cap webm is reported as a failure frame (reason "over-cap")
//     instead of being shipped to certain platform-side death — but the
//     GIF is STILL transcoded from it (640px @ 10fps is far smaller and is
//     what PR bodies embed), so one oversized recording no longer loses
//     both moving artifacts.
// WEBM_MAX_BYTES mirrors MAX_BYTES.webm in src/services/visuals.js.
const WEBM_MAX_BYTES = 8 * 1024 * 1024;
const MAX_SCROLL_VIEWPORTS = 3;

// #381: console-error check. Listeners on the staging "after" page collect
// console.error output, uncaught exceptions, unhandled rejections and
// failed loads so the platform can flag a proposal that "may break the
// app". The list is deduped by message, capped, and each message
// truncated so a chatty app can't blow stdout. After a console-only run
// (MEDIA=0) the page gets a little extra settle so deferred async errors
// surface before we report.
const MAX_CONSOLE_ERRORS = 20;
const MAX_CONSOLE_MSG_LEN = 500;
const CONSOLE_ONLY_SETTLE_MS = 1500;

// ── Settle: a bounded QUIET WINDOW, not a fixed sleep (#1144) ──
//
// The declared suite used to pay SETTLE_MS + CONSOLE_ONLY_SETTLE_MS = 2000ms
// of unconditional sleep per navigation, whatever the page did. Production
// measured 158 navigations over 8 lanes for this repo's own manifest — ~20
// waves, so ~40s of a 72s capture was spent asleep on pages that had already
// gone quiet the instant `networkidle2` resolved.
//
// The safety property those sleeps existed for is real and is preserved: a
// page that is STILL emitting deferred async errors keeps getting waited on,
// right up to SETTLE_MAX_MS. What changes is the common case — a page with
// nothing left to say proceeds after one quiet window instead of two full
// seconds. `lastAt` is bumped by console output, page errors and request
// lifecycle events, so "quiet" means the document is genuinely idle rather
// than merely past a timer.
//
// SETTLE_MIN_MS is the floor after a cold navigation. `networkidle2` already
// resolves 500ms after the last request, so a page whose deferred error fires
// a few hundred ms into idle would be judged before it spoke if the only bound
// were the quiet window. The floor keeps a guaranteed listening period; any
// error inside it re-arms the window, so the noisy case still runs long.
const SETTLE_QUIET_MS = 250;
const SETTLE_MIN_MS = 500;
const SETTLE_MAX_MS = 1500;
const SETTLE_POLL_MS = 50;

function settleQuietMs(env) {
  const raw = parseInt((env || {}).TEST_SETTLE_QUIET_MS, 10);
  return (Number.isFinite(raw) && raw >= 0) ? raw : SETTLE_QUIET_MS;
}

function settleMaxMs(env) {
  const raw = parseInt((env || {}).TEST_SETTLE_MAX_MS, 10);
  return (Number.isFinite(raw) && raw >= 0) ? raw : SETTLE_MAX_MS;
}

// ── Assertion polling ──
//
// The quiet window judges the page by what it EMITS — console output, page
// errors, request lifecycle. Timers, rAF work, IndexedDB reads and
// service-worker-served fetches emit none of those, so a screen can read as
// "quiet" while it is still rendering. The flat 2s settle this replaced
// masked that gap; shrinking it surfaced a wave of "Expected element was not
// found" failures on exactly the data-driven routes (20 of this repo's own
// declared checks in the first post-#1147 run). So presence assertions POLL:
// a check whose element is already there passes on the first probe and pays
// nothing; one whose screen is mid-render keeps being re-asked until it holds
// or the cohort's shared deadline expires. The deadline is per COHORT, not
// per check — ten missing selectors on one broken screen cost one ceiling,
// which is what lets the group budget stay proportional to cohort count.
const ASSERT_POLL_MS = 100;
const ASSERT_MAX_MS = 5000;

function assertMaxMs(env) {
  const raw = parseInt((env || {}).TEST_ASSERT_MAX_MS, 10);
  return (Number.isFinite(raw) && raw >= 0) ? raw : ASSERT_MAX_MS;
}

// An activity clock a page's listeners bump. Created per group and shared by
// every cohort's settle, so a late error from cohort 1 still holds cohort 2's
// window open — the page is one document either way.
function makeActivityClock(now) {
  const clock = now || (() => Date.now());
  return { lastAt: clock(), now: clock, bump() { this.lastAt = this.now(); } };
}

// Wait until the page has been quiet for `quietMs` — but never less than
// `minMs`, and never more than `maxMs`. Returns the elapsed wait.
async function waitForQuiet(activity, opts) {
  const o = opts || {};
  const quietMs = Number.isFinite(o.quietMs) ? o.quietMs : SETTLE_QUIET_MS;
  const maxMs = Number.isFinite(o.maxMs) ? o.maxMs : SETTLE_MAX_MS;
  const minMs = Math.min(Number.isFinite(o.minMs) ? o.minMs : 0, maxMs);
  const now = typeof o.now === 'function' ? o.now : (activity && activity.now) || (() => Date.now());
  const nap = typeof o.sleep === 'function' ? o.sleep : sleep;
  const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : SETTLE_POLL_MS;
  const startedAt = now();
  for (;;) {
    const elapsed = now() - startedAt;
    if (elapsed >= maxMs) return elapsed;
    const quietFor = now() - (activity ? activity.lastAt : 0);
    if (elapsed >= minMs && quietFor >= quietMs) return elapsed;
    await nap(Math.max(1, Math.min(pollMs, maxMs - elapsed)));
  }
}

// ── Test-suite pool bounds (every declared check now runs, see runTests) ──
//
// The suite used to be at most 12 checks run strictly one after another.
// It is now every declared check — 240-odd for this repo — which at the
// measured ~3.9s marginal cost per sequential check would be ~16 minutes,
// four times the container's own timeout. Two mechanisms bring that down:
// checks that share a URL share one navigation (groupTestsByUrl — this
// repo's 241 checks hit ~110 distinct routes, and a benchmark against the
// real manifest halved suite wall clock, 96s → 47s), and the groups run
// through a bounded pool of concurrent pages.
//
// 8: production timings put a navigation at ~3.9s sequential, so ~110
// groups at pool 8 is ~54s of ideal work; the staging preview (2 CPUs) is
// the real serialising resource, so budget 55-70% efficiency → ~80-100s,
// well inside the deadlines below. Raising this past ~16 buys nothing
// while the preview is the bottleneck, and each live page costs 80-150 MB
// against the container's 4g.
function poolSize(env) {
  const raw = parseInt((env || {}).TEST_CONCURRENCY, 10);
  if (!Number.isFinite(raw) || raw < 1) return 8;
  return Math.min(16, raw);
}

// Per-check wall clock. NAV_TIMEOUT_MS only bounds page.goto — the settle
// sleeps and the selector/text assertions are unbounded, so one wedged page
// could previously eat the whole run's budget. A check that blows this is
// reported as an ordinary failed frame and the pool moves on.
function testTimeoutMs(env) {
  const raw = parseInt((env || {}).TEST_TIMEOUT_MS, 10);
  return (Number.isFinite(raw) && raw > 0) ? raw : 25000;
}

// Whole-suite deadline. On expiry the pool stops dispatching and abandons
// what is in flight; undispatched checks simply produce no frame and the
// platform derives the missing set from the sentinel. Sits below the
// orchestrator's 600s docker timeout so the container always gets to emit
// its sentinel rather than being killed mid-suite.
function testsDeadlineMs(env) {
  // 420000 → 470000 (#1417), moved with MAX_DECLARED_TESTS 430 → 480 and the
  // platform-side TESTS_DEADLINE_MS. The two defaults are asserted equal by
  // tests/checks-budget.test.js precisely so a container running without the
  // env var cannot silently apply a shorter budget than the platform planned
  // — which would cut a full manifest's tail while the platform reported the
  // suite as merely unfinished.
  const raw = parseInt((env || {}).TESTS_DEADLINE_MS, 10);
  return (Number.isFinite(raw) && raw > 0) ? raw : 470000;
}

// Whether this run also produces the before/after media artifacts. The
// orchestrator sets MEDIA=0 for the always-on console-only check on a
// non-UI-affecting proposal (visuals.js) — the page is still navigated
// and console errors still reported, but screenshots/recordings and the
// prod "before" leg are skipped to keep the always-on cost to one load.
function mediaEnabled(env) {
  return (env || {}).MEDIA !== '0';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse the `name=value` cookie env form into { name, value }, or null
// when unset/malformed. Splits on the FIRST '=' only — session tokens
// are hex today, but the value side must survive '=' chars regardless.
function parseCookie(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const eq = s.indexOf('=');
  if (eq <= 0) return null;
  const name = s.slice(0, eq).trim();
  const value = s.slice(eq + 1).trim();
  if (!name || !value) return null;
  return { name, value };
}

// `fellback=1` tags a frame whose page was actually the FALLBACK url
// (a deep "before" path that 404'd on prod and was re-shot at '/') so the
// platform can persist before_fell_back and caption the pair honestly.
// Every frame goes through this one sink. In the container it is stdout —
// the protocol the orchestrator parses. It is indirected solely so tests can
// collect frames without monkey-patching process.stdout, which would also
// swallow the test runner's own output.
let _sink = (s) => process.stdout.write(s);
function setFrameSink(fn) {
  _sink = fn || ((s) => process.stdout.write(s));
  _emittedTests.clear();
}

function emit(kind, media, status, buf, index, fellback) {
  _sink(
    `__USERNODE_SHOT__ kind=${kind} media=${media} status=${status} bytes=${buf.length} index=${index || 0}${fellback ? ' fellback=1' : ''}\n`
  );
  _sink(buf.toString('base64'));
  _sink('\n__USERNODE_SHOT_END__\n');
}

function emitFail(kind, media, reason, index) {
  const enc = encodeURIComponent(String(reason || 'unknown').slice(0, 300));
  _sink(`__USERNODE_SHOT_FAIL__ kind=${kind} media=${media} index=${index || 0} reason=${enc}\n`);
}

// #381: one console-result frame per "after" target, mirroring the shot
// protocol. The error list is a single base64 JSON line so arbitrary
// messages survive without colliding with the protocol delimiters.
//   __USERNODE_CONSOLE__ index=<n> errors=<count> loadStatus=<n>
//   <base64 JSON array of { kind, message, source }>
//   __USERNODE_CONSOLE_END__
function emitConsole(index, errors, loadStatus) {
  const json = JSON.stringify(Array.isArray(errors) ? errors : []);
  _sink(
    `__USERNODE_CONSOLE__ index=${index || 0} errors=${(errors || []).length} loadStatus=${loadStatus || 0}\n`
  );
  _sink(Buffer.from(json, 'utf8').toString('base64'));
  _sink('\n__USERNODE_CONSOLE_END__\n');
}

// #47: one test-result frame per declared test, mirroring the console
// protocol. Everything bar the pass/fail status lives in the base64 JSON
// payload so arbitrary names / messages survive the protocol delimiters.
//   __USERNODE_TEST__ index=<n> status=<pass|fail> loadStatus=<n>
//   <base64 JSON { name, path, consoleErrors:[{kind,message,source}], failureReason }>
//   __USERNODE_TEST_END__
//
// Exactly one frame per index, whatever happens. runTests races each check
// against a per-check deadline, so the pool can write a "timed out" frame
// while the original runTest is still mid-navigation and finishes later.
// First writer wins and the straggler is dropped, so a slow check can never
// contradict its own recorded verdict.
const _emittedTests = new Set();
function emitTest(index, status, loadStatus, payload) {
  const key = Number(index) || 0;
  if (_emittedTests.has(key)) return false;
  _emittedTests.add(key);
  const json = JSON.stringify(payload || {});
  _sink(
    `__USERNODE_TEST__ index=${index || 0} status=${status === 'pass' ? 'pass' : 'fail'} loadStatus=${loadStatus || 0}\n`
  );
  _sink(Buffer.from(json, 'utf8').toString('base64'));
  _sink('\n__USERNODE_TEST_END__\n');
  return true;
}

// Completion sentinel for the test suite. With a pool, "fewer frames than
// dispatched" is no longer self-evidently a crash — it can also be the
// suite's own deadline stopping dispatch — so the container states plainly
// how far it got. The platform reads it to decide whether a missing check
// is a partial run it must fail closed on.
//
// parseTests ignores any line that isn't a `__USERNODE_TEST__ ` header, so
// an OLDER platform reading a NEWER image is unaffected by this line. The
// other direction (new platform, old image) sees no sentinel at all and
// falls back to comparing frame count against dispatched count.
function emitTestsDone(ran, expected, deadline) {
  _sink(`__USERNODE_TESTS_DONE__ ran=${ran || 0} expected=${expected || 0} deadline=${deadline ? 1 : 0}\n`);
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${(stderr || err.message).slice(0, 300)}`));
      resolve({ stdout, stderr });
    });
  });
}

// Two-pass palette GIF: deterministic control over fps/scale/quality, and
// far smaller output than a naive single-pass transcode.
async function webmToGif(webmPath, gifPath, palettePath) {
  const scale = `fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  await execFileAsync('ffmpeg', [
    '-y', '-i', webmPath, '-vf', `${scale},palettegen`, palettePath,
  ], { timeout: 45000 });
  await execFileAsync('ffmpeg', [
    '-y', '-i', webmPath, '-i', palettePath,
    '-lavfi', `${scale} [x]; [x][1:v] paletteuse`, gifPath,
  ], { timeout: 45000 });
}

// Scripted load + scroll: hold, smooth-scroll to the bottom (~4s), hold,
// scroll back up (~2s). Pages shorter than the viewport just hold so the
// clip is effectively a still. Time-bounded AND distance-bounded — an
// infinite-scroll / very tall page scrolls at most MAX_SCROLL_VIEWPORTS
// viewport heights so the recording stays inside the webm size cap.
async function scrollPass(page) {
  await page.evaluate(async (shortHoldMs, maxViewports) => {
    const total = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    const distance = Math.max(0, Math.min(
      total - window.innerHeight,
      window.innerHeight * maxViewports
    ));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (distance < 8) {
      await wait(shortHoldMs);
      return;
    }
    const downSteps = 40; // 40 * 100ms = ~4s down
    for (let i = 1; i <= downSteps; i++) {
      window.scrollTo(0, (distance * i) / downSteps);
      await wait(100);
    }
    await wait(1000);
    const upSteps = 40; // 40 * 50ms = ~2s back up
    for (let i = upSteps - 1; i >= 0; i--) {
      window.scrollTo(0, (distance * i) / upSteps);
      await wait(50);
    }
  }, SHORT_PAGE_HOLD_MS, MAX_SCROLL_VIEWPORTS);
}

// Resolve once the page has actually painted twice. Two nested rAF ticks
// is the standard "the compositor has produced a frame" signal — the first
// callback runs before the upcoming paint, the second after it. Bounded by
// a race so a page whose rAF never fires (backgrounded, crashed renderer)
// can't hang the run.
async function awaitRepaint(page) {
  await Promise.race([
    page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    })),
    sleep(1000),
  ]);
}

// The automatic phone-frame still, shot from the page that is ALREADY
// loaded for this target rather than from a second one.
//
// This used to be a sibling capture target, which meant a full second
// navigation per side per path: a proposal pointing at two screens loaded
// 8 pages instead of 4, and paid a cold `newPage` + networkidle2 wait for
// each. Reusing the page keeps the cookie jar and a warm HTTP cache, so
// the reload is a fraction of the cost. The reload itself is deliberate
// rather than a bare setViewport: it re-boots the app at the phone frame,
// so components that read the viewport at startup (nav chrome, drawers)
// render their narrow-screen form instead of a resized desktop layout —
// which is the whole point of shooting the frame at all.
//
// Emits under the companion's OWN capture index, so the stored artifact
// lands in the same rendered row it always has. Best-effort throughout: a
// failed companion is reported as a failure frame and never costs the
// target its desktop artifacts.
async function shootCompanion(page, kind, companion, status, usedFallback) {
  if (!companion) return;
  const { index, viewport } = companion;
  try {
    await page.setViewport({ ...viewport, deviceScaleFactor: VIEWPORT.deviceScaleFactor });
    await page.reload({ waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    await sleep(SETTLE_MS);
    const png = await page.screenshot({ type: 'png' });
    emit(kind, 'png', status, Buffer.from(png), index, usedFallback);
  } catch (err) {
    emitFail(kind, 'png', err.message, index);
  }
}

async function captureTarget(browser, kind, url, fallbackUrl, cookie, index, opts = {}) {
  // #381: media off → console-only mode (no screenshots/recordings). The
  // console check only judges the staging build, so error collection is
  // wired for the "after" target regardless of media.
  const media = opts.media !== false;
  // Still-only target (the automatic phone-frame companion shot): PNG
  // only, no screencast/GIF — keeps the doubled target list inside the
  // run's 240s budget. Missing webm/gif frames on these are BY DESIGN,
  // so no failure frames are emitted for them.
  const stillOnly = !!opts.stillOnly;
  // #47: when a TESTS suite runs, it owns console-error collection on the
  // staging build — the orchestrator sets collectConsole:false here so the
  // legacy __USERNODE_CONSOLE__ frame isn't double-counted against the
  // per-test frames. Defaults to the #381 behaviour (after-target only).
  const collectConsole = (opts.collectConsole != null ? opts.collectConsole : (kind === 'after'));
  const consoleErrors = [];
  const pushErr = (errKind, message, source) => {
    if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
    const msg = String(message == null ? '' : message).slice(0, MAX_CONSOLE_MSG_LEN);
    if (!msg) return;
    if (consoleErrors.some((e) => e.message === msg)) return; // dedupe by message
    consoleErrors.push({
      kind: errKind,
      message: msg,
      source: source ? String(source).slice(0, MAX_CONSOLE_MSG_LEN) : '',
    });
  };

  const page = await browser.newPage();
  if (collectConsole) {
    // Native Chromium events catch errors whether or not the app embeds
    // the dev-console forwarder (which only forwards via postMessage to a
    // parent frame that doesn't exist headless). console 'error' covers
    // console.error(); pageerror covers uncaught exceptions; Chromium
    // surfaces unhandled rejections through pageerror too.
    page.on('console', (msg) => {
      try {
        if (msg.type() !== 'error') return;
        const loc = typeof msg.location === 'function' ? msg.location() : null;
        const src = loc && loc.url
          ? `${loc.url}${loc.lineNumber != null ? ':' + loc.lineNumber : ''}`
          : '';
        pushErr('console', msg.text(), src);
      } catch { /* ignore a single malformed console message */ }
    });
    page.on('pageerror', (err) => {
      try { pushErr('pageerror', (err && (err.stack || err.message)) || String(err), ''); }
      catch { /* ignore */ }
    });
  }

  let navigated = false;
  let status = 200;
  let usedFallback = false;
  try {
    // Per-target viewport override (#768): a `@mobile` route shoots in a
    // phone-sized frame; the run's global pixel density applies either way.
    await page.setViewport(opts.viewport
      ? { ...opts.viewport, deviceScaleFactor: VIEWPORT.deviceScaleFactor }
      : VIEWPORT);
    // Auth cookie (self-app prod): set against the target URL so domain/
    // path resolve before the first navigation. The fallback URL is the
    // same origin, so the one cookie covers the retry navigation too.
    if (cookie) {
      await page.setCookie({ name: cookie.name, value: cookie.value, url });
    }
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      status = resp ? resp.status() : 200;
      navigated = true;
    } catch (err) {
      // First nav failed outright (refused / timeout); try the fallback
      // before giving up so a broken deep link still yields the root page.
      if (!fallbackUrl || fallbackUrl === url) throw err;
    }
    if ((!navigated || status >= 400) && fallbackUrl && fallbackUrl !== url) {
      const resp = await page.goto(fallbackUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      status = resp ? resp.status() : 200;
      navigated = true;
      usedFallback = true;
    }
    if (!navigated) throw new Error('navigation failed');
  } catch (err) {
    // A failed load is itself a "may break the app" signal — report it on
    // the console frame (loadStatus 0) before the media-fail frames.
    if (collectConsole) {
      pushErr('load', `navigation failed: ${err.message}`, url);
      emitConsole(index, consoleErrors, 0);
    }
    if (media) {
      emitFail(kind, 'png', err.message, index);
      if (!stillOnly) {
        emitFail(kind, 'webm', err.message, index);
        emitFail(kind, 'gif', err.message, index);
      }
      // The companion frame rides this same page, so a dead navigation
      // takes it down too. Report it under its own index rather than
      // leaving that capture group silently unaccounted for.
      if (opts.companion) emitFail(kind, 'png', err.message, opts.companion.index);
    }
    await page.close().catch(() => {});
    return;
  }

  await sleep(SETTLE_MS);

  // An HTTP error status that still rendered a body is a failed load too.
  if (collectConsole && status >= 400) {
    pushErr('load', `page returned HTTP ${status}`, url);
  }

  // Console-only mode: give async errors a moment to fire, report, done.
  if (!media) {
    if (collectConsole) {
      await sleep(CONSOLE_ONLY_SETTLE_MS);
      emitConsole(index, consoleErrors, status);
    }
    await page.close().catch(() => {});
    return;
  }

  // 1. Still: viewport-only PNG of the loaded page.
  try {
    const png = await page.screenshot({ type: 'png' });
    emit(kind, 'png', status, Buffer.from(png), index, usedFallback);
  } catch (err) {
    emitFail(kind, 'png', err.message, index);
  }

  // Still-only target: the PNG is the whole deliverable — report console
  // errors (if wired) and stop before the expensive recording steps.
  if (stillOnly) {
    if (collectConsole) {
      emitConsole(index, consoleErrors, status);
    }
    await shootCompanion(page, kind, opts.companion, status, usedFallback);
    await page.close().catch(() => {});
    return;
  }

  // Is there anything for a recording to show? Chromium's screencast is
  // CHANGE-driven: it emits frames when the page repaints. On a page that
  // fits its viewport, scrollPass has nothing to scroll and just holds
  // (`distance < 8` below), so the screencast sees a static page and the
  // webm comes back with zero frames — production logged ~270 of these
  // ("empty webm", plus the matching "no webm to transcode") in two weeks,
  // each after paying ~6s of holds plus an ffmpeg attempt for nothing.
  // Measure first and skip the whole recording when it provably cannot
  // produce anything, with its OWN reason so this stays distinguishable
  // from a recording that genuinely broke.
  let scrollable = true;
  try {
    scrollable = await page.evaluate(() => {
      const total = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      return (total - window.innerHeight) >= 8;
    });
  } catch { /* can't tell — attempt the recording as before */ }
  if (!scrollable) {
    emitFail(kind, 'webm', 'page-not-scrollable', index);
    emitFail(kind, 'gif', 'page-not-scrollable', index);
    if (collectConsole) {
      emitConsole(index, consoleErrors, status);
    }
    await shootCompanion(page, kind, opts.companion, status, usedFallback);
    await page.close().catch(() => {});
    return;
  }

  // 2. Recording: load + scroll, encoded to webm by Chromium's screencast
  //    frames piped through ffmpeg (puppeteer handles the plumbing). Temp
  //    paths are per-(kind,index) so sequential targets don't clobber.
  //
  //    Recorded at 1x density regardless of the run's DEVICE_SCALE_FACTOR:
  //    the still above keeps HiDPI, but screencast bitrate scales with
  //    pixel area and 2x recordings were the main driver of over-cap webm
  //    drops. The GIF is downscaled to 640px anyway, and the in-app
  //    <video> tile renders small — 1x loses nothing visible.
  const frame = opts.viewport
    ? { width: opts.viewport.width, height: opts.viewport.height }
    : { width: VIEWPORT.width, height: VIEWPORT.height };
  //    The viewport switch resets the compositor, and a fixed sleep was a
  //    guess at how long that takes — start the screencast too early and it
  //    attaches to a surface that never reports a frame (the other half of
  //    the "empty webm" losses above). Wait for the page to actually paint
  //    twice instead of for the clock, then settle briefly.
  if (VIEWPORT.deviceScaleFactor !== 1) {
    try {
      await page.setViewport({ ...frame, deviceScaleFactor: 1 });
      await awaitRepaint(page);
      await sleep(200);
    } catch { /* keep the current viewport — a 2x recording still works */ }
  }
  const webmPath = `/tmp/usernode-${kind}-${index}.webm`;
  let haveWebmFile = false;
  try {
    const recorder = await page.screencast({ path: webmPath });
    await sleep(PRE_SCROLL_HOLD_MS);
    await scrollPass(page);
    await sleep(500);
    await recorder.stop();
    const webm = fs.readFileSync(webmPath);
    if (!webm.length) throw new Error('empty webm');
    haveWebmFile = true;
    if (webm.length > WEBM_MAX_BYTES) {
      // The platform would drop this over-cap webm anyway — report WHY
      // instead of shipping ~11MB of doomed base64. The GIF transcode
      // below still runs from the file, so the moving artifact survives.
      emitFail(kind, 'webm', `over-cap ${webm.length} bytes`, index);
    } else {
      emit(kind, 'webm', status, webm, index, usedFallback);
    }
  } catch (err) {
    emitFail(kind, 'webm', err.message, index);
  }

  // 3. GIF transcode of the recording for the PR-body inline embed. Runs
  //    whenever the webm FILE exists — including the over-cap case above.
  if (haveWebmFile) {
    const gifPath = `/tmp/usernode-${kind}-${index}.gif`;
    const palettePath = `/tmp/usernode-${kind}-${index}-palette.png`;
    try {
      await webmToGif(webmPath, gifPath, palettePath);
      const gif = fs.readFileSync(gifPath);
      if (!gif.length) throw new Error('empty gif');
      emit(kind, 'gif', status, gif, index, usedFallback);
    } catch (err) {
      emitFail(kind, 'gif', err.message, index);
    }
  } else {
    emitFail(kind, 'gif', 'no webm to transcode', index);
  }

  // #381: report console errors collected across the whole load + scroll
  // lifecycle (errors can surface mid-scroll), after the media frames.
  // Deliberately BEFORE the companion reload: the console verdict has
  // always described this target's own load, and the companion re-boots
  // the page, so emitting first keeps that frame's content unchanged.
  if (collectConsole) {
    emitConsole(index, consoleErrors, status);
  }

  await shootCompanion(page, kind, opts.companion, status, usedFallback);

  await page.close().catch(() => {});
}

// Resolve the ordered list of capture targets from the environment.
// Prefer the multi-target TARGETS JSON (#270); fall back to the legacy
// scalar BEFORE_URL/AFTER_URL/... vars as a single target at index 0 when
// TARGETS is unset, empty, or unparseable (older orchestrator / rolling
// deploy). Each returned target is normalized: trimmed urls, parsed
// cookies, and an integer index. Targets with neither a before nor an
// after url are dropped.
function resolveTargets(env) {
  let list = null;
  const rawTargets = (env.TARGETS || '').trim();
  if (rawTargets) {
    try {
      const parsed = JSON.parse(rawTargets);
      if (Array.isArray(parsed) && parsed.length) list = parsed;
    } catch { /* fall through to scalar vars */ }
  }
  if (!list) {
    list = [{
      index: 0,
      beforeUrl: env.BEFORE_URL,
      afterUrl: env.AFTER_URL,
      beforeFallbackUrl: env.BEFORE_FALLBACK_URL,
      beforeCookie: env.BEFORE_COOKIE,
      afterCookie: env.AFTER_COOKIE,
    }];
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i] || {};
    const beforeUrl = String(t.beforeUrl || '').trim();
    const afterUrl = String(t.afterUrl || '').trim();
    if (!beforeUrl && !afterUrl) continue;
    out.push({
      index: Number.isInteger(t.index) ? t.index : i,
      beforeUrl,
      afterUrl,
      beforeFallbackUrl: String(t.beforeFallbackUrl || '').trim(),
      beforeCookie: parseCookie(t.beforeCookie),
      afterCookie: parseCookie(t.afterCookie),
      // #768: per-target frame override; null (legacy scalar fallback,
      // absent/garbage field) → the desktop default at capture time.
      viewport: parseTargetViewport(t.viewport),
      // Still-only target (the automatic phone-frame companion): PNG only,
      // no recording. Absent on legacy orchestrators → full media.
      still: !!t.still,
      // Companion still shot from the SAME page as this target, at a
      // different frame (the automatic phone shot). Replaces the second
      // full target the orchestrator used to emit for it — see the
      // companion block in captureTarget for why. Absent / malformed →
      // null, which is also what a legacy orchestrator produces (it sends
      // a sibling `still: true` target instead, still handled above).
      companion: parseCompanion(t.companion),
    });
  }
  return out;
}

// #47: resolve the declared test suite from the TESTS env. Each entry is
// pre-resolved by the orchestrator (services/visuals.js) to a fully-formed
// staging `url` (with the capture token) plus the assertion fields. An
// unset / empty / unparseable TESTS yields [] — the run then falls back to
// the legacy console-only behaviour on the "after" target (rolling-deploy
// safety, same shape as resolveTargets' TARGETS-vs-scalar fallback).
//
// TESTS='@stdin' means the payload was too large to ride in a single env
// string — a Linux exec caps any one argv/env string at 128KB
// (MAX_ARG_STRLEN), and a manifest-scale suite (200+ checks, each with a
// tokenized staging URL) blows through that: the platform's own proposals
// died with `spawn E2BIG` before the container even started. The
// orchestrator pipes the JSON through the container's stdin instead
// (docker run -i), which has no such cap.
function resolveTests(env, readStdin) {
  let raw = (env.TESTS || '').trim();
  if (raw === '@stdin') {
    try {
      raw = (readStdin ? readStdin() : fs.readFileSync(0, 'utf8')).trim();
    } catch (err) {
      process.stderr.write(`capture: failed to read TESTS from stdin: ${err.message}\n`);
      return [];
    }
  }
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i] || {};
    const url = String(t.url || '').trim();
    if (!url) continue;
    out.push({
      index: Number.isInteger(t.index) ? t.index : i,
      name: String(t.name || t.path || `test ${i + 1}`).slice(0, 200),
      path: String(t.path || '').slice(0, 512),
      url,
      expectSelector: t.expectSelector ? String(t.expectSelector).slice(0, 256) : '',
      expectText: t.expectText ? String(t.expectText).slice(0, 256) : '',
      allowConsoleErrors: !!t.allowConsoleErrors,
    });
  }
  return out;
}

// Group the declared suite by resolved URL, preserving first-appearance
// order (and, within a group, declaration order). The manifest's checks
// cluster heavily — this repo's 234 checks hit only ~106 distinct routes,
// with 46 on the dev screen alone — and the navigation + settle sleeps are
// where a check's wall clock actually goes. One navigation per URL, with
// every assertion for that URL evaluated against the single loaded page,
// halves the suite's real cost without touching what each check means:
// every check still gets its own frame, verdict, and failure reason.
//
// The key is the RESOLVED url (route + token), not the declared path — two
// checks only share a page when they'd have loaded byte-identical URLs.
function groupTestsByUrl(tests) {
  const byUrl = new Map();
  for (const t of (Array.isArray(tests) ? tests : [])) {
    if (!byUrl.has(t.url)) byUrl.set(t.url, []);
    byUrl.get(t.url).push(t);
  }
  return Array.from(byUrl.values());
}

// ── Document grouping (#1144) ──
//
// groupTestsByUrl keys on the fully resolved URL, so two checks share a page
// load only if they'd request byte-identical URLs. For a hash-routed SPA that
// is the wrong unit: this repo's 314 checks resolve to 158 distinct URLs but
// only 73 distinct DOCUMENTS — 231 of them differ from a sibling by the
// `#hash` alone. Each of those paid a full cold load of the same document.
//
// So the key is the document (origin + pathname + search) and the members are
// ordered into HASH COHORTS. runTestGroup loads the document once and moves
// between cohorts by writing `location.hash`, which is the app's own supported
// navigation path (public/js/app.js wires popstate/hashchange →
// restoreFromHash) rather than a simulation of one.
//
// THE COHORT CAP KEEPS THE POOL FED. One group holding 28 cohorts would
// serialise into a single lane and become the critical path however many
// workers are idle, so a document's cohorts are chunked and each chunk becomes
// its own group (its own navigation, its own context). Measured navigation
// counts for this repo's manifest by cap: 4 → 92, 6 → 85, 8 → 82, 12 → 79,
// against 158 ungrouped. 6 takes nearly all the win while leaving ≥8 groups
// for the pool at all times.
//
// A HASH SWITCH IS NOT A COLD LOAD — module-level init runs once per group
// instead of once per check — so a bug that only reproduces on first paint of
// a sub-route would be missed. TEST_GROUP_BY_DOCUMENT=0 restores per-URL
// grouping with one env flip on the host, no deploy.
const HASH_GROUP_CAP = 6;

function hashGroupCap(env) {
  const raw = parseInt((env || {}).TEST_HASH_GROUP_CAP, 10);
  if (!Number.isFinite(raw) || raw < 1) return HASH_GROUP_CAP;
  return Math.min(64, raw);
}

function groupByDocument(env) {
  return (env || {}).TEST_GROUP_BY_DOCUMENT !== '0';
}

// The cold-load fallback for a hash cohort whose assertions did not hold (see
// the long comment in runTestGroup). On by default: without it, grouping can
// change a check's verdict, which is not something a batching optimisation is
// allowed to do. TEST_COHORT_RELOAD_FALLBACK=0 turns it off for measuring what
// grouping alone costs or saves.
function cohortReloadFallback(env) {
  return (env || process.env || {}).TEST_COHORT_RELOAD_FALLBACK !== '0';
}

// A check's presence assertions against whatever is rendered right now.
// Returns '' when they hold, else the failure reason. Extracted from the emit
// loop so the cohort fallback can re-run exactly the same judgement against a
// reloaded document.
async function assertPresence(page, t) {
  if (t.expectSelector) {
    let found = false;
    try { found = !!(await page.$(t.expectSelector)); } catch { found = false; }
    if (!found) return `Expected element "${t.expectSelector}" was not found`;
  }
  if (t.expectText) {
    let found = false;
    try {
      // innerText reflects RENDERED text, including CSS text-transform — a
      // `text-transform: uppercase` header turns "Your apps" into "YOUR APPS"
      // and a case-sensitive includes() can never match the human-written
      // expectation. Compare case-insensitively: keeps the "visible on the
      // page" semantics (hidden text still fails) while making the assertion
      // robust to styling-only casing.
      found = await page.evaluate(
        (text) => (document.body ? document.body.innerText : '')
          .toLowerCase().includes(String(text).toLowerCase()),
        t.expectText
      );
    } catch { found = false; }
    if (!found) return `Expected text "${t.expectText}" was not found on the page`;
  }
  return '';
}

// Split a resolved URL into its document half and its fragment. Kept as plain
// string surgery rather than `new URL()` so a malformed url (which resolveTests
// tolerates) degrades to "its own document" instead of throwing.
function splitDocumentUrl(url) {
  const s = String(url == null ? '' : url);
  const i = s.indexOf('#');
  if (i === -1) return { doc: s, hash: '' };
  return { doc: s.slice(0, i), hash: s.slice(i) };
}

// The hash cohorts of an already-built group, in order. Members are adjacent
// by construction (groupTestsByDocument emits them that way), but this reads
// them back from the URLs so a hand-built group — the unit-test fakes, or a
// per-URL group under the kill-switch — behaves identically.
//
// The hash-less cohort, if the group has one, is hoisted to the front so it is
// always the COLD navigation. Sub-navigation writes `location.hash`, and
// clearing a fragment is not a same-document navigation — it would reload the
// page mid-group. Leading with it means every switch is to a real fragment.
//
// BOTH the builder and the runner order cohorts through this one function.
// They have to agree: the runner navigates once to `group[0].url` and treats
// the first cohort as already-loaded, so if the builder emitted a different
// cohort first, that cohort would be evaluated against someone else's hash.
function hoistBareCohort(cohorts) {
  const bare = cohorts.findIndex((c) => !c.hash);
  if (bare > 0) cohorts.unshift(cohorts.splice(bare, 1)[0]);
  return cohorts;
}

function cohortsOf(group) {
  const tests = Array.isArray(group) ? group : [group];
  const byHash = new Map();
  for (const t of tests) {
    const { hash } = splitDocumentUrl(t && t.url);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(t);
  }
  return hoistBareCohort(
    Array.from(byHash.entries()).map(([hash, members]) => ({ hash, tests: members }))
  );
}

function groupTestsByDocument(tests, opts) {
  const cap = Math.max(1, Number((opts || {}).cap) || HASH_GROUP_CAP);
  // doc -> Map(hash -> tests[]). Both levels are insertion-ordered, so the
  // suite's declaration order survives into the dispatch order.
  const byDoc = new Map();
  for (const t of (Array.isArray(tests) ? tests : [])) {
    const { doc, hash } = splitDocumentUrl(t.url);
    if (!byDoc.has(doc)) byDoc.set(doc, new Map());
    const byHash = byDoc.get(doc);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(t);
  }
  const groups = [];
  for (const byHash of byDoc.values()) {
    // Hoisted here, not just at run time: the FIRST chunk's first cohort is the
    // one the group's single goto() lands on, so the bare cohort has to be
    // ordered before the chunk boundaries are drawn, not after.
    const cohorts = hoistBareCohort(
      Array.from(byHash.entries()).map(([hash, members]) => ({ hash, tests: members }))
    );
    for (let i = 0; i < cohorts.length; i += cap) {
      // Flatten the chunk: a group stays a plain array of tests, which is what
      // the pool's budget/timeout/emit paths already iterate.
      groups.push([].concat(...cohorts.slice(i, i + cap).map((c) => c.tests)));
    }
  }
  return groups;
}

// The dispatch-time entry point: document grouping unless the kill-switch is
// set, in which case the historical per-URL grouping.
function groupTests(tests, env) {
  if (!groupByDocument(env)) return groupTestsByUrl(tests);
  return groupTestsByDocument(tests, { cap: hashGroupCap(env) });
}

// #47: run the declared tests for ONE route against the staging build.
// Navigates once, collects console errors / uncaught exceptions / failed
// loads (the #381 baseline) for that load, then evaluates each check's
// presence assertions against the same page. Emits exactly one
// __USERNODE_TEST__ frame per check. Never throws — an unexpected error is
// reported as a failed frame for every check that hasn't produced one yet.
//
// THE PAGE MUST BE A WINDOW, NOT A TAB. Concurrent newPage() calls on one
// context open tabs of one window, and Chromium reports every non-active
// tab's document as `visibilityState: 'hidden'`. Hidden documents are not
// an inert copy of visible ones: startViewTransition() skips itself and
// rejects `ready` (which surfaces as an unhandled-rejection pageerror —
// "InvalidStateError: Transition was aborted" failed every route that
// animates its entry, including 4 checks that had already graduated to
// blocking; the platform kit now swallows that rejection — #1035 — but
// any app code outside the kit still hits it), requestAnimationFrame
// never fires (so rAF-driven UI — the platform kit's popovers, action
// sheets, springs — never presents, and its selectors "aren't found"),
// and timers are throttled. Giving each group its OWN browser context
// gives it its own window, which Chromium keeps visible regardless of how
// many run concurrently — verified against real Chromium: 8 concurrent
// context-pages all report 'visible' with rAF firing, while 7 of 8
// same-context tabs report 'hidden'.
//
// The fresh context also means a fresh cookie jar, which is what makes the
// per-group `?token=` exchange deterministic — see runTests.
//
// `browser` may be a Browser (per-group context, the production shape) or
// anything else exposing newPage (the unit-test fakes; also tolerates
// being handed a BrowserContext).
//
// A group may now span several HASH COHORTS of one document (#1144). The
// document is loaded once, for the first cohort; every later cohort is reached
// by writing `location.hash`, which is the app's own navigation path. Console
// errors are attributed per cohort — see the comment on `sharedErrorCount`.
async function runTestGroup(browser, group, opts) {
  const o = opts || {};
  const tests = Array.isArray(group) ? group : [group];
  const cohorts = cohortsOf(tests);
  const lead = tests[0];
  const quietMs = Number.isFinite(o.settleQuietMs) ? o.settleQuietMs : SETTLE_QUIET_MS;
  const maxMs = Number.isFinite(o.settleMaxMs) ? o.settleMaxMs : SETTLE_MAX_MS;
  const assertMax = Number.isFinite(o.assertMaxMs) ? o.assertMaxMs : ASSERT_MAX_MS;
  const assertPoll = Number.isFinite(o.assertPollMs) && o.assertPollMs > 0
    ? o.assertPollMs : ASSERT_POLL_MS;
  const consoleErrors = [];
  const pushErr = (errKind, message, source) => {
    if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
    const msg = String(message == null ? '' : message).slice(0, MAX_CONSOLE_MSG_LEN);
    if (!msg) return;
    if (consoleErrors.some((e) => e.message === msg)) return;
    consoleErrors.push({
      kind: errKind,
      message: msg,
      source: source ? String(source).slice(0, MAX_CONSOLE_MSG_LEN) : '',
    });
  };
  const emitAll = (status, reasonFor) => {
    for (const t of tests) {
      const failureReason = reasonFor(t);
      const pass = !failureReason;
      emitTest(t.index, pass ? 'pass' : 'fail', status, {
        name: t.name, path: t.path,
        consoleErrors: t.allowConsoleErrors ? [] : consoleErrors,
        failureReason: pass ? '' : failureReason,
      });
    }
  };

  let context = null;
  let page;
  let status = 0;
  try {
    if (typeof browser.createBrowserContext === 'function') {
      context = await browser.createBrowserContext();
    }
    page = await (context || browser).newPage();
    await page.setViewport(VIEWPORT);

    // The settle's activity clock. Every signal that the document is still
    // doing something bumps it; `waitForQuiet` returns once nothing has.
    const activity = makeActivityClock();
    const on = (event, handler) => {
      try { page.on(event, handler); } catch { /* fake pages may not emit it */ }
    };
    on('console', (msg) => {
      activity.bump();
      try {
        if (msg.type() !== 'error') return;
        const loc = typeof msg.location === 'function' ? msg.location() : null;
        const src = loc && loc.url
          ? `${loc.url}${loc.lineNumber != null ? ':' + loc.lineNumber : ''}`
          : '';
        pushErr('console', msg.text(), src);
      } catch { /* ignore a single malformed console message */ }
    });
    on('pageerror', (err) => {
      activity.bump();
      try { pushErr('pageerror', (err && (err.stack || err.message)) || String(err), ''); }
      catch { /* ignore */ }
    });
    // Request lifecycle: a route that is still fetching is not quiet, however
    // silent its console is. This is what keeps a lazily-hydrating sub-route
    // from being judged before it renders.
    for (const ev of ['request', 'response', 'requestfinished', 'requestfailed']) {
      on(ev, () => activity.bump());
    }

    try {
      const resp = await page.goto(lead.url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      status = resp ? resp.status() : 200;
    } catch (err) {
      pushErr('load', `navigation failed: ${err.message}`, lead.url);
      emitAll(0, () => `Page failed to load: ${err.message}`);
      await page.close().catch(() => {});
      if (context) await context.close().catch(() => {});
      return;
    }

    let loadFailure = '';
    if (status >= 400) {
      pushErr('load', `page returned HTTP ${status}`, lead.url);
      loadFailure = `Page returned HTTP ${status}`;
    }

    // Errors seen during the cold load belong to EVERY cohort in the group —
    // they are a property of the document all of them share, and before this
    // change each cohort was its own navigation and would have observed them
    // itself. Errors after a hash switch belong to that cohort alone, which is
    // strictly better attribution than the old group-wide freeze: a broken
    // sub-route no longer fails its siblings.
    let sharedErrorCount = 0;

    for (let ci = 0; ci < cohorts.length; ci += 1) {
      const cohort = cohorts[ci];
      let cohortFrom = 0;
      if (ci === 0) {
        // Stamp the clock so the cold load always gets a listening window,
        // then wait it out.
        activity.bump();
        await waitForQuiet(activity, { quietMs, maxMs, minMs: Math.min(SETTLE_MIN_MS, maxMs) });
      } else {
        cohortFrom = consoleErrors.length;
        try {
          await page.evaluate((h) => {
            if (window.location.hash === h) {
              // Already there (the app normalised the fragment itself) — poke
              // the router anyway so this cohort gets a fresh render.
              window.dispatchEvent(new HashChangeEvent('hashchange'));
              return;
            }
            window.location.hash = h;
          }, cohort.hash);
        } catch (err) {
          pushErr('load', `hash navigation to ${cohort.hash} failed: ${err.message}`, lead.url);
        }
        activity.bump();
        await waitForQuiet(activity, { quietMs, maxMs });
      }

      // Poll the cohort's assertions until every one holds or the shared
      // deadline expires (see ASSERT_MAX_MS). The settle above only waited
      // for the page to stop EMITTING; a screen rendered by timers, rAF or
      // service-worker-served fetches goes quiet before it is done, and a
      // one-shot probe here judged those screens mid-render. A check whose
      // element is present pays a single probe; only a cohort with a check
      // still failing keeps waiting, and never past its one shared ceiling.
      // Evaluated BEFORE the console errors are frozen so the cold-load
      // fallback below can re-run them on a reloaded document.
      const presence = new Map();
      if (!loadFailure) {
        const assertDeadlineAt = Date.now() + assertMax;
        let pending = cohort.tests;
        for (;;) {
          const still = [];
          for (const t of pending) {
            const reason = await assertPresence(page, t);
            presence.set(t, reason);
            if (reason) still.push(t);
          }
          pending = still;
          const leftMs = assertDeadlineAt - Date.now();
          if (!pending.length || leftMs <= 0) break;
          await sleep(Math.min(assertPoll, leftMs));
        }
      }

      // ── A hash switch is not always equivalent to a cold load (#1146) ──
      //
      // Grouping was introduced as a pure speed optimisation, but writing
      // `location.hash` on a loaded document cannot reproduce every cold load,
      // and where it cannot it does not merely MISS a bug — it invents one.
      // Three shapes of that were failing in this repo's own suite:
      //
      //   * A screen already mounted on a sub-route keeps it. Cohort
      //     `#leaderboard/challenges` runs before cohort `#leaderboard`, and
      //     the bare fragment means "the board" rather than "reset to the
      //     standings tab" — so the two standings checks judged the challenges
      //     tab and reported the standings markup missing.
      //   * `#admin/seasons/*` renders its section from the boot restore; the
      //     five sub-route cohorts after the cold one never repainted
      //     `#admin-section-content`, so all seven admin checks failed while
      //     their cold-loaded sibling in cohort 0 passed.
      //   * A `?shot=`/`?flow=` deep link scripts a one-time interaction at
      //     boot. Every cohort after the first shares the document but not the
      //     script's effect, so the sheet those checks assert on was never
      //     opened for them.
      //
      // Waiting longer fixes none of it — the render is not late, it is not
      // coming. So an unmet assertion after a hash switch is not taken as a
      // verdict: the cohort is re-run as the real cold navigation the
      // ungrouped runner would have made, and judged on that. Cost is paid
      // only where grouping was NOT equivalent, which keeps the whole win on
      // a green suite while making the verdict independent of how the checks
      // happened to be batched. `about:blank` first because a goto that
      // differs only in the fragment is a same-document navigation and would
      // not reload anything.
      if (ci > 0 && !loadFailure && cohortReloadFallback(o.env)
        && [...presence.values()].some(Boolean)) {
        try {
          await page.goto('about:blank', { timeout: NAV_TIMEOUT_MS });
          const resp = await page.goto(cohort.tests[0].url, {
            waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS,
          });
          const reloadStatus = resp ? resp.status() : status;
          activity.bump();
          await waitForQuiet(activity, { quietMs, maxMs, minMs: Math.min(SETTLE_MIN_MS, maxMs) });
          if (reloadStatus >= 400) {
            pushErr('load', `page returned HTTP ${reloadStatus}`, cohort.tests[0].url);
            for (const t of cohort.tests) presence.set(t, `Page returned HTTP ${reloadStatus}`);
          } else {
            for (const t of cohort.tests) presence.set(t, await assertPresence(page, t));
          }
        } catch (err) {
          // The hash-switch verdict stands. A fallback that cannot navigate
          // must not turn a real assertion failure into a load error.
          pushErr('load', `cohort reload of ${cohort.hash} failed: ${err.message}`, cohort.tests[0].url);
        }
      }

      // Frozen per cohort, for the same reason it used to be frozen per group:
      // a straggling async error must not split one render into contradictory
      // verdicts across the checks judging it. Frozen AFTER the poll, so an
      // error that fires while assertions wait is still heard — the flat
      // settle this replaced would have been listening through that window.
      if (ci === 0) sharedErrorCount = consoleErrors.length;
      const cohortErrors = ci === 0
        ? consoleErrors.slice(0, sharedErrorCount)
        : consoleErrors.slice(0, sharedErrorCount).concat(consoleErrors.slice(cohortFrom));
      const errorCount = cohortErrors.length;

      // The presence verdicts settled above, plus the console-error rule.
      for (const t of cohort.tests) {
        let failureReason = loadFailure || presence.get(t) || '';
        // Console errors fail the check unless it opted out. A failed load /
        // missing assertion already set failureReason.
        if (!failureReason && !t.allowConsoleErrors && errorCount > 0) {
          failureReason = `${errorCount} console error${errorCount === 1 ? '' : 's'} on load`;
        }
        const pass = !failureReason;
        emitTest(t.index, pass ? 'pass' : 'fail', status, {
          name: t.name, path: t.path,
          consoleErrors: t.allowConsoleErrors ? [] : cohortErrors,
          failureReason: pass ? '' : failureReason,
        });
      }
    }
  } catch (err) {
    // emitTest de-duplicates by index, so checks that already reported are
    // untouched and only the unreported remainder is failed.
    emitAll(status, () => `Test run error: ${err.message}`);
  }
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
}

// Extra per-group deadline allowance for each check past the first. The
// navigation + settle sleeps (the expensive part, ~2s+) are paid once per
// group; each additional check is one page.$ and at most one evaluate —
// milliseconds normally, so a second per check is generous headroom, and
// keeping the allowance small preserves "one wedged page can't hold a
// worker long" from the ungrouped design.
const GROUP_EXTRA_CHECK_MS = 1000;

// Extra allowance for each hash cohort past the first. A cohort costs a hash
// write plus one settle, not a navigation — but a settle can run to
// SETTLE_MAX_MS, and a cohort with failing checks polls its assertions up to
// ASSERT_MAX_MS more, so the budget has to grow with cohort count or a full
// six-cohort group with one broken screen per cohort would be timed out for
// doing exactly what it was told to.
//
// It also has to cover the cold-load fallback (#1146), which is a real
// navigation plus a second settle — otherwise a group of genuinely-failing
// cohorts would be reported as "did not finish" rather than as the failures
// it found, which is the less useful of the two answers. Only cohorts whose
// assertions did not hold pay it, so a green suite never reaches this ceiling.
const GROUP_EXTRA_COHORT_MS = 13000;

// Run the whole declared suite through a bounded worker pool, each group in
// its own browser context. Two layers of batching:
//
//   * DOCUMENT GROUPS (groupTests): checks on the same document share one
//     navigation and one settled page, sub-navigating by hash within it —
//     this repo's suite is 314 checks over 158 resolved URLs but only 73
//     documents, and navigation + settle is where nearly all of a check's
//     wall clock goes. TEST_GROUP_BY_DOCUMENT=0 falls back to the older
//     per-URL grouping.
//   * THE POOL: groups run through `concurrency` workers. Replaces the
//     sequential loop that made a 241-check suite a ~16-minute job.
//
// Three shapes matter here:
//
//  1. ONE CONTEXT PER GROUP (see runTestGroup). Each group gets its own
//     window — so its document stays 'visible' however many run at once —
//     and its own empty cookie jar. Every test URL carries the view-only-
//     admin `?token=` (visuals.js appends it per test), the exchange is a
//     stateless JWT that mints a session per exchange, and an empty jar
//     means the exchange happens deterministically on the group's own
//     navigation. This replaced the shared-context design, which needed a
//     sequential "primer" navigation to seed the shared jar (concurrent
//     exchanges into one jar raced, and the losers rendered the "Admins
//     only" gate) and still left every non-active tab hidden.
//  2. PER-GROUP DEADLINE. runTestGroup bounds its navigation, but the
//     settle sleeps and assertion evaluation are not bounded, and a page
//     that keeps a socket open can hang `networkidle2` past its own
//     timeout. A group that overruns has its unreported checks recorded as
//     failures and its slot released, so one bad route can't hold a worker
//     forever. The budget scales gently with group size (see
//     GROUP_EXTRA_CHECK_MS) because assertions are cheap but not free.
//  3. GLOBAL DEADLINE. Workers stop PULLING new groups once the suite
//     budget is spent (in-flight groups are allowed to finish). Whatever
//     was never dispatched simply has no frame, and the sentinel says so —
//     the platform reads `deadline=1` and reports those checks as unrun
//     rather than as a crashed container.
async function runTests(browser, tests, opts) {
  const list = Array.isArray(tests) ? tests : [];
  const o = opts || {};
  const concurrency = Math.max(1, Number(o.concurrency) || 8);
  const perTestMs = Number(o.testTimeoutMs) > 0 ? Number(o.testTimeoutMs) : 25000;
  const budgetMs = Number(o.deadlineMs) > 0 ? Number(o.deadlineMs) : 470000;
  const now = typeof o.now === 'function' ? o.now : () => Date.now();

  if (!list.length) {
    emitTestsDone(0, 0, false);
    return { ran: 0, expected: 0, deadline: false };
  }

  const env = o.env || process.env;
  const groups = typeof o.groupTests === 'function' ? o.groupTests(list) : groupTests(list, env);
  const settleOpts = {
    settleQuietMs: Number.isFinite(o.settleQuietMs) ? o.settleQuietMs : settleQuietMs(env),
    settleMaxMs: Number.isFinite(o.settleMaxMs) ? o.settleMaxMs : settleMaxMs(env),
    assertMaxMs: Number.isFinite(o.assertMaxMs) ? o.assertMaxMs : assertMaxMs(env),
    assertPollMs: Number.isFinite(o.assertPollMs) ? o.assertPollMs : ASSERT_POLL_MS,
    // Carried so the cohort fallback reads the same env the grouping did.
    env,
  };
  const startedAt = now();
  let ran = 0;
  let hitDeadline = false;

  const runOne = async (group) => {
    const cohortCount = cohortsOf(group).length;
    const groupBudgetMs = perTestMs
      + GROUP_EXTRA_CHECK_MS * (group.length - 1)
      + GROUP_EXTRA_COHORT_MS * Math.max(0, cohortCount - 1);
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), groupBudgetMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    let outcome;
    try {
      outcome = await Promise.race([
        Promise.resolve()
          .then(() => runTestGroup(browser, group, settleOpts))
          .then(() => 'done', (err) => `error:${(err && err.message) || err}`),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    // emitTest de-duplicates by index, so these are no-ops for any check in
    // the group whose frame was already written before the overrun.
    if (outcome === 'timeout') {
      for (const t of group) {
        emitTest(t.index, 'fail', 0, {
          name: t.name, path: t.path, consoleErrors: [],
          failureReason: `Check did not finish within ${Math.round(groupBudgetMs / 1000)}s`,
        });
      }
    } else if (outcome !== 'done') {
      for (const t of group) {
        emitTest(t.index, 'fail', 0, {
          name: t.name, path: t.path, consoleErrors: [],
          failureReason: `Test run error: ${String(outcome).slice(6) || 'unknown'}`,
        });
      }
    }
    ran += group.length;
  };

  // Every group straight through the pool — with per-group contexts there
  // is no shared cookie jar to seed, so no primer (shape 1 above).
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (cursor >= groups.length) return;
      if ((now() - startedAt) >= budgetMs) { hitDeadline = true; return; }
      const group = groups[cursor];
      cursor += 1;
      await runOne(group);
    }
  };
  const lanes = Math.min(concurrency, groups.length);
  const workers = [];
  for (let i = 0; i < lanes; i += 1) workers.push(worker());
  await Promise.all(workers);

  emitTestsDone(ran, list.length, hitDeadline);
  return { ran, expected: list.length, deadline: hitDeadline };
}

async function main() {
  const targets = resolveTargets(process.env);
  const tests = resolveTests(process.env);
  if (!targets.length && !tests.length) {
    process.stderr.write('capture: no usable TARGETS / BEFORE_URL / AFTER_URL / TESTS set\n');
    return;
  }

  // Required lazily so the platform's test suite (no puppeteer-core
  // outside the capture image) can require this file for parseCookie /
  // resolveTargets.
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: CHROMIUM_LAUNCH_ARGS,
  });

  const media = mediaEnabled(process.env);
  const haveTests = tests.length > 0;
  try {
    // Sequential per target (a shared browser, one newPage per shot), and
    // before-then-after within each target so the per-target before/after
    // pair lands together. Per-target failures stay independent. In
    // console-only mode (MEDIA=0, #381) the prod "before" leg is skipped —
    // the console check only judges the staging "after" build.
    //
    // #47: when a TESTS suite is present it owns the staging-build console
    // check (per-test frames). So: suppress the after-target's legacy
    // console collection (collectConsole:false), and when media is off skip
    // the after-target navigation entirely — the tests cover that load.
    for (const t of targets) {
      if (media && t.beforeUrl) {
        await captureTarget(browser, 'before', t.beforeUrl, t.beforeFallbackUrl, t.beforeCookie, t.index,
          { media, viewport: t.viewport, stillOnly: t.still, companion: t.companion });
      }
      if (t.afterUrl && (media || !haveTests)) {
        await captureTarget(browser, 'after', t.afterUrl, '', t.afterCookie, t.index,
          { media, collectConsole: !haveTests, viewport: t.viewport, stillOnly: t.still, companion: t.companion });
      }
    }
    // #47: run the declared test suite (assertions + per-test console
    // check). Checks are grouped by URL (one navigation per route) and the
    // groups run through a bounded pool; per-test failures stay independent
    // and a thrown test is reported as a failed frame, never aborts the run.
    //
    // runTests creates a fresh browser context per URL group (see its
    // comment): each starts with an empty cookie jar, so the screenshot
    // pass's NON-admin session cookie (exchanged into the default context
    // above) can never downgrade a test navigation carrying the view-only-
    // admin ?token= — the failure mode that once rendered the "Admins only"
    // gate on the /debug badge check — and each group's page is its own
    // window, so its document stays visible under concurrency.
    if (tests.length) {
      await runTests(browser, tests, {
        concurrency: poolSize(process.env),
        testTimeoutMs: testTimeoutMs(process.env),
        deadlineMs: testsDeadlineMs(process.env),
        env: process.env,
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main()
    .catch((err) => {
      // Never a non-zero exit: missing frames are the platform's failure
      // signal, and a hard exit code would just add noise to the logs.
      process.stderr.write(`capture: fatal ${err.message}\n`);
    })
    .then(() => process.exit(0));
}

// captureTarget is exported for tests only — it is the one piece of this
// file whose BEHAVIOUR (how many navigations it makes, whether it starts a
// recording) is the thing under test, and it takes its page from the browser
// it is handed, so a fake browser exercises it without Chromium.
module.exports = { parseCookie, resolveTargets, resolveDeviceScaleFactor, parseTargetViewport, parseCompanion, mediaEnabled, resolveTests, captureTarget, runTests, runTestGroup, groupTestsByUrl, groupTestsByDocument, groupTests, cohortsOf, hashGroupCap, waitForQuiet, makeActivityClock, settleQuietMs, settleMaxMs, assertMaxMs, poolSize, testTimeoutMs, testsDeadlineMs, setFrameSink, CHROMIUM_LAUNCH_ARGS };
