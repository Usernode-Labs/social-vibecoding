#!/usr/bin/env node
'use strict';

/**
 * The example pictures of Homeroom's ready-made apps
 * (public/illustrations/starters/<id>.png).
 *
 * The made screen (frontend/src/features/first-session/made.tsx) shows a
 * ready-made project's card with an "Invite | App" switch, and App shows
 * what the app looks like before anyone has used it: its main screen, filled
 * in with a few neutral sample entries and tagged "Example". Each picture is
 * the starter's OWN screen, rendered from the files a new project gets
 * (services/template.js getTemplateFiles: its public/index.html with the
 * entry's fills, public/app.js, and the design kit compiled by the repo's
 * own Tailwind), in headless Chrome at a phone's size (390 x 844 CSS px, 2x,
 * light theme), with its one GET route answered by the samples below and
 * the clock held at SAMPLE_NOW so dates and "this week" read the same on
 * every run. The registry entry names its picture (app-templates.js
 * `exampleScreen`).
 *
 * Run it again whenever a starter's screen changes:
 *
 *   node scripts/render-starter-examples.js            every ready-made starter
 *   node scripts/render-starter-examples.js tier-list-hikes grocery-list
 *
 * It needs Chrome or Chromium: CHROME_PATH, else the usual install paths.
 * Nothing is added to package.json: Chrome is driven over its DevTools
 * protocol with Node's own WebSocket, and its PNG is read with pngjs
 * (already a devDependency) and written back as a 256-colour indexed PNG
 * with Node's zlib (compact), about a third of the size and no different to
 * the eye at the size the card draws it. The output is committed; the image
 * build never runs this.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const appTemplates = require('../src/services/app-templates');
const { getTemplateFiles } = require('../src/services/template');

const PHONE = { width: 390, height: 844, scale: 2 };
// A Saturday morning, so the week's chores, a potluck that evening and
// today's study sessions all read as ordinary.
const SAMPLE_NOW = '2026-10-17T10:30:00-07:00';
const SAMPLE_ZONE = 'America/Los_Angeles';

const ME = { id: 1, username: 'alex' };
const PEOPLE = [ME, { id: 2, username: 'sam' }, { id: 3, username: 'priya' }, { id: 4, username: 'jordan' }];
const at = (iso) => new Date(iso).toISOString();

/** A tier list's answer: each sample in the tier given, on your board and the group's. */
function tierAnswer(placed) {
  let id = 0;
  return {
    me: ME,
    tiers: ['S', 'A', 'B', 'C', 'D', 'F'],
    rankers: 4,
    items: placed.map(([name, tier]) => {
      id += 1;
      const average = { S: 5, A: 4, B: 3, C: 2, D: 1, F: 0 }[tier];
      return { id, name, by: PEOPLE[id % PEOPLE.length].username, mine: id % PEOPLE.length === 1, votes: 4, average, tier, yours: tier };
    }),
  };
}

/**
 * What each ready-made starter is shown with: the name the make screen
 * suggests for it (frontend/locales/en/onboarding.json
 * firstSession.template.*.name), its GET route's answer, and the element
 * that is there once the screen has drawn it.
 */
