// A conversation in the one frame, as the 2026-11-06 screen tour draws it
// (s17, s18): the open-item pane, where "your own messages and theirs share
// one style, so a thread reads top to bottom". The product's own renderer
// still draws it (frontend/src/features/messages/message-row.tsx, the thread
// header, the composer), and wears the kit's rules through the map in
// frontend/looks/looks.json ("wear", tests/looks-css.test.js). What changes
// in the markup under a look is held here:
//
//   1. No row has a side: no bubble, your own row has your face and your
//      name like anyone's.
//   2. A face is the kit's avatar (a circle in the person's own colour), the
//      bot's the Homeroom tile.
//   3. The look is read once for every row (lib/skin.ts useLiveSkin), not by
//      a listener per row.
//   4. The standard look's rules that the kit's do not answer are set aside
//      in app.css, under a look only.
//
// Run with: node --test tests/messages-frame-stream.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ME = { id: 7, username: 'me', avatarUrl: null };
const ADA = { id: 8, username: 'ada', avatarUrl: null };
const BOT = { id: 2, username: 'homeroom_bot', bot: true };

function message(sender, n, over = {}) {
  return {
    id: n, conversationId: 42, sender,
    createdAt: new Date(Date.UTC(2026, 9, 9, 12, 0) + n * 60000).toISOString(),
    reply: null, reactions: [], attachments: [], objects: [], deleted: false,
    ...over,
  };
}

globalThis.window = {
  App: { user: ME },
  location: { search: '', hash: '#messages/42' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const FRAME = ['glass', 'brandkit', 'workbench', 'paper', 'pastel', 'mosaic', 'sunrise', 'today', 'playground'];
const skin = (look) => ({
  '../../lib/skin': { useLiveSkin: () => look, useSkin: () => look, currentSkin: () => look, isFrameSkin: (s) => FRAME.includes(s), FRAME_SKINS: FRAME },
});
function row(props, look = 'glass') {
  const { MessageRow } = loadTsx('frontend/src/features/messages/message-row.tsx', { stubs: skin(look), cache: false });
  return renderToHtml(createElement(MessageRow, { conversationId: 42, ...props }));
}
function face(props, look = 'glass') {
  const { UserAvatar } = loadTsx('frontend/src/features/messages/format.tsx', { stubs: skin(look), cache: false });
  return renderToHtml(createElement(UserAvatar, props));
}

test('under a look no row has a side: theirs and yours are the same named row', () => {
  for (const kind of ['direct', 'group']) {
    const theirs = row({ message: message(ADA, 1, { content: 'Hello there' }), kind });
    const mine = row({ message: message(ME, 2, { content: 'Looking now' }), kind });
    for (const html of [theirs, mine]) {
      assert.doesNotMatch(html, /messages-message-bubble|messages-bubble/, `${kind}: no bubble`);
      assert.match(html, /class="min-w-0 flex-1"/, `${kind}: the plain content column`);
      assert.match(html, /<span class="fr-av"/, `${kind}: a face on every row`);
    }
    assert.match(mine, /<span dir="auto" class="messages-message-author ">me<\/span>/, `${kind}: your name is on your row, in sight`);
    assert.match(mine, /messages-message-self/, 'still marked as yours, for what else reads it');
  }
});

test('the standard look keeps its sides', () => {
  const mine = row({ message: message(ME, 2, { content: 'Looking now' }), kind: 'direct' }, 'standard');
  assert.match(mine, /class="messages-message group messages-message-bubble /);
  assert.match(mine, /<div class="messages-bubble" dir="auto">/);
  assert.doesNotMatch(mine, /fr-av/);
  assert.match(row({ message: message(ADA, 1, { content: 'Hi' }), kind: 'direct' }, 'brand'), /messages-message-bubble/, 'the New look is not a look of the frame');
});

test('a face under a look is the kit\'s avatar in the person\'s own colour; the bot\'s is the Homeroom tile', () => {
  assert.match(face({ user: ADA, size: 'md', shape: 'square' }), /^<span class="fr-av" style="--fr-as:32px;--fr-ac:#[0-9a-f]{6}" aria-hidden="true">a<\/span>$/);
  assert.match(face({ user: ADA, size: 'lg' }), /--fr-as:40px/);
  assert.match(face({ user: ADA, size: 'sm' }), /--fr-as:24px/);
  assert.match(face({ user: { ...ADA, avatarUrl: '/u/8.png' } }), /^<span class="fr-av"[^>]*><img src="\/u\/8\.png"/);
  assert.match(face({ user: BOT }), /^<span class="fr-tile" style="--fr-ts:32px;[^"]*" aria-hidden="true"><img src="\/brand\/homeroom-mark\.png"/);
  assert.match(face({ user: null, title: 'Design review' }), /^<span class="fr-av"[^>]*>D<\/span>$/, 'no person: the title\'s letter');
  // The standard look's own, untouched.
  assert.match(face({ user: ADA, size: 'md', shape: 'square' }, 'standard'), /^<span aria-hidden="true" class="w-9 h-9 text-xs rounded-xl text-white font-bold/);
});

test('the look is read once for all rows: one listener, a live answer after the first paint', () => {
  const src = read('frontend/src/lib/skin.ts');
  assert.match(src, /export function useLiveSkin\(\): Skin \{\s*return useSyncExternalStore\(subscribeSkin, currentSkin, \(\) => 'standard'\);/,
    'standard while a prerendered island hydrates, the device\'s look for anything mounted after');
  assert.match(read('frontend/src/features/messages/message-row.tsx'), /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(read('frontend/src/features/messages/format.tsx'), /isFrameSkin\(useLiveSkin\(\)\)/);

  const listeners = [];
  let look = 'glass';
  const before = globalThis.window.Skin;
  globalThis.window.Skin = { get: () => look, set() {}, apply() {}, onChange: (fn) => listeners.push(fn) };
  try {
    const mod = loadTsx('frontend/src/lib/skin.ts', { cache: false });
    const seen = [];
    const off1 = mod.subscribeSkin(() => seen.push('a'));
    const off2 = mod.subscribeSkin(() => seen.push('b'));
    assert.equal(listeners.length, 1, 'however many rows subscribe, window.Skin hears of one listener');
    look = 'paper';
    listeners[0]();
    assert.deepEqual(seen, ['a', 'b']);
    off1();
    listeners[0]();
    assert.deepEqual(seen, ['a', 'b', 'b'], 'a row that left is not told');
    off2();
  } finally {
    globalThis.window.Skin = before;
  }
});

test('app.css sets the standard row\'s own spacing aside under a look, and only there', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message \{[^}]*padding: 8px 0;/, 'the kit\'s 16px between posts');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message-grouped \{[^}]*padding-block: 1px;/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message:has\(\+ \.messages-message-grouped\) \{ padding-bottom: 0; \}/,
    'the same person going on is the same post: no gap before their next line');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message-grouped:not\(:has\(\+ \.messages-message-grouped\)\) \{ padding-bottom: 8px; \}/,
    'and the post ends where their run does');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-thread-header > \.fr-av \{ --fr-as: 40px !important; \}/, 'the head\'s face is the row\'s size');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-message-gutter \{ flex-basis: 44px; width: 44px; margin-inline-start: 0; \}/, 'a continuation\'s time sits under the face, not past the row\'s edge');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.messages-thread-pane > \.messages-thread-scroll \{[^}]*padding: 24px 32px;/, 'the open-item pane\'s own margins');
});

