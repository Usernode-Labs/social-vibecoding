// #4449: LIVE, the WATCHER, run in a first version's build worker while its
// build turn runs, so the people waiting can watch the new app take shape.
// It is not baked into the worker image: the platform
// (services/first-version-live.js) writes this file into the worker with one
// line in front of it, `const LIVE = {…};`, beside two files it reads (the
// benchmark capture step, for its boot helpers, and rrweb's UMD build), and
// starts it in the background, under `nice` (and `ionice` where there is
// one), when the build turn starts. It is killed when the turn ends.
//
// It is the build agent's neighbour, never its tool: its own copy of the
// workspace (the agent's checkout is only read), its own port (LIVE.port,
// not the agent's in-loop 3100), its own database in the container's local
// Postgres (not `inloop`, which the agent recreates). It boots the app the
// way the in-loop launch does (usernode-run-inloop: the app's own build,
// USERNODE_ENV=staging, the manifest's staging fallbacks), opens
// `/?demo=1` in the worker's headless Chromium at 390×760, and records it
// with rrweb.
//
// RESTARTS. When the app's own files change (what git would commit: build
// outputs and ignored files never count), once they have been quiet for a
// few seconds and at most once every 30 seconds, and at each
// `usernode-progress` marker (the platform touches LIVE.dir/progress when it
// reads one) when they changed since the last restart, the app is copied,
// rebooted and opened again. The old app is gone, and its port free, before
// the new one boots. (Club Votes, 12 October 2026: 19 restarts in one build,
// 10 not kept. Every marker restarted at once whether or not anything had
// changed, any file the agent's own runs wrote counted as a change, a
// restart could copy a change half written, and a new boot could find the
// old app still answering on the port.)
//
// A GOOD FRAME. A restart is KEPT only when the page settled cleanly: it
// loaded, no `pageerror`, none of its own fetch/XHR requests failed or
// answered an error, nothing changed and no request of its own was pending
// for STABLE_MS (or SETTLE_LIMIT_MS passed with nothing changing, for an app
// that holds a request open), some text in the body, more than one event.
// Its recording then starts from a snapshot taken at that moment, so what
// people see first is the settled page, never its loading or error state
// (the first frame Club Votes showed was "Couldn't load the decisions").
// Otherwise the last good recording stays what people see, and the failure
// is reported with why.
//
// OUTPUT. One JSON object per line, appended to LIVE.dir/stream.ndjson,
// which the platform reads as it grows:
//   { t: 'full', events, ms }   a kept restart: its whole recording so far
//   { t: 'inc', events }        what it recorded since, about once a second
//   { t: 'fail', why }          a restart that was not kept
//   { t: 'mem', headroomMb }    memory, at each restart
//   { t: 'stop', why }          the watcher stopped for the rest of the build
//
// GUARDS. Memory is checked before it starts and before every restart
// (cgroup memory.current/memory.max, less reclaimable file cache; else
// /proc/meminfo): under LIVE.startHeadroomMb free, it stops for the rest of
// the build. While it runs, under LIVE.runHeadroomMb, it stops too. Every
// error ends it quietly. It never writes to the agent's checkout, and it
// exits on its own when the platform stops reading it (no heartbeat for two
// minutes) or after LIVE.maxLifetimeMs.

