'use strict';

// Disposable TLS routing fixture. Policy, JWT/session exchange and permissions
// come from shipped modules; this is not an installed ingress controller.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { createHash } = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { authMiddleware } = require('../../src/middleware/auth');
const { adminMiddleware, requireAdminWrite } = require('../../src/middleware/admin');
const kubernetes = require('../../src/services/kubernetes');

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 10000 }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    });
    req.on('timeout', () => req.destroy(new Error('Fixture forward-auth timed out')));
    req.on('error', reject);
  });
}

function start(settings) {
  const proof = settings.privateCapture;
  assert.ok(proof && proof.hostname === `demo--s${proof.sessionId}.fixture.invalid`);
  assert.equal(new URL(proof.platformOrigin).protocol, 'http:');
  assert.equal(new URL(proof.platformOrigin).hostname, proof.platformAddress);
  const cert = fs.readFileSync('/fixture/cert.pem');
  assert.equal(createHash('sha256').update(cert).digest('hex'), proof.certificateSha256);
  const clients = kubernetes._getClients();
  const app = express();
  app.set('trust proxy', true);
  app.use(cookieParser());

  function record(kind, detail) {
    fs.appendFileSync('/evidence/https.jsonl', `${JSON.stringify({ kind, detail })}\n`);
  }

  app.use(async (req, res, next) => {
    try {
      assert.equal(req.hostname, proof.hostname, 'TLS fixture refuses unrecorded hosts');
      assert.equal((await clients.core.readNamespace({ name: 'kube-system' })).metadata.uid,
        settings.clusterIdentity);
      const gate = await request(`${proof.platformOrigin}/__caddy/access`, {
        'x-forwarded-host': proof.hostname,
        'x-forwarded-method': req.method,
        'x-forwarded-uri': req.originalUrl,
        cookie: req.headers.cookie || '',
        'x-usernode-token': req.headers['x-usernode-token'] || '',
        'sec-fetch-dest': req.headers['sec-fetch-dest'] || '',
      });
      record('edge', { path: req.path, method: req.method, status: gate.status, tls: req.secure });
      if (gate.status !== 200) {
        for (const header of ['set-cookie', 'location']) {
          if (gate.headers[header]) res.setHeader(header, gate.headers[header]);
        }
        return res.status(gate.status).send(gate.body);
      }
      next();
    } catch (error) {
      record('edge_error', { message: error.message });
      res.status(503).send('fixture edge unavailable');
    }
  });

  app.use(authMiddleware({ databaseUrl: process.env.DATABASE_URL }));
  app.use((req, res, next) => {
    record('identity', { path: req.path, method: req.method,
      username: req.user?.username || null, admin: !!req.user?.isAdmin,
      canWrite: !!req.user?.canAdminWrite });
    next();
  });
  app.use('/usernode-bridge', express.static('/app/public/usernode-bridge'));
  app.use('/usernode-native', express.static('/app/public/usernode-native'));
  app.use('/usernode-tailwind', express.static('/app/public/usernode-tailwind'));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.get('/api/proof/identity', (req, res) => res.json(req.user));
  app.get('/api/proof/admin', adminMiddleware, (_req, res) => res.json({ read: true }));
  app.post('/api/proof/admin', adminMiddleware, requireAdminWrite, (_req, res) => res.json({ write: true }));
  app.get(['/proof', '/health'], async (req, res) => {
    try {
      if (req.path === '/proof') {
        while (fs.existsSync('/evidence/hold-capture')) {
          await new Promise(resolve => setTimeout(resolve, 250));
          if (res.destroyed) return;
        }
      }
      // Verify that the currently activated real Service serves; never return a
      // successful runtime observation on behalf of the preparation workflow.
      const ingress = await clients.networking.readNamespacedIngress({ namespace: settings.namespace,
        name: proof.bindingName });
      const service = ingress.spec.rules[0].http.paths.find(value => value.path === '/').backend.service.name;
      const health = await clients.core.connectGetNamespacedServiceProxyWithPath({
        namespace: settings.namespace, name: `${service}:3000`, path: 'health',
      });
      assert.equal(health, 'Ok\n');
      const persona = req.user?.isAdmin ? 'Read-only assertions' : 'Ordinary screenshot';
      res.send(`<!doctype html><html><head><link rel="icon" href="data:,"><script src="/usernode-bridge/v1/bridge.js"></script><link rel="stylesheet" href="/usernode-native/v1/native.css"></head><body><h1>${persona}</h1><p>Real TLS and clone session</p></body></html>`);
    } catch (error) {
      record('surface_error', { message: error.message });
      res.status(503).send('fixture candidate unavailable');
    }
  });
  const credentials = { cert, key: fs.readFileSync('/fixture/key.pem') };
  https.createServer(credentials, app).listen(8443, '0.0.0.0');
  https.createServer(credentials, app).listen(443, '0.0.0.0');
}

module.exports = { start };
