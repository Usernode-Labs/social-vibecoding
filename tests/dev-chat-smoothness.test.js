'use strict';

// The dev chat on a phone: what made a streaming turn stutter and typing lag,
// and the fix for each. An emulated-iPhone audit (the same one #3104 ran on
// Messages) found six costs, all paid many times a second while a coding run
// streams its log:
//
//   1. `renderMarkdown` was uncached, and every transcript republish renders
//      every message — marked + DOMPurify over text that had not changed.
//   2. No transcript row was memoized, and every html sink handed React a
//      fresh `{ __html }` object, which React 19 answers by rewriting
//      innerHTML — so every republish rebuilt every message body.
//   3. Every SSE progress line, the 3s /status poll and each AI estimate
//      republished the transcript synchronously, many times per frame.
//   4. `initScrollTracking` ran on every `renderChatView` against the same
//      persistent `#dc-messages`, stacking listeners and MutationObservers,
//      and each observer queued its own (CSS-smoothed) scroll write.
//   5. Every keystroke republished the whole composer, rebuilding the model
//      picker (a Map and a sort over the catalogue) and re-parsing the drafts.
//   6. The live bubble re-rendered its finished lines every frame, though
//      they only change when a newline arrives.
//
// Each is pinned here, by behaviour where Node can drive it.
//
// Run with: node --test tests/dev-chat-smoothness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Marked } = require('marked');

const { loadTsx, FRONTEND } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
/** A vm-realm value as same-realm data, for deepEqual. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const DEV_CHAT_SRC = read('frontend/src/features/dev-chat/dev-chat.js');
const STREAMING_SRC = read('public/js/streaming-markdown.js');
const TRANSCRIPT_TSX = read('frontend/src/features/dev-chat/transcript.tsx');

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A requestAnimationFrame whose frames run only when the test says so. */
function frames() {
  const queue = new Map();
  let next = 1;
  return {
    requestAnimationFrame(fn) { const id = next++; queue.set(id, fn); return id; },
    cancelAnimationFrame(id) { queue.delete(id); },
    pending: () => queue.size,
    flush() {
      const due = [...queue.values()];
      queue.clear();
      for (const fn of due) fn();
    },
  };
}

function element(id, extra = {}) {
  const listeners = [];
  return {
    id,
    value: '',
    scrollTop: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    style: {},
    dataset: {},
    listeners,
    scrolls: [],
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    removeEventListener() {},
    scrollTo(opts) { this.scrolls.push(opts); },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra,
  };
}

/**
 * dev-chat.js in a vm, the way the other dev-chat suites load it: the real
 * source against a DOM shim. `marked` is the real library behind a counting
 * wrapper; DOMPurify is a stand-in that records its config into the output,
 * so a key that forgot the sanitizer's inputs would show up as a mismatch.
 */