/* global LIVE */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CONFIG = typeof LIVE === 'object' && LIVE ? LIVE : {};
const DIR = CONFIG.dir || '/tmp/usernode-live';
const WORKSPACE = CONFIG.workspace || '/home/node/workspace';
const APP_DIR = path.join(DIR, 'app');
const STREAM = path.join(DIR, 'stream.ndjson');
const PORT = Number(CONFIG.port) || 3300;
const DATABASE_URL = CONFIG.databaseUrl || 'postgres://postgres:postgres@127.0.0.1:5432/usernode_live';
const VIEWPORT = { width: 390, height: 760 };
const MIN_RESTART_MS = Number(CONFIG.minRestartMs) || 30000;
const START_HEADROOM = (Number(CONFIG.startHeadroomMb) || 768) * 1024 * 1024;
const RUN_HEADROOM = (Number(CONFIG.runHeadroomMb) || 384) * 1024 * 1024;
const MAX_FULL_BYTES = Number(CONFIG.maxFullBytes) || 1500 * 1024;
const MAX_INC_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = Number(CONFIG.maxStreamBytes) || 40 * 1024 * 1024;
const MAX_LIFETIME_MS = Number(CONFIG.maxLifetimeMs) || 90 * 60 * 1000;
const HEARTBEAT_MS = 2 * 60 * 1000;
const BOOT_TIMEOUT_MS = 4 * 60 * 1000;
const LOAD_TIMEOUT_MS = 45 * 1000;
const SETTLE_MS = 1500;
// A good frame: nothing changed, and nothing of its own pending, this long…
const STABLE_MS = Number(CONFIG.stableMs) || 2000;
// …within this long of the page's load.
const SETTLE_LIMIT_MS = Number(CONFIG.settleLimitMs) || 15000;
// The app's files quiet this long before a restart copies them…
const QUIET_MS = Number(CONFIG.quietMs) || 8000;
// …unless they have kept changing for this long.
const MAX_PENDING_MS = Number(CONFIG.maxPendingMs) || 2 * 60 * 1000;
// A marker restarts no sooner than this after the last restart.
const MARKER_MIN_MS = Number(CONFIG.markerMinMs) || 10000;
const TICK_MS = 1000;
const SCAN_MS = 5000;
const MAX_SCAN_FILES = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

let written = 0;
let stopping = false;
let browser = null;
let app = null;
// Settles once the last app stopped has exited (stopApp).
let appGone = Promise.resolve();
let context = null;
let current = null; // { good, events: [], errors, failed, inflight, lastAt }
// The fingerprint of the app's files the newest restart copied.
let copiedSig = null;
const startedAt = Date.now();

