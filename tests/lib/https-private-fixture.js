'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createHash, createPrivateKey, X509Certificate } = require('node:crypto');

function verifyTls(fixture) {
  const tls = fixture.checks?.tls;
  const isolation = fixture.isolation;
  assert.equal(tls?.fixtureId, isolation.fixtureId, 'Dedicated TLS fixture identity required');
  const directory = path.join(fs.realpathSync(isolation.directory), 'tls');
  assert.equal(fs.realpathSync(directory), directory, 'TLS directory must not redirect outside the fixture');
  for (const name of ['cert.pem', 'key.pem']) {
    assert.equal(fs.realpathSync(path.join(directory, name)), path.join(directory, name),
      'TLS files must stay inside the fixture');
  }
  const cert = fs.readFileSync(path.join(directory, 'cert.pem'));
  assert.equal(createHash('sha256').update(cert).digest('hex'), tls.certificateSha256,
    'TLS certificate fingerprint mismatch');
  const certificate = new X509Certificate(cert);
  assert.equal(certificate.checkHost('demo--s1.fixture.invalid'), '*.fixture.invalid');
  assert.ok(certificate.ca && certificate.verify(certificate.publicKey));
  assert.ok(Date.parse(certificate.validFrom) <= Date.now() && Date.now() < Date.parse(certificate.validTo));
  assert.ok(certificate.checkPrivateKey(createPrivateKey(fs.readFileSync(path.join(directory, 'key.pem')))));
  return cert;
}

function tlsRequest({ hostname, port, ca }, pathname, { token, cookie, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, port, path: pathname, method, ca,
      rejectUnauthorized: true, servername: hostname,
      lookup: (_name, options, callback) => {
        if (options.all) return callback(null, [{ address: '127.0.0.1', family: 4 }]);
        callback(null, '127.0.0.1', 4);
      },
      headers: { Host: hostname, ...(token ? { 'x-usernode-token': token } : {}),
        ...(cookie ? { Cookie: cookie } : {}) }, timeout: 15000,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Disposable TLS request timed out')));
    req.end();
  });
}

async function startPrivateCapture(f, session, app, web) {
  const namespace = f.fixture.isolation.namespace.name;
  const network = `c4-preview-${f.fixture.isolation.fixtureId}-network`;
  const platform = await f.ownedContainer(web);
  const platformAddress = platform.NetworkSettings.Networks[network].IPAddress;
  const resource = (await f.pool.query(`SELECT r.intent FROM preview_flow_resources r
    JOIN preview_flow_heads h ON h.flow_id = r.flow_id WHERE h.session_id = $1`, [session.id])).rows[0];
  const cloneUrl = new URL(f.environment.DATABASE_URL);
  cloneUrl.pathname = `/${resource.intent.dbName}`;
  const binding = require('../../src/services/preview-flow/binding-adapters').bindingRef({
    ...f.fixture.config, kubernetes: { ...f.fixture.config.kubernetes, appDomain: 'fixture.invalid' },
  }, app, session.id);
  const hostname = `demo--s${session.id}.fixture.invalid`;
  const id = await f.start('edge', { admission: false, privateCapture: {
    sessionId: session.id, appId: app.id, hostname, cloneUrl: cloneUrl.toString(),
    platformOrigin: `http://${platformAddress}:3000`, platformAddress,
    certificateSha256: f.fixture.checks.tls.certificateSha256, bindingName: binding.runtimeName,
  } });
  const edge = await f.ownedContainer(id);
  const destination = {
    hostname,
    ca: verifyTls(f.fixture),
    port: edge.NetworkSettings.Ports['8443/tcp'][0].HostPort,
  };
  fs.writeFileSync(path.join(f.evidence, 'tls-destination.json'), JSON.stringify({
    fixtureId: f.fixture.isolation.fixtureId, sessionId: session.id,
    hostname, address: edge.NetworkSettings.Networks[network].IPAddress, containerId: id,
  }), { mode: 0o644 });
  // Pods use the standard public HTTPS port. The edge owns both listeners.
  await f.waitFor(async () => {
    try { return (await tlsRequest(destination, '/api/proof/identity', { method: 'POST' })).status === 404; }
    catch { return false; }
  }, 'actual TLS/private forward-auth', 60000);
  return { id, destination, request: (pathname, options) => tlsRequest(destination, pathname, options) };
}

module.exports = { verifyTls, tlsRequest, startPrivateCapture };
