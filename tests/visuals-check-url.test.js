// The address one declared check visits (#6003). A `guest` check must really
// be signed out, so the platform appends no `token=` to it: the token IS the
// sign-in. Every other check signs in as the view-only admin, exactly as
// before, fragment and existing query preserved.
//
// Run with: node --test tests/visuals-check-url.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkVisitUrl, withToken } = require('../src/services/visuals');

test('a guest check visits the bare address, with no sign-in token', () => {
  assert.equal(checkVisitUrl('https://staging.example', '/', 'tok', 'guest'), 'https://staging.example/');
  assert.equal(
    checkVisitUrl('https://staging.example', '/invite/abc', 'tok', 'guest'),
    'https://staging.example/invite/abc',
  );
  assert.equal(
    checkVisitUrl('https://staging.example', '/app/demo?demo=1#landing', 'tok', 'guest'),
    'https://staging.example/app/demo?demo=1#landing',
    'an address that already carries a query and a fragment is untouched',
  );
});

test('every other check is withToken, byte for byte', () => {
  const origin = 'https://staging.example';
  for (const path of ['/', '/?login=1', '/#landing', '/dev?demo=1#settings', '/app/x/dev']) {
    assert.equal(checkVisitUrl(origin, path, 'tok', undefined), withToken(origin + path, 'tok'), path);
    assert.equal(checkVisitUrl(origin, path, 'tok', 'member'), withToken(origin + path, 'tok'), path);
  }
  assert.equal(checkVisitUrl(origin, '/', '', 'guest'), `${origin}/`, 'a guest never gains a token');
  assert.equal(checkVisitUrl(origin, '/', '', undefined), `${origin}/`, 'and no token still means none');
});
