'use strict';
// Operation-local connections prevent concurrent apps from changing each other's
// administrative endpoint. Secrets never appear in the public binding record.
const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');
const placement = require('./database-placement');
const context = new AsyncLocalStorage();
function blocked() { return Object.assign(new Error('Database routing unavailable; operation blocked'), {code:'DATABASE_PLACEMENT_BLOCKED'}); }
function credentials(records, env = process.env) {
  const external = records.filter(r => r.targetId !== 'central');
  if (!external.length) return new Map();
  try {
    const registry = JSON.parse(fs.readFileSync(env.SV_DATABASE_TARGETS_FILE,'utf8'));
    const urls = new Map();
    for (const record of external) {
      const entries = registry.targets.filter(t => t.id === record.targetId);
      if (entries.length !== 1) throw blocked();
      const entry = entries[0], url = new URL(entry.adminUrl);
      if (entry.clusterUid !== record.clusterRef.uid || !['postgres:', 'postgresql:'].includes(url.protocol)
        || url.hostname !== record.endpoint.host || Number(url.port || 5432) !== record.endpoint.port
        || !url.username || !url.password || url.pathname !== '/postgres'
        || url.searchParams.get('sslmode') !== 'verify-full'
        || url.searchParams.get('sslrootcert') !== `/etc/sv-database-targets/${record.targetId}.crt`) throw blocked();
      urls.set(record.targetId, url.toString());
    }
    return urls;
  } catch { throw blocked(); }
}
async function run(names, fn, options = {}) {
  const records = await placement.resolvePlacements(names, options);
  return runResolved(records, credentials(records, options.env), names, fn);
}
function runResolved(records, urls, names, fn) {
  return context.run({records, urls, defaultName: names.at(-1)}, fn);
}
function currentRecords() { return context.getStore()?.records || []; }
function connection(name) {
  const state = context.getStore();
  if (!state) return null;
  const record = state.records.find(r => placement.ownsDatabase(r, name || state.defaultName));
  if (!record || record.targetId === 'central') return null;
  const url = state.urls.get(record.targetId);
  if (!url) throw blocked();
  return new URL(url);
}
function withDefault(name, fn) {
  const state = context.getStore();
  if (!state) throw blocked();
  return context.run({...state, defaultName:name}, fn);
}
module.exports = {run, runResolved, credentials, connection, currentRecords, withDefault};
