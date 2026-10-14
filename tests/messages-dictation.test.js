'use strict';

// #4389: speak to the bot — the composer's microphone button.
//
// The chat with Homeroom bot in Messages grows a microphone beside Send.
// Tapping it listens to the microphone and the spoken words land in the
// message box for review, exactly as if they had been typed; nothing sends
// by itself. Tapping again stops it, and so do typing, Send, a switch of
// conversation or thread, and the composer going away.
//
// What this pins:
//
//   1. The shared control itself (frontend/src/lib/use-dictation.ts): how
//      spoken words join a draft, when a browser counts as able, and the
//      recogniser's events — what the words do, what each failure means,
//      and what a stop or an unmount does to a live recogniser.
//   2. The composer's side: the button mounts only in the chat with the bot
//      and only once support is known (effects do not run in the cold
//      render, so neither the button nor a hint is in the prerendered
//      document); where it sits in the row; the three things that stop a
//      listen; the hint above the box and the failures under it.
//   3. The lit state is selected by the button's aria-pressed attribute in
//      app.css, not by a class the render computes; and the group chat's
//      composer — people, groups, channels — is untouched.
//   4. Every catalog id the change speaks resolves to the English text.
//
// Run with: node --test tests/messages-dictation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const SPEAK_BUTTON = read('frontend/src/features/messages/speak-button.tsx');
const GROUP_CHAT = read('frontend/src/features/group-chat/composer.tsx');
const CSS = read('public/css/app.css');
const CATALOG = JSON.parse(read('frontend/locales/en/messages.json'));

const DICTATION_IDS = ['start', 'stop', 'listening', 'unsupported', 'blocked', 'failed']
  .map((key) => `composer.dictation.${key}`);

// ── A React that answers the hook's five calls, effects included ───────
//
// The hook's behaviour IS its effects and its event handlers, which
// renderToStaticMarkup never runs. This is the fake React the dialog-suspend
// and bot-activity suites use, with useState and useCallback added: a state
// write re-renders the one mounted function, and the mount and unmount
// effects run for real.

function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let effects = [];
  let rendering = false;
  const changed = (prev, next) => !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  function runEffects() {
    const list = effects;
    effects = [];
    for (const run of list) run();
  }
  function render() {
    cursor = 0;
    effects = [];
    rendering = true;
    renderFn();
    rendering = false;
    runEffects();
  }
  const React = {
    useRef: (current) => slot(() => ({ current })),
    useState: (init) => {
      const cell = slot(() => {
        const held = { value: typeof init === 'function' ? init() : init };
        held.set = (next) => {
          held.value = typeof next === 'function' ? next(held.value) : next;
          if (!rendering) render();
        };
        return held;
      });
      return [cell.value, cell.set];
    },
    useCallback: (fn) => slot(() => fn),
    useEffect(effect, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
      if (!s.fresh && !changed(s.deps, deps)) return;
      s.fresh = false;
      s.deps = deps;
      effects.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
  };
  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    render,
    unmount() { for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
  };
}

// ── The recogniser the browser would hand the hook ─────────────────────

function fakeRecognisers(instances) {
  return class FakeRecogniser {
    constructor() {
      instances.push(this);
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.ended = false;
    }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    // An abort is the recogniser's session being torn down: it fires `end`
    // and says nothing more — no last phrase, however close it was.
    abort() {
      this.aborted = true;
      this.ended = true;
      if (this.onend) this.onend();
    }
    result(event) { if (!this.ended && this.onresult) this.onresult(event); }
    error(name) { if (!this.ended && this.onerror) this.onerror({ error: name }); }
    ends() { this.ended = true; if (this.onend) this.onend(); }
  };
}

/** Point `globalThis.window` at `win` for one test, and put it back after. */
function withWindow(t, win) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'window', saved);
    else delete globalThis.window;
  });
  globalThis.window = win;
}

