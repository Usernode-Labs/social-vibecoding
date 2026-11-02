'use strict';

// S01 (overnight audit, 2 Nov 2026): reloading or relaunching the app on the
// first session's made screen ("Your new community", Share invite / Invite
// people later) dropped a newcomer on Home, with the invite step and their
// first look at the app gone. The made screen is now kept, per account on
// this browser (first-visit.ts oweMade), until one of its ways on is taken,
// and the island reopens it on the next boot.
//
// first-visit.ts is the record, against an injected store; the island's own
// wiring is pinned as source, the way the rest of the first session's is.
//
// Run with: node --test tests/first-session-made-reload.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'features', 'first-session', 'index.tsx'), 'utf8');

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

const MADE = {
  slug: 'restaurant-tier-list-a1b2c3', name: 'Restaurant Tier List', emoji: null, description: 'Rank places together',
  example: null, conversationId: null, readyMade: true,
};

test('a made screen is kept until it is left, per account, and not for ever', () => {
  const { MADE_PREFIX, MADE_KEEP_MS, oweMade, owedMade, clearMade } = loadTsx('frontend/src/features/first-session/first-visit.ts');
  const store = memoryStore();
  const now = 1_800_000_000_000;
  assert.equal(owedMade(7, store, now), null, 'nothing kept to begin with');
  oweMade(7, MADE, store, now);
  assert.ok(store.getItem(`${MADE_PREFIX}7`), 'kept on this browser, under this account');
  assert.deepEqual(owedMade(7, store, now + 60_000), MADE, 'a reload a minute later reopens it as it was made');
  assert.equal(owedMade(8, store, now), null, 'another account is not given it');
  assert.equal(owedMade(7, store, now + MADE_KEEP_MS + 1), null, 'a record left behind a day ago is not reopened');
  clearMade(7, store);
  assert.equal(owedMade(7, store, now), null, 'left by a way on: never reopened');
});

test('a broken or odd record never takes the first session down', () => {
  const { MADE_PREFIX, oweMade, owedMade, clearMade } = loadTsx('frontend/src/features/first-session/first-visit.ts');
  const broken = { getItem() { throw new Error('private mode'); }, setItem() { throw new Error('private mode'); } };
  assert.doesNotThrow(() => oweMade(3, MADE, broken));
  assert.equal(owedMade(3, broken), null);
  assert.doesNotThrow(() => clearMade(3, broken));
  assert.equal(owedMade(3, null), null);
  const store = memoryStore();
  store.setItem(`${MADE_PREFIX}3`, '{not json');
  assert.equal(owedMade(3, store), null);
  store.setItem(`${MADE_PREFIX}3`, JSON.stringify({ made: { name: 'No slug' }, at: Date.now() }));
  assert.equal(owedMade(3, store), null);
  oweMade(3, { slug: '', name: 'x' }, store);
  assert.equal(owedMade(3, store), null, 'a project with no slug is not kept');
});

test('the island keeps the first session\'s made screen while it is up, reopens it on boot, and lets it go', () => {
  // Kept while the first session's made screen is up, never Create's.
  assert.match(INDEX, /const madeUp = mode\.kind === 'made' && mode\.entry !== 'create' \? mode\.made : null;/);
  const effect = INDEX.slice(INDEX.indexOf('const madeKept = useRef(false);'));
  const body = effect.slice(0, effect.indexOf('}, [madeUp]);'));
  assert.match(body, /if \(madeUp\) \{\s*madeKept\.current = true;\s*oweMade\(uid, madeUp\);\s*return;/);
  // Gone by any way on (the mode leaves 'made'): let go. A reload runs no effect, so it stays.
  assert.match(body, /if \(!madeKept\.current\) return;\s*madeKept\.current = false;\s*clearMade\(uid\);/);
  // Reopened over nothing on boot and on sign-in, never on a ?shot= address nor over the waiting room.
  const reopen = INDEX.slice(INDEX.indexOf('// S01 (audit 2 Nov 2026)'));
  const check = reopen.slice(0, reopen.indexOf('}, []);'));
  assert.match(check, /if \(uid == null \|\| user\?\.hasPlatformAccess === false\) return;/);
  assert.match(check, /if \(shot \|\| modeRef\.current\.kind !== 'none'\) return;/);
  assert.match(check, /const made = owedMade<Made>\(uid\);/);
  assert.match(check, /prev\.kind === 'none' \? \{ kind: 'made', made \} : prev/);
  assert.match(check, /document\.addEventListener\('sv:authed', check\)/);
});
