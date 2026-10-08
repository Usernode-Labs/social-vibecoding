'use strict';

// #4389: say the message instead of typing it, in the Homeroom bot's DM.
//
// The Messages composer gains a microphone button between the message box
// and Send, drawn only in the Homeroom bot's direct message and only where
// the browser can turn speech into text (lib/speech-input.ts, the shared
// helper the make screen's speak button, #4385, reuses later). Dictated text
// fills the box through the same `updateValue` a typed keystroke uses, so
// the 8000 cap, the draft and the typing ping are the same, and the person
// sends as usual: nothing is sent on its own.
//
// What this pins:
//
//   1. `joinDictation` — what was already in the box, plus what was said,
//      once, with one space when the base lacks a trailing one.
//   2. `speechRecognitionCtor` — either constructor name, and null where
//      the browser has neither (so the button hides instead of erroring).
//   3. The composer's wiring, by source and by render: the button is gated
//      on `homeroomBot === true` and `speech.supported`, sits between the
//      textarea and Send, carries `aria-pressed` and both of its names, and
//      a send cancels the dictation so a late result cannot refill the box.
//   4. `supported` starts false and is set in an effect, so the first
//      markup matches the server prerender (no hydration mismatch).
//
// Run with: node --test tests/messages-composer-speak.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const HELPER = read('frontend/src/lib/speech-input.ts');

// ── 1. joinDictation ───────────────────────────────────────────────────

const speech = () => loadTsx('frontend/src/lib/speech-input.ts');

test('joinDictation adds the spoken words after what was typed, with one space', () => {
  const { joinDictation } = speech();
  assert.equal(joinDictation('Make a list app', 'for my book club'), 'Make a list app for my book club',
    'a base without a trailing space gets one');
  assert.equal(joinDictation('Make a list app ', 'for my book club'), 'Make a list app for my book club',
    'a base with a trailing space does not get a second');
  assert.equal(joinDictation('', 'for my book club'), 'for my book club', 'an empty base is just the words');
  assert.equal(joinDictation('Make a list app', '  '), 'Make a list app', 'blank spoken text leaves the base alone');
  assert.equal(joinDictation('', '  '), '', 'blank spoken text on an empty base stays empty');
});

// ── 2. speechRecognitionCtor ───────────────────────────────────────────

test('speechRecognitionCtor finds either constructor name, and nothing without one', () => {
  const { speechRecognitionCtor } = speech();
  const webkit = function FakeWebKit() {};
  const unprefixed = function FakeUnprefixed() {};
  assert.equal(speechRecognitionCtor({ webkitSpeechRecognition: webkit }), webkit,
    'a webkit-prefixed browser (the shots browser among them) is speakable');
  assert.equal(speechRecognitionCtor({ SpeechRecognition: unprefixed }), unprefixed,
    'an unprefixed browser is speakable');
  assert.equal(speechRecognitionCtor({}), null, 'a browser with neither is not');
  assert.equal(speechRecognitionCtor(), null, 'and outside a browser (server render) there is no button');
});

// ── 3. The composer's wiring ───────────────────────────────────────────

test('the button is drawn only in the Homeroom bot\'s DM, and only where speech is supported', () => {
  // The gate reads both facts; a channel, group or other DM never renders it.
  assert.match(COMPOSER, /const speakable = active\?\.kind === 'direct' && active\.homeroomBot === true;/);
  assert.match(COMPOSER, /speakable && speech\.supported \? <button type="button" className="messages-composer-action messages-composer-speak"/);
  // The speak button's class string is not exactly "messages-composer-action",
  // so the add-menu test's count of the exact string stays one ("+").
  const exact = COMPOSER.match(/className="messages-composer-action"/g) || [];
  assert.equal(exact.length, 1, 'the exact string stays the "+"\'s alone');
});