// The hook, mounted against a fake browser that offers speech recognition.
// Every load evaluates a fresh module (tests/lib/render-tsx.js), so the
// visit-wide `service-not-allowed` flag below never leaks between tests.
function mountDictation(t, { lang = 'en', onText = () => {} } = {}) {
  const fake = createFakeReact();
  const mod = loadTsx('frontend/src/lib/use-dictation.ts', { stubs: { react: fake.React } });
  const instances = [];
  const Recogniser = fakeRecognisers(instances);
  withWindow(t, { SpeechRecognition: Recogniser });
  let current = null;
  fake.mount(() => { current = mod.useDictation({ lang, onText }); });
  return { mod, fake, instances, hook: () => current };
}

const interim = (text) => ({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, 0: { transcript: text } } } });
const final = (text) => ({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: text } } } });

/** The rendered markup with React's entities decoded, so catalog text compares. */
function plain(html) {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

// ── 1. The shared control ──────────────────────────────────────────────

test('joinDictation appends the spoken words to the draft, one space between', () => {
  const { joinDictation } = loadTsx('frontend/src/lib/use-dictation.ts');
  assert.equal(joinDictation('', 'hello there'), 'hello there', 'an empty box takes the words alone');
  assert.equal(joinDictation('Dear bot,', 'hello there'), 'Dear bot, hello there', 'a draft gains the words after it');
  assert.equal(joinDictation('Dear bot,  ', 'hello'), 'Dear bot, hello', 'the draft\'s trailing space is not doubled');
  assert.equal(joinDictation('Dear bot,', '  hello '), 'Dear bot, hello', 'the words are trimmed');
  assert.equal(joinDictation('Dear bot,', ''), 'Dear bot,', 'nothing heard leaves the draft');
  assert.equal(joinDictation('   ', ''), '', 'an empty draft and nothing heard is still empty');
});

test('a browser without speech recognition is not able; one with either name is', (t) => {
  // One save-and-restore for the whole test (withWindow); the variants swap
  // the object directly underneath it.
  withWindow(t, undefined);
  const supported = (win) => { globalThis.window = win; return loadTsx('frontend/src/lib/use-dictation.ts').dictationSupported(); };
  assert.equal(supported(undefined), false, 'no window, no dictation');
  assert.equal(supported({}), false, 'no recogniser, no dictation');
  assert.equal(supported({ SpeechRecognition: function R() {} }), true);
  assert.equal(supported({ webkitSpeechRecognition: function R() {} }), true);
});

test('the words heard since start reach onText: interim guesses, then the settled sentence', (t) => {
  const heard = [];
  const { instances, hook } = mountDictation(t, { onText: (...call) => heard.push(call) });
  assert.equal(hook().supported, true, 'support is read in an effect, and the effect has run');
  assert.equal(hook().ready, true);
  hook().start();
  assert.equal(instances.length, 1, 'start makes one recogniser');
  const rec = instances[0];
  assert.equal(rec.lang, 'en', 'the recogniser hears the language Homeroom is shown in');
  assert.equal(rec.continuous, true);
  assert.equal(rec.interimResults, true);
  assert.equal(hook().listening, true);
  assert.deepEqual(heard, [], 'nothing is reported before the recogniser says anything');
  rec.result(interim(' hel'));
  assert.deepEqual(heard, [['', ' hel']], 'a guess in progress: nothing settled yet, the guess alone');
  rec.result(final(' hello world'));
  assert.deepEqual(heard[1], ['hello world', ''], 'settled words land, the guess is gone');
  rec.result(final(' again'));
  assert.deepEqual(heard[2], ['hello world again', ''], 'a second sentence joins the first with one space');
});

test('a refused microphone reads as blocked, and the button stays offerable', (t) => {
  const { instances, hook } = mountDictation(t, {});
  hook().start();
  instances[0].error('not-allowed');
  assert.equal(hook().error, 'blocked');
  assert.equal(hook().supported, true, 'a permission can still be granted, so the button stays');
});

test('no speech is not a failure: the error stays empty', (t) => {
  const { instances, hook } = mountDictation(t, {});
  hook().start();
  instances[0].error('no-speech');
  assert.equal(hook().error, null);
  instances[0].ends();
  assert.equal(hook().listening, false, 'and the recogniser ending settles the listening state');
});

test('an unmount aborts a live recogniser', (t) => {
  const { instances, fake, hook } = mountDictation(t, {});
  hook().start();
  const rec = instances[0];
  fake.unmount();
  assert.equal(rec.aborted, true, 'the recogniser is told to stop');
  assert.equal(rec.stopped, undefined, 'by abort, which cannot deliver one more sentence');
});

test('a stop is an abort, not a finish: nothing unreviewed lands after it', (t) => {
  const heard = [];
  const { instances, hook } = mountDictation(t, { onText: (...call) => heard.push(call) });
  hook().start();
  const rec = instances[0];
  hook().stop();
  assert.equal(rec.aborted, true);
  assert.equal(rec.stopped, undefined, 'stop() on the recogniser would let the current phrase land');
  assert.equal(hook().listening, false);
  rec.result(final(' words after the stop'));
  assert.deepEqual(heard, [], 'the aborted recogniser reports nothing');
});

test('a refused speech service ends dictation for the whole visit', (t) => {
  const { mod, instances, hook } = mountDictation(t, {});
  hook().start();
  instances[0].error('service-not-allowed');
  assert.equal(hook().error, 'unsupported');
  assert.equal(hook().supported, false, 'this mount stops offering the button');
  assert.equal(mod.dictationSupported(), false, 'so does the visit');
  hook().start();
  assert.equal(instances.length, 1, 'start answers a visit-wide no without another recogniser');
});

test('other failures read as failed, and the words are not lost to the draft', (t) => {
  const heard = [];
  const { instances, hook } = mountDictation(t, { onText: (...call) => heard.push(call) });
  hook().start();
  instances[0].result(final(' one good sentence'));
  instances[0].error('network');
  assert.equal(hook().error, 'failed');
  assert.deepEqual(heard[0], ['one good sentence', ''], 'what was settled before the failure still reached the box');
});

// ── 2. The composer's side ─────────────────────────────────────────────

test('the cold render carries no dictation: no button and no hint', () => {
  // The real hook, a browser not probed yet: `supported` and `ready` are
  // false until the effect runs, and renderToStaticMarkup runs none.
  const html = composerHtml({ activeBot: true });
  assert.doesNotMatch(html, /messages-composer-speak/);
  assert.doesNotMatch(html, /data-dictation-hint/);
  assert.match(html, /<div class="messages-composer-card">/, 'the composer itself is all there');
});

test('in the chat with the bot, the microphone sits between the box and Send', () => {
  const html = composerHtml({ activeBot: true, dictation: { supported: true, ready: true } });
  const row = html.slice(html.indexOf('messages-composer-card'));
  const speak = row.indexOf('messages-composer-speak');
  const field = row.indexOf('messages-composer-input');
  const send = row.indexOf('messages-send');
  assert.ok(speak > 0, 'the button is there');
  assert.ok(speak > field && speak < send, 'after the box, before Send');
  assert.match(row, /<button type="button" class="messages-composer-action messages-composer-speak" aria-pressed="false"/);
  const label = message('messages:composer.dictation.start');
  assert.ok(row.includes(`aria-label="${label}"`), `the button names itself in words: ${label}`);
});

test('outside the chat with the bot there is no microphone and no hint', () => {
  const html = composerHtml({ activeBot: false, dictation: { supported: true, ready: true } });
  assert.doesNotMatch(html, /messages-composer-speak/);
  assert.doesNotMatch(html, /data-dictation-hint/);
  assert.doesNotMatch(html, /data-dictation-error/);
});

test('while listening, the button is pressed and the hint says how to stop', () => {
  const html = composerHtml({ activeBot: true, dictation: { supported: true, ready: true, listening: true } });
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-dictation-hint=""/);
  const expected = message('messages:composer.dictation.listening');
  assert.ok(html.includes(expected), `the hint is the catalog line: ${expected}`);
  const stopLabel = message('messages:composer.dictation.stop');
  assert.ok(html.includes(`aria-label="${stopLabel}"`), 'and the button asks to be tapped again by name');
});

