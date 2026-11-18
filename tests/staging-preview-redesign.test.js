'use strict';

// The change preview's redesign (Nov 2026): where it stands, what its header
// says, how its state moves, where a comment pinned in it goes, and that the
// top window draws it when the side panel's copy of Homeroom asks.
//
//   placement   features/staging/placement.ts choosePlacement: a column beside
//               the thread when it gets MIN_COLUMN px, else the side panel's
//               place, else the whole window; always the whole window on a
//               phone or for a change declared for large screens only.
//   header      staging-overlay.tsx previewFacts / previewVoteLabel: the line
//               under the change's name, read as the chat's vote card reads
//               a vote, and the platform's Vote / See the vote.
//   bridge      staging-bridge.js: setChange is a patch, the switch shows
//               the before-and-after only when there is one, a placement is
//               normalised, close resets it all.
//   comments    comment-pin/post.ts: a comment pinned in a preview posts into
//               the change's thread (thread `session`), its pictures as the
//               chat's own attachments.
//   stacking    app.css: the preview is above the Get-the-app strip (which
//               covered its Back on a phone) and below the dialogs.
//   handoff     app-view.js: a Preview press in the side panel's document is
//               handed to the top window with the app it is of.
//
// Run with: node --test tests/staging-preview-redesign.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const storeMod = loadTsx('frontend/src/features/staging/staging-store.js');
const bridgeMod = loadTsx('frontend/src/features/staging/staging-bridge.js', {
  stubs: { './staging-store.js': storeMod },
});
const overlay = loadTsx('frontend/src/features/staging/staging-overlay.tsx', {
  stubs: { './staging-store.js': storeMod },
});
const placement = loadTsx('frontend/src/features/staging/placement.ts', {
  stubs: {
    './staging-store.js': storeMod,
    '../ai/detail': {
      closeDetail() {}, detailEntry: () => null, openDetail() {}, subscribeDetail: () => () => {},
    },
    '../side-panel/controller': { isBesideAi: () => false },
    '../side-panel/store.js': { sidePanelStore: { get: () => ({ open: false }), subscribe: () => () => {} } },
  },
});

// ── placement ─────────────────────────────────────────────────────────────

test('placement: a column beside the thread when it gets room, else the panel, else the window', () => {
  const at = (f) => placement.choosePlacement({
    phone: false, wide: false, besideApp: false, panelOpen: false, columnWidth: null, ...f,
  });
  assert.equal(placement.MIN_COLUMN, 400);
  assert.equal(at({ columnWidth: 613 }), 'column', 'the bot tab at 1440: thread | preview in halves');
  assert.equal(at({ columnWidth: 467, panelOpen: true }), 'column', 'the bot tab at 1600: three columns');
  assert.equal(at({ columnWidth: 354, panelOpen: true }), 'panel', 'too narrow a column: it takes the panel');
  assert.equal(at({ columnWidth: 354 }), 'full', 'and with no panel, the window');
  assert.equal(at({}), 'full', 'a page with no column');
  assert.equal(at({ besideApp: true, panelOpen: true, columnWidth: 900 }), 'panel',
    'beside a running app it always takes the panel: no room for app, request and preview');
  assert.equal(at({ phone: true, columnWidth: 900, panelOpen: true }), 'full', 'a phone: the whole screen');
  assert.equal(at({ wide: true, columnWidth: 900, panelOpen: true }), 'full',
    'a change declared for large screens only: a column would show the wrong layout');
});

test('placement: Full window docks back, and only from a column or a panel', () => {
  storeMod.stagingStore.set({ placement: 'full', expanded: false });
  assert.equal(placement.togglePreviewSize(), false, 'the whole window has nowhere to dock');
  assert.equal(storeMod.stagingStore.get().expanded, false);
  storeMod.stagingStore.set({ placement: 'column', expanded: false });
  assert.equal(placement.togglePreviewSize(), true);
  assert.equal(storeMod.stagingStore.get().expanded, true);
  assert.equal(placement.togglePreviewSize(), false);
  assert.equal(storeMod.stagingStore.get().expanded, false);
  storeMod.stagingStore.set({ placement: 'full', expanded: false });
});