test('on a phone the conversation names itself in its own head under a look, and no look hook sits behind a condition', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  // The drawer flips on and off as a thread opens; a hook read only while it
  // is on changes the header's hook count between two renders (a crash).
  assert.match(src, /const \{ on: drawerOn \} = useStoreState\(messagesDrawerStore\);[\s\S]{0,400}?const frame = isFrameSkin\(useLiveSkin\(\)\);\s+const inDrawer = drawerOn && !frame;/);
  assert.match(src, /useFramePage\(frame && snap\.route\.open && drawer\.on && drawer\.level === 1 \? \[tc\('core:tabs\.messages'\)\] : null, messagesBack\);/,
    'the bar says Messages, and its arrow is the drawer\'s own way back to the list');
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  for (const file of walk('frontend/src')) {
    assert.doesNotMatch(read(file), /(&&|\|\||\?)\s*!?isFrameSkin\(use(Live)?Skin\(\)\)/, `${file}: the look is read behind a condition`);
  }
});

test('a group wears one face under a look, a member\'s who is not you', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const faces = src.slice(src.indexOf('function GroupFaces('), src.indexOf('const ConversationRow = memo('));
  assert.match(faces, /const frame = isFrameSkin\(useLiveSkin\(\)\);\s+if \(frame\) return <UserAvatar user=\{others\[0\] \|\| null\} title=\{conversation\.title\} size="lg" shape="square" \/>;/);
  assert.ok(faces.indexOf('const frame = ') < faces.indexOf('if (others.length === 2)'), 'before the standard look\'s stacked pair');
});