test('the button sits between the message box and Send, with its two names', () => {
  const row = COMPOSER.slice(COMPOSER.indexOf('<div className="flex items-end gap-1.5">'));
  const field = row.indexOf('className="messages-composer-input"');
  const speak = row.indexOf('messages-composer-speak');
  const send = row.indexOf('className="messages-send"');
  assert.ok(field > 0 && field < speak && speak < send, 'textarea, speak button, send, in that order');
  assert.match(row, /aria-pressed=\{speech\.listening\}/);
  assert.match(row, /aria-label=\{speech\.listening \? 'Stop speaking' : 'Speak your message'\}/);
  assert.match(row, /title=\{speech\.listening \? 'Stop speaking' : 'Speak your message'\}/);
  assert.match(row, /<MicrophoneIcon aria-hidden="true" \/>/);
  // Pressing it never steals focus from the field (the Send button's iOS reason).
  assert.match(row, /messages-composer-speak" onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
});

test('a send cancels the dictation, so a late result cannot refill the emptied box', () => {
  const fn = COMPOSER.slice(COMPOSER.indexOf('function submit()'));
  assert.match(fn, /speech\.cancel\(\);\s*\n\s*if \(uploading/, 'submit() cancels first');
  // And a change of conversation or thread stops it too.
  const scopeEffect = COMPOSER.slice(COMPOSER.indexOf('setValue(draftFor(scope))'));
  assert.match(scopeEffect, /cancelSpeech\(\);/);
});

test('the dictated text goes through the same updateValue a typed keystroke uses', () => {
  assert.match(COMPOSER, /const speech = useSpeechInput\(\{\s*\n\s*onText: updateValue,/);
  // And the words the caller picks for the two error kinds.
  assert.match(COMPOSER, /Homeroom can’t use your microphone\. Allow it in your browser’s settings to speak your message\./);
  assert.match(COMPOSER, /Couldn’t hear that\. Try again, or type your message\./);
  assert.match(COMPOSER, /speech\.listening \? 'Listening…' : \(inThread \? 'Reply in thread…' : \(prompt \|\| 'Message…'\)\)/,
    'the empty box says Listening… while it listens');
});

// ── 4. The first render matches the server prerender ───────────────────

test('supported starts false and is set in an effect, so the first markup matches the prerender', () => {
  assert.match(HELPER, /const \[supported, setSupported\] = useState\(false\);/);
  const effect = HELPER.slice(HELPER.indexOf('useEffect(() => {\n    setSupported('));
  assert.ok(effect.length > 0, 'supported is set in an effect, not during render');
  // The hook is called above the early returns, like every other one here.
  const earlyReturn = COMPOSER.indexOf("if (!active || active.membershipStatus !== 'member') return null;");
  assert.ok(COMPOSER.indexOf('useSpeechInput({') > 0 && COMPOSER.indexOf('useSpeechInput({') < earlyReturn,
    'the hook runs before the composer can return nothing');
});

// ── 5. The rendered button ─────────────────────────────────────────────

/** The composer rendered in the Homeroom bot's DM, with the hook's answer stubbed. */
function botDmHtml(speechState) {
  const snap = {
    route: { conversationId: 7 },
    active: { id: 7, kind: 'direct', title: 'Homeroom bot', membershipStatus: 'member', myRole: 'member', members: [], memberCount: 2, canSend: true, awaitingAcceptance: false, homeroomBot: true },
    messages: [], conversations: [], discussions: [],
  };
  const store = {
    channels: () => [], draftFor: () => '', notifyTyping() {}, replyFor: () => null,
    scopeKey: (c, t) => (t ? `${c}:t${t}` : c), send: async () => {}, setDraft() {}, setReply() {},
    takePendingShare: () => undefined, takePendingAttach: () => undefined, useMessagesSnapshot: () => snap,
  };
  const { MessageComposer } = loadTsx('frontend/src/features/messages/composer.tsx', {
    stubs: {
      './store': store,
      './api': {},
      '../friends/store': { orderFriendsFirst: (list) => list, useFriendIds: () => [] },
      '../../lib/use-auto-grow': { useAutoGrow() {} },
      '../../lib/speech-input': { useSpeechInput: () => speechState },
    },
  });
  return renderToHtml(createElement(MessageComposer, {}));
}

const atRest = { supported: true, listening: false, start() {}, stop() {}, cancel() {} };
const listening = { supported: true, listening: true, start() {}, stop() {}, cancel() {} };

test('in the Homeroom bot\'s DM the resting button renders between the box and Send', () => {
  const html = botDmHtml(atRest);
  const speak = /<button type="button" class="messages-composer-action messages-composer-speak"[^>]*aria-pressed="false"[^>]*aria-label="Speak your message"/.exec(html);
  assert.ok(speak, 'the resting button carries aria-pressed="false" and its name');
  const field = html.indexOf('<textarea');
  const send = html.indexOf('class="messages-send"');
  assert.ok(field > 0 && field < html.indexOf('messages-composer-speak') && html.indexOf('messages-composer-speak') < send,
    'textarea, speak button, send, in that order, in the rendered HTML');
  assert.match(html, /placeholder="Message…"/, 'at rest the box keeps its usual placeholder');
});

test('while it listens the button is pressed, renamed, and the box says Listening…', () => {
  const html = botDmHtml(listening);
  assert.match(html, /class="messages-composer-action messages-composer-speak"[^>]*aria-pressed="true"[^>]*aria-label="Stop speaking"/);
  assert.match(html, /placeholder="Listening…"/);
});

test('a browser without speech support, or any other chat, renders no button', () => {
  const noSupport = botDmHtml({ ...atRest, supported: false });
  assert.doesNotMatch(noSupport, /messages-composer-speak/, 'no button where the browser cannot listen');
  assert.match(noSupport, /placeholder="Message…"/, 'and the composer looks as it does today');
});

test('the icon lives in the shared set, not drawn inline in the feature', () => {
  assert.match(read('frontend/@/components/ui/icons.tsx'), /export const MicrophoneIcon = stroked\('MicrophoneIcon',/);
});
