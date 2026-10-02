'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { verifyTls } = require('./lib/https-private-fixture');

function certificateFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'private-tls-rejection-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'tls'));
  const cert = path.join(directory, 'tls/cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(directory, 'tls/key.pem'), '-out', cert, '-days', '1',
    '-subj', '/CN=disposable', '-addext', 'subjectAltName=DNS:*.fixture.invalid',
    '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  const fixtureId = randomUUID();
  return {
    isolation: { directory, fixtureId },
    checks: { tls: { fixtureId, certificateSha256: createHash('sha256').update(fs.readFileSync(cert)).digest('hex') } },
  };
}

test('dedicated TLS trust requires the recorded fixture, certificate and matching key', t => {
  const fixture = certificateFixture(t);
  assert.ok(verifyTls(fixture).length);
  fixture.checks.tls.fixtureId = randomUUID();
  assert.throws(() => verifyTls(fixture), /Dedicated TLS fixture identity/);
  fixture.checks.tls.fixtureId = fixture.isolation.fixtureId;
  const fingerprint = fixture.checks.tls.certificateSha256;
  fixture.checks.tls.certificateSha256 = '0'.repeat(64);
  assert.throws(() => verifyTls(fixture), /fingerprint mismatch/);
  fixture.checks.tls.certificateSha256 = fingerprint;
  const other = certificateFixture(t);
  fs.copyFileSync(path.join(other.isolation.directory, 'tls/key.pem'),
    path.join(fixture.isolation.directory, 'tls/key.pem'));
  assert.throws(() => verifyTls(fixture), /checkPrivateKey/);

});

test('TLS proof cannot quietly use ambient browser trust or internal HTTP rewriting', () => {
  const preload = fs.readFileSync(path.join(__dirname, 'lib/packaged-cli-preload.js'), 'utf8');
  const httpsBranch = preload.slice(preload.indexOf('if (settings.httpsCapture) {'), preload.indexOf('  const pool =', preload.indexOf('if (settings.httpsCapture) {')));
  assert.doesNotMatch(httpsBranch, /replaceAll|http:\/\//);
  const edge = fs.readFileSync(path.join(__dirname, 'lib/https-private-edge.js'), 'utf8');
  assert.match(edge, /authMiddleware\(/);
  assert.match(edge, /adminMiddleware, requireAdminWrite/);
  assert.match(edge, /\/__caddy\/access/);
  assert.doesNotMatch(edge, /rejectUnauthorized:\s*false|ignoreHTTPSErrors/);
});

test('TLS client verifies the fixture certificate and uses explicit local DNS on current Node', async t => {
  const https = require('node:https');
  const { tlsRequest } = require('./lib/https-private-fixture');
  const fixture = certificateFixture(t);
  const directory = path.join(fixture.isolation.directory, 'tls');
  const server = https.createServer({ cert: verifyTls(fixture), key: fs.readFileSync(path.join(directory, 'key.pem')) },
    (_req, res) => res.end('actual encrypted response'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const destination = { hostname: 'demo--s1.fixture.invalid', port: server.address().port, ca: verifyTls(fixture) };
  const response = await tlsRequest(destination, '/');
  assert.equal(response.status, 200);
  assert.equal(response.body, 'actual encrypted response');
  await assert.rejects(tlsRequest({ ...destination, ca: undefined }, '/'), /self-signed certificate/);
});
