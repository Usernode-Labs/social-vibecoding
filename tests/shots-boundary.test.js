'use strict';

// The shots browser may reach the public internet, never the network it runs
// in, and only its shots of the run's own two addresses are published
// (worker/shots-boundary.js). Pinned here: which addresses count as public
// (including how net.BlockList treats IPv4-mapped IPv6), how a destination is
// vetted, and how a screenshot or clip proves where it was taken.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const boundary = require('../worker/shots-boundary');

test('only public addresses count as public, in both families', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.1', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1',
    '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:4136:e378::1', '100::1',
    // An IPv4 address written as IPv6 is checked against the IPv4 rules.
    '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254',
    'not-an-address', '', null,
  ]) {
    assert.equal(boundary.isPublicAddress(address), false, String(address));
  }
  for (const address of [
    '8.8.8.8', '1.1.1.1', '93.184.215.14', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1',
    '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8',
  ]) {
    assert.equal(boundary.isPublicAddress(address), true, address);
  }
});

test('a destination is reached only on a web port, and only when every address it resolves to is public', async () => {
  const answers = {
    'cdn.example': [{ address: '93.184.215.14', family: 4 }],
    'dual.example': [{ address: '2606:4700:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }],
    'rebind.example': [{ address: '93.184.215.14', family: 4 }, { address: '10.0.0.5', family: 4 }],
    'metadata.example': [{ address: '169.254.169.254', family: 4 }],
    'empty.example': [],
  };
  const asked = [];
  const lookup = async (name, options) => {
    asked.push([name, options]);
    if (!answers[name]) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return answers[name];
  };
  const vet = (host, port) => boundary.vetPublicDestination(host, port, { lookup });

  assert.deepEqual(await vet('cdn.example', 443), { ok: true, address: '93.184.215.14', family: 4 });
  assert.deepEqual(await vet('CDN.Example', 80), { ok: true, address: '93.184.215.14', family: 4 });
  assert.deepEqual(await vet('dual.example', 443), { ok: true, address: '2606:4700:4700::1111', family: 6 });
  assert.deepEqual(asked[0], ['cdn.example', { all: true, verbatim: true }], 'every answer is checked');

  // One internal answer among public ones is enough to refuse the name.
  assert.deepEqual(await vet('rebind.example', 443), { ok: false, reason: 'private_address' });
  assert.deepEqual(await vet('metadata.example', 80), { ok: false, reason: 'private_address' });
  assert.deepEqual(await vet('missing.example', 443), { ok: false, reason: 'dns' });
  assert.deepEqual(await vet('empty.example', 443), { ok: false, reason: 'dns' });
  assert.deepEqual(await vet('', 443), { ok: false, reason: 'dns' });
  for (const port of [22, 3000, 5432, 8080, 0, NaN]) {
    assert.deepEqual(await vet('cdn.example', port), { ok: false, reason: 'port' }, String(port));
  }

  // An address is checked as it is written, without a lookup.
  asked.length = 0;
  assert.deepEqual(await vet('1.1.1.1', 443), { ok: true, address: '1.1.1.1', family: 4 });
  assert.deepEqual(await vet('[2606:4700:4700::1111]', 443), { ok: true, address: '2606:4700:4700::1111', family: 6 });
  for (const literal of ['127.0.0.1', '10.0.0.5', '[::1]', '[::ffff:127.0.0.1]', '169.254.169.254']) {
    assert.deepEqual(await vet(literal, 443), { ok: false, reason: 'private_address' }, literal);
  }
  assert.deepEqual(asked, []);
});

test('a screenshot names the site it was taken on only while it is the image that was stamped', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputDir = path.join(dir, 'shots', 'member');
  fs.mkdirSync(outputDir, { recursive: true });
  const image = path.join(outputDir, 'saved-after.png');
  fs.writeFileSync(image, 'after pixels');

  boundary.stampScreenshot(outputDir, image, 'http://head.internal:3000/lists?id=7#done');
  assert.equal(boundary.screenshotOrigin(outputDir, 'saved-after.png', Buffer.from('after pixels')),
    'http://head.internal:3000', 'the stamp keeps the site, never the path or query');

  // The stamp lives beside the browser's directory, never inside it: a page
  // can make the browser save a download there under a name of its choosing.
  assert.deepEqual(fs.readdirSync(outputDir), ['saved-after.png']);
  assert.equal(boundary.provenanceDir(outputDir), path.join(dir, 'shots', '.provenance', 'member'));
  const stamp = path.join(boundary.provenanceDir(outputDir), 'saved-after.png.json');
  assert.equal(fs.statSync(stamp).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(stamp, 'utf8'), /lists|id=7|done/);

  // A file replaced after it was stamped has no provenance.
  assert.equal(boundary.screenshotOrigin(outputDir, 'saved-after.png', Buffer.from('other pixels')), null);
  assert.equal(boundary.screenshotOrigin(outputDir, 'never-stamped.png', Buffer.from('after pixels')), null);
  // A page that is not a web page has no site.
  boundary.stampScreenshot(outputDir, image, 'about:blank');
  assert.equal(boundary.screenshotOrigin(outputDir, 'saved-after.png', Buffer.from('after pixels')), null);
});

test('a clip is described only by the session record written after it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-boundary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outputDir = path.join(dir, 'admin');
  fs.mkdirSync(outputDir);
  assert.equal(boundary.sessionOrigins(outputDir), null);

  boundary.recordSession(outputDir, new Set([
    'http://head.internal:3000/a', 'http://head.internal:3000/b?x=1', 'about:blank', 'https://cdn.example/x.js',
  ]));
  assert.deepEqual(boundary.sessionOrigins(outputDir), ['http://head.internal:3000', 'https://cdn.example']);

  const record = path.join(boundary.provenanceDir(outputDir), 'session.json');
  const written = fs.statSync(record).mtimeMs;
  assert.deepEqual(boundary.sessionOrigins(outputDir, { notBefore: written }),
    ['http://head.internal:3000', 'https://cdn.example']);
  assert.equal(boundary.sessionOrigins(outputDir, { notBefore: written + 1000 }), null,
    'a clip newer than the record came from a session no record covers');
});

test('a shot is published only from its own side\'s address', () => {
  const pair = { base: 'http://base.internal:3000', head: 'http://head.internal:3000/' };
  assert.equal(boundary.provenanceRefusal('after', ['http://head.internal:3000'], pair), null);
  assert.equal(boundary.provenanceRefusal('before', ['http://base.internal:3000'], pair), null);
  assert.equal(boundary.provenanceRefusal('after', 'http://head.internal:3000', pair), null);

  const refusals = [
    ['after', ['http://base.internal:3000']],
    ['before', ['http://head.internal:3000']],
    ['after', ['https://example.com']],
    ['after', ['http://head.internal:3000', 'https://example.com']],
    ['after', ['http://head.internal:3001']],
    ['after', []],
    ['after', [null]],
    ['after', null],
  ];
  for (const [side, origins] of refusals) {
    assert.match(boundary.provenanceRefusal(side, origins, pair), new RegExp(`the ${side} address`),
      JSON.stringify([side, origins]));
  }
  assert.match(boundary.provenanceRefusal('sideways', ['http://head.internal:3000'], pair), /no address/);
  assert.match(boundary.provenanceRefusal('after', ['http://head.internal:3000'], { base: pair.base }), /no address/);
});
