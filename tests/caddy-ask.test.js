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

// Minimal pg-Pool stub. Apps keyed by slug, staging sessions keyed by
// their exact stored staging_url. Records every query so tests can assert
// we never hit the DB for syntactically-invalid hosts (cheap-path guard).
function makePool({ slugs = [], stagingUrls = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
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

test('approves a staging host that matches a session staging_url exactly', async () => {
  const host = `whiteboard-0d337f--s42--642297.${DOMAIN}`;
  const pool = makePool({ stagingUrls: [`https://${host}`] });
  assert.equal(await isKnownHost(pool, host), true);
});

test('refuses a staging host with no matching session (stale/unknown preview)', async () => {
  const pool = makePool({ stagingUrls: [`https://whiteboard-0d337f--s42--642297.${DOMAIN}`] });
  // Different (superseded) hash → not the current staging_url → refused.
  assert.equal(await isKnownHost(pool, `whiteboard-0d337f--s42--aaaaaa.${DOMAIN}`), false);
});

test('refuses hosts outside USERNODE_DOMAIN without querying the DB', async () => {
  const pool = makePool({ slugs: ['evil'] });
  assert.equal(await isKnownHost(pool, 'evil.attacker.com'), false);
  assert.equal(pool.calls.length, 0);
});

test('refuses multi-level subdomains (wildcard matches one label only)', async () => {
  const pool = makePool({ slugs: ['a'] });
  assert.equal(await isKnownHost(pool, `a.b.${DOMAIN}`), false);
  assert.equal(pool.calls.length, 0);
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