function line(obj) {
  if (stopping && obj.t !== 'stop') return;
  const text = `${JSON.stringify(obj)}\n`;
  written += Buffer.byteLength(text);
  fs.appendFileSync(STREAM, text);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── Memory ───────────────────────────────────────────────────────────────

function readNumber(file, read) {
  try {
    const raw = String(read(file)).trim();
    if (!raw || raw === 'max') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function statValue(text, key) {
  const m = new RegExp(`^${key}\\s+(\\d+)`, 'm').exec(String(text || ''));
  return m ? Number(m[1]) : 0;
}

/**
 * How much memory the container has left: { headroom, used, limit, source },
 * or null when it cannot be told. The cgroup's limit less its working set
 * (usage less inactive file cache, as the kubelet counts it); else, with no
 * limit, MemAvailable. `read` is fs.readFileSync, for tests.
 */
function memoryHeadroom(read = (f) => fs.readFileSync(f, 'utf8')) {
  const v2Limit = readNumber('/sys/fs/cgroup/memory.max', read);
  const v2Used = readNumber('/sys/fs/cgroup/memory.current', read);
  if (v2Limit && v2Used != null) {
    let stat = '';
    try { stat = read('/sys/fs/cgroup/memory.stat'); } catch { /* none */ }
    const used = Math.max(0, v2Used - statValue(stat, 'inactive_file'));
    return { headroom: v2Limit - used, used, limit: v2Limit, source: 'cgroup2' };
  }
  const v1Limit = readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes', read);
  const v1Used = readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes', read);
  // v1 reports an unlimited cgroup as a huge number.
  if (v1Limit && v1Used != null && v1Limit < 2 ** 50) {
    let stat = '';
    try { stat = read('/sys/fs/cgroup/memory/memory.stat'); } catch { /* none */ }
    const used = Math.max(0, v1Used - statValue(stat, 'total_inactive_file'));
    return { headroom: v1Limit - used, used, limit: v1Limit, source: 'cgroup1' };
  }
  try {
    const info = read('/proc/meminfo');
    const avail = statValue(String(info).replace(/:/g, ''), 'MemAvailable') * 1024;
    const total = statValue(String(info).replace(/:/g, ''), 'MemTotal') * 1024;
    if (avail > 0) return { headroom: avail, used: total - avail, limit: total, source: 'meminfo' };
  } catch { /* none */ }
  return null;
}

/** Whether there is room to (re)start: unknown counts as room. */
function roomFor(threshold, read) {
  const mem = memoryHeadroom(read);
  return { ok: !mem || mem.headroom >= threshold, mem };
}

// ── The workspace ────────────────────────────────────────────────────────

/**
 * The app's own files, as git would commit them: tracked, and untracked but
 * not ignored (the app's .gitignore, and the build outputs
 * usernode-run-inloop lists in .git/info/exclude). Null outside a git
 * checkout, or when git cannot say. Reads only: no index refresh, no lock.
 */
function appFiles(dir = WORKSPACE, run = spawnSync) {
  let out;
  try {
    out = run('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch { return null; }
  if (!out || out.status !== 0 || typeof out.stdout !== 'string') return null;
  return [...new Set(out.stdout.split('\0').filter(Boolean))].slice(0, MAX_SCAN_FILES);
}

/**
 * A cheap fingerprint of the app's files: their paths, sizes and times. Of
 * what git would commit (appFiles); else of the whole checkout but
 * node_modules and .git.
 */
function workspaceSignature(dir = WORKSPACE, files = appFiles(dir)) {
  if (Array.isArray(files)) {
    let acc = 0;
    for (const rel of files) {
      let st = null;
      try { st = fs.statSync(path.join(dir, rel)); } catch { st = null; }
      acc = (acc + (st ? st.size * 31 + Math.floor(st.mtimeMs) : 7) + rel.length * 131) % 1e15;
    }
    return `${files.length}:${acc}`;
  }
  let n = 0;
  let acc = 0;
  const stack = [dir];
  while (stack.length && n < MAX_SCAN_FILES) {
    const at = stack.pop();
    let entries;
    try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(at, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(full);
        n += 1;
        acc = (acc + st.size * 31 + Math.floor(st.mtimeMs) + full.length) % 1e15;
      } catch { /* gone meanwhile */ }
    }
  }
  return `${n}:${acc}`;
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** The app's copy: everything but node_modules and .git, with node_modules linked. */
function snapshot() {
  fs.rmSync(APP_DIR, { recursive: true, force: true });
  fs.cpSync(WORKSPACE, APP_DIR, {
    recursive: true,
    filter: (src) => !SKIP_DIRS.has(path.basename(src)) || path.dirname(src) !== WORKSPACE,
  });
  const modules = path.join(WORKSPACE, 'node_modules');
  if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(APP_DIR, 'node_modules'), 'dir');
}

// ── The app ──────────────────────────────────────────────────────────────

function freshDatabase() {
  const name = decodeURIComponent(new URL(DATABASE_URL).pathname.replace(/^\//, ''));
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || name === 'inloop') return false;
  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const psql = (sql) => spawnSync('psql', [admin.toString(), '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { encoding: 'utf8', timeout: 30000 });
  if (psql('SELECT 1').status !== 0) {
    // The build turn starts it; if it is not up yet, start it as its helper does.
    const pgdata = process.env.INLOOP_PGDATA || '/home/node/pgdata';
    spawnSync('pg_ctl', ['-D', pgdata, '-w', '-l', '/tmp/inloop-postgres.log', 'start'], { timeout: 60000 });
  }
  psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
  const dropped = psql(`DROP DATABASE IF EXISTS "${name}"`);
  const made = psql(`CREATE DATABASE "${name}"`);
  return dropped.status === 0 && made.status === 0;
}

function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

/**
 * Stop the app (its whole process group): SIGTERM, then SIGKILL after 3 s.
 * Resolves once it has exited (or 6 s, at most), so the next boot never
 * finds the old app still answering on the port, or still holding it.
 */
function stopApp() {
  const child = app;
  app = null;
  if (!child || child.exitCode != null || child.signalCode != null) return appGone;
  appGone = new Promise((resolve) => {
    let kill = null;
    let cap = null;
    const done = () => { clearTimeout(kill); clearTimeout(cap); resolve(); };
    child.once('exit', done);
    try { process.kill(-child.pid, 'SIGTERM'); } catch { done(); return; }
    kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000);
    cap = setTimeout(done, 6000);
  });
  return appGone;
}

/** Wait (up to `ms`) until nothing answers on the port. */
async function portFree(ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await probe())) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  return false;
}

async function bootApp(lib, identity) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')); } catch { pkg = {}; }
  const command = lib.startCommand(pkg, (f) => fs.existsSync(path.join(APP_DIR, f)));
  const env = {
    ...process.env,
    INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(PORT), INLOOP_DATABASE_URL: DATABASE_URL,
    USERNODE_JWT_PUBLIC_KEY: identity.publicKeyPem, USERNODE_APP_ID: String(Number(CONFIG.appId) || 1),
  };
  const launcher = CONFIG.launcher || '/usr/local/bin/usernode-run-inloop';
  const child = spawn(process.execPath, [launcher, ...command], { cwd: APP_DIR, env, detached: true, stdio: 'ignore' });
  app = child;
  try { fs.writeFileSync(path.join(DIR, 'app.pgid'), String(child.pid)); } catch { /* best effort */ }
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline && !stopping) {
    if (exited) return 'the app exited while starting';
    // eslint-disable-next-line no-await-in-loop
    const status = await probe();
    if (status && status !== 502) return null;
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  return 'the app did not answer in time';
}

// ── Recording ────────────────────────────────────────────────────────────

/**
 * The init script: rrweb, then recording in the TOP frame only. rrweb makes
 * helper iframes of its own, and recording in every frame recursed until
 * "Maximum call stack size exceeded" (the prototype's lesson). The UMD build
 * is wrapped so a page's own AMD loader cannot take it, and kept off
 * `window` once read.
 */
function initScript(rrwebSource) {
  return [
    "if (window === window.top && location.protocol === 'http:') { (function () {",
    'var define, exports, module;',
    'var rr = (function () {',
    rrwebSource,
    '\n; var r = this.rrweb; try { delete this.rrweb; } catch (e) { this.rrweb = undefined; } return r; }).call(window);',
    "document.addEventListener('DOMContentLoaded', function () {",
    '  try {',
    '    rr.record({',
    '      emit: function (e) { try { window.__usernodeLive(JSON.stringify(e)); } catch (err) {} },',
    '      inlineStylesheet: true, inlineImages: true, recordCanvas: false, collectFonts: false,',
    "      sampling: { mousemove: false, mouseInteraction: false, scroll: 250, input: 'last' },",
    '    });',
    '  } catch (err) {}',
    '});',
    // A fresh snapshot of the settled page, for the watcher (restart):
    // asked for by an event, so nothing new is put on `window`.
    "document.addEventListener('__usernode_live_checkout', function () {",
    '  try { rr.record.takeFullSnapshot(true); } catch (err) {}',
    '});',
    '})(); }',
  ].join('\n');
}

function flush() {
  const rec = current;
  if (!rec || !rec.good || !rec.events.length) return;
  let batch = [];
  let bytes = 0;
  for (const e of rec.events.splice(0)) {
    const size = e.length;
    if (size > MAX_FULL_BYTES) continue; // one event too big to show: skipped
    if (bytes + size > MAX_INC_BYTES && batch.length) {
      line({ t: 'inc', events: batch.map((s) => JSON.parse(s)) });
      batch = [];
      bytes = 0;
    }
    batch.push(e);
    bytes += size;
  }
  if (batch.length) line({ t: 'inc', events: batch.map((s) => JSON.parse(s)) });
}

async function closePage() {
  flush();
  current = null;
  const ctx = context;
  context = null;
  if (ctx) await ctx.close().catch(() => {});
}

// What the launcher passes to the platform, as production's edge does
// (usernode-run-inloop PLATFORM_ASSET_PREFIXES): not the app's own.
const PLATFORM_PATHS = /^\/usernode-(?:bridge|native|tailwind)\//;

/** Whether a request is one of the page's own fetch/XHR requests, to `origin` (the app, not the platform's assets). */
function ownRequest(request, origin) {
  try {
    const type = typeof request.resourceType === 'function' ? request.resourceType() : '';
    if (type !== 'fetch' && type !== 'xhr') return false;
    const url = new URL(request.url());
    return url.origin === origin && !PLATFORM_PATHS.test(url.pathname);
  } catch { return false; }
}

/**
 * Pure: whether a page has settled at `now`: nothing recorded and no request
 * of its own started or ended for STABLE_MS, with none pending. At the limit
 * (`limitReached`), quiet with a request still pending (an app that holds
 * one open), or changing with none pending (an app that animates), is
 * settled too; changing with one pending is still loading.
 */
function settledNow(rec, now, { limitReached = false } = {}) {
  const quiet = now - rec.lastAt >= STABLE_MS;
  if (quiet && rec.inflight <= 0) return true;
  return limitReached && (quiet || rec.inflight <= 0);
}

/**
 * Pure: why a page is not a good frame, or null. `rec` as restart keeps it;
 * `settled` from settledNow, `text` its body's text length, `size` its
 * recording's bytes.
 */
function frameProblem(rec, { settled, text, size }) {
  if (rec.errors) return 'the page threw an error';
  if (rec.failed) return 'a request of the page failed';
  if (!settled) return 'the page was still loading';
  if (!text) return 'the page was empty';
  if (rec.events.length < 2) return 'nothing was recorded';
  if (size > MAX_FULL_BYTES) return 'the page was too large to stream';
  return null;
}

/** Wait for the page to settle (settledNow), or for an error. Resolves whether it settled. */
async function settle(rec, loadedAt) {
  await sleep(SETTLE_MS);
  for (;;) {
    const now = Date.now();
    if (rec.errors || rec.failed) return false;
    if (settledNow(rec, now)) return true;
    if (now - loadedAt >= SETTLE_LIMIT_MS) return settledNow(rec, now, { limitReached: true });
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
}

function eventType(json) {
  const m = /^\{"type":(\d+)/.exec(json);
  if (m) return Number(m[1]);
  try { return Number(JSON.parse(json).type); } catch { return -1; }
}

/**
 * Pure: where the newest snapshot at or after `from` starts in `events`
 * (rrweb events as JSON): the Meta event before its FullSnapshot, or -1.
 */
function checkoutStart(events, from = 0) {
  let full = -1;
  for (let i = events.length - 1; i >= from; i -= 1) {
    if (eventType(events[i]) === 2) { full = i; break; }
  }
  for (let i = full - 1; full >= 0 && i >= from; i -= 1) {
    if (eventType(events[i]) === 4) return i;
  }
  return -1;
}

/**
 * Take a fresh snapshot of the settled page (initScript's checkout event)
 * and drop what was recorded before it, so the recording people see starts
 * from the settled page, its stylesheets loaded and inlined. False, and the
 * recording as it was, when none came.
 */
async function checkout(page, rec) {
  const from = rec.events.length;
  const asked = await page.evaluate(() => { document.dispatchEvent(new Event('__usernode_live_checkout')); return true; })
    .catch(() => false);
  if (!asked) return false;
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const at = checkoutStart(rec.events, from);
    if (at >= 0) { rec.events.splice(0, at); return true; }
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }
  return false;
}

async function restart(lib, identity, rrwebSource, cause = 'change') {
  await closePage();
  // The old app gone, and its port free, before anything boots on it.
  await stopApp();
  await portFree();
  const room = roomFor(START_HEADROOM);
  if (room.mem) line({ t: 'mem', headroomMb: Math.round(room.mem.headroom / 1048576) });
  if (!room.ok) return stop('memory');
  const t0 = Date.now();
  copiedSig = workspaceSignature();
  try { snapshot(); } catch (err) { return line({ t: 'fail', why: `copy: ${String(err.message).slice(0, 120)}`, cause }); }
  // An app that needs no database boots without one; one that does fails
  // to boot, and says so below.
  const db = freshDatabase();
  const bootError = await bootApp(lib, identity);
  if (stopping) return undefined;
  if (bootError) { await stopApp(); return line({ t: 'fail', why: db ? bootError : `${bootError} (no local database)`, cause }); }
  const rec = { good: false, events: [], errors: 0, failed: 0, inflight: 0, lastAt: Date.now() };
  current = rec;
  context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    colorScheme: 'light', serviceWorkers: 'block',
  });
  await context.exposeBinding('__usernodeLive', (source, json) => {
    if (current !== rec || typeof json !== 'string') return;
    // Only the top frame records (initScript), and only that frame's events are kept.
    if (source && source.frame && source.page && source.frame !== source.page.mainFrame()) return;
    rec.events.push(json);
    rec.lastAt = Date.now();
  });
  await context.addInitScript({ content: initScript(rrwebSource) });
  const page = await context.newPage();
  const origin = `http://localhost:${PORT}`;
  page.on('pageerror', () => { rec.errors += 1; });
  page.on('request', (r) => { if (ownRequest(r, origin)) { rec.inflight += 1; rec.lastAt = Date.now(); } });
  page.on('response', (r) => { if (ownRequest(r.request(), origin) && r.status() >= 400) rec.failed += 1; });
  page.on('requestfinished', (r) => { if (ownRequest(r, origin)) { rec.inflight -= 1; rec.lastAt = Date.now(); } });
  page.on('requestfailed', (r) => {
    if (!ownRequest(r, origin)) return;
    rec.inflight -= 1;
    rec.lastAt = Date.now();
    // One the page called off itself (a navigation, an AbortController) is no failure.
    const why = (typeof r.failure === 'function' && r.failure()?.errorText) || '';
    if (!/ERR_ABORTED/i.test(why)) rec.failed += 1;
  });
  try {
    await page.goto(lib.shotUrl(origin, { look: 'light', state: 'populated' }, identity.token), {
      waitUntil: 'load', timeout: LOAD_TIMEOUT_MS,
    });
    const settled = await settle(rec, Date.now());
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '').trim().length).catch(() => 0);
    let why = frameProblem(rec, { settled, text, size: 0 });
    if (!why) {
      await checkout(page, rec);
      why = frameProblem(rec, { settled, text, size: rec.events.reduce((n, e) => n + e.length, 0) });
    }
    if (why) {
      await closePage();
      await stopApp();
      return line({ t: 'fail', why, cause });
    }
    if (current !== rec) return undefined;
    rec.good = true;
    line({ t: 'full', events: rec.events.splice(0).map((e) => JSON.parse(e)), ms: Date.now() - t0, cause });
  } catch (err) {
    await closePage();
    await stopApp();
    return line({ t: 'fail', why: `the page did not load: ${String(err.message).split('\n')[0].slice(0, 120)}`, cause });
  }
  return undefined;
}

