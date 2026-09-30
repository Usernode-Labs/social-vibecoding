'use strict';

// #3407: A CHANNEL LEADS WITH ITS WAY BACK TO ITS HUB.
//
// The hub's own pages (Needs you, the Workshop, All items) open with a round
// chevron back to the hub; the project's channel, whose door is the hub's
// Channel card, had only the platform header's arrow. Pinned here:
//
//   1. ONE DISC: `PageBackButton` in dev-board/workshop/page-back.tsx is the
//      chevron the Workshop's `PageBack` draws and the channel panes draw, so
//      the two cannot drift apart.
//   2. BOTH CHANNELS CARRY IT, first in their header row: a project's channel
//      (`AppDiscussionThread`) and #general (`ThreadHeader`, channel only —
//      a conversation's way back is the header's, to the list).
//   3. IT IS A DOOR TO THE HUB: AppView._landOnHub, then the hub's address,
//      so it lands on the hub rather than the tab the page was last left on.
//   4. #GENERAL'S HUB IS FOUND LATE: on a cold load the platform's slug is
//      not known when the header first draws, so the press reads it when
//      pressed and the label waits on PlatformTarget's lookup (executed below
//      against channel-hub.ts, not grepped).
//
// Run with: node --test tests/channel-back-to-hub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const BACK = read('frontend/src/features/dev-board/workshop/page-back.tsx');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

test('one disc: the Workshop\'s page head and the channels draw the same button', () => {
  const button = fn(BACK, 'PageBackButton');
  assert.match(button, /className="dev-ws-page-back un-touch-target"/);
  assert.match(button, /aria-label=\{`Back to \$\{label\}`\}/);
  assert.match(button, /<ChevronLeftIcon className="dev-ws-page-back-glyph" aria-hidden="true" \/>/);
  assert.match(fn(BACK, 'PageBack'), /<PageBackButton label=\{label\} onBack=\{onBack\} data-ws-page-back="" \/>/);
  assert.match(WORKSHOP, /import \{ PageBack \} from '\.\/page-back';/);
  assert.doesNotMatch(WORKSHOP, /function PageBack\(/, 'defined once, in page-back.tsx');
  assert.match(SCREEN, /import \{ PageBackButton \} from '\.\.\/dev-board\/workshop\/page-back';/);
});

test('a project\'s channel leads its header with the way back to its hub', () => {
  const pane = fn(SCREEN, 'AppDiscussionThread');
  assert.match(pane,
    /<header className="messages-thread-header">\s*<PageBackButton label=\{name\} onBack=\{\(\) => openChannelHub\(slug\)\} data-channel-back="" \/>\s*<AppIconLink/);
});

test('#general leads with the way back to the Homeroom hub; a conversation does not', () => {
  const header = fn(SCREEN, 'ThreadHeader');
  // A hook, so before the header's early return; watched, not read once.
  const hook = header.indexOf("const hubSlug = usePlatformSlug(active?.kind === 'channel');");
  assert.ok(hook > 0 && hook < header.indexOf('if (!active) return null;'), 'the hook runs before the early return');
  assert.match(header,
    /\{channel \? <PageBackButton label=\{hubSlug \? 'Homeroom' : 'Communities'\} onBack=\{backToPlatformHub\} data-channel-back="" \/> : null\}/);
  assert.equal((header.match(/<PageBackButton /g) || []).length, 1, 'only behind `channel`');
  assert.match(SCREEN, /import \{ backToPlatformHub, openChannelHub, usePlatformSlug \} from '\.\/channel-hub';/);
});

// EXECUTED: the module that decides where the disc goes, against a stubbed
// window whose PlatformTarget knows nothing at first, the way a cold
// `#messages/<general-id>` load finds it while /api/version is in flight.
function withWindow(stub, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = stub;
  const done = () => { if (had) globalThis.window = prev; else delete globalThis.window; };
  let out;
  try { out = run(); } catch (err) { done(); throw err; }
  return Promise.resolve(out).finally(done);
}

function coldWindow() {
  let slug = null;
  let release;
  const lookup = new Promise((resolve) => { release = resolve; });
  const landed = [];
  const win = {
    location: { hash: '#messages/7' },
    AppView: { _landOnHub: (s) => landed.push(s) },
    PlatformTarget: { slug: () => slug, resolve: () => lookup },
  };
  return { win, landed, learn: (s) => { slug = s; release(); } };
}

test('a cold #general: Communities first, then the hub once the platform slug lands, and the press reads it then', async () => {
  const HUB = loadTsx('frontend/src/features/messages/channel-hub.ts');
  const { win, landed, learn } = coldWindow();
  await withWindow(win, async () => {
    const seen = [];
    const cancel = HUB.watchPlatformSlug((s) => seen.push(s));
    assert.equal(HUB.platformSlug(), null, 'nothing knows the slug at first draw');
    assert.deepEqual(seen, [], 'the label waits on the lookup, it does not settle on null early');

    learn('homeroom');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, ['homeroom'], 'the header hears the slug once the lookup settles');

    // The press resolves the slug when pressed, not when the header drew.
    HUB.backToPlatformHub();
    assert.deepEqual(landed, ['homeroom'], 'lands on the hub first');
    assert.equal(win.location.hash, '#app/homeroom/workshop');
    cancel();
  });
});

test('a press before anything knows the slug goes to Communities, without a hub landing', async () => {
  const HUB = loadTsx('frontend/src/features/messages/channel-hub.ts');
  const { win, landed } = coldWindow();
  await withWindow(win, () => {
    HUB.backToPlatformHub();
    assert.deepEqual(landed, []);
    assert.equal(win.location.hash, '#communities');
  });
});

test('a cancelled watch stays quiet; a known slug is handed over at once', async () => {
  const HUB = loadTsx('frontend/src/features/messages/channel-hub.ts');
  const { win, learn } = coldWindow();
  await withWindow(win, async () => {
    const seen = [];
    HUB.watchPlatformSlug((s) => seen.push(s))();
    learn('homeroom');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(seen, [], 'an unmounted header is not set');
    const now = [];
    HUB.watchPlatformSlug((s) => now.push(s));
    assert.deepEqual(now, ['homeroom']);
  });
});

test('a project\'s channel: _landOnHub first, then the hub\'s address', async () => {
  const HUB = loadTsx('frontend/src/features/messages/channel-hub.ts');
  const { win, landed } = coldWindow();
  await withWindow(win, () => {
    HUB.openChannelHub('whiteboard');
    assert.deepEqual(landed, ['whiteboard']);
    assert.equal(win.location.hash, '#app/whiteboard/workshop');
  });
});
