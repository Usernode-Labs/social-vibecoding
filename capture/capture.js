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
// Env:
//   BEFORE_URL          production target ('' / unset = skip "before")
//   AFTER_URL           staging target    ('' / unset = skip "after")
//   BEFORE_FALLBACK_URL retried once when BEFORE_URL answers HTTP >= 400
//                       (a newly-added page 404s on prod; fall back to /)
//
// Output protocol (stdout), mirroring the worker's __USERNODE_*__ style —
// one frame per artifact:
//   __USERNODE_SHOT__ kind=<before|after> media=<png|webm|gif> status=<n> bytes=<n>
//   <base64 payload, single line>
//   __USERNODE_SHOT_END__
// A failed step emits instead:
//   __USERNODE_SHOT_FAIL__ kind=... media=... reason=<encoded>
// Failures are independent: a dead recording still ships the PNG, a dead
// "before" page still ships every "after" artifact. The process always
// exits 0 — the platform treats missing frames as the failure signal.

const fs = require('fs');
const { execFile } = require('child_process');
const puppeteer = require('puppeteer-core');

const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const NAV_TIMEOUT_MS = 30000;
const SETTLE_MS = 500;
const PRE_SCROLL_HOLD_MS = 1500;
const SHORT_PAGE_HOLD_MS = 4000;
const GIF_WIDTH = 640;
const GIF_FPS = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(kind, media, status, buf) {
  process.stdout.write(
    `__USERNODE_SHOT__ kind=${kind} media=${media} status=${status} bytes=${buf.length}\n`
  );
  process.stdout.write(buf.toString('base64'));
  process.stdout.write('\n__USERNODE_SHOT_END__\n');
}

function emitFail(kind, media, reason) {
  const enc = encodeURIComponent(String(reason || 'unknown').slice(0, 300));
  process.stdout.write(`__USERNODE_SHOT_FAIL__ kind=${kind} media=${media} reason=${enc}\n`);
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
// clip is effectively a still. Time-bounded, not bottom-bounded — an
// infinite-scroll page scrolls as far as it gets and stops.
async function scrollPass(page) {
  await page.evaluate(async (shortHoldMs) => {
    const total = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    const distance = Math.max(0, total - window.innerHeight);
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
  }, SHORT_PAGE_HOLD_MS);
}

async function captureTarget(browser, kind, url, fallbackUrl) {
  const page = await browser.newPage();
  let navigated = false;
  let status = 200;
  try {
    await page.setViewport(VIEWPORT);
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
    }
    if (!navigated) throw new Error('navigation failed');
  } catch (err) {
    emitFail(kind, 'png', err.message);
    emitFail(kind, 'webm', err.message);
    emitFail(kind, 'gif', err.message);
    await page.close().catch(() => {});
    return;
  }

  await sleep(SETTLE_MS);

  // 1. Still: viewport-only PNG of the loaded page.
  try {
    const png = await page.screenshot({ type: 'png' });
    emit(kind, 'png', status, Buffer.from(png));
  } catch (err) {
    emitFail(kind, 'png', err.message);
  }

  // 2. Recording: load + scroll, encoded to webm by Chromium's screencast
  //    frames piped through ffmpeg (puppeteer handles the plumbing).
  const webmPath = `/tmp/usernode-${kind}.webm`;
  let haveWebm = false;
  try {
    const recorder = await page.screencast({ path: webmPath });
    await sleep(PRE_SCROLL_HOLD_MS);
    await scrollPass(page);
    await sleep(500);
    await recorder.stop();
    const webm = fs.readFileSync(webmPath);
    if (!webm.length) throw new Error('empty webm');
    emit(kind, 'webm', status, webm);
    haveWebm = true;
  } catch (err) {
    emitFail(kind, 'webm', err.message);
  }

  // 3. GIF transcode of the recording for the PR-body inline embed.
  if (haveWebm) {
    const gifPath = `/tmp/usernode-${kind}.gif`;
    const palettePath = `/tmp/usernode-${kind}-palette.png`;
    try {
      await webmToGif(webmPath, gifPath, palettePath);
      const gif = fs.readFileSync(gifPath);
      if (!gif.length) throw new Error('empty gif');
      emit(kind, 'gif', status, gif);
    } catch (err) {
      emitFail(kind, 'gif', err.message);
    }
  } else {
    emitFail(kind, 'gif', 'no webm to transcode');
  }

  await page.close().catch(() => {});
}

async function main() {
  const beforeUrl = (process.env.BEFORE_URL || '').trim();
  const afterUrl = (process.env.AFTER_URL || '').trim();
  const beforeFallbackUrl = (process.env.BEFORE_FALLBACK_URL || '').trim();
  if (!beforeUrl && !afterUrl) {
    process.stderr.write('capture: no BEFORE_URL or AFTER_URL set\n');
    return;
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-color-profile=srgb',
    ],
  });

  try {
    if (beforeUrl) await captureTarget(browser, 'before', beforeUrl, beforeFallbackUrl);
    if (afterUrl) await captureTarget(browser, 'after', afterUrl, '');
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .catch((err) => {
    // Never a non-zero exit: missing frames are the platform's failure
    // signal, and a hard exit code would just add noise to the logs.
    process.stderr.write(`capture: fatal ${err.message}\n`);
  })
  .then(() => process.exit(0));
