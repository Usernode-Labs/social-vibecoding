'use strict';

// #3737: the benchmark's screenshot step, RUN FOR REAL on today's Empty
// starter: worker/usernode-bench-capture.js boots the app through
// worker/usernode-run-inloop (its `npm run build`, staging mode, a fresh
// local database, the hosted /usernode-* assets served on the app's origin),
// signs a viewer in with its throwaway key, takes the sixteen screenshots
// with Chromium and measures them; the platform's half
// (services/bench/capture.js) keeps every one.
//
// The worker image has what this needs; a test machine may not. It skips
// unless Playwright with a Chromium it can launch, psql and a PostgreSQL
// server are all here (TEST_DATABASE_URL names the server). The starter's
// dependencies are this repository's own, linked, so nothing is installed,
// and the hosted assets are this repository's copies, served for this test
// alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'worker', 'usernode-bench-capture.js');
const capture = require('../src/services/bench/capture');
const { getTemplateFiles } = require('../src/services/template');

function playwrightPath() {
  for (const candidate of [process.env.BENCH_PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright',
    '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright']) {
    if (!candidate) continue;
    try { return require.resolve(candidate); } catch { /* next */ }
  }
  return null;
}

async function prerequisites() {
  const dsn = process.env.TEST_DATABASE_URL;
  if (!dsn) return { skip: 'set TEST_DATABASE_URL (a PostgreSQL server the step may make a database on) to run the screenshot step' };
  if (spawnSync('psql', ['--version']).status !== 0) return { skip: 'psql is not installed' };
  const pw = playwrightPath();
  if (!pw) return { skip: 'Playwright is not installed' };
  try {
    const browser = await require(pw).chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
    await browser.close();
  } catch (err) {
    return { skip: `Chromium will not launch here: ${String(err.message).split('\n')[0]}` };
  }
  return { dsn, pw };
}

function assetServer() {
  // What production's edge answers on an app's origin, from this
  // repository's copies (the in-loop launcher forwards /usernode-* here).
  const pub = path.join(ROOT, 'public');
  const server = http.createServer((req, res) => {
    const file = path.join(pub, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(pub) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const type = file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('the screenshot step boots today\'s Empty starter and takes and measures its sixteen screenshots', { timeout: 175000 }, async (t) => {
  const pre = await prerequisites();
  if (pre.skip) { t.skip(pre.skip); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-capture-'));
  const db = `bench_capture_${crypto.randomBytes(5).toString('hex')}`;
  const dbUrl = new URL(pre.dsn); dbUrl.pathname = `/${db}`;
  const assets = await assetServer();
  t.after(() => {
    assets.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const admin = new URL(pre.dsn); admin.pathname = '/postgres';
    spawnSync('psql', [String(admin), '-q', '-c', `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`]);
  });
  for (const f of getTemplateFiles('Taste Probe', 'taste-probe', '', null, {})) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=bench@example.invalid', '-c', 'user.name=bench', 'commit', '-qm', 'starter']]) {
    spawnSync('git', args, { cwd: dir });
  }

  const started = Date.now();
  const port = 31900 + Math.floor(Math.random() * 90);
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: dir,
      env: {
        ...process.env,
        INLOOP_PORT: String(port), INLOOP_DATABASE_URL: String(dbUrl), BENCH_APP_ID: '77',
        BENCH_RUN_INLOOP: path.join(ROOT, 'worker', 'usernode-run-inloop'),
        // Not the worker's helper (this machine's server is the test's).
        BENCH_INLOOP_DB_SCRIPT: path.join(dir, 'no-such-helper.sh'),
        BENCH_PLAYWRIGHT: pre.pw,
        PLATFORM_URL: `http://127.0.0.1:${assets.address().port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(-2000)}`))));
  });

  const result = capture.parseOutput(stdout);
  assert.ok(result, 'the step wrote its result line');
  assert.equal(result.error, null, result.error || '');
  assert.equal(result.booted, true);
  assert.equal(result.steps.install.ran, false, 'dependencies already there');
  assert.equal(result.steps.boot.command, 'npm start');
  assert.equal(result.steps.emptied.ok, true);

  // Sixteen PNGs of the planned sizes, every one of the signed-in app.
  const { kept, dropped } = capture.acceptShots(result.shots);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 16);
  assert.deepEqual(kept.map((s) => s.id).sort(), capture.plannedShots().map((s) => s.id).sort());
  for (const s of kept) {
    assert.deepEqual([s.width, s.height], s.viewport === 'phone' ? [390, 844] : [1280, 800], s.id);
    assert.equal(s.status, 200, `${s.id} is the app, not the "open in Homeroom" page an unsigned visit gets`);
  }
  const byId = Object.fromEntries(kept.map((s) => [s.id, s]));
  assert.notEqual(byId['phone-light-populated'].sha256, byId['phone-dark-populated'].sha256, 'the two looks differ');
  assert.notEqual(byId['phone-light-populated'].sha256, byId['desktop-light-populated'].sha256);

  // The checks, as numbers.
  const c = result.checks;
  assert.equal(c.consoleErrors.count, 0, JSON.stringify(c.consoleErrors.samples));
  assert.equal(c.consoleErrors.screens, 8);
  assert.deepEqual([c.overflow360.light, c.overflow360.dark], [0, 0], 'the starter fits 360 px');
  assert.ok(c.smallTapTargets.checked >= 1);
  assert.ok(Number.isInteger(c.smallTapTargets.small));
  for (const look of ['light', 'dark']) {
    assert.ok(c.lowContrast[look].checked > 10, `${look}: the text was read`);
    assert.ok(Number.isInteger(c.lowContrast[look].low));
    assert.ok(c.lowContrast[look].worst > 1);
  }
  assert.equal(c.nestedCards.worst, 0);
  // The tells, from the starter's own source.
  assert.ok(result.tells.files >= 1);
  assert.equal(result.tells.emojiIcons.count, 0);
  assert.equal(result.tells.arbitraryTextSizes.count, 0);
  assert.ok(Date.now() - started < 170000);
});

