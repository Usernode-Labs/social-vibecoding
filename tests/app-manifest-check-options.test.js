// Behavioural tests for the two optional per-check settings a check's page
// load reads (#6003): `persona` ("guest" = run signed out) and `repeat`
// (load the page N times).
//
// Both are read leniently, like every other field here: an unusable value
// never drops the check, it is ignored and counted for one log.warn. And
// both are opt-in KEYS — absent when the check does not set them — because
// tests/capture-switch-window.test.js pins the exact key set of a plain
// check, and the 739 existing checks must read byte-identically.
//
// Run with: node --test tests/app-manifest-check-options.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const manifest = require('../src/services/app-manifest');

const readOne = (entry) => manifest.readTestsWithMeta({ tests: [entry] }).tests[0];
const PLAIN_KEYS = ['allowConsoleErrors', 'expectSelector', 'expectText', 'name', 'path'];

test('a guest persona is kept as an opt-in key, and the default check carries none', () => {
  const plain = readOne({ name: 'p', path: '/#plain', expectSelector: '#p' });
  assert.deepEqual(Object.keys(plain).sort(), PLAIN_KEYS);
  assert.equal('persona' in plain, false, 'signed in is the default, never an emitted key');

  const guest = readOne({ name: 'g', path: '/', persona: 'guest' });
  assert.equal(guest.persona, 'guest');
  assert.equal(guest.expectSelector, null, 'the rest of the check reads as usual');
});

test('any other persona is ignored, and the check is kept', () => {
  for (const persona of ['admin', 'GUEST', '', 'member', 1, true]) {
    const t = readOne({ name: 'x', path: '/', persona });
    assert.ok(t, `check kept for persona ${JSON.stringify(persona)}`);
    assert.equal('persona' in t, false, `persona ${JSON.stringify(persona)} is not carried`);
  }
  // A guest on a check with the other fields set keeps them all.
  const t = readOne({
    name: 'x', path: '/?login=1', persona: 'guest', repeat: 3,
    expectSelector: '#sheet', expectText: 'Sign in', allowConsoleErrors: true,
  });
  assert.deepEqual(t, {
    name: 'x', path: '/?login=1', expectSelector: '#sheet', expectText: 'Sign in',
    allowConsoleErrors: true, persona: 'guest', repeat: 3,
  });
});

test('repeat is kept only from 2 to 10, and 1 is the default and not emitted', () => {
  for (let n = 2; n <= manifest.MAX_CHECK_REPEAT; n += 1) {
    assert.equal(readOne({ name: 'r', path: '/', repeat: n }).repeat, n, `repeat ${n}`);
  }
  assert.equal(manifest.MAX_CHECK_REPEAT, 10);
  assert.equal('repeat' in readOne({ name: 'r', path: '/', repeat: 1 }), false, '1 is one load');
  assert.equal('repeat' in readOne({ name: 'r', path: '/' }), false, 'absent is one load');
});

test('an unusable repeat is ignored rather than dropping the check', () => {
  for (const repeat of [0, 11, -3, 2.5, '5', null, true, {}]) {
    const t = readOne({ name: 'r', path: '/', repeat });
    assert.ok(t, `check kept for repeat ${JSON.stringify(repeat)}`);
    assert.equal('repeat' in t, false, `repeat ${JSON.stringify(repeat)} is not carried`);
  }
});

test('an invalid option changes no verdict and no other field', () => {
  const entry = { name: 'r', path: '/#x', expectSelector: '#x', repeat: 42, persona: 'robot' };
  const meta = manifest.readTestsWithMeta({ tests: [entry] });
  assert.deepEqual(meta.tests[0], {
    name: 'r', path: '/#x', expectSelector: '#x', expectText: null, allowConsoleErrors: false,
  });
  assert.equal(meta.rawCount, 1, 'the check still counts as declared');
});
