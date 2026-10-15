'use strict';

// Unit tests for the Caddy on-demand-TLS permission gate (isKnownHost).
// This function decides whether Caddy may issue a Let's Encrypt cert for
// a given hostname, so getting it wrong either bricks previews (false
// negatives) or lets arbitrary subdomains burn LE issuance quota for the
// registered domain (false positives). USERNODE_DOMAIN must be set before
// requiring the module under test, since services/caddy.js reads it at
// load time.

const test = require('node:test');
const assert = require('node:assert');

process.env.USERNODE_DOMAIN = process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org';
const DOMAIN = process.env.USERNODE_DOMAIN;

const { isKnownHost } = require('../src/routes/internal');
const caddy = require('../src/services/caddy');

// Minimal pg-Pool stub. Apps keyed by slug, staging sessions keyed by
// their exact stored staging_url. Records every query so tests can assert
// we never hit the DB for syntactically-invalid hosts (cheap-path guard).
function makePool({ slugs = [], stagingUrls = [], customHosts = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM app_domains WHERE hostname = \$1 AND status IN \('verified', 'live'\)/.test(sql)) {
        const status = customHosts[params[0]];
        return { rowCount: status === 'verified' || status === 'live' ? 1 : 0, rows: [] };
      }
      if (/FROM apps WHERE slug/.test(sql)) {
        return { rowCount: slugs.includes(params[0]) ? 1 : 0, rows: [] };
      }
      if (/FROM chat_sessions WHERE staging_url/.test(sql)) {
        return { rowCount: stagingUrls.includes(params[0]) ? 1 : 0, rows: [] };
      }
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('approves the apex domain without touching the DB', async () => {
  const pool = makePool();
  assert.equal(await isKnownHost(pool, DOMAIN), true);
  assert.equal(pool.calls.length, 0);
});

test('approves a known production app slug', async () => {
  const pool = makePool({ slugs: ['whiteboard-0d337f'] });
  assert.equal(await isKnownHost(pool, `whiteboard-0d337f.${DOMAIN}`), true);
});

test('refuses an unknown production app slug', async () => {
  const pool = makePool({ slugs: ['whiteboard-0d337f'] });
  assert.equal(await isKnownHost(pool, `nope-123456.${DOMAIN}`), false);
});

test('stagingHostname is stable per session (no commit hash)', () => {
  // The hostname must depend only on slug + session label so redeploys of
  // the same session reuse the same hostname (and thus the same cert).
  assert.equal(
    caddy.stagingHostname('whiteboard-0d337f', 's42'),
    `whiteboard-0d337f--s42.${DOMAIN}`,
  );
});

test('warmCert resolves ok=false (no network) for empty/invalid hostnames', async () => {
  // Guard path must resolve (never reject/hang) and report not-ready without
  // attempting a connection, so the deploy path can `await` it unconditionally.
  for (const bad of ['', undefined, null]) {
    const r = await caddy.warmCert(bad);
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof Error);
  }
});

test('approves a stable (hashless) staging host matching staging_url', async () => {
  const host = caddy.stagingHostname('whiteboard-0d337f', 's42');
  const pool = makePool({ stagingUrls: [`https://${host}`] });
  assert.equal(await isKnownHost(pool, host), true);
});

test('approves a legacy hashed staging host that matches staging_url exactly', async () => {
  const host = `whiteboard-0d337f--s42--642297.${DOMAIN}`;
  const pool = makePool({ stagingUrls: [`https://${host}`] });
  assert.equal(await isKnownHost(pool, host), true);
});

test('refuses a staging host with no matching session (stale/unknown preview)', async () => {
  const pool = makePool({ stagingUrls: [`https://whiteboard-0d337f--s42--642297.${DOMAIN}`] });
  // Different (superseded) hash → not the current staging_url → refused.
  assert.equal(await isKnownHost(pool, `whiteboard-0d337f--s42--aaaaaa.${DOMAIN}`), false);
});

