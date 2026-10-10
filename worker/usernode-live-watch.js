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
// RESTARTS. When the workspace changes, at most once every 30 seconds, and
// at each `usernode-progress` marker (the platform touches LIVE.dir/progress
// when it reads one), the app is copied, rebooted and opened again. A
// restart is KEPT only when the page loaded cleanly: no `pageerror`, some
// text in the body, more than one event. Otherwise the last good recording
// stays what people see, and the failure is reported.
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
const TICK_MS = 1000;
const SCAN_MS = 5000;
const MAX_SCAN_FILES = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

let written = 0;
let stopping = false;
let browser = null;
let app = null;
let context = null;
let current = null; // { good, events: [], bytes }
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

/** A cheap fingerprint of the checkout: its files' paths, sizes and times. */
function workspaceSignature(dir = WORKSPACE) {
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

function stopApp() {
  const child = app;
  app = null;
  if (!child || child.exitCode != null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
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

async function restart(lib, identity, rrwebSource) {
  await closePage();
  stopApp();
  const room = roomFor(START_HEADROOM);
  if (room.mem) line({ t: 'mem', headroomMb: Math.round(room.mem.headroom / 1048576) });
  if (!room.ok) return stop('memory');
  const t0 = Date.now();
  try { snapshot(); } catch (err) { return line({ t: 'fail', why: `copy: ${String(err.message).slice(0, 120)}` }); }
  // An app that needs no database boots without one; one that does fails
  // to boot, and says so below.
  const db = freshDatabase();
  const bootError = await bootApp(lib, identity);
  if (stopping) return undefined;
  if (bootError) { stopApp(); return line({ t: 'fail', why: db ? bootError : `${bootError} (no local database)` }); }
  const rec = { good: false, events: [], errors: 0 };
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
  });
  await context.addInitScript({ content: initScript(rrwebSource) });
  const page = await context.newPage();
  page.on('pageerror', () => { rec.errors += 1; });
  try {
    await page.goto(lib.shotUrl(`http://localhost:${PORT}`, { look: 'light', state: 'populated' }, identity.token), {
      waitUntil: 'load', timeout: LOAD_TIMEOUT_MS,
    });
    await sleep(SETTLE_MS);
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '').trim().length).catch(() => 0);
    const size = rec.events.reduce((n, e) => n + e.length, 0);
    let why = null;
    if (rec.errors) why = 'the page threw an error';
    else if (!text) why = 'the page was empty';
    else if (rec.events.length < 2) why = 'nothing was recorded';
    else if (size > MAX_FULL_BYTES) why = 'the page was too large to stream';
    if (why) {
      await closePage();
      stopApp();
      return line({ t: 'fail', why });
    }
    if (current !== rec) return undefined;
    rec.good = true;
    line({ t: 'full', events: rec.events.splice(0).map((s) => JSON.parse(s)), ms: Date.now() - t0 });
  } catch (err) {
    await closePage();
    stopApp();
    return line({ t: 'fail', why: `the page did not load: ${String(err.message).split('\n')[0].slice(0, 120)}` });
  }
  return undefined;
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
  let signature = null;
  let pending = true; // the first boot
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
      if (signature !== null && sig !== signature) pending = true;
      signature = sig;
    }
    const progress = mtimeOf(path.join(DIR, 'progress'));
    const marker = progress && progress !== progressSeen;
    if (marker || (pending && now - lastRestart >= MIN_RESTART_MS)) {
      progressSeen = progress;
      pending = false;
      lastRestart = now;
      // eslint-disable-next-line no-await-in-loop
      await restart(lib, identity, rrwebSource);
      lastRestart = Date.now();
      signature = workspaceSignature();
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

module.exports = { memoryHeadroom, roomFor, workspaceSignature, initScript, statValue };
