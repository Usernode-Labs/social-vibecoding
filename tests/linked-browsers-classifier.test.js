'use strict';

// #5974: what a session row keeps about the browser that signed in.
//
// `sessions.user_agent_class` is a SHORT class from a closed vocabulary,
// browser family and OS family ('chrome/mac'), so Settings › Linked devices
// can name a row. It is never the User-Agent header: no version, no device
// model, no language, nothing a person could be told apart by. This pins the
// classifier (src/services/linked-browsers.js classifyUserAgent and
// parseUserAgentClass) and that every session insert writes it.
//
// Run with: node --test tests/linked-browsers-classifier.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyUserAgent, parseUserAgentClass } = require('../src/services/linked-browsers');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const CASES = [
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'chrome/mac'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'edge/windows'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'firefox/windows'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', 'opera/linux'],
  ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'firefox/linux'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 'safari/mac'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'safari/ios'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1', 'chrome/ios'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15', 'firefox/ios'],
  ['Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 'safari/ipad'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'chrome/android'],
  ['Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'samsung/android'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0', 'edge/android'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'chrome/chromeos'],
  ['curl/8.7.1', 'other/other'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) SomethingNew/1.0', 'other/windows'],
];

test('a User-Agent becomes one of a few short classes, and nothing of the header survives', () => {
  for (const [ua, expected] of CASES) {
    const stored = classifyUserAgent(ua);
    assert.equal(stored, expected, ua);
    assert.match(stored, /^[a-z]+\/[a-z]+$/, 'two words from closed vocabularies');
    assert.doesNotMatch(stored, /\d/, 'no version, no build, no model');
  }
  assert.equal(classifyUserAgent(''), null);
  assert.equal(classifyUserAgent('   '), null);
  assert.equal(classifyUserAgent(undefined), null);
  assert.equal(classifyUserAgent(42), null);
});

test('the stored class reads back as its two words, and an unknown word as nothing', () => {
  assert.deepEqual(parseUserAgentClass('chrome/mac'), { browser: 'chrome', os: 'mac' });
  assert.deepEqual(parseUserAgentClass('safari/ipad'), { browser: 'safari', os: 'ipad' });
  assert.deepEqual(parseUserAgentClass('other/windows'), { browser: null, os: 'windows' });
  assert.deepEqual(parseUserAgentClass('other/other'), { browser: null, os: null });
  assert.deepEqual(parseUserAgentClass(null), { browser: null, os: null }, 'a row from before the column');
  assert.deepEqual(parseUserAgentClass('Mozilla/5.0 (Windows)'), { browser: null, os: null }, 'never trusted as a name');
});

test('every browser sign-in writes the class, and no insert writes the header itself', () => {
  const routes = read('src/routes/auth.js');
  const middleware = read('src/middleware/auth.js');
  // Signing in with a password, an activation code, a wallet, and the
  // staging iframe switch: each names the column and classifies the header.
  const inserts = [...routes.matchAll(/INSERT INTO sessions \(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(inserts.length, 3, 'createSession, the activation-code signup and the wallet recovery');
  for (const columns of inserts) assert.match(columns, /\buser_agent_class\b/);
  assert.equal((routes.match(/linkedBrowsers\.classifyUserAgent\(req(\?\.headers\?\.|\.headers)\['user-agent'\]\)/g) || []).length, 3);
  assert.match(middleware, /INSERT INTO sessions \(token, user_id, expires_at, user_agent_class\)/);
  assert.match(middleware, /classifyUserAgent\(req\?\.headers\?\.\['user-agent'\]\)/);
  for (const source of [routes, middleware]) {
    assert.doesNotMatch(source, /INSERT INTO sessions[^;]*\b(user_agent|ip|ip_address|remote_addr)\b/i, 'never the header, never an address');
  }
});
