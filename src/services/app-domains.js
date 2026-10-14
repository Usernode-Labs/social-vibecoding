'use strict';

// Custom domains (#4405): a project served at a web address its manager
// owns, beside its Homeroom address.
//
// A claim is a row in app_domains (schema.sql). It is proved by two DNS
// records the manager adds where the domain is managed:
//
//   CNAME <hostname>            -> <slug>.<USERNODE_APPS_DOMAIN>
//   TXT   _homeroom.<hostname>  -> homeroom-verify=<verification_token>
//
// The CNAME is what routes traffic (the apps domain's wildcard record already
// resolves to the edge) and names the app, so it is a first proof; the TXT
// record is the proof of control tied to THIS claim, so a dangling CNAME can
// never be claimed by whoever later holds the slug.
//
// The status machine:
//
//   pending   claimed; the sweep checks DNS every minute (every ten after a
//             day of misses), and gives up after a week (-> failed).
//   verified  both records answer; on Kubernetes the per-domain Ingress with
//             its issuer annotation is upserted (cert-manager issues), on
//             Docker nothing (Caddy issues on demand, asking /__caddy/ask).
//   live      the edge served a certificate for the host; Share switches.
//   failed    gave up, or a live host stopped answering three days running.
//             "Check now" starts it again.
//   disabled  an admin took it out of service; "Enable" re-verifies.
//
// The resolver is pinned to public resolvers rather than the cluster's, so a
// stale cache or an in-cluster answer never vouches for a record the public
// internet cannot see. The sweep runs on the leader only (server.js
// becomeLeader), so a preview, which never becomes leader, never acts on a
// row, and the table is staging:private anyway.

const crypto = require('crypto');
const dns = require('dns');
const { URL, domainToASCII } = require('url');
const log = require('./logger');
const { getPool } = require('../db/pool');
const caddy = require('./caddy');
const events = require('./events');

const TXT_PREFIX = '_homeroom';
const TXT_VALUE_PREFIX = 'homeroom-verify=';
const STATUSES = Object.freeze(['pending', 'verified', 'live', 'failed', 'disabled']);
const PUBLIC_RESOLVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);
const RESOLVE_TIMEOUT_MS = 5000;

const SWEEP_INTERVAL_MS = 60 * 1000;
// A pending claim that has missed for a day is checked every ten minutes.
const SLOW_AFTER_MS = 24 * 60 * 60 * 1000;
const SLOW_INTERVAL_MS = 10 * 60 * 1000;
// A pending claim is given up after a week; a verified one with no
// certificate after a day.
const GIVE_UP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const CERT_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
const CERT_SLOW_AFTER_MS = 30 * 60 * 1000;
// A live host is probed once a day, and fails after three misses.
const LIVE_RECHECK_MS = 24 * 60 * 60 * 1000;
const LIVE_FAILURES_BEFORE_FAILED = 3;
const MAX_CLAIMS_PER_USER_PER_DAY = 5;

const HOST_CACHE_TTL_MS = 10 * 1000;
const HOST_CACHE_MAX = 5000;

const ROW_COLUMNS = `id, app_id, hostname, verification_token, status, dns_checked_at, verified_at,
  live_at, cert_expires_at, last_error, failure_count, created_by, created_at, updated_at,
  disabled_at, disabled_by`;

// ── Hostnames ───────────────────────────────────────────────────────────

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function platformDomains() {
  return [caddy.USERNODE_DOMAIN, caddy.USERNODE_APPS_DOMAIN]
    .map((d) => String(d || '').toLowerCase())
    .filter(Boolean);
}

function underDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

/**
 * A hostname as typed, as the row stores it: lower-case ASCII (punycode for
 * an internationalised name), no scheme, path, port or trailing dot.
 * Throws an Error with a `code` the route answers with:
 *   invalid_hostname   not a DNS name at all, an IP, localhost, a wildcard
 *   apex_unsupported   a two-label name (a CNAME cannot sit at a zone apex)
 *   platform_domain    the platform's own domain, or anything under it
 */