function loadDevChat({ raf = null, markdown = true, els = {} } = {}) {
  const counts = { parse: 0, sanitize: 0, publishTranscript: 0, publishComposer: 0, publishStream: 0 };
  const observers = [];
  const storage = new Map();
  const published = { transcript: null, composer: null, stream: null };
  const sandbox = {
    console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    escapeHtml,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: {},
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.observed = []; observers.push(this); }
      observe(node, opts) { this.observed.push({ node, opts }); }
      disconnect() {}
    },
  };
  if (markdown) {
    // Its OWN marked: the renderers dev-chat.js registers close over the
    // DevChat that registered them, so two harnesses sharing the module's
    // singleton would each read the other's per-parse flags.
    const instance = new Marked();
    sandbox.marked = {
      use: (...a) => instance.use(...a),
      parse: (...a) => { counts.parse += 1; return instance.parse(...a); },
    };
    sandbox.DOMPurify = {
      addHook() {},
      sanitize(html, cfg) {
        counts.sanitize += 1;
        return `${html}<!--${cfg.ALLOWED_TAGS.includes('img') ? 'img' : 'noimg'}-->`;
      },
    };
  }
  if (raf) {
    sandbox.requestAnimationFrame = raf.requestAnimationFrame;
    sandbox.cancelAnimationFrame = raf.cancelAnimationFrame;
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.UsernodeReact = {
    devChat: {
      publishTranscript: (s) => { counts.publishTranscript += 1; published.transcript = s; },
      publishComposer: (s) => { counts.publishComposer += 1; published.composer = s; },
      publishStream: (s) => { counts.publishStream += 1; published.stream = s; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${STREAMING_SRC}\n${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // The neighbours `renderMessages` wires after its publish; not under test.
  for (const fn of ['_wireDevFlowCard', '_bindDevFlowVisibility', '_wireCreditsCards',
    '_syncElapsedTicker', '_renderQuickReplies']) DevChat[fn] = () => {};
  DevChat._devFlowHtml = () => '';
  return { DevChat, sandbox, counts, observers, storage, published };
}

// ── 1. The rendered-markdown cache ──────────────────────────────────────

const SAMPLES = [
  'plain **bold** text',
  'line one\nline two\n\n- [ ] a task\n- [x] done',
  '# Title\n\n1. one\n2. two\n\n| a | b |\n|---|---|\n| 1 | 2 |',
  'see ![shot](https://example.com/a.png) and [a link](https://example.com)',
  '[![img](https://example.com/b.png)](https://example.com/page)\n<img src="https://example.com/c.png" alt="c">',
  '```js:src/app.js\nconst x = 1 < 2;\n```\nand `code`',
];
const OPTION_SETS = [{}, { breaks: false }, { images: true }, { breaks: false, images: true }, { breaks: true }];

test('a cached render is byte-identical to an uncached one, for every option the output depends on', () => {
  const { DevChat } = loadDevChat();
  const reference = loadDevChat().DevChat;
  for (let round = 0; round < 3; round += 1) {
    for (const text of SAMPLES) {
      for (const opts of OPTION_SETS) {
        const expected = reference.renderMarkdown(text, { ...opts, cache: false });
        assert.equal(DevChat.renderMarkdown(text, opts), expected,
          `round ${round}, ${JSON.stringify(opts)}: ${JSON.stringify(text)}`);
      }
    }
  }
});

test('every option that changes the output is part of the key', () => {
  const { DevChat } = loadDevChat();
  const text = 'first line\nsecond line\n\n![shot](https://example.com/a.png)';
  const outs = OPTION_SETS.slice(0, 4).map((opts) => DevChat.renderMarkdown(text, opts));
  // Soft breaks, inline images and the sanitizer's image allowlist each
  // change the html, so the four combinations are four different answers —
  // and asking again in a different order still gets each its own.
  assert.equal(new Set(outs).size, 4, 'four option sets, four renders');
  const again = OPTION_SETS.slice(0, 4).reverse().map((opts) => DevChat.renderMarkdown(text, opts));
  assert.deepEqual(again.reverse(), outs);
  // `breaks: true` and the default are the same render.
  assert.equal(DevChat.renderMarkdown(text, { breaks: true }), outs[0]);
});

test('an unchanged text is parsed and sanitized once, however often the transcript republishes', () => {
  const { DevChat, counts } = loadDevChat();
  const first = DevChat.renderMarkdown('hello **world**');
  assert.equal(counts.parse, 1);
  for (let i = 0; i < 50; i += 1) assert.equal(DevChat.renderMarkdown('hello **world**'), first);
  assert.equal(counts.parse, 1, 'fifty republishes, one parse');
  assert.equal(counts.sanitize, 1, 'and one sanitize');
  DevChat.renderMarkdown('hello **world**', { breaks: false });
  assert.equal(counts.parse, 2, 'another option set is another render');
  DevChat.renderMarkdown('hello **world**', { cache: false });
  assert.equal(counts.parse, 3, '`cache: false` always renders');
});

test('the one piece of renderer state no option names bypasses the cache instead of being keyed wrong', () => {
  const { DevChat, counts } = loadDevChat();
  const text = '![shot](https://example.com/a.png)';
  DevChat.renderMarkdown(text, { images: true });
  assert.equal(counts.parse, 1);
  // Raised only mid-parse by the `link` renderer; were it ever set on entry,
  // the image would render without its full-size link, which no key says.
  DevChat._renderImageWithinLink = true;
  const inside = DevChat.renderMarkdown(text, { images: true });
  assert.equal(counts.parse, 2, 'not answered from the cache');
  assert.doesNotMatch(inside, /dc-inline-img-link/, 'and rendered for the state it was asked in');
  assert.equal(DevChat._renderImageWithinLink, false, 'the flag is still lowered afterwards');
  assert.match(DevChat.renderMarkdown(text, { images: true }), /dc-inline-img-link/,
    'the cached entry was not overwritten by the bypass');
  assert.equal(counts.parse, 2);
});

test('the cache is bounded, least-recently-used first, and a new marked/DOMPurify empties it', () => {
  const { DevChat, sandbox, counts } = loadDevChat();
  DevChat._MD_CACHE_MAX_ENTRIES = 3;
  for (const t of ['a', 'b', 'c']) DevChat.renderMarkdown(t);
  DevChat.renderMarkdown('a'); // touch: now the most recent
  DevChat.renderMarkdown('d'); // evicts the least recent, 'b'
  assert.deepEqual([...DevChat._mdCache.keys()], ['c', 'a', 'd']);
  const before = counts.parse;
  DevChat.renderMarkdown('a');
  assert.equal(counts.parse, before, '`a` survived because it was used');
  DevChat.renderMarkdown('b');
  assert.equal(counts.parse, before + 1, '`b` was evicted');

  DevChat._MD_CACHE_MAX_ENTRIES = 1500;
  DevChat._MD_CACHE_MAX_CHARS = 200;
  DevChat.renderMarkdown('x'.repeat(150));
  assert.ok(DevChat._mdCacheChars <= 200, `character budget holds (${DevChat._mdCacheChars})`);

  DevChat._MD_CACHE_MAX_CHARS = 6000000;
  DevChat.renderMarkdown('stable');
  const parses = counts.parse;
  const other = new Marked();
  sandbox.marked = { use: (...a) => other.use(...a), parse: (...a) => { counts.parse += 1; return other.parse(...a); } };
  DevChat.renderMarkdown('stable');
  assert.equal(counts.parse, parses + 1, 'a different marked on the page is a cold cache');
});

test('the no-library fallback is never cached', () => {
  const { DevChat } = loadDevChat({ markdown: false });
  const out = DevChat.renderMarkdown('# raw');
  assert.match(out, /dc-md-fallback/);
  assert.ok(!DevChat._mdCache || DevChat._mdCache.size === 0);
});

// ── 6. The live bubble renders its finished lines once per newline ─────

test('a streaming frame re-renders the finished lines only when a newline arrives, and never fills the cache', () => {
  const { DevChat, counts, published } = loadDevChat();
  DevChat._writeStreamingHtml('k', 'first line\nsec', true, false);
  assert.equal(counts.parse, 1);
  for (const more of ['seco', 'secon', 'second', 'second li', 'second line']) {
    DevChat._writeStreamingHtml('k', `first line\n${more}`, true, false);
  }
  assert.equal(counts.parse, 1, 'five frames on one line, the finished part parsed once');
  assert.match(published.stream.html, /dc-streaming-tail">second line</);
  DevChat._writeStreamingHtml('k', 'first line\nsecond line\nth', true, false);
  assert.equal(counts.parse, 2, 'a newline is a new finished part');
  assert.equal(DevChat._mdCache ? DevChat._mdCache.size : 0, 0,
    'the prefixes of a reply in flight never reach the shared cache');

  // The seal renders the whole reply through the cache, which is what the
  // `renderMessages` after it then finds.
  DevChat._streamKey = 'k';
  DevChat._streamPending = { key: 'k', fullText: 'first line\nsecond line\nthird', breaks: true };
  DevChat._flushStreamingFinal();
  assert.equal(DevChat._streamCommitted, null, 'the one-slot memo is released with the turn');
  const sealed = counts.parse;
  DevChat.renderMarkdown('first line\nsecond line\nthird', { breaks: true });
  assert.equal(counts.parse, sealed, 'the sealed text is a cache hit for the row model');
});

test('the live row renders uncached; once the turn seals it is cached like any other', () => {
  const { DevChat } = loadDevChat();
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat.messages = [
    { role: 'user', content: 'please change it', id: 1, created_at: '2026-09-25T00:00:00Z' },
    { role: 'assistant', content: 'working on it, so f', id: 2, created_at: '2026-09-25T00:00:01Z' },
  ];
  DevChat.isStreaming = true;
  DevChat._transcriptView();
  assert.ok(DevChat._mdCache.has('please change it'));
  assert.ok(!DevChat._mdCache.has('working on it, so f'), 'the growing reply is not cached');
  DevChat.isStreaming = false;
  DevChat._transcriptView();
  assert.ok(DevChat._mdCache.has('working on it, so f'), 'the sealed reply is');
});

// ── 2. Transcript rows: memoized by value, html by a steady wrapper ─────

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('every html sink in the transcript goes through one wrapper-memoizing component', () => {
  const code = stripComments(TRANSCRIPT_TSX);
  assert.doesNotMatch(code, /dangerouslySetInnerHTML=\{\{/, 'no inline { __html } object anywhere');
  assert.equal((code.match(/dangerouslySetInnerHTML=/g) || []).length, 1, 'one sink: Html');
  assert.match(code, /const inner = useMemo\(\(\) => \(\{ __html: html \}\), \[html\]\);/);
  // The live bubble included: a republish mid-turn must not rewrite the frame
  // the stream just painted.
  const live = code.slice(code.indexOf('function LiveContent('), code.indexOf('function Bubble('));
  assert.match(live, /<Html className="dc-msg-content" html=\{live \|\| html\} \/>/);
  assert.match(code, /const Row = memo\(function Row\(/);
  assert.match(code, /\}, sameRowProps\);/);
});

/** transcript.tsx bundled against a React whose useMemo the test can step. */
function loadTranscriptWithHooks() {
  const RealReact = require(require.resolve('react', { paths: [FRONTEND] }));
  const slots = [];
  let cursor = 0;
  const React = {
    ...RealReact,
    useMemo(fn, deps) {
      const i = cursor++;
      const slot = slots[i];
      if (slot && slot.deps.length === deps.length && slot.deps.every((d, k) => Object.is(d, deps[k]))) {
        return slot.value;
      }
      const value = fn();
      slots[i] = { deps, value };
      return value;
    },
  };
  const mod = loadTsx('frontend/src/features/dev-chat/transcript.tsx', { stubs: { react: React } });
  return { mod, render: (Component, props) => { cursor = 0; return Component(props); } };
}

test('an unchanged html string keeps the SAME { __html } object across renders', () => {
  const { mod, render } = loadTranscriptWithHooks();
  const a = render(mod.Html, { html: '<p>same</p>', className: 'dc-msg-content' });
  const b = render(mod.Html, { html: '<p>same</p>', className: 'dc-msg-content' });
  assert.equal(a.props.dangerouslySetInnerHTML, b.props.dangerouslySetInnerHTML,
    'React 19 reassigns innerHTML when this object is new');
  assert.equal(a.props.dangerouslySetInnerHTML.__html, '<p>same</p>');
  assert.equal(a.type, 'div');
  const c = render(mod.Html, { html: '<p>changed</p>', className: 'dc-msg-content' });
  assert.notEqual(c.props.dangerouslySetInnerHTML, a.props.dangerouslySetInnerHTML);
  assert.equal(c.props.dangerouslySetInnerHTML.__html, '<p>changed</p>');
  assert.equal(render(mod.Html, { as: 'span', html: 'x' }).type, 'span');
});

test('a row re-renders only when its model changed by value', () => {
  const { mod } = loadTranscriptWithHooks();
  const same = mod.Row.compare;
  assert.equal(typeof same, 'function', 'Row is memo()d with a comparator');
  const row = {
    t: 'attached', key: '12', details: { persistId: '12:ccrun', defaultOpen: true },
    icon: 'spinner', text: 'Claude Code is running', html: 'Claude Code is running',
    elapsed: { kind: 'since', since: 1000 }, stamp: '12 1000',
    progress: { current: 'Editing a.js', steps: 3, phase: 'edit', estimate: '', countdownTo: null, cohortSince: 1000 },
    body: { kind: 'log', persistId: '11:progress', text: 'one\ntwo' },
  };
  // `_transcriptView` rebuilds every model on every publish: identity never
  // survives, so the comparison has to be by value.
  const rebuilt = JSON.parse(JSON.stringify(row));
  assert.equal(same({ r: row }, { r: rebuilt }), true, 'a rebuilt, identical model skips the render');
  assert.equal(same({ r: row, embedded: false }, { r: rebuilt }), true, 'default props compare as their defaults');
  const grown = JSON.parse(JSON.stringify(row));
  grown.body.text += '\nthree';
  assert.equal(same({ r: row }, { r: grown }), false, 'a new log line renders');
  const stepped = JSON.parse(JSON.stringify(row));
  stepped.progress.steps = 4;
  assert.equal(same({ r: row }, { r: stepped }), false, 'a nested field renders');
  assert.equal(same({ r: row }, { r: rebuilt, embedded: true }), false);
  assert.equal(same({ r: row }, { r: rebuilt, historical: true }), false);
  const chips = { t: 'failure', key: 'f', text: 'stopped', stamp: '', tone: 'stopped', chips: ['a', 'b'] };
  assert.equal(same({ r: chips }, { r: { ...chips, chips: ['a'] } }), false, 'a shorter array renders');
  assert.equal(same({ r: chips }, { r: { ...chips, chips: ['a', 'c'] } }), false);
  assert.equal(same({ r: chips }, { r: { ...chips, forceStop: undefined } }), false, 'an added key renders');
});

// ── 3. Progress-driven republishes: at most one per frame ───────────────

function progressHarness(raf) {
  const els = { 'dc-messages': element('dc-messages') };
  const h = loadDevChat({ raf, els });
  h.DevChat.currentSession = { id: 7, status: 'active' };
  h.DevChat.isStreaming = true;
  h.DevChat.messages = [
    { role: 'system', content: 'Claude Code is running', _active: true, _slug: 's1', created_at: '2026-09-25T00:00:00Z' },
  ];
  return h;
}

test('a burst of progress lines, a poll and an estimate publish the transcript once, on the next frame', () => {
  const raf = frames();
  const { DevChat, counts, published } = progressHarness(raf);
  DevChat._appendProgressLine('clone');           // the first creates the row: a full, synchronous render
  assert.equal(counts.publishTranscript, 1);
  for (const line of ['checkout', 'read a.js', 'edit a.js', 'run tests']) DevChat._appendProgressLine(line);
  DevChat._replaceProgressLog(['clone', 'checkout', 'read a.js', 'edit a.js', 'run tests', 'commit']);
  DevChat._applyEstimate('about a minute', 60, { estimatedAt: Date.now() });
  assert.equal(counts.publishTranscript, 1, 'nothing published inside the frame');
  assert.equal(raf.pending(), 1, 'one frame queued for all of it');
  raf.flush();
  assert.equal(counts.publishTranscript, 2, 'one publish');
  const run = published.transcript.rows.find((r) => r.t === 'attached');
  assert.equal(run.body.text.split('\n').length, 6, 'carrying the latest log');
  assert.equal(run.progress.estimate, 'about a minute', 'and the latest guess');
});

test('a synchronous render supersedes a queued progress publish', () => {
  const raf = frames();
  const { DevChat, counts } = progressHarness(raf);
  DevChat._appendProgressLine('clone');
  DevChat._appendProgressLine('checkout');
  assert.equal(raf.pending(), 1);
  DevChat.renderMessages();
  assert.equal(counts.publishTranscript, 2);
  assert.equal(raf.pending(), 0, 'the queued frame is cancelled');
  raf.flush();
  assert.equal(counts.publishTranscript, 2);
});

test('without requestAnimationFrame a progress line publishes on the spot', () => {
  const { DevChat, counts } = progressHarness(null);
  DevChat._appendProgressLine('clone');
  DevChat._appendProgressLine('checkout');
  assert.equal(counts.publishTranscript, 2);
});

test('the other patch paths stay synchronous', () => {
  const body = (fn) => {
    const at = DEV_CHAT_SRC.indexOf(`  ${fn}(`);
    return DEV_CHAT_SRC.slice(at, DEV_CHAT_SRC.indexOf('\n  },', at));
  };
  assert.match(body('_syncActivityNode'), /DevChat\._publishTranscript\(\);/);
  assert.match(body('renderMessages'), /react\.publishTranscript\(DevChat\._transcriptView\(\)\)/);
  for (const fn of ['_patchProgressDom', '_clearEstimate', '_applyEstimate']) {
    assert.match(body(fn), /DevChat\._publishTranscriptSoon\(\);/, `${fn} is coalesced`);
  }
});

// ── 4. The scroll tracker binds once per node and follows once per frame ─

function scrollHarness(raf) {
  const els = { 'dc-messages': element('dc-messages') };
  const h = loadDevChat({ raf, els });
  h.els = els;
  h.count = (node, type) => node.listeners.filter((l) => l.type === type).length;
  h.fire = (node, type, ev = {}) => node.listeners.filter((l) => l.type === type).forEach((l) => l.fn(ev));
  return h;
}

const CONTENT = [{ type: 'childList', target: { tagName: 'DIV' } }];

test('initScrollTracking binds once per #dc-messages node, however often renderChatView runs', () => {
  const { DevChat, els, observers, count } = scrollHarness(frames());
  const first = els['dc-messages'];
  for (let i = 0; i < 5; i += 1) DevChat.initScrollTracking();
  assert.equal(observers.length, 1, 'one MutationObserver');
  assert.equal(observers[0].observed.length, 1);
  for (const type of ['click', 'keydown', 'scroll', 'touchstart', 'touchend']) {
    assert.equal(count(first, type), 1, `one ${type} listener`);
  }
  // A session switch remounts the view: a NEW node gets its own binding.
  els['dc-messages'] = element('dc-messages');
  DevChat.initScrollTracking();
  DevChat.initScrollTracking();
  assert.equal(observers.length, 2);
  assert.equal(observers[1].observed[0].node, els['dc-messages']);
  assert.equal(count(els['dc-messages'], 'click'), 1);
  assert.equal(count(first, 'click'), 1, 'and the old node gained nothing');
});

test('a burst of mutations and scrollToBottom calls is one instant write on the next frame', () => {
  const raf = frames();
  const { DevChat, els, observers } = scrollHarness(raf);
  const node = els['dc-messages'];
  DevChat.initScrollTracking();
  DevChat._lockedToBottom = true;
  for (let i = 0; i < 10; i += 1) observers[0].cb(CONTENT);
  DevChat.scrollToBottom();
  DevChat.scrollToBottom();
  assert.equal(raf.pending(), 1, 'one frame for all twelve');
  node.scrollHeight = 2400;
  raf.flush();
  assert.deepEqual(plain(node.scrolls), [{ top: 2400, behavior: 'instant' }],
    'instant, to the height at the frame, whatever the stylesheet says');
  // The reader's own disclosure toggle is still left alone.
  observers[0].cb([{ type: 'attributes', attributeName: 'open', target: { tagName: 'DETAILS' } }]);
  assert.equal(raf.pending(), 0);
});

test('the follow re-reads the lock and the reader\'s finger when its frame runs', () => {
  const raf = frames();
  const { DevChat, els, observers, fire } = scrollHarness(raf);
  const node = els['dc-messages'];
  DevChat.initScrollTracking();
  DevChat._lockedToBottom = true;

  observers[0].cb(CONTENT);
  DevChat._lockedToBottom = false; // the reader scrolled up before the frame
  raf.flush();
  assert.equal(node.scrolls.length, 0, 'an unlock in between wins');

  DevChat._lockedToBottom = true;
  fire(node, 'touchstart');
  observers[0].cb(CONTENT);
  raf.flush();
  assert.equal(node.scrolls.length, 0, 'no follow under a finger');
  fire(node, 'touchend', { touches: [] });
  observers[0].cb(CONTENT);
  raf.flush();
  assert.equal(node.scrolls.length, 1, 'following resumes when it lifts');

  // A touch whose end was lost (its target was replaced mid-touch) goes
  // stale rather than switching following off for good.
  fire(node, 'touchstart');
  DevChat._transcriptTouchAt = Date.now() - 5000;
  observers[0].cb(CONTENT);
  raf.flush();
  assert.equal(node.scrolls.length, 2, 'a stale touch no longer counts');

  DevChat._lockedToBottom = false;
  DevChat.scrollToBottom(true);
  raf.flush();
  assert.equal(node.scrolls.length, 3, 'a forced jump ignores the lock');
});

test('restoring a session\'s position stays an explicit instant jump', () => {
  const { DevChat, els } = scrollHarness(null);
  DevChat.currentSession = { id: 7 };
  DevChat.restoreSessionScroll();
  assert.deepEqual(plain(els['dc-messages'].scrolls), [{ top: 1000, behavior: 'instant' }]);
});

// ── 5. A keystroke publishes the composer only when what it draws changed ─

function composerHarness() {
  const els = {
    'dc-input': element('dc-input'),
    'dc-composer-bar': element('dc-composer-bar'),
  };
  const h = loadDevChat({ els });
  h.DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'claude_code' };
  h.input = els['dc-input'];
  return h;
}

test('typing that does not flip the circle publishes nothing', () => {
  const { DevChat, counts, input, published } = composerHarness();
  DevChat._renderComposer();
  assert.equal(counts.publishComposer, 1);
  let builds = 0;
  const build = DevChat._buildModelPickerView;
  DevChat._buildModelPickerView = (...a) => { builds += 1; return build(...a); };

  // Idle: the circle is Send whatever is typed.
  for (const v of ['a', 'al', 'als', 'also', 'also w']) { input.value = v; DevChat._syncSaveDraftBtn(); }
  assert.equal(counts.publishComposer, 1, 'five keystrokes, no publish');
  assert.equal(builds, 0, 'and no model-picker rebuild');

  // Mid-turn, the field decides between Stop and Save — THAT publishes.
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'claude');
  const afterTurn = counts.publishComposer;
  assert.equal(published.composer.send.kind, 'save', 'text in the box mid-turn is Save');
  for (const v of ['also wi', 'also wid', 'also wide']) { input.value = v; DevChat._syncSaveDraftBtn(); }
  assert.equal(counts.publishComposer, afterTurn, 'still Save: nothing to publish');
  input.value = '';
  DevChat._syncSaveDraftBtn();
  assert.equal(counts.publishComposer, afterTurn + 1, 'emptied: the circle flips to Stop');
  assert.equal(published.composer.send.kind, 'stop');
  input.value = 'n';
  DevChat._syncSaveDraftBtn();
  assert.equal(published.composer.send.kind, 'save', 'and back');
  assert.equal(counts.publishComposer, afterTurn + 2);
});

test('the model picker is memoized on its inputs, the session read field by field', () => {
  const { DevChat } = composerHarness();
  const a = DevChat._modelPickerView();
  assert.ok(a && a.options.length, 'a picker on the platform venue');
  assert.equal(DevChat._modelPickerView(), a, 'same inputs, same object');
  DevChat.currentSession.agent_model = 'z-ai/glm';
  DevChat.currentSession.agent_backend = 'codex_openrouter';
  const b = DevChat._modelPickerView();
  assert.notEqual(b, a, 'an in-place session edit is seen');
  assert.equal(b.selected, 'openrouter:z-ai/glm');
  DevChat._modelPickerChanging = true;
  assert.equal(DevChat._modelPickerView().changeDisabled, true);
  DevChat._modelPickerChanging = false;
  DevChat._modelPickerData = { models: [{ id: 'z-ai/glm', name: 'GLM', isRecommended: true }], codexAvailable: true };
  assert.match(DevChat._modelPickerView().options.map((o) => o.label).join('|'), /GLM/,
    'a new catalogue is a new list');
  DevChat.MODELS = { 'claude-x': { label: 'Claude X' } };
  assert.match(DevChat._modelPickerView().options.map((o) => o.label).join('|'), /Claude X/);
});

test('the drafts list is memoized on the stored string', () => {
  const { DevChat } = composerHarness();
  const empty = DevChat._savedDraftsView();
  assert.equal(DevChat._savedDraftsView(), empty);
  DevChat._setSavedDrafts(7, [{ id: 'd1', text: 'park this', synced: true }]);
  const one = DevChat._savedDraftsView();
  assert.notEqual(one, empty);
  assert.deepEqual(JSON.parse(JSON.stringify(one.rows)), [{ id: 'd1', text: 'park this' }]);
  assert.equal(DevChat._savedDraftsView(), one, 'unchanged storage, same object');
  DevChat.isStreaming = true;
  const busy = DevChat._savedDraftsView();
  assert.equal(busy.busy, true, 'the busy flag is part of the key');
  assert.notEqual(busy, one);
});
