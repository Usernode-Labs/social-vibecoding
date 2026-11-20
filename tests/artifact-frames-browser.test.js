'use strict';

// Artifacts, stage 1 (docs/plans/artifacts.md): the surfaces that moved onto
// the one frame (frontend/src/features/artifact/frame.tsx), drawn in a real
// browser from the data the server stores. tests/artifact-frame.test.js
// renders the same frames to markup; this suite is what markup cannot show:
// what actually runs inside each frame, what gets out of it, and that the
// chat still sizes and opens a laid-out answer now that its frame is no
// longer same-origin with the chat.
//
//   a design's version    run, for its author: its script runs, a fetch is
//                         refused, a pinned comment's click is answered
//   the same page, for    static until they choose: nothing of the page's
//   anyone else           runs; Run it draws it running in a plain box
//   a laid-out answer     the helper mode (Homeroom's helper alone runs, by
//                         its nonce): measured by a message, a link opens in
//                         the same tick as the press, a summary toggles, no
//                         script of its own
//   a plan's screens      static: sandbox "", nothing runs
//   a first look's        static, from a route under the same policy as a
//   drawn screen          header
//   a plain page          run, for its author, on its version card and in
//                         its pane: named a page, loading nothing from any
//                         address (not even this site), never a plan
//
// Skipped (with the reason) where Chromium cannot launch.
//
// Run with: node --test tests/artifact-frames-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FRONTEND = path.join(ROOT, 'frontend');
const policy = require('../src/services/artifact-policy');
const { message } = require('./lib/platform-i18n');

// A plain page the bot wrote (artifact-session.js), as its version is
// stored: self-contained, with a script that adds up. It also tries to load
// a picture from this very site, which a page may not (it names no origin).
const PAGE = `<!doctype html><html><head><style>td{padding:4px}</style></head><body>
<h1>Trip budget</h1><table><tr><td>Flights</td><td class="n">420</td></tr><tr><td>Hotel</td><td class="n">610</td></tr></table>
<p id="sum"></p><img src="/leak?from=page" alt="">
<script>var t = 0; document.querySelectorAll('.n').forEach(function (n) { t += Number(n.textContent); });
document.getElementById('sum').textContent = 'Total: ' + t; parent.postMessage({ ran: 'page', total: t }, '*');</script>
</body></html>`;
// The thread that holds it, as GET /api/conversations/homeroom-bot/designs/:rootId answers.
const PAGE_THREAD = {
  rootId: 9, conversationId: 4, state: 'open', number: null, kind: 'idea', about: null, app: { slug: 'ear', name: 'Ear Trainer' },
  artifactKind: 'page', place: 'thread', title: 'Trip budget', surface: 'new', route: null, viewport: 'desktop', width: 1280,
  height: 800, latest: 1, versions: [{ version: 1, author: 'bot', note: 'Flights and hotel', messageId: 31 }], planOn: null,
};

// A design's version as design-bot.js saves it: a whole document, one of the
// project's stylesheets written in, and a script for an interactive state.
// The script also tries what the frame must refuse.
const DESIGN = `<!doctype html><html><head><meta charset="utf-8"><title>Plant list</title>
<style data-design-sheet="public/styles.css">body{margin:0;font:16px system-ui}.row{padding:12px}</style>
<style>.menu{display:none}.menu.open{display:block}</style></head>
<body class="app"><main><h1 id="title">Plant list</h1><button id="more" class="row">More</button>
<ul class="menu" id="menu"><li>Water</li><li>Repot</li></ul><a href="#water">Water today</a></main>
<script>
document.getElementById('more').addEventListener('click', function () { document.getElementById('menu').classList.add('open'); });
var said = { ran: 'design', cookie: null, fetched: null };
try { said.cookie = document.cookie; } catch (e) { said.cookie = 'refused'; }
fetch('/leak?from=design').then(function () { said.fetched = 'sent'; }, function () { said.fetched = 'refused'; })
  .then(function () { parent.postMessage(said, '*'); });
</script></body></html>`;