function normalizeHostname(raw) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  let value = String(raw || '').trim().toLowerCase();
  if (!value) throw fail('invalid_hostname', 'Enter a web address, for example app.example.com.');
  // Forgive a pasted URL.
  if (/^[a-z]+:\/\//.test(value)) {
    try { value = new URL(value).hostname; } catch { throw fail('invalid_hostname', 'That is not a web address.'); }
  }
  value = value.replace(/\/.*$/, '').replace(/\.$/, '');
  if (value.includes('*')) throw fail('invalid_hostname', 'A wildcard address cannot be used.');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':') || value.includes('[')) {
    throw fail('invalid_hostname', 'Enter a domain name, not an IP address.');
  }
  const ascii = domainToASCII(value);
  if (!ascii) throw fail('invalid_hostname', 'That is not a valid domain name.');
  if (ascii.length > 253) throw fail('invalid_hostname', 'That domain name is too long.');
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    throw fail('invalid_hostname', 'That is not a valid domain name.');
  }
  for (const domain of platformDomains()) {
    if (underDomain(ascii, domain)) {
      throw fail('platform_domain', 'That address is already Homeroom’s. Use a domain you own.');
    }
  }
  if (['localhost', 'local', 'invalid', 'test', 'example'].includes(labels[labels.length - 1])) {
    throw fail('invalid_hostname', 'That domain name cannot be reached from the internet.');
  }
  if (labels.length === 2) {
    throw fail('apex_unsupported',
      'Apex domains like example.com are not supported yet. Use a subdomain, for example app.example.com or www.example.com.');
  }
  return ascii;
}

function isHostnameError(err) {
  return !!err && ['invalid_hostname', 'apex_unsupported', 'platform_domain'].includes(err.code);
}

function mintToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** The two records a claim needs, as the dialog lists them. */
function expectedRecords(app, row) {
  const target = caddy.productionHostname(app.slug);
  return [
    { type: 'CNAME', name: row.hostname, value: target },
    { type: 'TXT', name: `${TXT_PREFIX}.${row.hostname}`, value: `${TXT_VALUE_PREFIX}${row.verification_token}` },
  ];
}

// ── DNS ─────────────────────────────────────────────────────────────────

let resolverFactory = null;
function makeResolver() {
  if (resolverFactory) return resolverFactory();
  const resolver = new dns.promises.Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 2 });
  resolver.setServers(PUBLIC_RESOLVERS);
  return resolver;
}

function isNotFoundCode(code) {
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL' || code === 'NXDOMAIN';
}
function isTimeoutCode(code) {
  return code === 'ETIMEOUT' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED';
}

/**
 * Check a claim's two records. Resolves (never rejects) to
 *   { ok: true }                                   both match
 *   { ok: false, error, transient }                error is one sentence for
 *                                                  the status line; transient
 *                                                  (a resolver timeout) does
 *                                                  not count toward giving up
 */
async function checkDns(app, row, resolver = makeResolver()) {
  const [cname, txt] = expectedRecords(app, row);
  let targets;
  try {
    targets = await resolver.resolveCname(cname.name);
  } catch (err) {
    if (isTimeoutCode(err?.code)) return { ok: false, error: 'DNS lookup timed out.', transient: true };
    if (!isNotFoundCode(err?.code)) {
      return { ok: false, error: `DNS lookup failed: ${err?.code || err?.message || 'unknown error'}.`, transient: true };
    }
    targets = [];
  }
  const found = (targets || []).map((t) => String(t).toLowerCase().replace(/\.$/, ''));
  if (!found.length) return { ok: false, error: `No CNAME record found for ${cname.name}.`, transient: false };
  if (!found.includes(cname.value.toLowerCase())) {
    return { ok: false, error: `The CNAME for ${cname.name} points to ${found[0]}, not ${cname.value}.`, transient: false };
  }
  let records;
  try {
    records = await resolver.resolveTxt(txt.name);
  } catch (err) {
    if (isTimeoutCode(err?.code)) return { ok: false, error: 'DNS lookup timed out.', transient: true };
    if (!isNotFoundCode(err?.code)) {
      return { ok: false, error: `DNS lookup failed: ${err?.code || err?.message || 'unknown error'}.`, transient: true };
    }
    records = [];
  }
  const values = (records || []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)).trim());
  if (!values.includes(txt.value)) {
    return { ok: false, error: `The TXT record ${txt.name} is missing or does not match.`, transient: false };
  }
  return { ok: true };
}

