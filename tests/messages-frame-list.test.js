// The Messages list in the one frame (frontend/src/features/messages/frame-
// list.tsx), as the 2026-11-06 screen tour draws it (s15, s20): the page's
// head, People and Agents as the page's tabs, a search, then the
// conversations as the kit's one row. It is the product's own list (./index
// .tsx ConversationList) with another face: the pane builds each row from
// the conversations and words it already has and hands them in.
//
// Run with: node --test tests/messages-frame-list.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const LIST = 'frontend/src/features/messages/frame-list.tsx';
const PANE = 'frontend/src/features/messages/index.tsx';

const row = (key, title, over) => ({
  key, section: 'people', lead: null, title, line: 'ignore', time: '4d ago', fresh: null, status: null, active: false,
  href: `#messages/${key}`, onClick() {}, ...over,
});
const base = {
  rows: [
    row('4', 'evan', { active: true }),
    row('9', 'Evan / Lukas / Salah / Drea', { line: 'evan: going to make some changes', fresh: '2 new' }),
    row('12', 'Bruno', { line: 'test (edit)', time: '14 Aug' }),
    row('agent:a1', 'Simplify the admin console', { section: 'agents', line: 'Homeroom · 29 Oct', time: '29 Oct', status: { text: 'Live', kind: 'ok' } }),
    row('agent:a2', 'Call a spec a plan', { section: 'agents', line: 'Homeroom · 9 Oct', time: '9 Oct' }),
  ],
  tab: 'people', onTab() {}, query: '', onQuery() {}, onNew() {}, loaded: true,
};
const render = (over) => renderComponent(LIST, 'MessagesFrameList', { ...base, ...over }, { cache: false });

test('the list is the kit\'s pane: the head with one sentence and one action, two tabs, a search', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-pane" data-messages-frame-list=""><div class="fr-scroll"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Messages<\/h1><p class="fr-purpose">People and groups you talk to\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn"><svg[^>]*>.*?<\/svg>New message<\/button><\/div><\/div>/s);
  assert.match(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">People<span class="fr-n">1<\/span><\/button><button type="button" class="fr-tab" aria-pressed="false">Agents<\/button>/,
    'People says how many conversations hold something new; Agents says nothing');
  assert.match(html, /placeholder="Search people and messages"/);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('a conversation with something new ends in the blue pill, the others in a grey time', () => {
  const html = render();
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['evan', 'Evan / Lukas / Salah / Drea', 'Bruno'],
    'People holds the conversations, in the order the pane hands them');
  assert.match(html, /<span class="fr-t">Evan \/ Lukas \/ Salah \/ Drea<\/span><span class="fr-s">evan: going to make some changes<\/span><\/span><span class="fr-pill fr-act" data-kind="act">2 new<\/span>/);
  assert.match(html, /<span class="fr-t">Bruno<\/span><span class="fr-s">test \(edit\)<\/span><\/span><span class="fr-meta">14 Aug<\/span>/);
  assert.equal((html.match(/data-kind="act"/g) || []).length, 1, 'blue only where something waits');
});

test('the open conversation\'s row is lit, and every row is a link to its own address', () => {
  const html = render();
  assert.match(html, /<a class="fr-row fr-on" href="#messages\/4" aria-current="page">/);
  assert.equal((html.match(/<a class="fr-row/g) || []).length, 3);
  assert.equal((html.match(/class="fr-row fr-on"/g) || []).length, 1);
});

test('Agents is the second tab: its own sentence, its own search, the chats counted, each status one word', () => {
  const html = render({ tab: 'agents' });
  assert.match(html, /<p class="fr-purpose">Older chats with coding agents\. New work with the bot is in the Homeroom bot tab\.<\/p>/);
  assert.match(html, /placeholder="Search agent chats"/);
  assert.match(html, /<button type="button" class="fr-tab fr-on" aria-pressed="true">Agents<\/button>/);
  assert.match(html, /<h2 class="fr-cap">2 older chats<\/h2>/, 'the group says how many there are');
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['Simplify the admin console', 'Call a spec a plan']);
  assert.match(html, /<span class="fr-s">Homeroom · 29 Oct<\/span><\/span><span class="fr-pill fr-ok" data-kind="ok">Live<\/span>/, 'a status is the pill of its kind');
  assert.match(html, /<span class="fr-s">Homeroom · 9 Oct<\/span><\/span><span class="fr-meta">9 Oct<\/span>/, 'no status: the grey time');
  assert.equal(message('messages:frame.inbox.agentsCount_one').replace('{{count}}', '1'), '1 older chat');
});

test('a tab with nothing says so once the list has been read, and says nothing before', () => {
  assert.match(render({ rows: [], loaded: true }), /<div class="fr-card fr-pad">Nothing here yet\.<\/div>/);
  assert.doesNotMatch(render({ rows: [], loaded: false }), /Nothing here yet/);
});

test('the list pane hands its own conversations to the kit list under a look, and only then', () => {
  const src = read(PANE);
  assert.match(src, /const frame = isFrameSkin\(useSkin\(\)\);/);
  assert.match(src, /if \(frame\) \{[\s\S]*?<MessagesFrameList[\s\S]*?onNew=\{\(\) => startNew\('direct'\)\}/, 'New message is the pane\'s own way to start one');
  assert.match(src, /color=\{swatchFor\(face\?\.username \|\| name \|\| '\?'\)\}/, 'a person with no picture wears the colour they wear everywhere');
  assert.match(src, /const face = c\.kind === 'group' && !invited\s+\? c\.members\.find\(\(member\) => member\.status === 'member' && Number\(member\.id\) !== me\) \|\| null\s+: peer;/,
    'a group wears the face of someone in it who is not you');
  assert.match(src, /data-frame-list=""/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\] \.messages-list-pane\[data-frame-list\] \{ flex: 0 0 520px; width: 520px; \}/, 'the list is the split\'s 520px pane');
  assert.match(css, /html\[data-skin\] \.messages-layout:has\(> \[data-frame-list\]\) > \.messages-thread-pane \{[^}]*border-inline-start: 1px solid var\(--fr-line\);/, 'one line between the two panes');
});
