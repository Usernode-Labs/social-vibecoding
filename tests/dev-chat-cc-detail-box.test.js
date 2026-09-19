// #1944: the coding-run card's toggle and its log panel's scrolling.
//
// QA reported the "Claude Code" detail box's toggle button and scrolling as
// broken. Three things were, each pinned here:
//
//   1. The chevron never flipped. app.css flipped it with a DIRECT-CHILD
//      selector (`> .dc-cc-attached-chevron`), and #1672 moved the chevron
//      into the summary's head row, so the rule matched only the shared
//      transcript page's copy. The dev chat's glyph sat on ▸ open or closed,
//      which is what a dead toggle looks like.
//   2. The log panel never followed the run. The React conversion dropped
//      the `<pre>` auto-scroll the innerHTML renderer did, so an open card
//      showed the first dozen lines of a run hundreds of lines further on.
//      features/dev-chat/log-follow.ts is the rule: follow at the end, stop
//      when the reader scrolls up, resume when they come back, and an open
//      always shows the latest line.
//   3. Opening a card scrolled the transcript past it. `initScrollTracking`'s
//      MutationObserver followed every mutation to the bottom, the `open`
//      flip included; the card's toggle handler brings the card into view
//      now and the observer ignores a batch that is only that flip.
//
// Run with: node --test tests/dev-chat-cc-detail-box.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const CSS = read('public/css/app.css');
const TRANSCRIPT = read('frontend/src/features/dev-chat/transcript.tsx');
const DEV_CHAT = read('frontend/src/features/dev-chat/dev-chat.js');
const DAPP = JSON.parse(read('dapp.json'));

// ── 1. The chevron flips where it actually is ──────────────────────────