// ── Rows ────────────────────────────────────────────────────────────────

async function forApp(pool, appId) {
  const { rows } = await pool.query(`SELECT ${ROW_COLUMNS} FROM app_domains WHERE app_id = $1`, [appId]);
  return rows[0] || null;
}

async function byId(pool, id) {
  const { rows } = await pool.query(`SELECT ${ROW_COLUMNS} FROM app_domains WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** The app a live custom hostname serves, or null. Uncached. */
async function lookupLiveHost(pool, hostname) {
  const { rows } = await pool.query(
    `SELECT d.app_id, a.slug, a.name
       FROM app_domains d JOIN apps a ON a.id = d.app_id
      WHERE d.hostname = $1 AND d.status = 'live'`,
    [hostname]
  );
  return rows[0] || null;
}

function recordEvent(pool, { appId, userId = null, hostname, action }) {
  return events.record(pool, {
    type: events.EVENT_TYPES.APP_DOMAIN_CHANGED,
    userId, appId, metadata: { hostname, action },
  });
}

/**
 * Claim a hostname for an app. Throws with a `code`:
 *   invalid_hostname | apex_unsupported | platform_domain (normalizeHostname)
 *   already_has_domain   the app has one (v1: one per project)
 *   hostname_taken       another app's claim that is not failed holds it
 *   claim_limit          the person claimed MAX_CLAIMS_PER_USER_PER_DAY today
 */
async function claim(pool, app, rawHostname, user) {
  const hostname = normalizeHostname(rawHostname);
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (await forApp(pool, app.id)) throw fail('already_has_domain', 'This project already has a custom domain. Remove it first.');
  const { rows: taken } = await pool.query(
    `SELECT app_id, status FROM app_domains WHERE hostname = $1`, [hostname]
  );
  if (taken.length && taken[0].status !== 'failed') {
    throw fail('hostname_taken', 'That address is already in use by another project.');
  }
  if (user?.id != null) {
    const { rows: recent } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM events
        WHERE event_type = $1 AND user_id = $2 AND created_at > NOW() - INTERVAL '1 day'
          AND metadata->>'action' = 'added'`,
      [events.EVENT_TYPES.APP_DOMAIN_CHANGED, user.id]
    );
    if ((recent[0]?.n || 0) >= MAX_CLAIMS_PER_USER_PER_DAY) {
      throw fail('claim_limit', 'You have added as many domains as you can today. Try again tomorrow.');
    }
  }
  // A failed claim by another app is released to this one.
  if (taken.length) await pool.query('DELETE FROM app_domains WHERE hostname = $1', [hostname]);
  const { rows } = await pool.query(
    `INSERT INTO app_domains (app_id, hostname, verification_token, status, created_by)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING ${ROW_COLUMNS}`,
    [app.id, hostname, mintToken(), user?.id ?? null]
  );
  const row = rows[0];
  await recordEvent(pool, { appId: app.id, userId: user?.id ?? null, hostname, action: 'added' });
  return row;
}

async function remove(pool, config, app, row, user, { action = 'removed' } = {}) {
  await teardownEdge(config, row).catch((err) => {
    log.warn('app-domains', 'Edge teardown failed on remove', { hostname: row.hostname, err: err.message });
  });
  await pool.query('DELETE FROM app_domains WHERE id = $1', [row.id]);
  invalidateHost(row.hostname);
  await recordEvent(pool, { appId: app.id, userId: user?.id ?? null, hostname: row.hostname, action });
}

async function setStatus(pool, id, status, fields = {}) {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params = [id, status];
  for (const [key, value] of Object.entries(fields)) {
    params.push(value);
    sets.push(`${key} = $${params.length}`);
  }
  const { rows } = await pool.query(
    `UPDATE app_domains SET ${sets.join(', ')} WHERE id = $1 RETURNING ${ROW_COLUMNS}`, params
  );
  return rows[0] || null;
}

