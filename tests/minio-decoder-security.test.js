'use strict';

// test:changed: when vendor/decode-uri-component (the dependency's actual source)
// test:changed: when package-lock.json (verify the installed dependency tree)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const decoder = createRequire(require.resolve('query-string')).resolve('decode-uri-component');

test('query-string uses the upstream patched decoder with only its export adapted', () => {
  const source = fs.readFileSync(decoder, 'utf8');
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  assert.equal(hash(source), 'e82696ecdf0ee2c25bd90169cc7915e552d2ccb82a5006c55bc17aecdb55b919');
  const original = source.replace('module.exports = function decodeUriComponent', 'export default function decodeUriComponent');
  assert.equal(hash(original), '6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0');
  assert.equal(require('decode-uri-component'), require(decoder));
  assert.equal(require('../vendor/decode-uri-component/package.json').version, '0.5.1+homeroom.cjs.1');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.equal(Object.values(lock.packages).some((p) => p.version === '0.2.2' && /decode-uri-component/.test(p.resolved || '')), false);
  assert.match(fs.readFileSync(path.join(root, 'vendor/decode-uri-component/LICENSE'), 'utf8'), /Copyright \(c\) 2017, Sam Verschueren/);
});

test('the advisory payload completes under a process deadline and is decoded only once', () => {
  // The old implementation takes tens of seconds for these 32,000 distinct
  // runs. A child deadline bounds that regression without relying on timing
  // ratios in the shared test process.
  const probe = `
    const assert = require('node:assert/strict');
    const decode = require(${JSON.stringify(decoder)});
    let payload = '';
    for (let i = 0; i < 32000; i++) {
      const high = Math.floor(i / 256).toString(16).padStart(2, '0');
      const low = (i % 256).toString(16).padStart(2, '0');
      payload += '%' + high + '%' + low + 'x';
    }
    payload += '%zz';
    const result = decode(payload);
    assert.equal(result.endsWith('%zz'), true);
    assert.equal(decode('%25%34%31%zz'), '%41%zz');
  `;
  const result = spawnSync(process.execPath, ['-e', probe], { timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('query-string retains valid and malformed Unicode decoding and encoding behavior', () => {
  const query = require('query-string');
  const decode = require(decoder);
  for (const [input, expected] of [['%C3%A5', 'å'], ['%F0%9F%98%80', '😀'], ['%FE%FF', '\uFFFD\uFFFD'],
    ['%C2', '\uFFFD'], ['%zz', '%zz'], ['%E0%A4%A', '%E0%A4%A'], ['%C0%AF', '%C0%AF']]) {
    assert.equal(decode(input), expected);
    assert.equal(query.parse(`value=${input}`).value, expected);
  }
  assert.equal(query.stringify({ label: 'hello å', key: ['a/b', 'x+y'] }), 'key=a%2Fb&key=x%2By&label=hello%20%C3%A5');
  assert.throws(() => decode(null), TypeError);
});

test('the real MinIO client can sign encoded object names with the patched dependency tree', async () => {
  const { Client } = require('minio');
  const client = new Client({ endPoint: '127.0.0.1', port: 9000, useSSL: false,
    accessKey: 'fixture-access', secretKey: 'fixture-secret-key', region: 'us-east-1' });
  const signed = new URL(await client.presignedGetObject('fixture-bucket', 'folder/hello å+%.txt', 60));
  assert.equal(signed.pathname, '/fixture-bucket/folder/hello%20%C3%A5%2B%25.txt');
  assert.equal(signed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '60');
  assert.match(signed.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
});