test('a host outside USERNODE_DOMAIN is a custom domain (#4405): approved only once its claim is verified', async () => {
  const pool = makePool({ slugs: ['evil'], customHosts: {
    'app.example.com': 'live', 'soon.example.com': 'verified', 'waiting.example.com': 'pending',
    'gone.example.com': 'failed', 'off.example.com': 'disabled',
  } });
  assert.equal(await isKnownHost(pool, 'evil.attacker.com'), false, 'nobody’s claim');
  assert.equal(await isKnownHost(pool, 'app.example.com'), true, 'served already');
  assert.equal(await isKnownHost(pool, 'APP.example.com:443'), true);
  assert.equal(await isKnownHost(pool, 'soon.example.com'), true, 'DNS proved, so the certificate may be issued');
  assert.equal(await isKnownHost(pool, 'waiting.example.com'), false, 'not proved yet: no certificate');
  assert.equal(await isKnownHost(pool, 'gone.example.com'), false);
  assert.equal(await isKnownHost(pool, 'off.example.com'), false);
  // Only the one indexed probe, never the slug lookup, for a foreign host.
  assert.ok(pool.calls.every((c) => /FROM app_domains/.test(c.sql)));
});

test('a foreign host that could never be a claim is refused without querying the DB', async () => {
  const pool = makePool({ slugs: ['evil'] });
  assert.equal(await isKnownHost(pool, 'not a host'), false);
  assert.equal(await isKnownHost(pool, 'localhost'), false, 'no dot');
  assert.equal(await isKnownHost(pool, `deeper.under.${DOMAIN}`), false, 'under the platform domain is never a custom domain');
  assert.equal(pool.calls.length, 0);
});

test('refuses multi-level subdomains (wildcard matches one label only)', async () => {
  const pool = makePool({ slugs: ['a'] });
  assert.equal(await isKnownHost(pool, `a.b.${DOMAIN}`), false);
  assert.equal(pool.calls.length, 0);
});

test('the Caddyfile asks before any on-demand certificate, and only its custom-domain site is on demand', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const caddyfile = fs.readFileSync(path.join(__dirname, '..', 'Caddyfile'), 'utf8');
  const globals = caddyfile.slice(caddyfile.indexOf('{\n\tgrace_period'), caddyfile.indexOf('\n}\n') + 3);
  assert.match(globals, /on_demand_tls \{\s*ask http:\/\/usernode:3000\/__caddy\/ask\s*\}/, 'the ask is the platform’s /__caddy/ask');
  const siteStart = caddyfile.indexOf('\nhttps:// {');
  assert.ok(siteStart > 0, 'the catch-all site');
  const onDemand = [...caddyfile.matchAll(/\n\t\ton_demand\n/g)].map((m) => m.index);
  assert.equal(onDemand.length, 1, 'on-demand issuance in one site, and no other');
  assert.ok(onDemand[0] > siteStart, 'that site is the catch-all');
  const site = caddyfile.slice(siteStart);
  assert.match(site, /header_up X-Usernode-Gate caddy/, 'asks the gate for the container');
  assert.match(site, /copy_headers X-Usernode-Identity X-Usernode-Upstream X-Usernode-Applink/);
  assert.match(site, /reverse_proxy \{http\.request\.header\.X-Usernode-Upstream\}:3000/);
  assert.match(site, /header_up -X-Usernode-Upstream/, 'the app never sees the gate’s material');
  assert.match(site, /header_up -X-Usernode-Identity/);
  assert.match(site, /request_header @edge_identity X-Usernode-Token \{http\.request\.header\.X-Usernode-Identity\}/);
  assert.match(site, /@platform_assets path \/usernode-bridge\/\* \/usernode-native\/\* \/usernode-tailwind\/\*/, 'the three centrally hosted trees on the custom origin');
});

test('handles empty / missing domain gracefully', async () => {
  const pool = makePool();
  assert.equal(await isKnownHost(pool, ''), false);
  assert.equal(await isKnownHost(pool, undefined), false);
  assert.equal(pool.calls.length, 0);
});

test('is case-insensitive and ignores a port suffix', async () => {
  const pool = makePool({ slugs: ['whiteboard-0d337f'] });
  assert.equal(await isKnownHost(pool, `WhiteBoard-0d337f.${DOMAIN.toUpperCase()}:443`), true);
});