// ── The edge ────────────────────────────────────────────────────────────

function runtimeIsKubernetes(config) {
  return (config?.appRuntime || process.env.APP_RUNTIME) === 'kubernetes';
}

/** Route the host at the edge: a per-domain Ingress on Kubernetes, nothing on Docker. */
async function provisionEdge(config, app, row) {
  if (!runtimeIsKubernetes(config)) return;
  const kubernetes = require('./kubernetes');
  await kubernetes.deployCustomDomain(config, { app, domain: row });
}

async function teardownEdge(config, row) {
  if (!runtimeIsKubernetes(config)) return;
  const kubernetes = require('./kubernetes');
  await kubernetes.deleteCustomDomain(config, { domain: row });
}

/**
 * Did the edge serve a certificate for the host? Resolves to
 * { ok, expiresAt, error }. A matching SAN from a named issuer is what
 * "live" means; the handshake alone, so the app itself is never woken.
 */
async function probeLive(hostname) {
  const probe = await caddy.probeEdge(hostname, { handshakeOnly: true });
  const cert = probe.cert;
  if (!probe.ok && !cert) return { ok: false, expiresAt: null, error: probe.error?.message || 'No answer from the edge.' };
  if (!cert || !cert.sanMatched || !cert.issuer) {
    return { ok: false, expiresAt: null, error: 'The edge has not got a certificate for this address yet.' };
  }
  const expiresAt = cert.validTo ? new Date(cert.validTo) : null;
  return { ok: true, expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null, error: null };
}

// ── The check ───────────────────────────────────────────────────────────

async function appOf(pool, row) {
  const { rows } = await pool.query('SELECT id, slug, name, runtime_name FROM apps WHERE id = $1', [row.app_id]);
  return rows[0] || null;
}

/**
 * Move one row along: DNS for pending, the certificate for verified, a
 * health probe for live. Returns the row as it stands afterwards. `now` and
 * `deps` are for tests.
 */
async function checkRow(pool, config, row, { now = Date.now(), resolver, probe = probeLive } = {}) {
  const app = await appOf(pool, row);
  if (!app) return row;
  const since = (at) => (at ? now - new Date(at).getTime() : 0);

  if (row.status === 'pending' || row.status === 'failed') {
    const dnsResult = await checkDns(app, row, resolver);
    if (dnsResult.ok) {
      let next = await setStatus(pool, row.id, 'verified', {
        dns_checked_at: new Date(now), verified_at: new Date(now), last_error: null, failure_count: 0,
      });
      try {
        await provisionEdge(config, app, next);
      } catch (err) {
        log.warn('app-domains', 'Edge provisioning failed', { hostname: row.hostname, err: err.message });
        next = await setStatus(pool, row.id, 'verified', { last_error: 'Getting a certificate failed; trying again.' });
      }
      invalidateHost(row.hostname);
      return next;
    }
    const failures = dnsResult.transient ? row.failure_count : row.failure_count + 1;
    const giveUp = !dnsResult.transient && row.status === 'pending' && since(row.created_at) > GIVE_UP_AFTER_MS;
    const next = await setStatus(pool, row.id, giveUp ? 'failed' : row.status, {
      dns_checked_at: new Date(now), last_error: dnsResult.error, failure_count: failures,
    });
    if (giveUp) await recordEvent(pool, { appId: app.id, hostname: row.hostname, action: 'failed' });
    return next;
  }

  if (row.status === 'verified') {
    const live = await probe(row.hostname);
    if (live.ok) {
      const next = await setStatus(pool, row.id, 'live', {
        live_at: new Date(now), cert_expires_at: live.expiresAt, last_error: null, failure_count: 0,
        dns_checked_at: new Date(now),
      });
      invalidateHost(row.hostname);
      await recordEvent(pool, { appId: app.id, hostname: row.hostname, action: 'live' });
      return next;
    }
    // Keep asking the edge to route it: an Ingress lost to a failed upsert
    // is re-created here rather than waiting on a person.
    await provisionEdge(config, app, row).catch(() => {});
    const waited = since(row.verified_at);
    if (waited > CERT_GIVE_UP_AFTER_MS) {
      const next = await setStatus(pool, row.id, 'failed', {
        last_error: 'Still getting a certificate. Check that the CNAME record is still in place.',
        failure_count: row.failure_count + 1, dns_checked_at: new Date(now),
      });
      await recordEvent(pool, { appId: app.id, hostname: row.hostname, action: 'failed' });
      return next;
    }
    return setStatus(pool, row.id, 'verified', {
      last_error: waited > CERT_SLOW_AFTER_MS ? 'Still getting a certificate.' : null,
      dns_checked_at: new Date(now),
    });
  }

  if (row.status === 'live') {
    const dnsResult = await checkDns(app, row, resolver);
    const live = dnsResult.ok ? await probe(row.hostname) : { ok: false, error: dnsResult.error };
    if (live.ok) {
      return setStatus(pool, row.id, 'live', {
        cert_expires_at: live.expiresAt, last_error: null, failure_count: 0, dns_checked_at: new Date(now),
      });
    }
    if (dnsResult.transient) return setStatus(pool, row.id, 'live', { dns_checked_at: new Date(now) });
    const failures = row.failure_count + 1;
    const failed = failures >= LIVE_FAILURES_BEFORE_FAILED;
    const next = await setStatus(pool, row.id, failed ? 'failed' : 'live', {
      last_error: live.error, failure_count: failures, dns_checked_at: new Date(now),
    });
    if (failed) {
      invalidateHost(row.hostname);
      await recordEvent(pool, { appId: app.id, hostname: row.hostname, action: 'failed' });
    }
    return next;
  }
  return row;
}