const SAMPLES = {
  'tier-list-restaurants': {
    name: 'Restaurant Tier List',
    ready: '#board .tier-s',
    api: { '/api/items': tierAnswer([['Joe\'s Pizza', 'S'], ['Pho 88', 'A'], ['Taqueria Sol', 'A'], ['Burger Barn', 'B'], ['Noodle Bar', 'C']]) },
  },
  'tier-list-hikes': {
    name: 'Hiking Tier List',
    ready: '#board .tier-s',
    api: { '/api/items': tierAnswer([['Lake Loop', 'S'], ['Ridge Trail', 'A'], ['Cedar Falls', 'A'], ['Pine Hollow', 'B'], ['Quarry Path', 'C']]) },
  },
  'tier-list-cities': {
    name: 'City Tier List',
    ready: '#board .tier-s',
    api: { '/api/items': tierAnswer([['Lisbon', 'S'], ['Kyoto', 'A'], ['Montreal', 'A'], ['Chicago', 'B'], ['Rotterdam', 'C']]) },
  },
  'tier-list-games': {
    name: 'Game Tier List',
    ready: '#board .tier-s',
    api: { '/api/items': tierAnswer([['Codenames', 'S'], ['Catan', 'A'], ['Chess', 'A'], ['Uno', 'B'], ['Monopoly', 'C']]) },
  },
  'grocery-list': {
    name: 'Grocery List',
    ready: '#categories [data-item]',
    api: {
      '/api/list': {
        me: { id: ME.id, username: ME.username },
        now: at(SAMPLE_NOW),
        list: { due_dates_enabled: false },
        categories: [
          { id: 1, name: 'General', is_default: true, sort_order: 0 },
          { id: 2, name: 'Produce', is_default: false, sort_order: 1 },
          { id: 3, name: 'Dairy', is_default: false, sort_order: 2 },
        ],
        items: [
          { id: 1, category_id: 1, text: 'Coffee', checked: false, sort_order: 1, completed_at: null, created_by: 'sam', last_checked_by: null, due_date: null, due_time: null },
          { id: 2, category_id: 1, text: 'Paper towels', checked: false, sort_order: 2, completed_at: null, created_by: 'alex', last_checked_by: null, due_date: null, due_time: null },
          { id: 3, category_id: 2, text: 'Bananas', checked: false, sort_order: 1, completed_at: null, created_by: 'priya', last_checked_by: null, due_date: null, due_time: null },
          { id: 4, category_id: 2, text: 'Spinach', checked: false, sort_order: 2, completed_at: null, created_by: 'alex', last_checked_by: null, due_date: null, due_time: null },
          { id: 5, category_id: 2, text: 'Avocados', checked: false, sort_order: 3, completed_at: null, created_by: 'sam', last_checked_by: null, due_date: null, due_time: null },
          { id: 6, category_id: 3, text: 'Milk', checked: false, sort_order: 1, completed_at: null, created_by: 'jordan', last_checked_by: null, due_date: null, due_time: null },
          { id: 7, category_id: 3, text: 'Greek yogurt', checked: false, sort_order: 2, completed_at: null, created_by: 'priya', last_checked_by: null, due_date: null, due_time: null },
          { id: 8, category_id: 2, text: 'Lemons', checked: true, sort_order: 4, completed_at: at('2026-10-17T09:10:00-07:00'), created_by: 'sam', last_checked_by: 'sam', due_date: null, due_time: null },
        ],
        activity: { actor: 'sam', verb: 'checked', text: 'Lemons' },
      },
    },
  },
  'chore-list': {
    name: 'Chore List',
    ready: '#chores [data-chore]',
    api: {
      '/api/chores': {
        me: ME,
        week: '2026-10-12',
        rota: 'ok',
        people: PEOPLE.length,
        members: PEOPLE,
        chores: [
          { id: 1, name: 'Dishes', fixed: false, done: false, doneBy: null, turn: 'alex', turnId: 1, yours: true, next: 'sam' },
          { id: 2, name: 'Take out the trash', fixed: false, done: true, doneBy: 'sam', turn: 'sam', turnId: 2, yours: false, next: 'priya' },
          { id: 3, name: 'Vacuum the living room', fixed: false, done: false, doneBy: null, turn: 'priya', turnId: 3, yours: false, next: 'jordan' },
          { id: 4, name: 'Water the plants', fixed: true, done: false, doneBy: null, turn: 'jordan', turnId: 4, yours: false, next: null },
        ],
      },
    },
  },
  'lending-library': {
    name: 'Lending Library',
    ready: '#shelf [data-thing]',
    api: {
      '/api/things': {
        me: ME,
        now: at(SAMPLE_NOW),
        things: [
          { id: 1, name: 'Camping tent', note: 'Sleeps four', owner: 'sam', mine: false, holder: 'alex', withMe: true, atHome: false, since: at('2026-10-11T12:00:00-07:00'), asks: [], askedByMe: false },
          { id: 2, name: 'Cordless drill', note: null, owner: 'priya', mine: false, holder: 'priya', withMe: false, atHome: true, since: at('2026-09-20T12:00:00-07:00'), asks: [], askedByMe: false },
          { id: 3, name: 'Catan', note: 'All the pieces are there', owner: 'jordan', mine: false, holder: 'sam', withMe: false, atHome: false, since: at('2026-10-14T19:00:00-07:00'), asks: [{ id: 3, username: 'priya', mine: false }], askedByMe: false },
          { id: 4, name: 'Stand mixer', note: null, owner: 'alex', mine: true, holder: 'alex', withMe: true, atHome: true, since: at('2026-09-01T12:00:00-07:00'), asks: [], askedByMe: false },
        ],
      },
    },
  },
  'potluck-planner': {
    name: 'Potluck Planner',
    ready: '#potlucks [data-potluck] [data-dish]',
    api: {
      '/api/potlucks': {
        me: ME,
        now: at(SAMPLE_NOW),
        courses: ['Mains', 'Sides', 'Salads', 'Desserts', 'Drinks', 'Other'],
        reactions: ['😋', '🤤', '👏', '❤️', '🔥'],
        upcoming: [{
          id: 1,
          title: 'Friendsgiving',
          startsAt: at('2026-10-24T18:00:00-07:00'),
          place: 'Sam\'s place',
          host: 'sam',
          mine: false,
          dishes: 4,
          courses: [
            { course: 'Mains', dishes: [{ id: 1, dish: 'Roast chicken', by: 'sam', mine: false, canRemove: false, reactions: [{ emoji: '😋', count: 3, mine: true, people: ['alex', 'jordan', 'priya'] }], comments: [] }] },
            { course: 'Sides', dishes: [{ id: 2, dish: 'Mac and cheese', by: 'priya', mine: false, canRemove: false, reactions: [{ emoji: '🔥', count: 2, mine: false, people: ['jordan', 'sam'] }], comments: [] }] },
            { course: 'Salads', dishes: [{ id: 3, dish: 'Kale salad', by: 'jordan', mine: false, canRemove: false, reactions: [], comments: [] }] },
            { course: 'Desserts', dishes: [{ id: 4, dish: 'Apple pie', by: 'alex', mine: true, canRemove: true, reactions: [], comments: [] }] },
            { course: 'Drinks', dishes: [] },
            { course: 'Other', dishes: [] },
          ],
          messages: [{ id: 1, by: 'sam', mine: false, text: 'Doors open at six.', at: at('2026-10-16T20:00:00-07:00') }],
        }],
        past: [],
      },
    },
  },
  'study-timer': {
    name: 'Study Timer',
    ready: '#today[data-loaded]',
    api: { '/api/today': { me: ME, day: '2026-10-17', count: 3 } },
  },
};

