'use strict';

// #3737: the benchmark's screenshot step, RUN FOR REAL on today's Empty
// starter: worker/usernode-bench-capture.js boots the app through
// worker/usernode-run-inloop (its `npm run build`, staging mode, a fresh
// local database, the hosted /usernode-* assets served on the app's origin),
// signs a viewer in with its throwaway key, takes the sixteen screenshots
// with Chromium and measures them, and finds no primary action on the
// starter's screen to take the result state's three after; the platform's
// half (services/bench/capture.js) keeps every one.
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

test('the screenshot step boots today\'s Empty starter and takes and measures its sixteen screenshots, and says why it tapped nothing', { timeout: 175000 }, async (t) => {
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

  // Sixteen PNGs of the planned sizes, every one of the signed-in app. The
  // starter's screen has no button, so the result state took none, said
  // why, and did not open the same page again for the other look.
  const { kept, dropped } = capture.acceptShots(result.shots);
  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 16);
  assert.deepEqual(kept.map((s) => s.id).sort(), capture.plannedShots().filter((s) => s.state !== 'result').map((s) => s.id).sort());
  assert.deepEqual(result.primaryAction.map((a) => [a.id, a.skipped, a.sameAs || null]), [
    ['phone-light-result', result.primaryAction[0].skipped, null],
    ['phone-dark-result', result.primaryAction[0].skipped, 'phone-light-result'],
    ['desktop-light-result', result.primaryAction[2].skipped, null],
  ]);
  for (const a of result.primaryAction) assert.match(a.skipped, /^no clear primary action: no marked control/);
  assert.equal(capture.summarize(result, kept, dropped).primaryAction.length, 3);
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
  // #3737 Rec2: the starter every first version is built from passes its
  // own measures: its design kit's tokens and 44 px controls.
  assert.ok(c.smallTapTargets.checked >= 1);
  assert.equal(c.smallTapTargets.small, 0, JSON.stringify(c.smallTapTargets.samples));
  for (const look of ['light', 'dark']) {
    assert.ok(c.lowContrast[look].checked > 10, `${look}: the text was read`);
    assert.equal(c.lowContrast[look].low, 0, `${look}: ${JSON.stringify(c.lowContrast[look].samples)}`);
    assert.ok(c.lowContrast[look].worst >= 4.5);
  }
  assert.equal(c.nestedCards.worst, 0);
  // The tells, from the starter's own source.
  assert.ok(result.tells.files >= 1);
  assert.equal(result.tells.emojiIcons.count, 0);
  assert.equal(result.tells.arbitraryTextSizes.count, 0);
  assert.equal(result.tells.uppercaseEyebrows.count, 0);
  assert.equal(result.tells.hexColours.count, 0);
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

// The result state on fixture pages, through the step's own takeShot: the
// populated screen loaded as every populated screenshot is, its primary
// action chosen in the page and tapped once, and what it brought up shown.
const FIXTURE_HEAD = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --accent: 15 118 110; }
  body { margin: 0; font: 16px/1.4 sans-serif; background: #fff; color: #111; }
  header { display: flex; justify-content: space-between; align-items: center; height: 56px; padding: 0 16px; }
  main { padding: 16px; }
  .btn-primary { display: block; width: 100%; min-height: 48px; border: 0; border-radius: 8px; background: rgb(var(--accent)); color: #fff; font: inherit; }
  header .btn-primary { width: auto; padding: 0 12px; }
  .btn-secondary { min-height: 48px; border: 1px solid #ccc; background: #fff; }
  label { display: block; height: 96px; }
  #recipe { min-height: 360px; background: #ccfbf1; }
</style></head><body>`;

const FIXTURES = {
  // A bread calculator: the recipe appears below the form, out of view on a
  // phone, after the API answers.
  '/calc/': `${FIXTURE_HEAD}
    <header><b>Bread Bot</b><a class="btn-primary" href="https://example.com/upgrade">Upgrade</a></header>
    <main>
      <p style="height:200px">How much bread do you want to bake?</p>
      <form id="f">
        <label>Flour (g) <input name="flour" value="500"></label>
        <label>Hydration (%) <input name="water" value="70"></label>
        <label>Salt (%) <input name="salt" value="2"></label>
        <button class="btn-secondary" type="button">Reset</button>
        <button class="btn-primary" type="submit">Calculate</button>
      </form>
      <section id="recipe" hidden></section>
    </main>
    <script>
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        const r = await fetch('/api/recipe');
        const lines = await r.json();
        const out = document.getElementById('recipe');
        out.innerHTML = '<h2>Your recipe</h2><ul>' + lines.map((l) => '<li>' + l + '</li>').join('') + '</ul>';
        out.hidden = false;
      });
    </script></body></html>`,
  // Its only action asks something, then tries to leave the app.
  '/away/': `${FIXTURE_HEAD}<main><p>Ready?</p><button class="btn-primary" id="go">Continue</button></main>
    <script>document.getElementById('go').onclick = () => { if (confirm('Leave?')) return; alert('Leaving anyway'); location.href = 'https://example.invalid/next'; };</script></body></html>`,
  '/link/': `${FIXTURE_HEAD}<main><a class="btn-primary" href="https://example.com/shop">Open the shop</a></main></body></html>`,
  '/two/': `${FIXTURE_HEAD}<main><button class="btn-primary">Save</button><button class="btn-primary">Share</button></main></body></html>`,
  '/disabled/': `${FIXTURE_HEAD}<main><form><input name="q"><button class="btn-primary" disabled>Calculate</button></form></main></body></html>`,
  '/none/': `${FIXTURE_HEAD}<main><p>Nothing to tap here.</p></main></body></html>`,
};

test('the result state taps the screen\'s primary action once and shows what it brought up, and never leaves the app or waits on a dialog', { timeout: 120000 }, async (t) => {
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
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/recipe') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(['500 g flour', '350 g water', '10 g salt', '5 g yeast']));
      }, 300);
      return;
    }
    if (!FIXTURES[pathname]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(FIXTURES[pathname]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const step = require('../worker/usernode-bench-capture');
  const plan = step.capturePlan();
  const shotOf = (id) => plan.find((s) => s.id === id);
  const at = (page) => `http://127.0.0.1:${server.address().port}${page.replace(/\/$/, '')}`;

  // The calculator: "Calculate" is the main content's one kit button (the
  // header's off-site "Upgrade" is passed over); the recipe, fetched and
  // drawn below the fold, is scrolled into view.
  const populated = await step.takeShot(browser, at('/calc/'), 'tok', shotOf('phone-light-populated'));
  const result = await step.takeShot(browser, at('/calc/'), 'tok', shotOf('phone-light-result'));
  assert.equal(result.failed, undefined, result.failed);
  assert.deepEqual(result.action.used, {
    label: 'Calculate', rule: 'kit-primary', why: 'the design kit\'s primary button (.btn-primary), the only one in the main content',
  });
  assert.equal(result.action.settled, 'network idle', 'it waited for the recipe to arrive');
  assert.ok(result.action.changes >= 1);
  assert.equal(result.action.revealed, true, 'the recipe was below the fold');
  assert.deepEqual([result.action.dialogs, result.action.blocked], [0, 0]);
  assert.ok(result.action.ms < step.ACTION_BUDGET_MS);
  assert.ok(Buffer.isBuffer(result.png) && Buffer.isBuffer(populated.png));
  assert.deepEqual([result.width, result.height], [390, 844]);
  assert.equal(result.status, 200);
  assert.equal(result.consoleErrors, 0, JSON.stringify(result.errorSamples));
  // What the platform keeps of it: a screenshot unlike the populated one,
  // captioned with the control it tapped.
  const { kept } = capture.acceptShots([populated, result].map((s) => ({ ...s, png: s.png.toString('base64') })));
  assert.deepEqual(kept.map((s) => s.id), ['phone-light-populated', 'phone-light-result']);
  assert.notEqual(kept[0].sha256, kept[1].sha256, 'the recipe shows');
  const summary = capture.summarize({ booted: true, primaryAction: step.primaryActionRecord([result]) }, kept, [], { 'phone-light-populated': 'a'.repeat(32), 'phone-light-result': 'b'.repeat(32) });
  assert.deepEqual(capture.pickShots(summary).chosen.map((s) => s.caption), [
    'Phone 390×844, light look, populated (the app\'s own staging data)',
    'Phone 390×844, light look, after tapping "Calculate" (the screen\'s primary action)',
  ]);
  assert.equal(summary.primaryAction[0].used.label, 'Calculate');

  // A confirm and an alert are dismissed and the jump to another site is
  // blocked: the screenshot is of the app, still on its own page.
  const away = await step.takeShot(browser, at('/away/'), 'tok', shotOf('desktop-light-result'));
  assert.equal(away.failed, undefined, away.failed);
  assert.equal(away.action.used.label, 'Continue');
  assert.equal(away.action.dialogs, 2);
  assert.equal(away.action.blocked, 1);
  assert.ok(Buffer.isBuffer(away.png));

  // Nothing tapped, nothing taken, and why.
  const skipped = async (page) => {
    const s = await step.takeShot(browser, at(page), 'tok', shotOf('phone-dark-result'));
    assert.equal(s.png, undefined, page);
    assert.equal(s.failed, undefined, page);
    assert.equal(s.skipped, s.action.skipped);
    return s.skipped;
  };
  assert.equal(await skipped('/link/'), 'the primary action "Open the shop" leads to another site');
  assert.match(await skipped('/two/'), /^no clear primary action: 2 equally prominent design kit primary buttons \(\.btn-primary\) in the main content \("Save", "Share"\)$/);
  assert.equal(await skipped('/disabled/'), 'the primary action "Calculate" is disabled');
  assert.match(await skipped('/none/'), /^no clear primary action: no marked control/);
});
