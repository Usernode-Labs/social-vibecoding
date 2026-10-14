'use strict';

// Custom domains (#4405): the pure half of services/app-domains.js.
//
//   * what a hostname may be (lower-case ASCII, a subdomain, nobody's
//     platform domain, never an IP or a dev host);
//   * the two records a claim needs;
//   * what the DNS check concludes from what the resolver answers, and which
//     outcomes are "not yet" versus "the resolver was unreachable";
//   * the sweep's cadence (every minute, every ten after a day, a live host
//     once a day);
//   * the status machine, one transition at a time, over a pool stub;
//   * resolveAppHost: a Homeroom host never reaches the table, a live custom
//     host resolves as the app's production address, and unknown hosts are
//     cached as unknown;
//   * the notices panel's lines.
//
// Run with: node --test tests/app-domains.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';
delete process.env.APP_RUNTIME;
const DOMAIN = process.env.USERNODE_DOMAIN;

const appDomains = require('../src/services/app-domains');
const notices = require('../src/services/app-notices');
const { EVENT_TYPES } = require('../src/services/events');

const APP = { id: 42, slug: 'bread-bot-3e3f5c', name: 'Bread Bot', runtime_name: 'sv-app-42-bread-bot-3e3f5c' };
const ROW = { id: 7, app_id: 42, hostname: 'app.example.com', verification_token: 'a'.repeat(32), status: 'pending' };

// ── Hostnames ───────────────────────────────────────────────────────────

test('a hostname is normalised to lower-case ASCII without scheme, path or trailing dot', () => {
  assert.equal(appDomains.normalizeHostname(' APP.Example.com. '), 'app.example.com');
  assert.equal(appDomains.normalizeHostname('https://www.foo.org/some/path'), 'www.foo.org');
  assert.equal(appDomains.normalizeHostname('bücher.shop.de'), 'xn--bcher-kva.shop.de');
});

test('refusals name their reason: apex, platform domain, not a domain at all', () => {
  const code = (value) => { try { appDomains.normalizeHostname(value); return null; } catch (err) { return err.code; } };
  assert.equal(code('example.com'), 'apex_unsupported', 'a CNAME cannot sit at a zone apex');
  assert.equal(code(`bread-bot.${DOMAIN}`), 'platform_domain', 'the apps domain is Homeroom’s');
  assert.equal(code(DOMAIN), 'platform_domain', 'the platform itself');
  assert.equal(code('1.2.3.4'), 'invalid_hostname');
  assert.equal(code('[::1]'), 'invalid_hostname');
  assert.equal(code('*.example.com'), 'invalid_hostname');
  assert.equal(code('app.localhost'), 'invalid_hostname');
  assert.equal(code('x.y.example'), 'invalid_hostname', 'reserved TLDs never resolve');
  assert.equal(code(''), 'invalid_hostname');
  assert.equal(code('not a host'), 'invalid_hostname');
  assert.equal(code('-bad.example.com'), 'invalid_hostname');
  assert.ok(appDomains.isHostnameError(Object.assign(new Error(), { code: 'apex_unsupported' })));
  assert.ok(!appDomains.isHostnameError(Object.assign(new Error(), { code: 'hostname_taken' })));
});

test('the two records: a CNAME to the app’s Homeroom host and a TXT under _homeroom', () => {
  assert.deepEqual(appDomains.expectedRecords(APP, ROW), [
    { type: 'CNAME', name: 'app.example.com', value: `bread-bot-3e3f5c.${DOMAIN}` },
    { type: 'TXT', name: '_homeroom.app.example.com', value: `homeroom-verify=${'a'.repeat(32)}` },
  ]);
});

// ── DNS ─────────────────────────────────────────────────────────────────

function resolver({ cname, txt } = {}) {
  const answer = (value) => {
    if (value instanceof Error) return Promise.reject(value);
    return Promise.resolve(value);
  };
  return { resolveCname: () => answer(cname), resolveTxt: () => answer(txt) };
}
const notFound = () => Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
const timeout = () => Object.assign(new Error('slow'), { code: 'ETIMEOUT' });

test('both records answering as expected verifies the claim', async () => {
  const r = await appDomains.checkDns(APP, ROW, resolver({
    cname: [`Bread-Bot-3e3f5c.${DOMAIN}.`],
    txt: [['other'], ['homeroom-', `verify=${'a'.repeat(32)}`]],
  }));
  assert.deepEqual(r, { ok: true });
});