// The platform bridge, as much of it as these screens read: the theme, and
// the clock (`now`, held at SAMPLE_NOW by the page script below).
const BRIDGE_STUB = `window.usernode = window.usernode || {
  theme: 'light',
  previewNow: null,
  now: function () { return new Date(); },
};`;

// Run before any of the page's own scripts: the page's clock starts at
// SAMPLE_NOW and runs on from there, so timers still tick.
const CLOCK_SCRIPT = `(() => {
  const Real = Date;
  const offset = ${JSON.stringify(Date.parse(SAMPLE_NOW))} - Real.now();
  function SampleDate(...args) {
    if (!new.target) return new Real(Real.now() + offset).toString();
    return args.length ? new Real(...args) : new Real(Real.now() + offset);
  }
  SampleDate.prototype = Real.prototype;
  SampleDate.now = () => Real.now() + offset;
  SampleDate.parse = Real.parse;
  SampleDate.UTC = Real.UTC;
  globalThis.Date = SampleDate;
  try { localStorage.clear(); } catch (e) { /* none */ }
})();`;

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME_PATH');
  return found;
}

/** A starter's files, as a new project made from it gets them, written under `dir`, with its stylesheet compiled. */
function buildStarter(id, name, dir) {
  const files = getTemplateFiles(name, 'example', 'postgres://unused', null, { template: id });
  for (const f of files) {
    const to = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.content);
  }
  // The project's own Tailwind build (its Dockerfile's css stage), with the
  // repo's pinned tailwindcss; its config's content globs are relative to it.
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tailwindcss'),
    ['-c', 'tailwind.config.js', '-i', 'styles/tailwind-input.css', '-o', 'public/tailwind.css', '--minify'],
    { cwd: dir, stdio: 'pipe' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** Serves the starter's public/ files, the bridge, and its GET route's sample answer. */
function serve(dir, api) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/usernode-bridge/v1/bridge.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'] });
      return res.end(BRIDGE_STUB);
    }
    if (url.pathname.startsWith('/api/')) {
      const body = req.method === 'GET' ? api[url.pathname] : null;
      res.writeHead(body ? 200 : 404, { 'Content-Type': TYPES['.json'] });
      return res.end(JSON.stringify(body || { error: 'not in the sample' }));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(dir, 'public', path.normalize(rel));
    if (!file.startsWith(path.join(dir, 'public')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Chrome, headless, with its DevTools endpoint. */
function launchChrome(profile) {
  const child = spawn(chromePath(), [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu',
    '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TZ: SAMPLE_ZONE } });
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 30000);
    child.stderr.on('data', (chunk) => {
      seen += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
      if (m) { clearTimeout(timer); resolve({ child, ws: m[1] }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code})`)); });
  });
}

/** A minimal DevTools protocol client over Node's own WebSocket. */
function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    next += 1;
    pending.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({ send, close: () => socket.close() }));
    socket.addEventListener('error', () => reject(new Error('DevTools connection failed')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(cdp, url, ready) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: PHONE.width, height: PHONE.height, deviceScaleFactor: PHONE.scale, mobile: true });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send('Emulation.setTimezoneOverride', { timezoneId: SAMPLE_ZONE });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SCRIPT });
    await send('Page.navigate', { url });
    const deadline = Date.now() + 20000;
    for (;;) {
      const { result } = await send('Runtime.evaluate', { expression: `!!document.querySelector(${JSON.stringify(ready)}) && document.fonts.status === 'loaded'`, returnByValue: true });
      if (result.value) break;
      if (Date.now() > deadline) throw new Error(`${url}: ${ready} never appeared`);
      await sleep(100);
    }
    // Anything that fades in has settled.
    await sleep(600);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    return Buffer.from(data, 'base64');
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/**
 * The colours of an opaque RGBA image cut down to at most 256 (median cut,
 * weighted by how many pixels have each colour): returns the palette and
 * each pixel's index into it. A flat screen of text and fills loses
 * nothing a reader can see at the size the made screen draws it.
 */
function quantize(rgba, pixels) {
  const counts = new Map();
  for (let i = 0; i < pixels; i += 1) {
    const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const colors = [...counts].map(([key, n]) => ({ c: [(key >> 16) & 255, (key >> 8) & 255, key & 255], n, key }));
  let boxes = [colors];
  const spread = (box) => {
    let best = { channel: 0, range: -1 };
    for (let ch = 0; ch < 3; ch += 1) {
      let lo = 255; let hi = 0;
      for (const { c } of box) { if (c[ch] < lo) lo = c[ch]; if (c[ch] > hi) hi = c[ch]; }
      if (hi - lo > best.range) best = { channel: ch, range: hi - lo };
    }
    return best;
  };
  while (boxes.length < 256) {
    // Split the box with the most pixels that still has room to split.
    let pick = -1; let weight = -1;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const w = box.reduce((s, x) => s + x.n, 0) * (spread(box).range + 1);
      if (w > weight) { weight = w; pick = i; }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const { channel } = spread(box);
    box.sort((a, b) => a.c[channel] - b.c[channel]);
    const half = box.reduce((s, x) => s + x.n, 0) / 2;
    let run = 0; let cut = 1;
    for (; cut < box.length - 1; cut += 1) { run += box[cut - 1].n; if (run >= half) break; }
    boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
  }
  const palette = boxes.map((box) => {
    const total = box.reduce((s, x) => s + x.n, 0);
    return [0, 1, 2].map((ch) => Math.round(box.reduce((s, x) => s + x.c[ch] * x.n, 0) / total));
  });
  const nearest = new Map();
  for (const { c, key } of colors) {
    let best = 0; let dist = Infinity;
    palette.forEach((p, i) => {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      if (d < dist) { dist = d; best = i; }
    });
    nearest.set(key, best);
  }
  const index = Buffer.alloc(pixels);
  for (let i = 0; i < pixels; i += 1) {
    index[i] = nearest.get((rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]);
  }
  return { palette, index };
}

/** One PNG chunk: length, type, data, CRC. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Chrome's PNG, made small enough to send to a phone on its first session:
 * read with pngjs, its colours cut to a palette (quantize), and written
 * back as an 8-bit indexed PNG, deflated at the highest level.
 */
function compact(png) {
  const { PNG } = require('pngjs');
  const image = PNG.sync.read(png);
  const { width, height } = image;
  const { palette, index } = quantize(image.data, width * height);
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width + 1)] = 0; // filter: none, best for an indexed image
    index.copy(rows, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('sRGB', Buffer.from([0])),
    chunk('PLTE', Buffer.from(palette.flat())),
    chunk('IDAT', zlib.deflateSync(rows, { level: zlib.constants.Z_BEST_COMPRESSION, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const asked = process.argv.slice(2);
  const ids = asked.length ? asked : appTemplates.READY_IDS.slice();
  for (const id of ids) {
    if (!appTemplates.isReadyMade(id)) throw new Error(`${id} is not a ready-made starter`);
    if (!appTemplates.get(id).exampleScreen) throw new Error(`${id} names no exampleScreen in services/app-templates.js`);
    if (!SAMPLES[id]) throw new Error(`${id} has no samples in this script: add them to SAMPLES`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-examples-'));
  const chrome = await launchChrome(path.join(work, 'profile'));
  const cdp = await connect(chrome.ws);
  try {
    for (const id of ids) {
      const sample = SAMPLES[id];
      const dir = path.join(work, id);
      buildStarter(id, sample.name, dir);
      const server = await serve(dir, sample.api);
      try {
        const png = compact(await shoot(cdp, `http://127.0.0.1:${server.address().port}/?token=example`, sample.ready));
        const out = path.join(ROOT, 'public', appTemplates.get(id).exampleScreen);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, png);
        process.stdout.write(`${path.relative(ROOT, out)}  ${(png.length / 1024).toFixed(1)} KB\n`);
      } finally {
        server.close();
      }
    }
  } finally {
    cdp.close();
    chrome.child.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { SAMPLES, SAMPLE_NOW, PHONE };
