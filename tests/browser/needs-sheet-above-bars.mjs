// Needs you sheets above the tab bar and the Resume strip, in a real browser.
//
// Run with PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE pointing to installed
// tools, after `npm run ensure:shell` (it reads the built public/index.html
// and public/css/tailwind.css):
//
//   PLAYWRIGHT_MODULE=/path/to/playwright-core \
//   BROWSER_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//   node tests/browser/needs-sheet-above-bars.mjs
//
// Set SHEET_BASE=<commit> to run the same cases against that commit's app.css
// as well; it then also asserts the base FAILS the case the run-through hit,
// so a green run is known to be able to see the bug.
//
// What it draws: the shipped shell (public/index.html with its scripts taken
// out, so nothing boots or calls an API), the shipped stylesheets in their
// order, and a Needs you feed rendered by the feed's own component
// (NeedsFeed, through tests/lib/render-tsx.js) on a project page or on the
// Communities screen, with the tab bar and the Resume strip up. Into it goes
// each sheet as workshop.tsx renders it: the vote sheet INSIDE the rail with
// the vote form rendered by NeedsVoteForm, Ask, Comments and Description
// beside it, plus the change page's kit sheet (`.un-sheet`) for comparison.
// `data-ws-sheet` and, with the keyboard up, `data-ws-kb` are set on the feed
// root the way workshop.tsx's state and keyboard effect set them.
//
// What it asserts, for each action at a sheet's foot (Cancel and the send on
// the vote sheets, the send and the field on Ask, the last line of a long
// Comments or Description body scrolled to its end, and Close): its box is
// inside the visible viewport (above the keys when they are up), and
// elementFromPoint at its centre is the control itself, not #platform-tabs or
// #platform-parked. With the keys up on the vote sheet, the focused line box
// is clear of the action row.
//
// The keyboard, two ways: the Homeroom app resizes its web view to end at
// the keys (viewport heights below; lib/keyboard-open.ts sets
// `platform-kb-open`), and Safari covers the page (`un-kb` with the kit's
// `--un-kb-inset`). Both are simulated by the classes and the property the
// kit and keyboard-open.ts write; the viewport is what the host leaves.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = new URL('../../', import.meta.url).pathname;
const base = process.env.SHEET_BASE || '';

for (const built of ['public/index.html', 'public/css/tailwind.css']) {
  if (!existsSync(root + built)) throw new Error(`${built} is missing: run npm run ensure:shell first`);
}