test('a browser that cannot listen gets a word instead of a button', () => {
  const html = composerHtml({ activeBot: true, dictation: { supported: false, ready: true } });
  assert.doesNotMatch(html, /messages-composer-speak/);
  assert.match(html, /data-dictation-hint=""/);
  const expected = message('messages:composer.dictation.unsupported');
  assert.ok(plain(html).includes(expected), `the hint is the catalog line: ${expected}`);
});

test('the unsupported word waits for the answer: not ready, no hint', () => {
  // A stub that forgets `ready` — the first render's honest state — must
  // show neither the button nor the "not available" line.
  const html = composerHtml({ activeBot: true, dictation: { supported: false, ready: false } });
  assert.doesNotMatch(html, /messages-composer-speak/);
  assert.doesNotMatch(html, /data-dictation-hint/);
});

test('a refused microphone and a failed listen speak in the composer\'s error line', () => {
  for (const [kind, id] of [['blocked', 'composer.dictation.blocked'], ['failed', 'composer.dictation.failed']]) {
    const html = composerHtml({ activeBot: true, dictation: { supported: true, ready: true, error: kind } });
    assert.match(html, new RegExp(`data-dictation-error="${kind}"`));
    assert.ok(plain(html).includes(message(`messages:${id}`)), `the "${kind}" line is the catalog text`);
  }
});