test('placement: the frame is never moved, only the overlay over a measured spot', () => {
  const src = read('frontend/src/features/staging/placement.ts');
  assert.doesNotMatch(src, /appendChild|insertBefore|replaceWith|\.append\(/,
    'nothing here reparents an element: a moved iframe reloads');
  assert.match(src, /\[data-preview-slot\]/, 'the column is measured through its placeholder');
  assert.match(read('frontend/src/features/detail/detail-pane.tsx'), /data-preview-slot=""/,
    'which the detail column draws for a `preview` entry');
  assert.match(read('frontend/src/features/detail/detail-slot.tsx'), /'shots', 'preview'\]/,
    'and the request page\'s and Workshop\'s column draws too');
});

// ── header ────────────────────────────────────────────────────────────────

test('header: the line under the name reads the vote as the chat\'s vote card does', () => {
  const facts = (o) => overlay.previewFacts({ appName: 'Audit Garden', number: 34, vote: null, withApp: false, ...o })
    .map((p) => (p.ask ? `[${p.text}]` : p.text)).join(' · ');
  assert.equal(facts({}), 'Change #34');
  assert.equal(facts({ withApp: true }), 'Audit Garden · Change #34', 'the project\'s name in the whole window');
  const open = { yes: 1, needed: 2, needsOtherMember: false, myVote: null, status: 'promoted' };
  assert.equal(facts({ vote: open }), 'Change #34 · [Needs 1 more yes]', 'the ask is the accent');
  assert.equal(facts({ vote: { ...open, myVote: 'yes' } }), 'Change #34 · Needs 1 more yes · You voted yes',
    'once voted it no longer asks the viewer');
  assert.equal(facts({ vote: { ...open, yes: 2, needsOtherMember: true } }), 'Change #34 · Needs another member’s yes');
  assert.equal(facts({ vote: { ...open, status: 'merged' } }), 'Change #34 · Merged');
  assert.equal(facts({ number: 0 }), '', 'a dev session\'s preview: no number, no vote');
});

test('header: the platform\'s Vote, See the vote once voted or settled', () => {
  const open = { yes: 1, needed: 2, needsOtherMember: false, myVote: null, status: 'promoted' };
  assert.equal(overlay.previewVoteLabel(null), '', 'not up for a vote: no button');
  assert.equal(overlay.previewVoteLabel(open), 'Vote');
  assert.equal(overlay.previewVoteLabel({ ...open, myVote: 'no' }), 'See the vote');
  assert.equal(overlay.previewVoteLabel({ ...open, status: 'merging' }), 'See the vote');
  const src = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(src, /id="staging-vote-btn"[\s\S]*?onClick=\{\(\) => stagingHandlers\.onVote\?\.\(\)\}/,
    'wired to the handler app-view.js points at the Votes card');
  assert.match(read('public/js/app-view.js'), /_stagingVote\(\) \{[\s\S]*?AppView\.openChangeAtVotes\(pv\.slug, pv\.sessionId\)/,
    'which opens the change at its Votes card, as the chat\'s vote card does');
});

// ── bridge ────────────────────────────────────────────────────────────────

test('bridge: setChange is a patch, so the change\'s name arrives without clearing the tile', () => {
  const b = bridgeMod.stagingBridge;
  b.setChange({ appName: 'Audit Garden', tile: '🌱', tileImage: 'javascript:alert(1)', selfHosted: false, title: '', number: null });
  let st = storeMod.stagingStore.get();
  assert.equal(st.appTile, '🌱');
  assert.equal(st.appTileImage, '', 'only an http(s) or same-origin picture is drawn');
  b.setChange({ title: '  Remind whoever is on watering duty ', number: 34 });
  st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, 'Remind whoever is on watering duty');
  assert.equal(st.changeNumber, 34);
  assert.equal(st.appTile, '🌱', 'the tile stays');
  assert.equal(st.appName, 'Audit Garden');
  b.close();
  st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, '');
  assert.equal(st.changeNumber, 0);
  assert.equal(st.appTile, '');
});

test('bridge: the switch offers Before & after only when there are shots', () => {
  const b = bridgeMod.stagingBridge;
  b.setShots('');
  b.setView('shots');
  assert.equal(storeMod.stagingStore.get().view, 'preview', 'nothing to show on that side');
  b.setShots('<div class="shots-viewer"></div>');
  b.setView('shots');
  assert.equal(storeMod.stagingStore.get().view, 'shots');
  b.setShots('');
  assert.equal(storeMod.stagingStore.get().view, 'preview', 'shots gone: back to the preview');
  b.close();
});

