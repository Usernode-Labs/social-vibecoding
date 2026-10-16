'use strict';

// The Messages list's folded sections are remembered per device (16 Oct 2026).
//
// The filter chips above the inbox (All, People, Agents; #4783 remembered the
// one picked) went when the list was split into headed sections: Homeroom
// bot, Agents, People. What a person chooses now is which of Agents and
// People to fold away from its heading, and that is remembered the way the
// chosen filter was: in localStorage, read after mount.
//
// Three things are pinned, each a way the remembering quietly comes undone:
//
//   1. AN UNKNOWN SAVED VALUE FOLDS NOTHING. Storage is user-writable, and
//      the bot's section never folds: only `agents` and `people` are read.
//   2. SETTING WRITES BEFORE IT PUBLISHES, inside a try. Storage may be
//      unavailable (private mode, blocked); folding must still work in
//      memory, and a crash in the write must not skip the publish.
//   3. THE INITIAL STATE FOLDS NOTHING. The module default is what the first
//      render and the prerendered shell show; the saved value arrives after
//      mount, with the two layout preferences, so the first paint matches.
//
// Run with: node --test tests/messages-folded-remembered.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const STORE = read('frontend/src/features/messages/store.ts');

const { savedFolded } = loadTsx('frontend/src/features/messages/store.ts', {
  stubs: { '../../lib/i18n/runtime': { t: (id) => id } },
});

test('a saved value folds the sections it names, Agents and People only', () => {
  assert.deepEqual(savedFolded('agents'), ['agents']);
  assert.deepEqual(savedFolded('people,agents'), ['agents', 'people'], 'in the list\'s order');
  assert.deepEqual(savedFolded('bot,people'), ['people'], 'the Homeroom bot\'s never folds');
});

test('an unknown saved value folds nothing', () => {
  for (const raw of ['', 'channels', 'all', 'nonsense', null, undefined]) {
    assert.deepEqual(savedFolded(raw), [], String(raw));
  }
});

test('setSectionFolded writes the choice before it publishes, inside a try', () => {
  const start = STORE.indexOf('export function setSectionFolded(');
  assert.ok(start >= 0, 'setSectionFolded exists');
  const body = STORE.slice(start, STORE.indexOf('\n}\n', start));
  assert.match(body, /if \(!FOLDABLE\.includes\(section\)\) return;/, 'the bot\'s section never folds');
  assert.match(body, /try \{ localStorage\.setItem\('usernode:messages-folded', next\.join\(','\)\); \} catch \{ \/\* storage unavailable \*\/ \}/,
    'the write is guarded, so private mode still folds in memory');
  const write = body.indexOf("localStorage.setItem('usernode:messages-folded'");
  const published = body.indexOf('publish({ folded: next })');
  assert.ok(write >= 0 && published > write, 'the choice is saved before the view hears it');
});

test('initializeMessagesStore reads the folded sections after mount and publishes them', () => {
  const start = STORE.indexOf('export function initializeMessagesStore(');
  assert.ok(start >= 0, 'initializeMessagesStore exists');
  const body = STORE.slice(start, STORE.indexOf('\nexport ', start + 1));
  assert.match(body, /folded = savedFolded\(localStorage\.getItem\('usernode:messages-folded'\)\);/,
    'the saved value is read through savedFolded, so an unknown one folds nothing');
  assert.match(body, /publish\(\{ online: navigator\.onLine, demo: browserDemo\(\), listCollapsed, showMoreChannels, folded \}\)/,
    'the folded sections arrive with the two layout preferences, after mount');
  assert.doesNotMatch(STORE, /usernode:messages-filter/, 'the retired filter is neither read nor written');
});

test('the module default folds nothing, so the first paint matches the prerendered shell', () => {
  assert.match(STORE, /folded: \[\],/,
    'the initial state folds nothing; the saved value is applied after mount');
});