/** "Check now": a failed claim starts over; anything else is checked at once. */
async function checkNow(pool, config, row, deps = {}) {
  let current = row;
  if (row.status === 'failed') {
    current = await setStatus(pool, row.id, 'pending', { failure_count: 0, last_error: null, verified_at: null, live_at: null });
  }
  return checkRow(pool, config, current, deps);
}

/** Which rows a sweep at `now` should look at. Pure. */
function selectDue(rows, now = Date.now()) {
  return rows.filter((row) => {
    const checked = row.dns_checked_at ? new Date(row.dns_checked_at).getTime() : 0;
    const age = row.created_at ? now - new Date(row.created_at).getTime() : 0;
    if (row.status === 'pending') {
      const interval = age > SLOW_AFTER_MS ? SLOW_INTERVAL_MS : SWEEP_INTERVAL_MS;
      return now - checked >= interval;
    }
    if (row.status === 'verified') return now - checked >= SWEEP_INTERVAL_MS;
    if (row.status === 'live') return now - checked >= LIVE_RECHECK_MS;
    return false;
  });
}

// ── Admin levers ────────────────────────────────────────────────────────

async function disable(pool, config, row, user) {
  await teardownEdge(config, row).catch((err) => {
    log.warn('app-domains', 'Edge teardown failed on disable', { hostname: row.hostname, err: err.message });
  });
  const next = await setStatus(pool, row.id, 'disabled', { disabled_at: new Date(), disabled_by: user?.id ?? null });
  invalidateHost(row.hostname);
  await recordEvent(pool, { appId: row.app_id, userId: user?.id ?? null, hostname: row.hostname, action: 'disabled' });
  return next;
}

async function enable(pool, row, user) {
  const next = await setStatus(pool, row.id, 'pending', {
    disabled_at: null, disabled_by: null, failure_count: 0, last_error: null, verified_at: null, live_at: null,
  });
  await recordEvent(pool, { appId: row.app_id, userId: user?.id ?? null, hostname: row.hostname, action: 'enabled' });
  return next;
}

async function adminList(pool) {
  const { rows } = await pool.query(
    `SELECT d.id, d.app_id, d.hostname, d.verification_token, d.status, d.dns_checked_at, d.verified_at,
            d.live_at, d.cert_expires_at, d.last_error, d.failure_count, d.created_by, d.created_at,
            d.updated_at, d.disabled_at, d.disabled_by,
            a.slug AS app_slug, a.name AS app_name, u.username AS created_by_username
       FROM app_domains d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN users u ON u.id = d.created_by
      ORDER BY d.created_at DESC`
  );
  return rows;
}

