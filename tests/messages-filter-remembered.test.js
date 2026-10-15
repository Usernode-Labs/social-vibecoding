'use strict';

// #4783: the Messages filter is remembered per device.
//
// The filter row above the inbox (All, People, Agents) was deliberately not
// persisted (#2718): "a filter that survives a reload is a filter somebody
// has to remember turning on." People who vote every day from the Agents
// list asked for the opposite, and got it: the choice is remembered in
// localStorage, the same way the two layout preferences already are, and a
// reload, an app reopen or a new tab comes back on the filter last picked.
//
// Three things are pinned, each a way the remembering quietly comes undone:
//
//   1. AN UNKNOWN SAVED VALUE IS ALL. `channels` was once a chip (#2783,
//      since retired), and storage is user-writable: anything that does not
//      name a chip on the row today falls back to All, not to a filter the
//      row no longer draws.
//   2. SETTING WRITES BEFORE IT PUBLISHES, inside a try. Storage may be
//      unavailable (private mode, blocked); the in-memory behaviour of today
//      must survive that, and a crash in the write must not skip the publish.
//   3. THE INITIAL STATE IS STILL ALL. The module default is what the first
//      render and the prerendered shell show; the saved value arrives after
//      mount, with the two layout preferences, so the first paint matches.
//
// Run with: node --test tests/messages-filter-remembered.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const STORE = read('frontend/src/features/messages/store.ts');

const inbox = loadTsx('frontend/src/features/messages/inbox.ts');

test('a saved filter round-trips when it names a chip on the row', () => {
  const { savedInboxFilter } = inbox;
  assert.equal(savedInboxFilter('all'), 'all');
  assert.equal(savedInboxFilter('people'), 'people');
  assert.equal(savedInboxFilter('agents'), 'agents');
});

test('an unknown saved value falls back to All', () => {
  const { savedInboxFilter } = inbox;
  // `channels` was a chip once (#2783); the row does not draw it any more.
  assert.equal(savedInboxFilter('channels'), 'all');
  assert.equal(savedInboxFilter('apps'), 'all');
  assert.equal(savedInboxFilter(''), 'all');
  assert.equal(savedInboxFilter('nonsense'), 'all');
  assert.equal(savedInboxFilter(null), 'all');
  assert.equal(savedInboxFilter(undefined), 'all');
});

test('setFilter writes the choice before it publishes, inside a try', () => {
  const start = STORE.indexOf('export function setFilter(');
  assert.ok(start >= 0, 'setFilter exists');
  const next = STORE.indexOf('\nexport ', start + 1);
  const body = STORE.slice(start, next);
  assert.match(body, /try \{ localStorage\.setItem\('usernode:messages-filter', next\); \} catch \{ \/\* storage unavailable \*\/ \}/,
    'the write is guarded, so private mode keeps the in-memory behaviour of today');
  const write = body.indexOf("localStorage.setItem('usernode:messages-filter'");
  const published = body.indexOf('publish({ filter: next })');
  assert.ok(write >= 0 && published > write, 'the choice is saved before the view hears it');
});

test('initializeMessagesStore reads the saved filter after mount and publishes it', () => {
  const start = STORE.indexOf('export function initializeMessagesStore(');
  assert.ok(start >= 0, 'initializeMessagesStore exists');
  const body = STORE.slice(start, STORE.indexOf('\nexport ', start + 1));
  assert.match(body, /filter = savedInboxFilter\(localStorage\.getItem\('usernode:messages-filter'\)\);/,
    'the saved value is read through savedInboxFilter, so an unknown one is All');
  assert.match(body, /publish\(\{ online: navigator\.onLine, demo: browserDemo\(\), listCollapsed, showMoreChannels, filter \}\)/,
    'the saved filter arrives with the two layout preferences, after mount');
});

test('the module default is still All, so the first paint matches the prerendered shell', () => {
  assert.match(STORE, /filter: 'all',/,
    'the initial state holds All; the saved value is applied after mount');
});