test('the in-page measurements run under a strict Content-Security-Policy and count what they should', { timeout: 60000 }, async (t) => {
  const pw = playwrightPath();
  if (!pw) { t.skip('Playwright is not installed'); return; }
  let browser;
  try {
    browser = await require(pw).chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
  } catch (err) {
    t.skip(`Chromium will not launch here: ${String(err.message).split('\n')[0]}`);
    return;
  }
  t.after(() => browser.close());
  const html = `<!doctype html><html><body style="margin:0;background:#fff;font:16px sans-serif">
    <p style="color:#999">Faint text, about 2.8 to 1</p>
    <p style="color:#111">Readable text</p>
    <button style="width:30px;height:30px">x</button>
    <button style="width:120px;height:48px">Big enough</button>
    <p>Read <a href="/x">the inline link</a> in a sentence.</p>
    <div style="border:1px solid #ddd;border-radius:8px;padding:16px;width:300px">
      <div style="border:1px solid #ddd;border-radius:8px;padding:12px;width:240px;height:60px">Card in a card</div>
    </div>
    <div style="width:600px">Too wide for a phone</div>
  </body></html>`;
  const server = http.createServer((req, res) => {
    // A strict policy, as an app using helmet's defaults sends: no inline
    // script, no eval.
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 780 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const step = require('../worker/usernode-bench-capture');
  const m = await page.evaluate(step.measureExpression({ minTap: 44, maxSamples: 5 }));
  assert.equal(m.contrast.low, 1, JSON.stringify(m.contrast.samples));
  assert.equal(m.contrast.samples[0].text, 'Faint text, about 2.8 to 1');
  assert.ok(m.contrast.checked >= 5);
  assert.equal(m.tap.small, 1, 'the 30 px button; the inline link is exempt');
  assert.equal(m.tap.checked, 2);
  assert.equal(m.nestedCards, 1);
  assert.ok(m.overflowPx >= 240, 'a 600 px box on a 360 px screen');
});
