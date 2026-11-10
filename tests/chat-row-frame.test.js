// A channel's rows in the one frame. A project's #general and its topics
// are drawn by the app chat's transcript (features/group-chat), whose row
// and day label are the shared primitives in frontend/@/components/ui/
// chat.tsx. Under one of the frame's looks those two emit the kit's post
// and day label (the tour's s31: "messages use the one message style shared
// by Messages and Homeroom bot"), so every look's rules for a conversation
// reach a channel as well. Under the standard look they are untouched.
//
// Run with: node --test tests/chat-row-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CHAT = 'frontend/@/components/ui/chat.tsx';
const FRAME = ['glass', 'brandkit', 'workbench', 'paper', 'pastel', 'mosaic', 'sunrise', 'today', 'playground'];
const skin = (look) => ({ '../../../src/lib/skin': { useLiveSkin: () => look, isFrameSkin: (s) => FRAME.includes(s) } });
const load = (look) => loadTsx(CHAT, { stubs: skin(look), cache: false });
const face = createElement('span', { className: 'h-11 w-11 rounded-xl', color: '#6fb3a8' }, 'E');
const row = (look, props, body = 'Hello there') => renderToHtml(createElement(load(look).ChatMessageRow, { name: 'evan', timestamp: '5:30 PM', avatar: face, 'data-msg-id': 7, ...props }, body));

test('under a look a channel\'s row is the kit\'s post: a face, the name and the time on one line, the words', () => {
  const html = row('glass', { className: 'gc-msg' });
  assert.equal(html, '<div class="fr-post gc-msg" data-msg-id="7"><span class="fr-av" style="--fr-as:32px;--fr-ac:#6fb3a8" aria-hidden="true">E</span><div class="fr-bd"><div class="fr-posthead"><span class="fr-who">evan</span><span class="fr-when">5:30 PM</span></div><div class="fr-txt">Hello there</div></div></div>');
});

test('your own row reads the same way round, and its controls keep their place at the end of the line', () => {
  const html = row('paper', { from: 'me', actions: createElement('button', { type: 'button' }, 'Edit') });
  assert.doesNotMatch(html, /flex-row-reverse|justify-end|items-end/);
  assert.match(html, /<span class="fr-when">5:30 PM<\/span><span class="fr-postacts"><button type="button">Edit<\/button><\/span><\/div>/);
});

test('the same person going on is the same post: no face, no name, the time kept for the gutter', () => {
  const html = row('glass', { grouped: true, gutter: createElement('span', null, '5:31') }, 'and another thing');
  assert.equal(html, '<div class="fr-post fr-postmore" data-grouped="" data-msg-id="7"><span class="fr-postgut gc-msg-gutter"><span>5:31</span></span><div class="fr-bd"><div class="fr-txt">and another thing</div></div></div>');
});

test('the bot\'s picture is the kit\'s tile, and a day\'s label the kit\'s', () => {
  const bot = row('glass', { avatar: createElement('img', { src: '/brand/homeroom-mark.png', alt: '' }) });
  assert.match(bot, /<span class="fr-tile" style="--fr-ts:32px;--fr-tc:#fff" aria-hidden="true"><img src="\/brand\/homeroom-mark\.png" alt=""/);
  assert.equal(renderToHtml(createElement(load('glass').DaySeparator, null, 'Yesterday')), '<div class="fr-day">Yesterday</div>');
});

test('the standard look, and the New look, keep the row as it was', () => {
  for (const look of ['standard', 'brand']) {
    const html = row(look, { className: 'gc-msg' });
    assert.match(html, /^<div class="flex gap-3 px-4 py-2 gc-msg" data-msg-id="7"><span class="h-11 w-11 rounded-xl"/);
    assert.doesNotMatch(html, /fr-/);
    assert.match(renderToHtml(createElement(load(look).DaySeparator, null, 'Yesterday')), /^<div class="py-3 text-center/);
  }
});

test('app.css gives a channel\'s posts the kit\'s spacing, and its page the kit\'s column', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\] \.fr-post\.gc-msg \{ padding: 8px 0; \}/);
  assert.match(hand, /html\[data-skin\] \.fr-post\.gc-msg \.gc-msg-content \{ font-size: inherit; color: inherit; \}/, 'the words are the kit\'s size, as in Messages');
  assert.match(hand, /html\[data-skin\] \.fr-post\.gc-msg:has\(\+ \.fr-postmore\) \{ padding-bottom: 0; \}/);
  assert.match(hand, /html\[data-skin\] \.fr-posthead \{ display: flex; align-items: baseline; min-width: 0; \}/);
});