test('a missing, wrong or mismatching record says which, in one sentence', async () => {
  assert.deepEqual(await appDomains.checkDns(APP, ROW, resolver({ cname: notFound() })),
    { ok: false, error: 'No CNAME record found for app.example.com.', transient: false });
  assert.deepEqual(await appDomains.checkDns(APP, ROW, resolver({ cname: ['other.example.net'] })),
    { ok: false, error: `The CNAME for app.example.com points to other.example.net, not bread-bot-3e3f5c.${DOMAIN}.`, transient: false });
  assert.deepEqual(await appDomains.checkDns(APP, ROW, resolver({ cname: [`bread-bot-3e3f5c.${DOMAIN}`], txt: notFound() })),
    { ok: false, error: 'The TXT record _homeroom.app.example.com is missing or does not match.', transient: false });
  assert.deepEqual(await appDomains.checkDns(APP, ROW, resolver({ cname: [`bread-bot-3e3f5c.${DOMAIN}`], txt: [['homeroom-verify=wrong']] })),
    { ok: false, error: 'The TXT record _homeroom.app.example.com is missing or does not match.', transient: false });
});

test('a resolver timeout is transient: reported, never counted against the claim', async () => {
  const r = await appDomains.checkDns(APP, ROW, resolver({ cname: timeout() }));
  assert.equal(r.ok, false);
  assert.equal(r.transient, true);
  assert.equal(r.error, 'DNS lookup timed out.');
});

// ── Cadence ─────────────────────────────────────────────────────────────

test('the sweep: pending every minute, every ten after a day; verified every minute; live daily', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  const rows = [
    { id: 1, status: 'pending', created_at: at(5), dns_checked_at: at(2) },
    { id: 2, status: 'pending', created_at: at(5), dns_checked_at: at(0.5) },
    { id: 3, status: 'pending', created_at: at(25 * 60), dns_checked_at: at(5) },
    { id: 4, status: 'pending', created_at: at(25 * 60), dns_checked_at: at(11) },
    { id: 5, status: 'verified', created_at: at(5), dns_checked_at: at(2) },
    { id: 6, status: 'live', created_at: at(5), dns_checked_at: at(23 * 60) },
    { id: 7, status: 'live', created_at: at(5), dns_checked_at: at(25 * 60) },
    { id: 8, status: 'failed', created_at: at(5), dns_checked_at: null },
    { id: 9, status: 'disabled', created_at: at(5), dns_checked_at: null },
    { id: 10, status: 'pending', created_at: at(5), dns_checked_at: null },
  ];
  assert.deepEqual(appDomains.selectDue(rows, now).map((r) => r.id), [1, 4, 5, 7, 10]);
});

// ── The status machine, over a pool stub ────────────────────────────────

function poolWith(row) {
  const state = { row: { ...row, failure_count: row.failure_count || 0 }, events: [] };
  const pool = {
    async query(sql, params = []) {
      if (/SELECT id, slug, name, runtime_name FROM apps WHERE id/.test(sql)) return { rows: [APP] };
      if (/^UPDATE app_domains SET/.test(sql)) {
        const sets = sql.match(/SET (.*) WHERE/s)[1].split(', ');
        for (const part of sets) {
          const m = part.trim().match(/^(\w+) = \$(\d+)$/);
          if (m) state.row[m[1]] = params[Number(m[2]) - 1];
        }
        return { rows: [{ ...state.row }] };
      }
      if (/INSERT INTO events/.test(sql)) {
        const raw = params.find((v) => typeof v === 'string' && v.startsWith('{'));
        state.events.push({ type: params.find((v) => typeof v === 'string' && !v.startsWith('{')), metadata: JSON.parse(raw) });
        return { rows: [{ id: state.events.length }] };
      }
      throw new Error(`app-domains stub: unexpected query: ${sql}`);
    },
  };
  return { pool, state };
}
const config = { appRuntime: 'docker' };
const liveProbe = async () => ({ ok: true, expiresAt: new Date('2027-01-01T00:00:00Z'), error: null });
const noCert = async () => ({ ok: false, expiresAt: null, error: 'The edge has not got a certificate for this address yet.' });
const good = () => resolver({ cname: [`bread-bot-3e3f5c.${DOMAIN}`], txt: [[`homeroom-verify=${'a'.repeat(32)}`]] });