// ── The fixture: the feed and the sheets, rendered by the real components ──
const { loadTsx, renderToHtml, createElement } = require(root + 'tests/lib/render-tsx.js');
const { reelRows } = loadTsx('frontend/src/features/workshop/needs-reel.tsx');
const W = loadTsx('frontend/src/features/dev-board/workshop/workshop.tsx');
const item = {
  kind: 'proposal', id: 42, title: 'Add a dark theme to the settings page',
  summary: 'Adds a dark theme that follows the phone. Every screen gets the new colours, and the switch in Settings remembers your choice.',
  author: 'ada', number: 7, epoch: 3, at: null, yes: 0, no: 0,
  app: { slug: 'demo-app', name: 'Demo', icon_url: null, icon_emoji: null },
};
const rows = reelRows([item, { ...item, id: 43, title: 'A second change' }]);
const noop = () => {};
const feed = renderToHtml(createElement(W.NeedsFeed, {
  rows, total: 2, models: { list: [], selected: null }, slug: 'demo-app', canPost: true, onDone: noop, doneLabel: 'Back',
}));
const form = (side) => renderToHtml(createElement(W.NeedsVoteForm, {
  row: rows[0], side, line: '', onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop,
}));
const ask = 'Should this change go in?';
const voteSheet = (side) => `<div class="dev-ws-sheet-modal dev-ws-sheet-vote" data-ws-sheet="vote" role="dialog" aria-label="${ask}"><button type="button" class="dev-ws-scrim" aria-label="Close"></button><div class="dev-ws-sheet-card"><span class="dev-ws-sheet-handle" aria-hidden="true"></span><p class="dev-ws-ask-q">${ask}</p><p class="dev-ws-vote-sub">0 of 2 have said yes so far.</p>${form(side)}<p class="dev-ws-keys-hint" aria-hidden="true">Y yes · N no · Enter vote · Esc close</p></div></div>`;
const head = (t, s) => `<span class="dev-ws-sheet-handle" aria-hidden="true"></span><div class="dev-ws-sheet-head"><span><span class="dev-ws-sheet-title">${t}</span>${s ? `<span class="dev-ws-sheet-sub">${s}</span>` : ''}</span><button type="button" class="dev-ws-sheet-x">Close</button></div>`;
const long = Array.from({ length: 14 }, (_, i) => `<p>Paragraph ${i + 1}: the settings page draws its colours from the phone, and the switch remembers the choice.</p>`).join('');
const sheets = {
  'vote-yes': voteSheet('yes'),
  'vote-no': voteSheet('no'),
  ask: `<div class="dev-ws-sheet-modal dev-ws-sheet-ask" data-ws-sheet="ask" role="dialog" aria-label="Ask about this item"><button type="button" class="dev-ws-scrim" aria-label="Close"></button><section class="dev-ws-ask dev-ws-sheet-card" data-ws-ask="">${head('Ask about this change', 'private to you')}<div class="dev-ws-ask-log" data-ws-ask-log=""><p class="dev-ws-ask-hint">Ask what this changes, who it affects, or what happens if it goes in.</p></div><form class="dev-ws-ask-composer dc-card"><div class="dev-ws-ask-line"><input id="dev-ws-ask-input" class="dev-ws-ask-input" type="text" placeholder="Ask a question…"></div><div class="dev-ws-ask-row"><button type="submit" class="dc-send-btn dc-circle-send dev-ws-ask-send" aria-label="Ask"></button></div></form></section></div>`,
  comments: `<div class="dev-ws-sheet-modal dev-ws-sheet-comments" data-ws-sheet="comments" role="dialog" aria-label="Comments"><button type="button" class="dev-ws-scrim" aria-label="Close"></button><section class="dev-ws-sheet-card" data-ws-comments="">${head('3 comments', 'on this change')}<div class="dev-ws-sheet-body">${long}<p data-last="">The last comment.</p></div></section></div>`,
  description: `<div class="dev-ws-sheet-modal dev-ws-sheet-description" data-ws-sheet="description" role="dialog" aria-label="Description"><button type="button" class="dev-ws-scrim" aria-label="Close"></button><section class="dev-ws-sheet-card" data-ws-description="">${head('Description')}<div class="dev-ws-sheet-body"><h3 class="dev-ws-desc-title">Add a dark theme</h3><div class="dev-ws-desc-body">${long}</div><a class="dev-ws-desc-open" data-last="" href="#x">Open the proposal</a></div></section></div>`,
  // The change page's vote picker, as the kit presents it (dev-card.tsx
  // VotePicker in `.dev-vote-sheet`, appended to <body> by presentSheet).
  'kit-no': `<div class="un-backdrop" style="opacity:1"></div><div class="un-sheet" style="transform:none"><div class="un-sheet-grabber"></div><div class="un-sheet-body"><div class="dev-vote-sheet-host">${form('no').replace('class="dev-ws-vote-form" data-ws-vote-form=""', 'class="dev-vote-sheet" role="dialog" aria-label="Your vote" data-vote-sheet=""')}</div></div></div>`,
};