// ── Host resolution for the edge (services/edge-gate.js) ────────────────

const hostCache = new Map();
function boundedSet(map, key, value) {
  if (map.size >= HOST_CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, value);
}
function invalidateHost(hostname) {
  hostCache.delete(String(hostname || '').toLowerCase());
}
function resetCachesForTest() {
  hostCache.clear();
}

/**
 * The app behind a request host. A Homeroom host (<slug>.<apps domain>, a
 * preview) answers from parseAppHost with no database work, exactly as
 * before; anything else is looked up as a LIVE custom domain, through a
 * short cache, and resolves as that app's production host:
 *   { slug, label: slug, host, custom: true }
 * Null for an unknown host, as parseAppHost answers.
 */
async function resolveAppHost(pool, rawHost) {
  const appAccess = require('./app-access');
  const parsed = appAccess.parseAppHost(rawHost);
  if (parsed) return parsed;
  const host = String(rawHost || '').trim().toLowerCase().replace(/:\d+$/, '');
  if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/.test(host)) return null;
  for (const domain of platformDomains()) if (underDomain(host, domain)) return null;
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < HOST_CACHE_TTL_MS) return hit.value;
  const found = await lookupLiveHost(pool, host);
  const value = found ? { slug: found.slug, label: found.slug, host, custom: true } : null;
  boundedSet(hostCache, host, { at: Date.now(), value });
  return value;
}

// ── The sweep ───────────────────────────────────────────────────────────

let intervalHandle = null;
let sweepInFlight = false;
let lastSweepAt = null;
let lastError = null;

async function sweep(config, { now = Date.now() } = {}) {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const pool = getPool(config);
    const { rows } = await pool.query(
      `SELECT ${ROW_COLUMNS} FROM app_domains WHERE status IN ('pending', 'verified', 'live')`
    );
    for (const row of selectDue(rows, now)) {
      try {
        await checkRow(pool, config, row, { now });
      } catch (err) {
        log.warn('app-domains', 'Domain check failed', { hostname: row.hostname, err: err.message });
      }
    }
    lastSweepAt = new Date();
    lastError = null;
  } catch (err) {
    lastError = err.message;
    log.warn('app-domains', 'Sweep failed', { err: err.message });
  } finally {
    sweepInFlight = false;
  }
}

function start(config) {
  if (intervalHandle) return;
  setTimeout(() => { sweep(config); }, 20 * 1000).unref?.();
  intervalHandle = setInterval(() => { sweep(config); }, SWEEP_INTERVAL_MS);
  intervalHandle.unref?.();
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

function getStatus() {
  return { lastSweepAt, lastError, sweepInFlight };
}

/** The row as the API answers it: nothing a client does not need. */
function publicRow(row) {
  if (!row) return null;
  const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
  return {
    hostname: row.hostname,
    status: row.status,
    last_error: row.last_error || null,
    checked_at: iso(row.dns_checked_at),
    verified_at: iso(row.verified_at),
    live_at: iso(row.live_at),
    cert_expires_at: iso(row.cert_expires_at),
    created_at: iso(row.created_at),
  };
}

module.exports = {
  STATUSES,
  TXT_PREFIX,
  TXT_VALUE_PREFIX,
  MAX_CLAIMS_PER_USER_PER_DAY,
  SWEEP_INTERVAL_MS,
  normalizeHostname,
  isHostnameError,
  expectedRecords,
  checkDns,
  forApp,
  byId,
  lookupLiveHost,
  claim,
  remove,
  checkRow,
  checkNow,
  selectDue,
  disable,
  enable,
  adminList,
  resolveAppHost,
  invalidateHost,
  resetCachesForTest,
  probeLive,
  provisionEdge,
  teardownEdge,
  publicRow,
  sweep,
  start,
  stop,
  getStatus,
  _setResolverFactoryForTest(fn) { resolverFactory = fn; },
};