test('pending → verified once both records answer; the error clears', async () => {
  const { pool, state } = poolWith({ ...ROW, last_error: 'No CNAME record found for app.example.com.', failure_count: 3 });
  const next = await appDomains.checkRow(pool, config, state.row, { resolver: good(), probe: noCert });
  assert.equal(next.status, 'verified');
  assert.equal(next.last_error, null);
  assert.equal(next.failure_count, 0);
  assert.ok(next.verified_at instanceof Date);
});

test('pending stays pending with the sentence that says why, and gives up after a week', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const { pool, state } = poolWith({ ...ROW, created_at: new Date(now - 60000).toISOString() });
  let next = await appDomains.checkRow(pool, config, state.row, { now, resolver: resolver({ cname: notFound() }) });
  assert.equal(next.status, 'pending');
  assert.equal(next.last_error, 'No CNAME record found for app.example.com.');
  assert.equal(next.failure_count, 1);
  // A transient failure is recorded but not counted.
  next = await appDomains.checkRow(pool, config, state.row, { now, resolver: resolver({ cname: timeout() }) });
  assert.equal(next.failure_count, 1);
  assert.equal(next.last_error, 'DNS lookup timed out.');
  // A week in: failed, and on the record.
  state.row.created_at = new Date(now - 8 * 24 * 3600 * 1000).toISOString();
  next = await appDomains.checkRow(pool, config, state.row, { now, resolver: resolver({ cname: notFound() }) });
  assert.equal(next.status, 'failed');
  assert.deepEqual(state.events.map((e) => e.metadata.action), ['failed']);
  assert.equal(state.events[0].type, EVENT_TYPES.APP_DOMAIN_CHANGED);
});

test('verified → live once the edge serves a certificate for the host, on the record', async () => {
  const { pool, state } = poolWith({ ...ROW, status: 'verified', verified_at: new Date().toISOString() });
  const next = await appDomains.checkRow(pool, config, state.row, { probe: liveProbe });
  assert.equal(next.status, 'live');
  assert.equal(next.cert_expires_at.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.ok(next.live_at instanceof Date);
  assert.deepEqual(state.events.map((e) => e.metadata), [{ hostname: 'app.example.com', action: 'live' }]);
});

test('verified waits quietly, says so after half an hour, and gives up after a day', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const { pool, state } = poolWith({ ...ROW, status: 'verified', verified_at: new Date(now - 5 * 60000).toISOString() });
  let next = await appDomains.checkRow(pool, config, state.row, { now, probe: noCert });
  assert.equal(next.status, 'verified');
  assert.equal(next.last_error, null);
  state.row.verified_at = new Date(now - 45 * 60000).toISOString();
  next = await appDomains.checkRow(pool, config, state.row, { now, probe: noCert });
  assert.equal(next.last_error, 'Still getting a certificate.');
  state.row.verified_at = new Date(now - 25 * 3600 * 1000).toISOString();
  next = await appDomains.checkRow(pool, config, state.row, { now, probe: noCert });
  assert.equal(next.status, 'failed');
  assert.match(next.last_error, /Still getting a certificate/);
});

test('live stays live while the records and the certificate hold; fails after three misses', async () => {
  const { pool, state } = poolWith({ ...ROW, status: 'live', live_at: new Date().toISOString() });
  let next = await appDomains.checkRow(pool, config, state.row, { resolver: good(), probe: liveProbe });
  assert.equal(next.status, 'live');
  assert.equal(next.failure_count, 0);
  for (let i = 1; i <= 3; i += 1) {
    next = await appDomains.checkRow(pool, config, state.row, { resolver: resolver({ cname: notFound() }), probe: liveProbe });
    assert.equal(next.failure_count, i);
    assert.equal(next.status, i < 3 ? 'live' : 'failed');
  }
  assert.equal(next.last_error, 'No CNAME record found for app.example.com.');
  assert.deepEqual(state.events.map((e) => e.metadata.action), ['failed']);
});

test('Check now on a failed claim starts it over', async () => {
  const { pool, state } = poolWith({ ...ROW, status: 'failed', failure_count: 9, last_error: 'old' });
  const next = await appDomains.checkNow(pool, config, state.row, { resolver: resolver({ cname: notFound() }) });
  assert.equal(next.status, 'pending');
  assert.equal(next.failure_count, 1, 'reset, then this check’s miss');
  assert.equal(next.last_error, 'No CNAME record found for app.example.com.');
});