// The shell, inert: comments first (one mentions a script tag), then scripts.
const shell = readFileSync(root + 'public/index.html', 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');

// ── Set the screen up and measure, in the page ──
function setUpAndMeasure({ c, feed, sheet }) {
  const rootEl = document.documentElement;
  rootEl.style.setProperty('--un-safe-inset-bottom', `${c.safeBottom}px`);
  rootEl.style.setProperty('--un-safe-inset-top', `${c.safeTop}px`);
  if (c.layout === 'app') rootEl.classList.add('un-ios', 'in-native-webview');
  else if (c.surface === 'project') rootEl.setAttribute('data-browser-scroller', 'dev-forum-scroll');
  document.querySelectorAll('[id$="-screen"]').forEach((el) => el.classList.add('hidden'));
  const tabs = document.getElementById('platform-tabs');
  const parked = document.getElementById('platform-parked');
  tabs.classList.remove('hidden');
  parked.classList.remove('hidden');
  parked.innerHTML = '<a class="platform-parked-open" href="#app/plant-pal"><span class="platform-parked-tile">P</span><span class="platform-parked-name">Plant Pal</span><span class="platform-parked-pill">Resume</span></a><button type="button" class="platform-parked-x" aria-label="Forget">×</button>';
  if (c.surface === 'project') {
    document.getElementById('app-view').classList.remove('hidden');
    document.getElementById('app-content').innerHTML = '<div class="flex flex-col h-full min-h-0 dc-lift dc-lift-strip"><div id="dev-forum-scroll" class="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll"><div id="dev-body" class="px-3 py-2"><div id="dev-workshop"><div class="dev-ws" data-ws-tab="needs" data-ws-slug="demo-app"><div style="height:92px"></div><div class="dev-ws-tabbody">' + feed + '</div></div></div></div></div></div>';
  } else {
    const ws = document.getElementById('workshop-screen');
    ws.classList.remove('hidden');
    ws.innerHTML = '<div class="max-w-2xl mx-auto pb-8"><div data-workshop-pane="needs"><div class="px-4 pb-2"><div class="dev-ws-pagehead"><div class="dev-ws-pagehead-text"><span class="dev-ws-pagehead-over">Communities</span><h2 class="dev-ws-pagehead-title">Needs you</h2></div></div></div><div class="workshop-needs-feed" data-needs-reel="">' + feed + '</div></div></div>';
  }
  const needs = document.querySelector('.dev-ws-needs');
  const kind = c.sheet.split('-')[0];
  const holder = kind === 'vote' ? needs.querySelector('.dev-ws-rail') : kind === 'kit' ? document.body : needs;
  holder.insertAdjacentHTML('beforeend', sheet);
  if (kind !== 'kit') needs.setAttribute('data-ws-sheet', kind);
  if (c.kb !== 'none' && kind !== 'kit') needs.setAttribute('data-ws-kb', '');
  if (c.kb === 'app') rootEl.classList.add('platform-kb-open');
  if (c.kb === 'safari') { rootEl.classList.add('un-kb'); rootEl.style.setProperty('--un-kb-inset', `${c.inset}px`); }
  const field = document.querySelector('.dev-ws-sheet-modal textarea, .un-sheet textarea, #dev-ws-ask-input');
  if (c.kb !== 'none' && field) { field.focus(); field.scrollIntoView({ block: 'nearest' }); }

  const surface = document.querySelector('.dev-ws-sheet-modal, .un-sheet');
  const floor = innerHeight - (c.kb === 'safari' ? c.inset : 0);
  const name = (el) => (el ? el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.closest('[id]') ? ` in #${el.closest('[id]').id}` : '') : 'nothing');
  const probe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), hit: name(hit), onTarget: !!hit && el.contains(hit), inView: r.top >= 0 && r.bottom <= floor };
  };
  const out = { probes: {} };
  if (kind === 'vote' || kind === 'kit') {
    out.probes.cancel = probe(surface.querySelector('.dev-vote-reason-cancel'));
    out.probes.send = probe(surface.querySelector('.dev-vote-reason-send'));
    if (c.kb !== 'none') {
      const box = surface.querySelector('textarea').getBoundingClientRect();
      const row = surface.querySelector('.dev-vote-reason-actions').getBoundingClientRect();
      out.boxClear = box.top >= 0 && box.bottom <= row.top + 1;
    }
  } else if (kind === 'ask') {
    out.probes.send = probe(surface.querySelector('.dev-ws-ask-send'));
    out.probes.field = probe(surface.querySelector('#dev-ws-ask-input'));
    out.probes.close = probe(surface.querySelector('.dev-ws-sheet-x'));
  } else {
    out.probes.close = probe(surface.querySelector('.dev-ws-sheet-x'));
    const body = surface.querySelector('.dev-ws-sheet-body');
    body.scrollTop = body.scrollHeight;
    out.probes.last = probe(surface.querySelector('[data-last]'));
  }
  return out;
}