test('bridge: a placement is normalised, and only the panel beside an app marks it Live', () => {
  const b = bridgeMod.stagingBridge;
  const rect = { left: 827, top: 44, width: 613, height: 856 };
  b.setPlacement({ placement: 'column', rect, beside: 'app' });
  let st = storeMod.stagingStore.get();
  assert.equal(st.placement, 'column');
  assert.deepEqual(st.rect, rect);
  assert.equal(st.beside, null, 'Live is the panel beside an app only');
  b.setPlacement({ placement: 'panel', rect, beside: 'app' });
  assert.equal(storeMod.stagingStore.get().beside, 'app');
  b.setPlacement({ placement: 'sideways', rect });
  st = storeMod.stagingStore.get();
  assert.equal(st.placement, 'full');
  assert.equal(st.rect, null, 'the whole window has no spot');
  b.close();
});

// ── comments ──────────────────────────────────────────────────────────────

test('comments: pinned in a preview, they go into the change\'s thread with their pictures', async () => {
  const calls = [];
  const fakeWindow = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (/chat-attachments/.test(url)) return { ok: true, json: async () => ({ id: 'a'.repeat(32) }) };
      return { ok: true, json: async () => ({ message: { id: 1 } }) };
    },
  };
  const post = loadTsx('frontend/src/features/comment-pin/post.ts', { cache: false });
  const saved = global.window;
  global.window = fakeWindow;
  try {
    const out = await post.postComment({
      text: 'Could the reminder say which beds need water most?',
      target: 'change',
      appSlug: 'audit-garden',
      sessionId: 9201,
      shots: [{ blob: { type: 'image/png', size: 10 }, pins: [{ x: 0.5, y: 0.2, note: 'here' }] }],
      images: [],
      change: '',
    });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 2, 'one picture up, then one message');
    assert.match(calls[0].url, /^\/api\/apps\/audit-garden\/chat-attachments\?filename=/);
    assert.equal(calls[1].url, '/api/apps/audit-garden/messages');
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.thread_type, 'session');
    assert.equal(body.thread_ref, 9201);
    assert.deepEqual(body.attachment_ids, ['a'.repeat(32)]);
    assert.equal(body.content, 'Could the reminder say which beds need water most?');
    assert.ok(!calls.some((c) => /\/api\/feedback/.test(c.url)), 'no request is filed');
  } finally {
    global.window = saved;
  }
});

test('comments: the box offers the change first, and picks it, for a pin in a preview', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /const PREVIEW_TARGETS: readonly Target\[\] = \['change', 'app', 'platform'\];/);
  assert.match(src, /draft\.chosen \?\? \(inPreview \? 'change' :/);
});

// ── stacking ──────────────────────────────────────────────────────────────

test('stacking: above the Get-the-app strip, below the dialogs', () => {
  const css = read('public/css/app.css');
  const z = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at !== -1, `missing ${selector}`);
    return Number(/z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('}', at)))[1]);
  };
  const preview = z('#staging-overlay');
  const strip = z('#mobile-install-banner:not(.hidden)');
  assert.ok(preview > strip, `the preview (${preview}) is over the strip (${strip}), whose cover hid its Back`);
  assert.ok(preview < 50, 'and under the drawer and the dialogs (z-50)');
});

// ── handoff ───────────────────────────────────────────────────────────────

test('handoff: a Preview press in the side panel\'s document is drawn by the top window', async () => {
  const SRC = read('public/js/app-view.js');
  const forwarded = [];
  const top = { AppView: { ensureStaging: (...args) => { forwarded.push(args); return 'top'; } } };
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console,
    App: { user: { id: 1 }, embeddedPanel: true },
    document: { getElementById: () => null, documentElement: { classList: { contains: () => false } } },
    setTimeout, clearTimeout, URL,
    location: { origin: 'https://platform.example', hostname: 'platform.example', hash: '' },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = top;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'audit-garden', name: 'Audit Garden', audience: 'invited', icon_emoji: '🌱', self_hosted: false };
  const out = await AppView.ensureStaging(9201, null, { md: 'Try it', path: null }, {});
  assert.equal(out, 'top', 'the top window took it');
  assert.equal(forwarded.length, 1);
  const [id, url, testing, opts] = forwarded[0];
  assert.equal(id, 9201);
  assert.equal(url, null);
  assert.deepEqual(JSON.parse(JSON.stringify(testing)), { md: 'Try it', path: null }, 'with its testing notes');
  assert.equal(opts.app.slug, 'audit-garden', 'and the app it is of');
  assert.equal(opts.app.name, 'Audit Garden');
  assert.equal(opts.app.icon_emoji, '🌱');

  // The top window itself draws its own.
  sandbox.App.embeddedPanel = false;
  assert.equal(AppView._stagingTop(), null);
});