test('the API row carries what the dialog draws and nothing else', () => {
  const row = appDomains.publicRow({ ...ROW, dns_checked_at: new Date('2026-10-08T12:00:00Z'), created_by: 5, disabled_by: null });
  assert.deepEqual(Object.keys(row).sort(), ['cert_expires_at', 'checked_at', 'created_at', 'hostname', 'last_error', 'live_at', 'status', 'verified_at']);
  assert.equal(row.checked_at, '2026-10-08T12:00:00.000Z');
  assert.ok(!('verification_token' in row));
  assert.equal(appDomains.publicRow(null), null);
});

// ── Host resolution for the gate ────────────────────────────────────────

test('resolveAppHost: a Homeroom host never touches the table; a live custom host is the app’s production address', async () => {
  appDomains.resetCachesForTest();
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push(params[0]);
      assert.match(sql, /FROM app_domains d JOIN apps a[\s\S]*d\.status = 'live'/);
      return { rows: params[0] === 'app.example.com' ? [{ app_id: 42, slug: 'bread-bot-3e3f5c', name: 'Bread Bot' }] : [] };
    },
  };
  assert.deepEqual(await appDomains.resolveAppHost(pool, `bread-bot-3e3f5c.${DOMAIN}`),
    { slug: 'bread-bot-3e3f5c', label: 'bread-bot-3e3f5c', host: `bread-bot-3e3f5c.${DOMAIN}` });
  assert.deepEqual(await appDomains.resolveAppHost(pool, `bread-bot-3e3f5c--s42.${DOMAIN}`),
    { slug: 'bread-bot-3e3f5c', label: 'bread-bot-3e3f5c--s42', host: `bread-bot-3e3f5c--s42.${DOMAIN}` });
  assert.equal(await appDomains.resolveAppHost(pool, DOMAIN), null);
  assert.equal(await appDomains.resolveAppHost(pool, `a.b.${DOMAIN}`), null, 'deeper under the apps domain is nobody’s');
  assert.deepEqual(queries, [], 'no database work for a Homeroom host');

  assert.deepEqual(await appDomains.resolveAppHost(pool, 'App.Example.com:443'),
    { slug: 'bread-bot-3e3f5c', label: 'bread-bot-3e3f5c', host: 'app.example.com', custom: true });
  assert.equal(await appDomains.resolveAppHost(pool, 'nobody.example.com'), null);
  assert.equal(await appDomains.resolveAppHost(pool, 'nobody.example.com'), null);
  assert.deepEqual(queries, ['app.example.com', 'nobody.example.com'], 'the second miss came from the cache');
  appDomains.invalidateHost('nobody.example.com');
  await appDomains.resolveAppHost(pool, 'nobody.example.com');
  assert.equal(queries.length, 3, 'invalidated, it is asked again');
  assert.equal(await appDomains.resolveAppHost(pool, 'not a host'), null);
  assert.equal(await appDomains.resolveAppHost(pool, ''), null);
  assert.equal(queries.length, 3);
});

// ── The notices panel ───────────────────────────────────────────────────

test('each domain change reads as a line; the sweep’s verdicts name nobody', () => {
  const at = new Date('2026-09-27T10:00:00Z');
  const row = (action) => notices.settingsLine({
    event_type: 'app_domain_changed', metadata: { hostname: 'app.example.com', action }, username: 'ada', created_at: at,
  });
  assert.deepEqual(row('added'), { kind: 'domain', text: 'Custom domain app.example.com added', by: 'ada', at: at.toISOString() });
  assert.deepEqual(row('live'), { kind: 'domain', text: 'Custom domain app.example.com is live', by: null, at: at.toISOString() });
  assert.equal(row('removed').text, 'Custom domain app.example.com removed');
  assert.equal(row('removed').by, 'ada');
  assert.equal(row('failed').by, null);
  assert.equal(row('disabled').text, 'Custom domain app.example.com disabled by an admin');
  assert.equal(row('enabled').text, 'Custom domain app.example.com enabled again');
  assert.equal(row('bogus'), null);
  assert.equal(notices.settingsLine({ event_type: 'app_domain_changed', metadata: {}, username: 'ada', created_at: at }), null);
  assert.equal(EVENT_TYPES.APP_DOMAIN_CHANGED, 'app_domain_changed');
});