// A laid-out answer as the chat stores it (metadata.homeroomBot.html,
// homeroom-bot-html.js): a fragment with headings, a list, a table, a link
// and a fold. The script and the handler are what a cleaner must never let
// through; they are here to show nothing of the fragment's runs.
const REPLY = `<style>.opt{border:1px solid var(--line);padding:8px}</style>
<h3>Two ways to do it</h3>
<ol><li>Keep the list as it is</li><li>Group it by room</li></ol>
<table><tr><th>Way</th><th>Work</th></tr><tr><td>As it is</td><td>None</td></tr><tr><td>By room</td><td>A day</td></tr></table>
<p class="opt">See <a id="link" href="https://example.com/rooms">how rooms work</a>.</p>
<details><summary id="fold">Why by room</summary><p>Because most people look for a plant by where it stands, and a long list hides the ones in the hall.</p></details>
<img src="x" onerror="parent.postMessage({ ran: 'reply' }, '*')">
<script>parent.postMessage({ ran: 'reply' }, '*')</script>`;

async function bundle() {
  const esbuild = require(require.resolve('esbuild', { paths: [FRONTEND] }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-frames-'));
  const entry = path.join(dir, 'entry.tsx');
  const from = (rel) => JSON.stringify(path.join(FRONTEND, 'src', rel));
  fs.writeFileSync(entry, `
    import { createRoot } from 'react-dom/client';
    import { ArtifactFrame } from ${from('features/artifact/frame.tsx')};
    import { BotHtmlReply } from ${from('features/messages/bot-html.tsx')};
    import { PlanCrops } from ${from('features/messages/plan-crops.tsx')};
    import { DrawnLook } from ${from('features/first-session/drawn-look.tsx')};
    import { DesignVersionCard } from ${from('features/messages/design-card.tsx')};
    import { DesignPane } from ${from('features/messages/design-pane.tsx')};
    const roots: Record<string, any> = {};
    const rootOf = (id: string) => (roots[id] ||= createRoot(document.getElementById(id)!));
    const w = window as any;
    w.said = [];
    w.opened = [];
    window.addEventListener('message', (e) => { if (e.data && typeof e.data === 'object') w.said.push(e.data); });
    // A link the chat opens is a real anchor of the chat's own, clicked.
    document.addEventListener('click', (e) => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      if (a) { w.opened.push(a.getAttribute('href')); e.preventDefault(); }
    }, true);
    w.drawDesign = (html: string, viewer: 'author' | 'other') => rootOf('design-' + viewer).render(
      <ArtifactFrame mode="run" viewer={viewer} author="ada" html={html} title="Version 2" style={{ width: 390, height: 300, border: 0 }} />,
    );
    w.drawReply = (html: string) => rootOf('reply').render(
      <BotHtmlReply html={html} fallback={<p id="words">The words</p>} />,
    );
    w.drawStatic = (html: string) => rootOf('static').render(
      <ArtifactFrame mode="static" html={html} title="Static" style={{ width: 390, height: 120, border: 0 }} />,
    );
    w.drawPlan = (html: string) => rootOf('plan').render(<PlanCrops html={html} />);
    w.drawPageCard = () => rootOf('page-card').render(<DesignVersionCard conversationId={4} rootId={9} version={1} title="Trip budget" />);
    w.drawPagePane = () => rootOf('page-pane').render(<DesignPane conversationId={4} rootId={9} view="preview" onView={() => {}} />);
    w.drawLook = (src: string) => rootOf('look').render(
      <div style={{ position: 'relative', width: 125, height: 270 }}><DrawnLook src={src} label="The first look" width={125} onLoad={() => { w.lookLoaded = true; }} /></div>,
    );
  `);
  // The pane's thread store is the whole Messages screen's; the pane reads
  // only the thread's replies from it, and there are none here.
  const store = path.join(dir, 'store-stub.ts');
  fs.writeFileSync(store, 'export const loadReplyThread = () => Promise.resolve();\n'
    + 'export const useMessagesSnapshot = () => ({ thread: null });\n');
  const stubStore = {
    name: 'stub-store',
    setup(b) {
      b.onResolve({ filter: /^\.\/store$/ }, (args) => (args.importer.endsWith('design-pane.tsx') ? { path: store } : undefined));
    },
  };
  const result = await esbuild.build({
    plugins: [stubStore],
    entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020',
    jsx: 'automatic', alias: { '@': path.join(FRONTEND, '@') }, nodePaths: [path.join(FRONTEND, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', loader: { '.json': 'json' },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return result.outputFiles[0].text;
}

async function launch() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return { skip: 'Playwright is not installed' }; }
  try { return { browser: await chromium.launch({ headless: true, args: ['--no-sandbox'] }) }; } catch (err) {
    return { skip: `Chromium will not launch here: ${String(err.message || err).slice(0, 300)}` };
  }
}

// A plan as postDesignPlan stores it: planHtml's document, checked and
// stamped the way request-specs.js postRequestSpec does before it is kept.
function storedPlan() {
  const designs = require('../src/services/design-threads');
  const specs = require('../src/services/request-specs');
  const specHtml = require('../src/services/spec-html');
  const plan = designs.planHtml({
    design: { width: 390, height: 844, title: 'Plant list', route: '/plants', surface: 'app' },
    title: 'Design: Plant list', notes: 'A More menu on the list.', before: null, after: DESIGN, version: 2,
  });
  const prepared = specs.prepareSpec(plan);
  assert.equal(prepared.ok, true, 'the plan a design makes is one the plans keep');
  return specHtml.stampSpecStyles(prepared.html, 'kit');
}

test('every page the bot writes is drawn in the one frame: what runs, what gets out, and what the chat still knows', async (t) => {
  const { browser, skip } = await launch();
  if (skip) { t.skip(skip); return; }
  const code = await bundle();
  const purify = fs.readFileSync(path.join(ROOT, 'public/vendor/purify-3.4.17.min.js'));
  const requests = [];
  const missing = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    requests.push(req.url);
    if (url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
        <body style="margin:0;font:17px system-ui">
          <div id="design-author"></div><div id="design-other"></div>
          <div id="reply" style="width:420px"></div><div id="static"></div>
          <div id="plan" style="width:420px"></div><div id="look"></div>
          <div id="page-card"></div><div id="page-pane" style="width:700px"></div>
          <script src="/purify.js"></script><script>${code.replace(/<\/script/gi, '<\\/script')}</script>
        </body></html>`);
      return;
    }
    if (url === '/purify.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(purify); return; }
    if (url === '/favicon.ico') { res.statusCode = 204; res.end(); return; }
    // The language runtime asks what is translated; English needs nothing.
    if (url === '/api/languages') { res.setHeader('Content-Type', 'application/json'); res.end('{"languages":[]}'); return; }
    if (url === '/api/conversations/homeroom-bot/designs/9') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(PAGE_THREAD)); return;
    }
    if (url === '/api/conversations/homeroom-bot/designs/9/versions/1') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 1, html: PAGE })); return;
    }
    if (url === '/drawn') {
      // routes/apps.js GET /api/apps/:slug/first-version/first-look/drawn.
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Security-Policy', require('../src/services/first-version-screens').DRAWN_CSP);
      res.end('<!doctype html><html><body><h1>Club Votes</h1><script>parent.postMessage({ ran: "look" }, "*")</script></body></html>');
      return;
    }
    missing.push(req.url);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  const said = (match) => page.evaluate((m) => window.said.filter((d) => Object.keys(m).every((k) => d[k] === m[k])), match);
  const waitSaid = (match) => page.waitForFunction(
    (m) => window.said.some((d) => Object.keys(m).every((k) => d[k] === m[k])), match, { timeout: 10000 });
  try {
    await page.goto(base);

    await t.test('a design\'s version runs for its author, in a frame that reaches nothing', async () => {
      await page.evaluate((html) => window.drawDesign(html, 'author'), DESIGN);
      const frame = page.locator('#design-author iframe');
      assert.equal(await frame.getAttribute('sandbox'), policy.sandboxFor('run'));
      assert.equal(await frame.getAttribute('data-artifact-frame'), 'run');
      await waitSaid({ ran: 'design' });
      const [told] = await said({ ran: 'design' });
      assert.equal(told.fetched, 'refused', 'the page fetches nothing');
      assert.ok(told.cookie === 'refused' || told.cookie === '', 'and reads no cookie of Homeroom\'s');
      assert.equal(requests.some((url) => url.startsWith('/leak')), false, 'nothing reached the server');
      // A pinned comment: with comment mode on, a click on the page is taken
      // and answered with its point and what is under it. Nothing in this is
      // a design's: any artifact's frame answers the same way.
      const box = await frame.boundingBox();
      await frame.evaluate((el) => el.contentWindow.postMessage({ __artifact: 'mode', on: true }, '*'));
      await page.waitForTimeout(100);
      await page.mouse.click(box.x + 40, box.y + 30);
      await waitSaid({ __artifact: 'pin' });
      const [pin] = await said({ __artifact: 'pin' });
      assert.ok(pin.x > 0 && pin.x < 1 && pin.y > 0 && pin.y < 1, 'the point, as fractions of the page');
      assert.equal(pin.element.tag, 'h1');
      assert.equal(pin.element.text, 'Plant list');
    });

    await t.test('anyone else is shown it static until they choose to run it, and then in a plain box that says so', async () => {
      await page.evaluate(() => { window.said.length = 0; });
      await page.evaluate((html) => window.drawDesign(html, 'other'), DESIGN);
      const holder = page.locator('#design-other [data-artifact-viewer]');
      assert.equal(await holder.getAttribute('data-artifact-viewer'), 'static');
      const frame = page.locator('#design-other iframe');
      assert.equal(await frame.getAttribute('sandbox'), '', 'scripts off');
      assert.doesNotMatch(await frame.getAttribute('srcdoc'), /<script|addEventListener/, 'and none of the page\'s own left in it');
      await page.waitForTimeout(600);
      assert.deepEqual(await said({ ran: 'design' }), [], 'nothing of the page\'s ran');
      // Their own choice.
      await page.locator('#design-other [data-artifact-run]').click();
      await waitSaid({ ran: 'design' });
      assert.equal(await holder.getAttribute('data-artifact-viewer'), 'running');
      assert.equal(await page.locator('#design-other iframe').getAttribute('sandbox'), 'allow-scripts');
      const note = await page.locator('#design-other [role="note"]').textContent();
      assert.match(note, /^ada made this page in a chat with Homeroom bot\. It is not part of Homeroom\. Never type a password into it\.$/);
      // Never inside chrome that looks like Homeroom's own: the box is the
      // note and the frame, and no class of the shell's is on it.
      const chrome = await holder.evaluate((el) => ({
        children: [...el.children].map((c) => c.tagName.toLowerCase()), className: el.className,
        classes: [...el.querySelectorAll('[class]')].length,
      }));
      assert.deepEqual(chrome, { children: ['p', 'iframe'], className: '', classes: 0 });
    });

    await t.test('a laid-out answer is sized and opened by messages from its frame, which is never same-origin', async () => {
      await page.evaluate(() => { window.said.length = 0; });
      await page.evaluate((html) => window.drawReply(html), REPLY);
      await page.waitForSelector('#reply [data-bot-html="drawn"]', { timeout: 10000 });
      const frame = page.locator('#reply iframe');
      const sandbox = await frame.getAttribute('sandbox');
      assert.equal(sandbox, policy.sandboxFor('helper'));
      assert.equal(await frame.getAttribute('data-artifact-frame'), 'helper', 'the helper mode, its own, never the static one');
      assert.doesNotMatch(sandbox, /allow-same-origin/);
      assert.equal(await page.locator('#words').count(), 0, 'the words give way once the frame has its size');
      const reachable = await frame.evaluate((el) => { try { return !!el.contentDocument; } catch { return false; } });
      assert.equal(reachable, false, 'the chat cannot reach into the frame, and the frame cannot reach out');
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(await frame.getAttribute('srcdoc'))[1];
      assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/, 'only Homeroom\'s helper may run');
      assert.doesNotMatch(csp, /https?:|unsafe-inline'; connect/, 'and the page names no address');
      const height = (await frame.boundingBox()).height;
      assert.ok(height > 150, `sized to its content by the helper's message (${height}px)`);
      assert.deepEqual(await said({ ran: 'reply' }), [], 'nothing of the fragment\'s own runs');
      // A press on the link opens it, as a link of the chat's own, at once.
      const [size] = (await said({ __artifact: 'size' })).slice(-1);
      const link = size.hits.find((hit) => hit.href === 'https://example.com/rooms');
      assert.ok(link, 'the helper says where the link is');
      const box = await frame.boundingBox();
      await page.mouse.click(box.x + link.x + link.w / 2, box.y + link.y + link.h / 2);
      assert.deepEqual(await page.evaluate(() => window.opened), ['https://example.com/rooms']);
      // A press on the summary opens its details, and the frame grows.
      const fold = size.hits.find((hit) => hit.href === null);
      await page.mouse.click(box.x + fold.x + fold.w / 2, box.y + fold.y + fold.h / 2);
      await page.waitForFunction((was) => document.querySelector('#reply iframe').getBoundingClientRect().height > was + 20, height, { timeout: 10000 });
      // A press anywhere else is the row's: nothing opens.
      await page.mouse.click(box.x + 5, box.y + 2);
      assert.equal(await page.evaluate(() => window.opened.length), 1);
    });

    await t.test('a static page runs nothing of its own even when it is handed in whole', async () => {
      await page.evaluate(() => { window.said.length = 0; });
      await page.evaluate((html) => window.drawStatic(html), DESIGN);
      const frame = page.locator('#static iframe');
      assert.equal(await frame.getAttribute('sandbox'), '');
      await page.waitForTimeout(500);
      assert.deepEqual(await said({ ran: 'design' }), []);
    });

    await t.test('a plan\'s screens are drawn static, from the plan as it is stored', async () => {
      await page.evaluate((html) => window.drawPlan(html), storedPlan());
      await page.locator('#plan summary').click();
      await page.waitForSelector('#plan iframe', { timeout: 10000 });
      const frames = page.locator('#plan iframe');
      assert.ok(await frames.count() >= 1);
      for (let i = 0; i < await frames.count(); i += 1) {
        assert.equal(await frames.nth(i).getAttribute('sandbox'), '');
        assert.equal(await frames.nth(i).getAttribute('data-artifact-frame'), 'static');
        const doc = await frames.nth(i).getAttribute('srcdoc');
        const csp = /Content-Security-Policy" content="([^"]+)"/.exec(doc)[1].replace(/&#39;/g, "'");
        assert.equal(csp, policy.cspFor('static', { site: base }), 'under the one policy, with this site\'s stylesheets');
        assert.doesNotMatch(doc, /<script/i);
      }
      const after = await frames.last().getAttribute('srcdoc');
      assert.match(after, /Plant list/, 'the design\'s screen, without its script');
    });

    await t.test('a first look\'s drawn screen comes from its route under the same policy, and runs nothing', async () => {
      await page.evaluate(() => { window.said.length = 0; });
      await page.evaluate((src) => window.drawLook(src), `${base}/drawn`);
      await page.waitForFunction(() => window.lookLoaded === true, null, { timeout: 10000 });
      const frame = page.locator('#look iframe');
      assert.equal(await frame.getAttribute('sandbox'), '');
      assert.equal(await frame.getAttribute('src'), `${base}/drawn`);
      await page.waitForTimeout(300);
      assert.deepEqual(await said({ ran: 'look' }), []);
    });

    await t.test('a plain page runs for its author on its card and in its pane, named a page, loading nothing, never a plan', async () => {
      await page.evaluate(() => { window.said.length = 0; });
      await page.evaluate(() => window.drawPageCard());
      const card = page.locator('#page-card iframe');
      await card.waitFor({ timeout: 10000 });
      assert.equal(await card.getAttribute('sandbox'), 'allow-scripts', 'running, for its author');
      assert.equal(await card.getAttribute('title'), message('messages:design.card.frameTitlePage', { version: 1 }));
      const cardCsp = /Content-Security-Policy" content="([^"]+)"/.exec(await card.getAttribute('srcdoc'))[1];
      assert.equal(cardCsp, policy.cspFor('run'), 'a page names no origin: not even this site\'s');
      await waitSaid({ ran: 'page' });
      assert.equal((await said({ ran: 'page' }))[0].total, 1030, 'its own script ran');

      await page.evaluate(() => window.drawPagePane());
      const pane = page.locator('#page-pane section[data-design-pane="9"]');
      await page.waitForSelector('#page-pane iframe', { timeout: 10000 });
      assert.equal(await pane.getAttribute('aria-label'), message('messages:design.pane.labelPage'));
      assert.notEqual(message('messages:design.pane.labelPage'), message('messages:design.pane.label'));
      const frame = page.locator('#page-pane iframe');
      assert.equal(await frame.getAttribute('title'), message('messages:design.pane.frameTitlePage', { version: 1 }));
      assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(await frame.getAttribute('srcdoc'))[1];
      assert.equal(csp, policy.cspFor('run'));
      assert.equal(await page.locator('#page-pane [data-design-propose]').count(), 0, 'no Request it, though its thread is in a project');
      assert.equal(await page.locator('#page-pane [data-design-comment]').count(), 1, 'pins work on any artifact');
      const text = await pane.textContent();
      assert.doesNotMatch(text, /design/i, 'never called a design');
      await page.waitForTimeout(300);
      assert.equal(requests.some((url) => url.startsWith('/leak?from=page')), false, 'the page\'s picture by address never loaded');
    });

    // What the frames were refused is what this suite asked them to try:
    // the design's fetch, and the served look's script (its route's header
    // refuses it; a real one is cleaned of scripts before it is stored).
    // And a page's picture by address, which its policy refuses.
    const unexpected = errors.filter((text) => !/\/leak\?from=design|Refused to connect|Connecting to|violates the following Content Security Policy directive: "connect-src|Blocked script execution in '[^']*\/drawn'|\/drawn|\/leak\?from=page|directive: "img-src/.test(text));
    assert.deepEqual(unexpected, [], `no other error on the page that holds the frames (not found: ${missing.join(', ')})`);
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
