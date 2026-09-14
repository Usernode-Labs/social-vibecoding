// The stage-2 waitlist URL is intentionally forgiving: people commonly type
// a domain without a scheme, and the form should supply HTTPS rather than let
// native URL validation reject it before React's submit handler runs.
//
// Run with: node --test tests/waitlist-made-url.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const MORE = 'frontend/src/features/auth/more.tsx';

test('client URL normalizer adds HTTPS only when no scheme was supplied', () => {
  const { normalizeMadeUrl } = loadTsx('frontend/src/features/auth/made-url.ts');

  assert.equal(normalizeMadeUrl(' example.com/project '), 'https://example.com/project');
  assert.equal(normalizeMadeUrl('www.example.com'), 'https://www.example.com');
  assert.equal(normalizeMadeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeMadeUrl('http://example.com'), 'http://example.com');
  assert.equal(normalizeMadeUrl('ftp://example.com'), 'ftp://example.com');
  assert.equal(normalizeMadeUrl('   '), '');
});

test('the made URL field lets React normalize before validation and wires blur plus submit', () => {
  const html = interiorHtmlFor('auth-more-screen');
  const input = html.match(/<input[^>]*id="more-made-url"[^>]*>/)?.[0];
  assert.ok(input, '#more-made-url is rendered');
  assert.match(input, /type="text"/);
  assert.match(input, /inputMode="url"/);
  assert.doesNotMatch(input, /type="url"/,
    'native URL validation must not block the React submit handler first');

  const source = fs.readFileSync(path.join(ROOT, MORE), 'utf8');
  assert.match(source, /onBlur=\{normalizeMadeUrlInput\}/,
    'leaving the field visibly canonicalizes it');
  assert.match(source, /const normalizedMadeUrl = normalizeMadeUrlInput\(\)/,
    'keyboard submission canonicalizes it even when blur does not run');
  assert.match(source, /made_url: normalizedMadeUrl \|\| undefined/,
    'the canonical value is the one sent to the API');
});