test('a refused speech service answers once, not twice', () => {
  // `service-not-allowed` sets the error AND takes the button away; the
  // hint above the box must not repeat the error line below it.
  const html = composerHtml({ activeBot: true, dictation: { supported: false, ready: true, error: 'unsupported' } });
  const lines = html.split('<p').filter((part) => plain(part).includes(message('messages:composer.dictation.unsupported')));
  assert.equal(lines.length, 1, 'one line says the browser cannot listen');
});

// ── 3. What the source pins ────────────────────────────────────────────

test('the composer knows the bot chat and mounts the button under its support', () => {
  assert.match(COMPOSER, /const botChat = active\?\.kind === 'direct' && active\.homeroomBot === true;/);
  assert.match(COMPOSER, /botChat && dictation\.supported \? <SpeakButton listening=\{dictation\.listening\} onToggle=\{toggleDictation\} \/> : null/);
});

test('typing, Send and a conversation or thread switch all stop the listen', () => {
  // `onComposerChange` stops BEFORE it reads the value, so a keystroke that
  // arrives while listening cannot race the recogniser's next result.
  const change = COMPOSER.slice(COMPOSER.indexOf('function onComposerChange'), COMPOSER.indexOf('function insertChannel'));
  assert.match(change, /dictation\.stop\(\);\s*\n\s*const input = event\.target;/);
  const submit = COMPOSER.slice(COMPOSER.indexOf('function submit()'), COMPOSER.indexOf("if (!active || active.membershipStatus !== 'member') return null;"));
  assert.match(submit, /dictation\.stop\(\);/);
  const scopeEffect = COMPOSER.slice(COMPOSER.indexOf('setValue(draftFor(scope))'), COMPOSER.indexOf("}, [scope]);"));
  assert.match(scopeEffect, /dictation\.stop\(\);/, 'a switch of conversation or thread stops it too');
});

test('spoken words append to what was there, through updateValue\'s 8000 ceiling', () => {
  assert.match(COMPOSER, /const dictationBaseRef = useRef\(''\);/);
  assert.match(COMPOSER, /dictationBaseRef\.current = value;/, 'what was in the box is taken when dictation starts');
  assert.match(COMPOSER, /updateValue\(joinDictation\(dictationBaseRef\.current, joinDictation\(finalText, interimText\)\)\);/);
  assert.match(COMPOSER, /lang: getLanguage\(\),/, 'the recogniser hears the language Homeroom is shown in');
});

