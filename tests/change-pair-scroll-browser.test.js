'use strict';

// #6615: a change page's Votes/Testing pair and the one-line strip that
// floats under the sheet's header while the reader scrolls
// (frontend/src/features/dev-board/topic/change-head.tsx `ChangeGates`,
// public/css/app.css `.dev-change-pair-float`).
//
// The component is bundled with the frontend's own esbuild into a page that
// loads public/css/app.css, inside a scroller at the side panel's size
// (874x1003). The test steps the scroll across the switching point and then
// updates the cards while the strip is up:
//
//   - every step moves scrollTop by exactly the step and leaves scrollHeight
//     alone, so the switch resizes nothing in the page's flow;
//   - changing the cards' words while stuck moves neither, and the strip
//     shows the new words;
//   - a real change in the cards' own size moves scrollHeight by exactly that
//     much, and never flips the strip.
//
// The first version (the pair shrank in place and gave the lost height back
// as marginBlockEnd) fails the step assertions: the switch changed
// scrollHeight, and Chrome's scroll anchoring moved scrollTop with it.
//
// Skipped (with the reason) where Chromium cannot launch.
//
// Run with: node --test tests/change-pair-scroll-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const COMPONENT = path.join(FRONTEND, 'src/features/dev-board/topic/change-head.tsx');
const APP_CSS = fs.readFileSync(path.join(ROOT, 'public/css/app.css'));

// The side panel the clip was taken in (the issue's own measurement).
const PANEL = { width: 874, height: 1003 };
// Where the mark above the pair sits, and how far the page is stepped.
const LEAD = 300;
const END = 600;

