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
function setFrameSink(fn) { _sink = fn || ((s) => process.stdout.write(s)); }

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
function emitTest(index, status, loadStatus, payload) {
  const json = JSON.stringify(payload || {});
  _sink(
    `__USERNODE_TEST__ index=${index || 0} status=${status === 'pass' ? 'pass' : 'fail'} loadStatus=${loadStatus || 0}\n`
  );
  _sink(Buffer.from(json, 'utf8').toString('base64'));
  _sink('\n__USERNODE_TEST_END__\n');
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
function resolveTests(env) {
  const raw = (env.TESTS || '').trim();
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

// #47: run one declared test against the staging build. Navigates the
// test's route, collects console errors / uncaught exceptions / failed
// loads (the #381 baseline, now per-test), then evaluates the optional
// presence assertions. Emits exactly one __USERNODE_TEST__ frame. Never
// throws — an unexpected error is itself reported as a failed test.
// `browser` may be a Browser or a BrowserContext (both expose newPage) —
// main() passes the tests-only context so screenshot cookies can't bleed
// into test navigations (see the isolation comment at the call site).
async function runTest(browser, test) {
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

  let page;
  let status = 0;
  let failureReason = '';
  try {
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
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

    try {
      const resp = await page.goto(test.url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
      status = resp ? resp.status() : 200;
    } catch (err) {
      pushErr('load', `navigation failed: ${err.message}`, test.url);
      emitTest(test.index, 'fail', 0, {
        name: test.name, path: test.path, consoleErrors,
        failureReason: `Page failed to load: ${err.message}`,
      });
      await page.close().catch(() => {});
      return;
    }

    await sleep(SETTLE_MS);
    if (status >= 400) {
      pushErr('load', `page returned HTTP ${status}`, test.url);
      failureReason = `Page returned HTTP ${status}`;
    }
    // Give deferred async errors a moment to fire before we judge.
    await sleep(CONSOLE_ONLY_SETTLE_MS);

    // Presence assertions (only when the page loaded OK).
    if (!failureReason && test.expectSelector) {
      let found = false;
      try { found = !!(await page.$(test.expectSelector)); } catch { found = false; }
      if (!found) failureReason = `Expected element "${test.expectSelector}" was not found`;
    }
    if (!failureReason && test.expectText) {
      let found = false;
      try {
        // innerText reflects RENDERED text, including CSS text-transform —
        // a `text-transform: uppercase` header turns "Your apps" into
        // "YOUR APPS" and a case-sensitive includes() can never match the
        // human-written expectation. Compare case-insensitively: keeps the
        // "visible on the page" semantics (hidden text still fails) while
        // making the assertion robust to styling-only casing.
        found = await page.evaluate(
          (text) => (document.body ? document.body.innerText : '')
            .toLowerCase().includes(String(text).toLowerCase()),
          test.expectText
        );
      } catch { found = false; }
      if (!found) failureReason = `Expected text "${test.expectText}" was not found on the page`;
    }
  } catch (err) {
    failureReason = failureReason || `Test run error: ${err.message}`;
  }

  // Console errors fail the test unless the test opted out. A failed load
  // / missing assertion already set failureReason.
  const consoleFails = !test.allowConsoleErrors && consoleErrors.length > 0;
  if (!failureReason && consoleFails) {
    failureReason = `${consoleErrors.length} console error${consoleErrors.length === 1 ? '' : 's'} on load`;
  }
  const pass = !failureReason;
  emitTest(test.index, pass ? 'pass' : 'fail', status, {
    name: test.name, path: test.path,
    consoleErrors: test.allowConsoleErrors ? [] : consoleErrors,
    failureReason: pass ? '' : failureReason,
  });
  if (page) await page.close().catch(() => {});
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
    // check). Sequential, one page each; per-test failures stay independent
    // and a thrown test is reported as a failed frame, never aborts the run.
    //
    // Tests get their OWN browser context, isolated from the screenshot
    // pages above. The screenshot pass navigates with the NON-admin capture
    // token, and the self-app's staging auth exchanges that query token for
    // a session COOKIE in the shared default context; the platform's auth
    // is cookie-first, so a test navigation carrying the view-only-admin
    // ?token= was silently downgraded to the non-admin identity — the
    // admin-gated check pages rendered their "Admins only" gate instead of
    // the content under test (the /debug "PR closed" badge check failed
    // exactly this way). A fresh context starts with an empty cookie jar,
    // so the first test navigation exchanges the admin token as intended.
    const testContext = tests.length ? await browser.createBrowserContext() : null;
    for (const test of tests) {
      await runTest(testContext || browser, test);
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
module.exports = { parseCookie, resolveTargets, resolveDeviceScaleFactor, parseTargetViewport, parseCompanion, mediaEnabled, resolveTests, captureTarget, setFrameSink, CHROMIUM_LAUNCH_ARGS };