// ── The cases ──
const phones = { '375x812': [375, 812], '402x874': [402, 874] };
const cases = [];
for (const [size, [w, h]] of Object.entries(phones)) {
  for (const surface of ['project', 'communities']) {
    for (const layout of ['app', 'browser']) {
      for (const sheet of ['vote-yes', 'vote-no', 'ask', 'comments', 'description', 'kit-no']) {
        cases.push({
          size, w, h, surface, layout, sheet, kb: 'none', inset: 0,
          safeBottom: layout === 'app' ? 34 : 0, safeTop: layout === 'app' ? 62 : 0,
        });
      }
    }
  }
}
// Keys up in the app: the page ends at them. 402x874 with a 380px keyboard
// (keys, suggestions and the web view's form bar) and with 336; 375x812 the
// same; and a small phone's 363px strip, where the vote form must scroll.
for (const [w, h] of [[402, 494], [402, 538], [375, 432], [375, 363]]) {
  for (const surface of ['project', 'communities']) {
    for (const sheet of ['vote-no', 'vote-yes', 'ask', 'kit-no']) {
      cases.push({ size: `${w}x${h}`, w, h, surface, layout: 'app', sheet, kb: 'app', inset: 0, safeBottom: 34, safeTop: 62 });
    }
  }
}
// Keys up in Safari: they cover the page.
for (const [size, [w, h]] of Object.entries(phones)) {
  for (const sheet of ['vote-no', 'ask', 'kit-no']) {
    cases.push({ size, w, h, surface: 'project', layout: 'browser', sheet, kb: 'safari', inset: 336, safeBottom: 34, safeTop: 0 });
  }
}

const label = (c) => `${c.size} ${c.surface} ${c.layout} ${c.sheet}${c.kb === 'none' ? '' : ` keys-up(${c.kb})`}`;
const failures = (r) => [
  ...Object.entries(r.probes).filter(([, p]) => !p || !p.onTarget || !p.inView)
    .map(([k, p]) => `${k}: ${p ? `${p.top}-${p.bottom}, elementFromPoint ${p.hit}${p.inView ? '' : ', off screen'}` : 'missing'}`),
  ...(r.boxClear === false ? ['the focused line box is under the action row'] : []),
];

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
const versions = base ? ['head', 'base'] : ['head'];
const report = {};
try {
  for (const version of versions) {
    const appCss = version === 'base' ? execFileSync('git', ['show', `${base}:public/css/app.css`], { cwd: root }) : readFileSync(root + 'public/css/app.css');
    report[version] = [];
    for (const c of cases) {
      const context = await browser.newContext({
        viewport: { width: c.w, height: c.h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.route('http://sheet.test/**', (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p === '/') return route.fulfill({ contentType: 'text/html', body: shell });
        if (p === '/css/app.css') return route.fulfill({ contentType: 'text/css', body: appCss });
        const file = root + 'public' + p;
        if (!p.endsWith('.css') || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'text/css', body: readFileSync(file) });
      });
      await page.goto('http://sheet.test/');
      const r = await page.evaluate(setUpAndMeasure, { c, feed, sheet: sheets[c.sheet] });
      report[version].push({ name: label(c), fails: failures(r) });
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const headFails = report.head.filter((x) => x.fails.length);
for (const x of headFails) console.error(`FAIL ${x.name}\n  ${x.fails.join('\n  ')}`);
assert.equal(headFails.length, 0, `${headFails.length} of ${report.head.length} cases have an action the viewer cannot reach`);
if (base) {
  const hit = report.base.find((x) => x.name === '375x812 project browser vote-yes');
  assert.ok(hit && hit.fails.some((f) => f.startsWith('send:') && f.includes('#platform-tab')),
    `the base must fail the run-through's case (Vote yes under the tab bar); got ${JSON.stringify(hit)}`);
}
console.log(JSON.stringify({
  cases: report.head.length,
  head: 'all reachable',
  ...(base ? { base, baseFailing: report.base.filter((x) => x.fails.length).length } : {}),
}));