function bundle() {
  const esbuild = require(require.resolve('esbuild', { paths: [FRONTEND] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-pair-'));
  const entry = path.join(dir, 'entry.tsx');
  fs.writeFileSync(entry, `
    import { createRoot } from 'react-dom/client';
    import { ChangeGates } from ${JSON.stringify(COMPONENT)};
    const root = createRoot(document.getElementById('react-root')!);
    (window as any).renderGates = (v: any) => {
      root.render(
        <div className="dev-change-root">
          <div className="min-w-0 flex-1">
            <div style={{ height: ${LEAD} }} />
            <ChangeGates id={7} card={{}} v={v} />
            <div style={{ height: 1600 }} />
          </div>
        </div>,
      );
    };
  `);
  const result = esbuild.buildSync({
    entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    jsx: 'automatic', alias: { '@': path.join(FRONTEND, '@') }, nodePaths: [path.join(FRONTEND, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return result.outputFiles[0].text;
}

const gate = (name, figure, tone, extra = {}) => ({
  name, figure, tone, done: false, label: `${name} progress`,
  note: [], facts: [], segments: [{ weight: 1, pct: 40, state: 'moving' }], ...extra,
});

// The moment the issue describes: votes cleared, Testing moving from a
// failure to a rebuild.
const view = (patch = {}) => ({
  number: 6586, category: null, author: 'evan', at: null, time: '7:34 PM', timeTitle: '',
  via: 'via Claude Code', status: null, thanks: false, shots: null, merge: null,
  votes: gate('Votes', "You haven't voted", 'ask', { facts: [{ key: 'needs', text: 'Needs 1 more yes' }] }),
  testing: gate('Testing', 'Found a problem', 'bad'),
  ...patch,
});

async function launch() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return { skip: 'Playwright is not installed' }; }
  try { return { browser: await chromium.launch({ headless: true, args: ['--no-sandbox'] }) }; } catch (err) {
    return { skip: `Chromium will not launch here: ${String(err.message || err).slice(0, 300)}` };
  }
}

test('a change page does not move while its floating Votes and Testing rows show', async (t) => {
  const { browser, skip } = await launch();
  if (skip) { t.skip(skip); return; }
  const code = bundle();
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="stylesheet" href="/app.css"></head>
        <body style="margin:0">
          <div id="gc-thread-scroll" class="messages-thread-scroll" style="height:${PANEL.height}px;overflow-y:auto">
            <div id="react-root"></div>
          </div>
          <script>${code}</script>
        </body></html>`);
      return;
    }
    if (url === '/app.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(APP_CSS);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const context = await browser.newContext({ viewport: PANEL });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const metrics = () => page.evaluate(() => {
    const s = document.getElementById('gc-thread-scroll');
    return { top: s.scrollTop, height: s.scrollHeight };
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const render = async (v) => {
    await page.evaluate((next) => window.renderGates(next), v);
    await settle();
    // React schedules a root render off the frame loop; let it commit.
    await page.waitForTimeout(30);
  };

  try {
    await page.goto(base);
    await page.evaluate((v) => window.renderGates(v), view());
    await page.waitForSelector('.dev-change-pair[data-stick]');
    await settle();

    await t.test('stepping the scroll across the switch moves neither scrollTop nor scrollHeight', async () => {
      const sweep = await page.evaluate(async ({ end }) => {
        const s = document.getElementById('gc-thread-scroll');
        const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const height = s.scrollHeight;
        const problems = [];
        const stripAt = [];
        for (let top = 0; top <= end; top += 2) {
          s.scrollTop = top;
          await frame();
          if (s.scrollTop !== top) problems.push({ at: top, top: s.scrollTop });
          if (s.scrollHeight !== height) problems.push({ at: top, height: s.scrollHeight, was: height });
          if (document.querySelector('[data-change-gate-line="votes"]')) stripAt.push(top);
        }
        return { problems, height, stripAt };
      }, { end: END });
      assert.deepEqual(sweep.problems, [], 'the page did not move by itself while stepping the scroll');
      assert.ok(sweep.stripAt.length > 0, 'the one-line Votes row showed once past the mark');
      assert.ok(sweep.stripAt[0] >= LEAD - 20, `nothing floated before the pair left the top (first at ${sweep.stripAt[0]}px)`);
      // Back to the top: the strip goes, and nothing moved.
      const height = (await metrics()).height;
      await page.evaluate(() => { document.getElementById('gc-thread-scroll').scrollTop = 0; });
      await page.waitForFunction(() => !document.querySelector('[data-change-gate-line="votes"]'), null, { timeout: 4000 });
      const back = await metrics();
      assert.equal(back.top, 0);
      assert.equal(back.height, height, 'scrollHeight is the same after going back');
    });

    await t.test('the cards updating while stuck moves nothing, and the rows say the new words', async () => {
      await page.evaluate(() => { document.getElementById('gc-thread-scroll').scrollTop = 600; });
      await page.waitForSelector('[data-change-gate-line="votes"]');
      const before = await metrics();
      for (let step = 1; step <= 5; step += 1) {
        await render(view({
          votes: gate('Votes', 'Needs 1 more yes', 'ask', { facts: [{ key: 'needs', text: 'Needs 1 more yes' }] }),
          testing: gate('Testing', `Building the preview, step ${step} of 5`, 'muted'),
        }));
        const now = await metrics();
        assert.equal(now.top, before.top, `scrollTop stayed put at tick ${step}`);
        assert.equal(now.height, before.height, `scrollHeight stayed put at tick ${step}`);
      }
      assert.match(
        await page.locator('[data-change-gate-line="testing"]').innerText(),
        /Building the preview, step 5 of 5/,
        'the floating row says the new figure',
      );
      assert.match(await page.locator('[data-change-gate-line="votes"]').innerText(), /Needs 1 more yes/);
    });

    await t.test('a real change in the cards’ size moves scrollHeight by exactly that much, and the strip stays', async () => {
      await page.evaluate(() => { document.getElementById('gc-thread-scroll').scrollTop = 600; });
      await page.waitForSelector('[data-change-gate-line="votes"]');
      const before = await page.evaluate(() => ({
        height: document.getElementById('gc-thread-scroll').scrollHeight,
        pair: document.querySelector('.dev-change-pair[data-stick]').offsetHeight,
      }));
      await render(view({
        votes: gate('Votes', 'Needs 1 more yes', 'ask'),
        testing: gate('Testing', 'Found a problem', 'bad', {
          facts: [{ key: 'a', text: 'One check failed.' }, { key: 'b', text: 'Two checks failed.' }, { key: 'c', text: 'Three checks failed.' }],
        }),
      }));
      const after = await page.evaluate(() => ({
        height: document.getElementById('gc-thread-scroll').scrollHeight,
        pair: document.querySelector('.dev-change-pair[data-stick]').offsetHeight,
        stuck: !!document.querySelector('[data-change-gate-line="votes"]'),
        inFlowStuck: !!document.querySelector('.dev-change-pair[data-stick][data-stuck]'),
      }));
      assert.ok(after.pair > before.pair, 'the full Testing card grew');
      assert.equal(after.height - before.height, after.pair - before.pair, 'scrollHeight moved by exactly the card’s growth');
      assert.equal(after.stuck, true, 'the floating rows stayed shown');
      assert.equal(after.inFlowStuck, false, 'the pair in the flow never shrank');
    });

    assert.deepEqual(errors, [], 'no script error on the console');
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }
});
