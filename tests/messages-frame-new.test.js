// New message in the one frame (frontend/src/features/messages/frame-new
// .tsx), as the 2026-11-06 screen tour draws it (s16): the standard sheet
// over the inbox, one field, the people as rows, and one button that names
// what happens. One person is a direct message; more make a group, named
// after the people in it (a name can be changed from the group's own menu).
//
// Run with: node --test tests/messages-frame-new.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent, loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const SHEET = 'frontend/src/features/messages/frame-new.tsx';

const EVAN = { id: 8, username: 'evan', avatarUrl: null };
const BRUNO = { id: 9, username: 'Bruno', avatarUrl: null };
const LUKAS = { id: 10, username: 'Lukas', avatarUrl: '/u/10.png' };
const base = {
  query: '', onQuery() {}, picked: [], people: [EVAN, BRUNO, LUKAS], searching: false, onToggle() {}, onUnpick() {},
  busy: false, error: '', onStart() {}, onClose() {}, blocked: null, onBlocked() {}, onUnblock() {},
};
const stubs = { './store': { createDirect() {}, createGroup() {}, setUserBlocked() {}, useMessagesSnapshot: () => ({ conversations: [] }) }, './api': { searchUsers: async () => [], listBlocks: async () => [] } };
const render = (over) => renderComponent(SHEET, 'NewMessageSheetView', { ...base, ...over }, { cache: false, stubs });

test('it is the standard sheet: the title, one sentence, one field, the people, one button', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-ovhost"><div class="fr-ov"><div class="fr-sheet" role="dialog" aria-modal="true"/);
  assert.match(html, /<h2 class="fr-title" id="[^"]+">New message<\/h2><p class="fr-purpose">One person is a direct message\. Add more to make a group\.<\/p>/);
  assert.match(html, /<div class="fr-card"><div class="fr-fields"><div class="fr-field"><label for="([^"]+)">To<\/label><div class="fr-inp"><svg[^>]*>.*?<\/svg><input id="\1" class="fr-v" type="text" autoComplete="off" placeholder="Search by username" autofocus="" value=""\/><\/div><\/div><\/div><\/div>/s);
  assert.match(html, /<h2 class="fr-cap">People you talk to<\/h2>/);
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['evan', 'Bruno', 'Lukas']);
  assert.match(html, /<button type="button" class="fr-btn fr-block fr-off" disabled=""><svg[^>]*>.*?<\/svg>Start chat<\/button>/s, 'nothing to start until somebody is picked');
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('a picked person is in the field and their row is lit; the button is ready', () => {
  const html = render({ picked: [EVAN], query: 'br' });
  assert.match(html, /<div class="fr-inp fr-val"><svg[^>]*>.*?<\/svg><span>evan<\/span><input id="[^"]+" class="fr-v" type="text" autoComplete="off" placeholder="" autofocus="" value="br"\/>/s,
    'the field reads as the tour\'s: the names, then what is being typed');
  assert.match(html, /<button type="button" class="fr-row fr-sm fr-on" aria-pressed="true"><span class="fr-av"[^>]*>e<\/span><span class="fr-tx"><span class="fr-t">evan<\/span><\/span><\/button>/);
  assert.match(html, /<button type="button" class="fr-row fr-sm" aria-pressed="false"><span class="fr-av"[^>]*>B<\/span>/);
  assert.match(html, /<button type="button" class="fr-btn fr-block"><svg/);
  assert.match(html, /<h2 class="fr-cap">People<\/h2>/, 'while searching the group is what was found');
});

test('it says when it is searching, when nobody matches, and what went wrong', () => {
  assert.match(render({ query: 'zz', people: [], searching: true }), /<div class="fr-card fr-pad">Searching…<\/div>/);
  assert.match(render({ query: 'zz', people: [] }), /<div class="fr-card fr-pad">No matching people\.<\/div>/);
  assert.doesNotMatch(render({ people: [] }), /fr-cap/, 'nobody talked to yet: no empty group');
  assert.match(render({ query: 'zz', people: [], picked: [EVAN] }), /<span class="fr-t">evan<\/span>.*<div class="fr-card fr-pad">No matching people\.<\/div>/s,
    'with somebody picked already, a search that finds nobody still says so');
  assert.match(render({ error: 'That person cannot be messaged.' }), /<div class="fr-note fr-bad"[^>]*><svg[^>]*>.*?<\/svg><div>That person cannot be messaged\.<\/div><\/div>/s);
  assert.match(render({ busy: true, picked: [EVAN] }), /class="fr-btn fr-block fr-off" disabled=""/);
});

test('blocked people stay reachable from the sheet\'s foot', () => {
  assert.match(render(), /<div class="fr-foot"><button type="button" class="fr-link">Blocked people<\/button><\/div>/);
  const open = render({ blocked: [BRUNO] });
  assert.match(open, /<h2 class="fr-cap">Blocked people<\/h2>.*?<span class="fr-t">Bruno<\/span>.*?<button type="button" class="fr-btn fr-quiet fr-sm">Unblock<\/button>/s);
  assert.match(render({ blocked: [] }), /<div class="fr-card fr-pad">Nobody is blocked\.<\/div>/);
});

test('one person starts a direct message, more a group named after the people in it', () => {
  const { groupTitle } = loadTsx(SHEET, { stubs, cache: false });
  assert.equal(groupTitle('snait', [EVAN, BRUNO]), 'snait / evan / Bruno');
  assert.equal(groupTitle('', [EVAN, BRUNO]), 'evan / Bruno');
  const many = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, username: `person_number_${i}` }));
  assert.ok(groupTitle('snait', many).length <= 80, 'within the 80 characters a group\'s name may have');
  assert.match(groupTitle('snait', many), /…$/);
  const src = read(SHEET);
  assert.match(src, /picked\.length === 1\s*\? await createDirect\(picked\[0\]\.id\)\s*: await createGroup\(groupTitle\(/);
});

test('under a look New message opens the sheet, in place of the standard dialog', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /onNew=\{\(\) => setFrameNew\(true\)\}/);
  assert.match(pane, /\{frameNew \? <NewMessageSheet known=\{known\} onClose=\{\(\) => setFrameNew\(false\)\} \/> : null\}/);
  assert.match(pane, /const person = c\.kind === 'direct' && !c\.homeroomBot \? directPerson\(c\) : null;/, 'its people: those already talked to, the bot left out');
});

test('an agent chat, the other kind the standard dialog starts, is a row under the people until somebody is picked', () => {
  const html = render({ onAgent() {} });
  assert.match(html, /<h2 class="fr-cap">Or else<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Agent chat<\/span><span class="fr-s">Plan and build a change with a coding agent<\/span><\/span><svg class="fr-ic fr-go"/s);
  assert.doesNotMatch(render({ onAgent() {}, picked: [EVAN] }), /Agent chat/, 'a picked person means a message');
  assert.doesNotMatch(render({ onAgent() {}, query: 'ev' }), /Agent chat/, 'nor while searching');
  assert.doesNotMatch(render(), /Agent chat/, 'nothing without the entry');
  const src = read(SHEET);
  assert.match(src, /onAgent=\{\(\) => \{ onClose\(\); void startAgentSession\(\{ entry: 'messages' \}\); \}\}/, 'the same start the standard dialog makes');
});
