'use strict';

// #4389: a speak button in the Homeroom bot's chat composer — press, say the
// message, and the words land in the field to review and send as usual.
//
// Source-level, like tests/messages-composer-add-menu.test.js beside it: the
// composer needs a live conversation and the messages store to render, and
// what this pins is the SHAPE of the feature (which chat gets the button,
// what hides it, its labels and states) plus the shared helper and the CSS
// that fills the disc while it listens.
//
// Run with: node --test tests/messages-composer-speak.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const HELPER = read('frontend/src/lib/speech-input.ts');
const ICONS = read('frontend/@/components/ui/icons.tsx');
const CSS = read('public/css/app.css');

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('the button is gated on the Homeroom bot direct conversation', () => {
  // The server sets `homeroomBot: true` only on the accepted direct chat with
  // the bot, so this one condition covers the Messages pane and the full-screen
  // DM — and everything else (channels, groups, other DMs, agent chats) fails it.
  assert.match(COMPOSER, /active\.kind === 'direct' && !!active\.homeroomBot/);
});

test('a browser without speech support renders no button', () => {
  // The feature check comes from the shared helper at render time; the
  // composer must not draw the control when it answers false.
  assert.match(COMPOSER, /speechInputSupported\(\)/);
  assert.match(COMPOSER, /\{speechReady \? \(/, 'the button sits behind the support check');
});

test('the helper is the shared lib module, not composer-local code', () => {
  // The make screen's speak button (#4385) adopts the same helper, so the
  // browser-specific parts live in lib/speech-input.ts and the composer
  // imports them rather than re-deriving them.
  assert.match(HELPER, /export function speechInputSupported/);
  assert.match(HELPER, /export function startSpeechInput/);
  assert.match(HELPER, /webkitSpeechRecognition/, 'it knows both constructor names');
  assert.match(COMPOSER, /from '\.\.\/\.\.\/lib\/speech-input'/);
});

test('the helper maps the browser error codes to sentences', () => {
  assert.match(HELPER, /Microphone access was declined\./);
  assert.match(HELPER, /Nothing was heard\. Try again\./);
  assert.match(HELPER, /Speaking didn’t work\. Try again\./);
});

test('the dictation is only ever reported, never sent', () => {
  // Phrases land in the field through the composer's own `updateValue` — the
  // cap, the draft store and the typing notice behave as for typed text — and
  // sending stays the send disc's job.
  const speech = COMPOSER.slice(COMPOSER.indexOf('function toggleSpeech'), COMPOSER.indexOf('function submit()'));
  assert.match(speech, /updateValue\(/);
  assert.ok(!/\bsend\(/.test(speech), 'no send in the dictation path');
});

test('the labels are "Speak your message" and "Stop speaking", the placeholder "Listening…"', () => {
  assert.match(COMPOSER, /'Speak your message'/);
  assert.match(COMPOSER, /'Stop speaking'/);
  assert.match(COMPOSER, /listening \? 'Listening…'/);
  assert.match(COMPOSER, /is-listening/, 'listening is also a class of the button');
});

test('the mic is the shared icon, not an inline svg', () => {
  // tests/shell-icon-set.test.js allows no svg tags in the features: the glyph
  // is a named component of the shell's set, like every other icon.
  assert.match(ICONS, /export const MicrophoneIcon = stroked\(/);
  assert.match(COMPOSER, /<MicrophoneIcon aria-hidden="true" \/>/);
  const row = COMPOSER.slice(COMPOSER.indexOf('speechReady ? ('), COMPOSER.indexOf('className="messages-send"'));
  assert.ok(!/<svg/.test(row), 'no inline svg in the composer row');
});

test('the listening disc borrows the send disc\'s accent', () => {
  const body = rule('.messages-composer-action.is-listening');
  assert.match(body, /background: var\(--accent\);/);
  assert.match(body, /color: var\(--accent-ink\);/);
});

test('dictation ends with the conversation', () => {
  // The session is stopped in the same cleanup that stops the typing notice:
  // leaving the conversation, or unmounting a thread composer, must not leave
  // a microphone open.
  const cleanup = COMPOSER.slice(COMPOSER.indexOf('if (typingStop.current) window.clearTimeout'), COMPOSER.indexOf('}, [conversationId])'));
  assert.match(cleanup, /speech\.current\?\.stop\(\)/);
});