test('the hint is the composer\'s own hint line, above the box', () => {
  assert.match(COMPOSER, /className="messages-composer-hint" data-dictation-hint=""/);
  assert.match(COMPOSER, /t\('messages:composer\.dictation\.listening'\)/);
  assert.match(COMPOSER, /t\('messages:composer\.dictation\.unsupported'\)/);
  assert.match(COMPOSER, /!inThread && !value/, 'the unsupported word shows while the box is empty, not in a thread');
});

test('the button keeps a constant class and lets the attribute light it', () => {
  assert.match(SPEAK_BUTTON, /className="messages-composer-action messages-composer-speak"/);
  assert.doesNotMatch(SPEAK_BUTTON, /className=\{/, 'nothing in the render computes a class string');
  assert.match(SPEAK_BUTTON, /aria-pressed=\{listening\}/);
  assert.match(SPEAK_BUTTON, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/,
    'a tap does not take the field\'s focus, the same contract Send is on');
});

test('app.css lights the listening button by the attribute it already carries', () => {
  assert.match(CSS, /\.messages-composer-speak\[aria-pressed="true"\] \{/);
  assert.match(CSS, /@keyframes messages-speak-pulse \{/);
  const lit = CSS.indexOf('messages-speak-pulse 1.6s');
  const reduce = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)', lit));
  const block = reduce.slice(0, reduce.indexOf('\n}\n'));
  assert.match(block, /\.messages-composer-speak\[aria-pressed="true"\] \{ animation: none; \}/,
    'a person who said no to motion keeps the lit state without the breathing');
});

test('the group chat\'s composer — people, groups, channels — is untouched', () => {
  assert.doesNotMatch(GROUP_CHAT, /use-dictation|SpeakButton|MicrophoneIcon|messages-composer-speak/);
});

// ── 4. The words the change speaks ─────────────────────────────────────

test('every dictation line is a catalog entry with text and a description', () => {
  for (const id of DICTATION_IDS) {
    const entry = CATALOG[id];
    assert.ok(entry, `messages.json defines ${id}`);
    assert.ok(entry.text && entry.text.length > 0, `${id} has text`);
    assert.ok(entry.description && entry.description.length > 0, `${id} says where it appears`);
    assert.equal(message(`messages:${id}`), entry.text, `${id} resolves to the same English the render shows`);
  }
});

// ── The rendered composer ──────────────────────────────────────────────

function composerHtml({ activeBot = true, dictation = null } = {}) {
  const snap = {
    route: { conversationId: 42 },
    active: {
      id: 42, kind: 'direct', homeroomBot: activeBot || undefined, title: 'homeroom',
      membershipStatus: 'member', myRole: 'member', members: [], memberCount: 2,
      canSend: true, awaitingAcceptance: false,
    },
    messages: [], conversations: [], discussions: [],
  };
  const store = {
    channels: () => [], draftFor: () => '', notifyTyping() {}, replyFor: () => null,
    scopeKey: (c, t) => (t ? `${c}:t${t}` : c), send: async () => {}, setDraft() {}, setReply() {},
    takePendingShare: () => undefined, useMessagesSnapshot: () => snap,
  };
  const stubs = {
    './store': store,
    './api': {},
    '../friends/store': { orderFriendsFirst: (list) => list, useFriendIds: () => [] },
    '../../lib/use-auto-grow': { useAutoGrow() {} },
  };
  if (dictation) {
    stubs['../../lib/use-dictation'] = {
      dictationSupported: () => !!dictation.supported,
      joinDictation: (base, heard) => `${base} ${heard}`.trim(),
      useDictation: () => ({
        supported: false, ready: false, listening: false, error: null,
        start() {}, stop() {}, ...dictation,
      }),
    };
  }
  const { MessageComposer } = loadTsx('frontend/src/features/messages/composer.tsx', { stubs });
  return renderToHtml(createElement(MessageComposer, {}));
}