test('the open-card chevron rule reaches a chevron inside the head row', () => {
  // The dev chat draws the chevron inside `.dc-cc-head`, the summary's first
  // row, not as the summary's own child.
  const head = TRANSCRIPT.slice(TRANSCRIPT.indexOf('className="dc-cc-head"'));
  const chevronAt = head.indexOf('dc-cc-attached-chevron');
  // The head's OWN closing tag, at the summary's indentation — not the tag
  // of whatever happens to follow it. #2597 put the venue caption between
  // the head and the chips, and an anchor that named the next sibling read
  // that as the chevron having left the head row.
  const headCloses = head.indexOf('\n        </span>');
  assert.ok(chevronAt > 0 && chevronAt < headCloses, 'chevron is drawn inside .dc-cc-head');

  // So the flip must be a DESCENDANT rule. The direct-child form is exactly
  // the bug: it matched nothing in the dev chat.
  assert.match(
    CSS,
    /\.dc-cc-attached\[open\] > \.dc-cc-attached-summary \.dc-cc-attached-chevron::before \{\s*content: '\\25BE'/,
    'an open card flips the chevron to ▾ wherever the summary holds it',
  );
  assert.doesNotMatch(
    CSS,
    /\.dc-cc-attached-summary > \.dc-cc-attached-chevron::before/,
    'the direct-child flip rule is gone',
  );
});

// ── 2. The log panel follows the run ────────────────────────────────────

const { createLogFollower, isAtEnd, scrollToEnd, revealDisclosure, FOLLOW_SLACK_PX } =
  loadTsx('frontend/src/features/dev-chat/log-follow.ts');

const box = (over = {}) => ({ scrollTop: 0, scrollHeight: 240, clientHeight: 240, ...over });

test('isAtEnd allows a line and a half of slack, no more', () => {
  assert.equal(isAtEnd(box({ scrollHeight: 1000, scrollTop: 760 })), true, 'exactly at the end');
  assert.equal(isAtEnd(box({ scrollHeight: 1000, scrollTop: 760 - FOLLOW_SLACK_PX })), true, 'within slack');
  assert.equal(isAtEnd(box({ scrollHeight: 1000, scrollTop: 760 - FOLLOW_SLACK_PX - 1 })), false, 'past slack');
  assert.equal(isAtEnd(box()), true, 'a panel with nothing to scroll is at its end');
});

test('a follower at the end follows growth; one scrolled up does not', () => {
  const f = createLogFollower();
  assert.equal(f.pinned, true, 'starts pinned');
  // A fake element is a plain object, so scrollToEnd writes back onto it.
  const el = box({ scrollHeight: 600, scrollTop: 160 });
  f.noteGrowth(el);
  assert.equal(el.scrollTop, 600, 'followed to the new end');

  // The reader scrolls up to read something.
  el.scrollTop = 100;
  f.noteScroll(el);
  assert.equal(f.pinned, false, 'scrolling away unpins');
  const before = el.scrollTop;
  Object.defineProperty(el, 'scrollHeight', { value: 900 });
  f.noteGrowth(el);
  assert.equal(el.scrollTop, before, 'growth leaves a reader who scrolled up where they are');

  // …and comes back to the bottom.
  el.scrollTop = 900 - 240 - 10;
  f.noteScroll(el);
  assert.equal(f.pinned, true, 'returning to within slack pins again');
  Object.defineProperty(el, 'scrollHeight', { value: 1200 });
  f.noteGrowth(el);
  assert.equal(el.scrollTop, 1200, 'and growth is followed again');
});

test('opening the card shows the latest line whatever the reader did before', () => {
  const f = createLogFollower();
  const el = box({ scrollHeight: 800, scrollTop: 0 });
  f.noteScroll(el);
  assert.equal(f.pinned, false, 'the panel was left at its top');
  f.noteOpened(el);
  assert.equal(el.scrollTop, 800, 'an open jumps to the end');
  assert.equal(f.pinned, true, 'and follows from there');
});

test('scrollToEnd and revealDisclosure are the two DOM writes, and tolerate a bare fake', () => {
  const el = box({ scrollHeight: 500 });
  scrollToEnd(el);
  assert.equal(el.scrollTop, 500);
  const calls = [];
  revealDisclosure({ scrollIntoView: (o) => calls.push(o) });
  assert.deepEqual(calls, [{ block: 'nearest', inline: 'nearest' }], 'the least scroll that shows the card');
  assert.doesNotThrow(() => revealDisclosure({}), 'no scrollIntoView, no call');
  assert.doesNotThrow(() => revealDisclosure(null));
});

test('the card wires the follower to its log panel and its toggle', () => {
  // The panel keeps its markup — class, persist id, text — and gains the two
  // hooks the follower needs: the ref it scrolls and the scroll it listens to.
  assert.match(
    TRANSCRIPT,
    /<pre\s+className="dc-cc-attached-log" data-persist-id=\{r\.body\.persistId\}\s+ref=\{log\.pre\} onScroll=\{log\.onScroll\}\s*>\s*\{r\.body\.text\}\s*<\/pre>/,
    'the log <pre> carries the follower ref and scroll listener, nothing else new',
  );
  // An OPEN — the reader's, read off the element because no render sits
  // between the browser's flip and its toggle event — shows the latest line
  // and brings the card into view.
  assert.match(TRANSCRIPT, /if \(ev\.currentTarget\.open\) \{\s*log\.onOpened\(\);\s*revealDisclosure\(ev\.currentTarget\);/);
  // Growth under an open card follows; a closed card's panel has no layout
  // to scroll, so the effect waits for `open`.
  assert.match(TRANSCRIPT, /if \(open && text != null && pre\.current\) follower\.current!\.noteGrowth\(pre\.current\);\s*\}, \[text, open\]\)/);
});

// ── 3. The transcript does not scroll past a card the reader opened ─────

