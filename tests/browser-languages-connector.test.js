'use strict';

// get_browser_languages (#3659): a full admin's connector reads which
// languages people's browsers ask Homeroom for, to choose the languages
// frontend/locales/config.json ships, and where the translation step stands.
// The count is the console's (/api/admin/analytics/browser-languages); the
// connector reaches it through a route outside /api/admin, which no connector
// token may call, behind the same full-admin gate as the other admin tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');
const policy = require('../src/services/cli-api-policy');
const runner = require('../src/services/language-sync-runner');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function register(user) {
  const handlers = new Map();
  const specs = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); },
  }, {
    accessToken: 'svmcp_test', scopes: [READ_SCOPE, WRITE_SCOPE], user, clientName: 'Claude Code', clientId: 'c1',
    origin: 'https://homeroom.example', baseUrl: 'http://platform.internal',
    pool: null, config: {}, tokenId: 1, grantId: null, delegation: null,
  });
  return { specs, handlers };
}

test('a full admin reads the browser languages and the translation step through the connector', async (t) => {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        days: 30,
        people: 120,
        languages: [{ language: 'id-ID', people: 70 }, { language: 'en-US', people: 40 }, { language: 'es', people: 10 }],
        translation: { enabled: true, checkedSha: 'a'.repeat(40), batch: null, proposal: { prNumber: 4700, status: 'promoted' } },
      }),
    };
  };
  t.after(() => { global.fetch = real; });
  const { specs, handlers } = register({ id: 1, username: 'evan', isAdmin: true, canAdminWrite: true });
  assert.match(specs.get('get_browser_languages').description, /^Admin only\./);
  assert.ok(specs.get('get_browser_languages').description.length <= 1800);
  const out = await handlers.get('get_browser_languages')({ days: 30, includeAdmins: true });
  assert.equal(calls[0], 'http://platform.internal/api/browser-languages?days=30&includeAdmins=true');
  assert.deepEqual(out.structuredContent.languages[0], { language: 'id-ID', people: 70 });
  assert.equal(out.structuredContent.people, 120);
  assert.equal(out.structuredContent.translation.proposal.prNumber, 4700);
});

test('nobody else is offered it, and the route is a full admin\'s read outside /api/admin', () => {
  for (const user of [{ id: 2, username: 'ann' }, { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false }]) {
    assert.ok(!register(user).specs.has('get_browser_languages'), user.username);
  }
  const route = read('src/routes/ui-telemetry.js');
  assert.match(route, /router\.get\('\/api\/browser-languages', requireAdminWrite, sameOriginBrowserOnly,/);
  assert.match(route, /translation: await languageSync\.status\(pool\)/);
  assert.ok(policy.CONNECTOR_ALLOWED_ROUTES.some((r) => r.method === 'GET' && r.pattern === '/api/browser-languages'));
});

test('the translation step\'s status names its batch and its last proposal', async () => {
  const pool = {
    async query(sql, params) {
      if (/platform_settings/.test(sql)) {
        return { rows: [{ value: JSON.stringify({ checkedSha: 'b'.repeat(40), batch: { id: 'msgbatch_1', baseSha: 'b'.repeat(40), submittedAt: '2026-10-10T00:00:00Z', messages: 9000 }, proposal: { sessionId: 12, englishDigest: 'x' } }) }] };
      }
      if (/FROM chat_sessions WHERE id = \$1/.test(sql)) {
        assert.deepEqual(params, [12]);
        return { rows: [{ pr_number: 4700, status: 'merged' }] };
      }
      return { rows: [] };
    },
  };
  assert.deepEqual(await runner.status(pool), {
    enabled: true,
    checkedSha: 'b'.repeat(40),
    batch: { submittedAt: '2026-10-10T00:00:00Z', messages: 9000 },
    proposal: { prNumber: 4700, status: 'merged' },
  });
});
