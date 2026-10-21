'use strict';

// "Look around first" on the waitlist (#5678). The four cards point at
// things the waiting room does not have, so pressing it there answers the
// question and writes down that the tour is owed; it opens on the first Home
// after the account is let in, once.
//
// first-visit.ts is the record, against an injected store; the island's own
// wiring is pinned as source, the way the rest of the first session's is.
//
// Run with: node --test tests/first-session-look-owed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const DIR = path.join(__dirname, '..', 'frontend', 'src', 'features', 'first-session');
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
  };
}

test('the look-around is owed, read and cleared against the store it is given', () => {
  const { LOOK_PREFIX, oweLook, lookOwed, clearLook } = loadTsx('frontend/src/features/first-session/first-visit.ts');
  const store = memoryStore();
  assert.equal(lookOwed(9, store), false, 'nothing owed to begin with');
  oweLook(9, store);
  assert.equal(lookOwed(9, store), true);
  assert.equal(store.getItem(`${LOOK_PREFIX}9`), 'owed', 'it is this browser, under this account');
  assert.equal(lookOwed(10, store), false, 'another account is not owed it');
  clearLook(9, store);
  assert.equal(lookOwed(9, store), false, 'opened once: never again on this browser');
  oweLook(9, store);
  assert.equal(lookOwed(9, store), false, 'and it can not be owed again after');
});

test('a store that throws never takes the first session down with it', () => {
  const { oweLook, lookOwed, clearLook } = loadTsx('frontend/src/features/first-session/first-visit.ts');
  const broken = {
    getItem() { throw new Error('private mode'); },
    setItem() { throw new Error('private mode'); },
  };
  assert.doesNotThrow(() => oweLook(3, broken));
  assert.equal(lookOwed(3, broken), false);
  assert.doesNotThrow(() => clearLook(3, broken));
  assert.equal(lookOwed(3, null), false);
});

test('an owed look-around is something this device is waiting on', () => {
  const { anyOwed, oweLook, clearLook } = loadTsx('frontend/src/features/first-session/first-visit.ts');
  const store = memoryStore();
  assert.equal(anyOwed(store), false);
  oweLook(4, store);
  assert.equal(anyOwed(store), true, 'the island looks at the screen while it is owed');
  clearLook(4, store);
  assert.equal(anyOwed(store), false);
});

test('pressing Look around first on the waitlist opens no tour, and owes it', () => {
  const src = read('index.tsx');
  const block = src.slice(src.indexOf('onLookAround={() => {'), src.indexOf('onLookAround={() => {') + 900);
  assert.match(block, /noteAnswered\(\);/, 'the question is answered all the same');
  assert.match(block, /void recordLookAround\(\);/);
  assert.match(block, /if \(legacy\(\)\.App\?\.user\?\.hasPlatformAccess === false\) \{/, 'only while still waiting');
  assert.match(block, /if \(uid != null\) oweLook\(uid\);/, 'written down for the first Home after release');
  assert.match(block, /setMode\(\{ kind: 'none' \}\);\s*return;/, 'the waiting room is left uncovered');
  const waiting = block.slice(block.indexOf('hasPlatformAccess === false'));
  assert.doesNotMatch(waiting.slice(0, waiting.indexOf('return;')), /kind: 'tour'|navigateHome/);
  // Everybody else behaves exactly as before.
  assert.match(block, /legacy\(\)\.App\?\.navigateHome\?\.\(\);\s*setMode\(\{ kind: 'tour', info: LOOK_AROUND_INFO, path: 'look' \}\);/);
});

test('the owed tour opens on the first Home with access, once, and waits its turn', () => {
  const src = read('index.tsx');
  const effect = src.slice(src.indexOf('// "Look around first" pressed on the waitlist'));
  const body = effect.slice(0, effect.indexOf('}, []);'));
  assert.match(body, /if \(uid == null \|\| user\?\.hasPlatformAccess === false\) return;/,
    'never over the waiting room');
  assert.match(body, /if \(!lookOwed\(uid\)\) return;/);
  assert.match(body, /if \(modeRef\.current\.kind !== 'none'\) return;/, 'another screen keeps the record for later');
  assert.match(body, /clearLook\(uid\);\s*app\?\.navigateHome\?\.\(\);/);
  assert.match(body, /setMode\(\{ kind: 'tour', info: LOOK_AROUND_INFO, path: 'look' \}\);/);
  // `sv:authed` fires past the access gate: the waiting room's in-place
  // release, and every later boot on this browser.
  assert.match(body, /if \(legacy\(\)\.App\?\.user\) check\(\);/);
  assert.match(body, /document\.addEventListener\('sv:authed', check\)/);
  assert.match(body, /document\.removeEventListener\('sv:authed', check\)/);
  // The record is kept by the module that keeps the tip and the walk.
  assert.match(src, /clearLook, FIRST_VISIT_CHECK_MS, lookOwed, noteTipShown, noteWalkRun, oweLook, oweTip,/);
});