function loadDevChat() {
  const noop = () => {};
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: {}, fetch: async () => ({ ok: false }), URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = noop;
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT}\n;globalThis.__DevChat = DevChat;`, sandbox);
  return { DevChat: sandbox.__DevChat, sandbox };
}

const rec = (over = {}) => ({ type: 'attributes', attributeName: 'open', target: { tagName: 'DETAILS' }, ...over });

test('a batch that is only <details> open flips is the reader\'s toggle; anything else is content', () => {
  const { DevChat } = loadDevChat();
  assert.equal(DevChat._isDisclosureToggle([rec()]), true, 'one open flip');
  assert.equal(DevChat._isDisclosureToggle([rec(), rec({ target: { tagName: 'details' } })]), true, 'two flips, any case');
  assert.equal(DevChat._isDisclosureToggle([]), false, 'an empty batch is not a toggle');
  assert.equal(DevChat._isDisclosureToggle(null), false);
  assert.equal(DevChat._isDisclosureToggle([rec(), { type: 'childList', target: { tagName: 'DIV' } }]), false, 'a new row in the same batch is followed');
  assert.equal(DevChat._isDisclosureToggle([rec({ attributeName: 'class' })]), false, 'another attribute is followed');
  assert.equal(DevChat._isDisclosureToggle([rec({ target: { tagName: 'DIV' } })]), false, 'an open attribute on a non-details is followed');
  assert.equal(DevChat._isDisclosureToggle([{ type: 'characterData', target: {} }]), false, 'streamed text is followed');
});

test('initScrollTracking asks before following, and the follow is otherwise unchanged', () => {
  const body = DEV_CHAT.slice(DEV_CHAT.indexOf('  initScrollTracking() {'), DEV_CHAT.indexOf('  _isDisclosureToggle(records) {'));
  assert.match(body, /new MutationObserver\(\(records\) => \{\s*if \(DevChat\._isDisclosureToggle\(records\)\) return;\s*if \(DevChat\._lockedToBottom\) \{\s*requestAnimationFrame\(\(\) => \{ container\.scrollTop = container\.scrollHeight; \}\);/);
  assert.match(body, /observer\.observe\(container, \{ childList: true, subtree: true, attributes: true \}\)/, 'still watches attributes: `hidden` and class flips on rows are content changes');
});

// ── The deep link the declared checks reach the open card through ──────

test('?shot=cc-log-open opens the coding-run cards and nothing else, and writes nothing', () => {
  const { DevChat, sandbox } = loadDevChat();
  const writes = [];
  sandbox.localStorage.setItem = (k, v) => writes.push([k, v]);
  DevChat.currentSession = { id: 7 };

  // No location at all (the prerender, the vm): the stored state rules.
  assert.equal(DevChat._detailsOpen('101:ccrun', false), false);

  sandbox.location = { search: '?workspace=1&shot=cc-log-open' };
  assert.equal(DevChat._detailsOpen('101:ccrun', false), true, 'a paired run card opens');
  assert.equal(DevChat._detailsOpen('102:ccrunorphan', false), true, 'an orphan log card opens');
  assert.equal(DevChat._detailsOpen('103:ccout', false), false, 'the finished-output card keeps its default');
  assert.equal(DevChat._detailsOpen('104:cclog', false), false, 'the raw log keeps its default');

  sandbox.location = { search: '?shot=credits-low' };
  assert.equal(DevChat._detailsOpen('101:ccrun', false), false, 'another shot leaves the card on its stored state');
  assert.deepEqual(writes, [], 'the deep link persists nothing');
});

test('the declared checks reach the open card through the deep link', () => {
  const mine = DAPP.tests.filter((t) => t.name.startsWith('#1944'));
  assert.equal(mine.length, 2);
  for (const t of mine) {
    assert.equal(t.path, '/?workspace=1&shot=cc-log-open#app/usernode-2d5619/dev/sessions/990412');
    assert.match(t.expectSelector, /^details\.dc-cc-attached\[open\] > /, 'each asserts on the OPEN card');
  }
  assert.ok(mine.some((t) => t.expectSelector.endsWith('.dc-cc-head > .dc-cc-attached-chevron')), 'the chevron, in the head row');
  assert.ok(mine.some((t) => t.expectSelector.endsWith('> pre.dc-cc-attached-log')), 'the log panel');
});
