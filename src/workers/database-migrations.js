'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { GROUP, RESOURCE, createMigrations, reconcile } = require('../services/database-migrations');
const { loadPolicy } = require('../services/database-control-plane');

const KUBECONFIG = '/tmp/migration-kubeconfig.json';
const children = new Set();
let stopping = false;
function run(binary, args, input, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let output = '', overflow = false;
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, timeout);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 2 * 1024 * 1024) { overflow = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} } });
    child.stderr.resume(); // Never log kubectl/SQL bodies or credentials.
    child.on('error', () => { clearTimeout(timer); children.delete(child); reject(new Error('Operator invocation failed')); });
    child.on('close', code => { clearTimeout(timer); children.delete(child); if (code || overflow || stopping) reject(new Error('Operator invocation stopped')); else resolve(output); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const kube = (args, body) => run('kubectl', ['--kubeconfig', KUBECONFIG, '--request-timeout=10s', '--cache-dir=/tmp/kube-cache', ...args], body && JSON.stringify(body));
function createStore(namespace) {
  const get = async (resource, name, ns = namespace) => {
    const raw = await kube(['get', resource, name, '-n', ns, '--ignore-not-found', '-o', 'json']);
    return raw.trim() ? JSON.parse(raw) : null;
  };
  return {
    get: id => get(RESOURCE, id),
    binding: name => get('appdatabasebinding', name),
    hasJob: async id => !!await get('job', id, 'sv-db-stockroom'),
    list: async () => JSON.parse(await kube(['get', RESOURCE, '-n', namespace, '-o', 'json'])).items,
    create: async (id, spec) => JSON.parse(await kube(['create', '-f', '-', '-o', 'json'], {
      apiVersion: GROUP + '/v1alpha1', kind: 'AppDatabaseMigration', metadata: { name: id, namespace }, spec })),
    update: async (o, spec) => JSON.parse(await kube(['replace', '-f', '-', '-o', 'json'], { ...o, spec })),
    status: async (o, status) => JSON.parse(await kube(['replace', '--raw', `/apis/${GROUP}/v1alpha1/namespaces/${namespace}/${RESOURCE}/${o.metadata.name}/status`, '-f', '-'], {
      apiVersion: GROUP + '/v1alpha1', kind: 'AppDatabaseMigration',
      metadata: { name: o.metadata.name, namespace, resourceVersion: o.metadata.resourceVersion }, status })),
  };
}
async function execute(command, { id, binding, target, expectedRevision }) {
  const args = ['/opt/sv-database-operator/move-app-database.py', command, '--kubeconfig', KUBECONFIG, '--operation', id, '--cache-dir', '/tmp/kube-cache'];
  if (['plan', 'start'].includes(command)) args.push('--binding', binding, '--target', target);
  if (expectedRevision !== undefined) args.push('--expected-revision', String(expectedRevision));
  const output = await run('python3', args, undefined, command === 'plan' ? 60000 : 20 * 60 * 1000);
  if (command === 'plan') return JSON.parse(output);
  const lines = output.trim().split('\n');
  return JSON.parse(lines.at(-1));
}
async function main() {
  if (process.env.SV_DATABASE_MIGRATIONS_ENABLED !== 'true') throw new Error('Migrations disabled');
  const serviceAccount = '/var/run/secrets/kubernetes.io/serviceaccount';
  fs.writeFileSync(KUBECONFIG, JSON.stringify({ apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: 'staging', cluster: { server: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`,
      'certificate-authority': serviceAccount + '/ca.crt' } }],
    users: [{ name: 'operator', user: { tokenFile: serviceAccount + '/token' } }],
    contexts: [{ name: 'staging', context: { cluster: 'staging', user: 'operator' } }], 'current-context': 'staging' }), { mode: 0o600 });
  const express = require('express');
  const app = express();
  app.disable('x-powered-by');
  let lastPoll = 0;
  app.get('/health', (_req, res) => res.sendStatus(stopping ? 503 : 200));
  app.get('/ready', (_req, res) => res.sendStatus(!stopping && Date.now() - lastPoll < 30000 ? 200 : 503));
  app.use(require('cookie-parser')());
  app.use(express.json({ limit: '8kb' }));
  const config = { databaseUrl: process.env.DATABASE_URL, dbPoolMax: 3 };
  app.use(require('../middleware/auth').authMiddleware(config));
  app.use(require('../middleware/admin').adminMiddleware);
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const store = createStore(loadPolicy().namespace);
  const service = createMigrations({ store, execute });
  require('../routes/admin-database-migrations').registerMigrationRoutes(app, service, { origin: process.env.SV_DATABASE_ADMIN_ORIGIN });
  app.use('/database-maintenance/assets', express.static(path.resolve('public/shell/assets')));
  app.use('/database-maintenance/css', express.static(path.resolve('public/css')));
  app.get('/database-maintenance', (_req, res) => res.type('html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Database maintenance</title><link rel="stylesheet" href="/database-maintenance/css/native.css"><link rel="stylesheet" href="/database-maintenance/css/app.css"><link rel="stylesheet" href="/database-maintenance/css/tailwind.css"></head><body><div id="database-maintenance-root"></div><script type="module" src="/database-maintenance/assets/database-maintenance.js"></script></body></html>'));
  app.use((_req, res) => res.sendStatus(404));
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'Migration service unavailable' }));
  const server = app.listen(3002, '0.0.0.0');
  const stop = () => { stopping = true; server.close(); for (const c of children) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // The service remains ready while one long operator command is running.
  let active = null;
  while (!stopping) {
    try {
      const operations = await store.list();
      lastPoll = Date.now();
      if (!active) {
        const o = operations.find(r => r.status?.phase === 'Running' || r.status?.observedAttempt !== r.spec.attempt);
        if (o) active = reconcile(o, { store, execute }).catch(() => {}).finally(() => { active = null; });
      }
    } catch { /* readiness reports loss of Kubernetes access */ }
    await delay(2000);
  }
  if (active) await active;
  await require('../db/pool').getPool(config).end();
}
if (require.main === module) main().catch(() => { console.error('database-migrations: startup failed'); process.exitCode = 1; });
module.exports = { createStore, execute };