/**
 * Pure: whether the app restarts now, and why ('first', 'marker',
 * 'change'), or null. `changed`: its files differ from what the newest
 * restart copied; `changedAt`: when they last changed; `pendingSince`: since
 * when they have differed; `marker`: a progress marker not acted on yet.
 */
function restartDue({ first = false, now, changed = false, changedAt = 0, pendingSince = 0, lastRestart = 0, marker = false }) {
  if (first) return 'first';
  if (!changed) return null;
  if (marker && now - lastRestart >= MARKER_MIN_MS) return 'marker';
  if (now - lastRestart < MIN_RESTART_MS) return null;
  if (now - changedAt >= QUIET_MS || now - pendingSince >= MAX_PENDING_MS) return 'change';
  return null;
}

// ── Running ──────────────────────────────────────────────────────────────

async function stop(why) {
  if (stopping) return;
  line({ t: 'stop', why });
  stopping = true;
  current = null;
  stopApp();
  if (browser) await browser.close().catch(() => {});
  setTimeout(() => process.exit(0), 200);
}

function loadPlaywright() {
  const candidates = [process.env.BENCH_PLAYWRIGHT, 'playwright', '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const lib = require(CONFIG.libPath || path.join(DIR, 'capture-lib.js'));
  const rrwebSource = fs.readFileSync(CONFIG.rrwebPath || path.join(DIR, 'rrweb.umd.min.cjs'), 'utf8');
  const first = roomFor(START_HEADROOM);
  if (first.mem) line({ t: 'mem', headroomMb: Math.round(first.mem.headroom / 1048576) });
  if (!first.ok) return stop('memory');
  const playwright = loadPlaywright();
  if (!playwright) return stop('no_browser');
  browser = await playwright.chromium.launch({
    channel: 'chromium', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const identity = lib.throwawayIdentity(CONFIG.appId);
  let lastRestart = 0;
  let lastScan = 0;
  let scanned = null; // the app's files as last scanned
  let changedAt = 0; // when they last changed
  let pendingSince = 0; // since when they have differed from what the app runs
  let firstBoot = true;
  let progressSeen = mtimeOf(path.join(DIR, 'progress'));
  while (!stopping) {
    const now = Date.now();
    if (now - startedAt > MAX_LIFETIME_MS) return stop('lifetime');
    if (now - startedAt > HEARTBEAT_MS && now - mtimeOf(path.join(DIR, 'heartbeat')) > HEARTBEAT_MS) return stop('orphaned');
    if (written > MAX_STREAM_BYTES) return stop('size');
    const mem = memoryHeadroom();
    if (mem && mem.headroom < RUN_HEADROOM) return stop('memory');
    if (now - lastScan >= SCAN_MS) {
      lastScan = now;
      const sig = workspaceSignature();
      if (sig !== scanned) { scanned = sig; changedAt = now; }
    }
    const changed = scanned !== null && copiedSig !== null && scanned !== copiedSig;
    if (!changed) pendingSince = 0;
    else if (!pendingSince) pendingSince = now;
    const progress = mtimeOf(path.join(DIR, 'progress'));
    const marker = !!progress && progress !== progressSeen;
    // A marker with nothing new to show is passed over.
    if (marker && !changed && !firstBoot) progressSeen = progress;
    const cause = restartDue({ first: firstBoot, now, changed, changedAt, pendingSince, lastRestart, marker });
    if (cause) {
      if (marker) progressSeen = progress;
      firstBoot = false;
      lastRestart = now;
      // eslint-disable-next-line no-await-in-loop
      await restart(lib, identity, rrwebSource, cause);
      lastRestart = Date.now();
      pendingSince = 0;
    }
    flush();
    // eslint-disable-next-line no-await-in-loop
    await sleep(TICK_MS);
  }
  return undefined;
}

if (require.main === module) {
  process.on('SIGTERM', () => { stop('ended'); });
  process.on('SIGINT', () => { stop('ended'); });
  main().catch((err) => {
    try { line({ t: 'stop', why: 'error', detail: String((err && err.message) || err).slice(0, 200) }); } catch { /* nothing to say it on */ }
    stopping = true;
    stopApp();
    if (browser) browser.close().catch(() => {});
    setTimeout(() => process.exit(0), 200);
  });
}

module.exports = {
  memoryHeadroom, roomFor, workspaceSignature, appFiles, initScript, statValue,
  settledNow, frameProblem, checkoutStart, restartDue, ownRequest,
  STABLE_MS, SETTLE_LIMIT_MS, QUIET_MS, MAX_PENDING_MS, MARKER_MIN_MS, MIN_RESTART_MS,
};
