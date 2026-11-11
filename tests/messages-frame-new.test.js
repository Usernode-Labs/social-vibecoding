// New message in the one frame (frontend/src/features/messages/frame-new
// .tsx), version 2 of the screen tour's s16: the kit's sheet over the inbox
// holding what the standard "+" offers and nothing else. Three kinds of
// conversation, each with its one line; a press hands over to the product
// (an agent chat starts; a direct message or a group opens the product's
// own create dialog on that tab, which wears the look).
//
// Run with: node --test tests/messages-frame-new.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const SHEET = 'frontend/src/features/messages/frame-new.tsx';
const PANE = 'frontend/src/features/messages/index.tsx';

const CHOICES = [
  { key: 'agent', label: 'messages:inbox.new.agent.label', hint: 'messages:inbox.new.agent.hint' },
  { key: 'direct', label: 'messages:inbox.new.direct.label', hint: 'messages:inbox.new.direct.hint' },
  { key: 'group', label: 'messages:inbox.new.group.label', hint: 'messages:inbox.new.group.hint' },
];
const render = (over) => renderComponent(SHEET, 'NewMessageSheet', { choices: CHOICES, onPick() {}, onClose() {}, ...over }, { cache: false });

test('it is the kit\'s sheet: the product\'s title and sentence, then three rows in one card', () => {
  const html = render();
  assert.match(html, /^<div class="fr fr-ovhost"><div class="fr-ov"><div class="fr-sheet" role="dialog" aria-modal="true"/);
  assert.match(html, /<h2 class="fr-title" id="[^"]+">New message<\/h2><p class="fr-purpose">Start a new conversation<\/p>/);
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span><span class="fr-s">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]), [
    ['Agent chat', 'Plan and build a change with a coding agent'],
    ['Direct message', 'Talk to one person'],
    ['Group chat', 'Bring a few people together'],
  ], 'the standard menu\'s three choices, in its order and words');
  assert.equal((html.match(/<div class="fr-card">/g) || []).length, 1);
  assert.equal((html.match(/<button type="button" class="fr-row">/g) || []).length, 3, 'each a button');
  assert.equal((html.match(/<span class="fr-lead" aria-hidden="true"><svg/g) || []).length, 3, 'each with its glyph');
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('what the first tour put in the sheet is gone: no field, no people, no Start chat, no blocked list', () => {
  const html = render();
  assert.doesNotMatch(html, /<input|fr-field|fr-btnrow|fr-foot|fr-cap/);
  assert.doesNotMatch(html, /Start chat|People you talk to|Blocked people|Or else|Search by username/);
  const src = read(SHEET);
  assert.doesNotMatch(src, /createDirect|createGroup|listBlocks|searchUsers|setUserBlocked|groupTitle|useState|useEffect/, 'nothing is picked, searched or created here');
  assert.doesNotMatch(src, /messages:frame\.new\./);
  const catalog = JSON.parse(read('frontend/locales/en/messages.json'));
  assert.deepEqual(Object.keys(catalog).filter((id) => id.startsWith('frame.new.')), [], 'its catalog entries went with it');
  assert.match(src, /title=\{t\('messages:create\.title'\)\}\s+purpose=\{t\('messages:inbox\.new\.menuName'\)\}/, 'the product\'s own title and menu name');
});

test('the rows are the pane\'s own choices, and a press hands over to the product\'s own start', () => {
  const pane = read(PANE);
  assert.match(pane, /onNew=\{\(\) => setFrameNew\(true\)\}/);
  assert.match(pane, /<NewMessageSheet\s+choices=\{NEW_CHOICES\}\s+onPick=\{\(choice\) => \{ setFrameNew\(false\); window\.setTimeout\(\(\) => startNew\(choice\), 0\); \}\}\s+onClose=\{\(\) => setFrameNew\(false\)\}\s+\/>/,
    'the sheet goes first, so the focus it hands back lands before the product\'s dialog takes it');
  assert.match(pane, /function startNew\(choice: NewChoice\) \{[^}]*if \(choice === 'agent'\) void startAgentSession\(\{ entry: 'messages' \}\);\s+else openDialog\('messagesCreate', choice\);/,
    'an agent chat starts; a direct message or a group is the product\'s create dialog, on that tab');
});
