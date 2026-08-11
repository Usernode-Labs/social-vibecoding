'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const diagnostics = require('../src/services/mobile-push-diagnostics');
const serviceSource = fs.readFileSync(
  path.join(ROOT, 'src/services/mobile-push-diagnostics.js'), 'utf8'
);
const routeSource = fs.readFileSync(path.join(ROOT, 'src/routes/admin.js'), 'utf8');
const consoleSource = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/admin/admin-console.js'), 'utf8'
);
const moduleSource = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/admin/admin-push.js'), 'utf8'
);
const islandSource = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/admin/index.tsx'), 'utf8'
);

test('lookup accepts exact username/email/id text and rejects oversized input', () => {
  assert.equal(diagnostics.normalizeLookup(undefined), null);
  assert.equal(diagnostics.normalizeLookup('  '), null);
  assert.deepEqual(diagnostics.normalizeLookup('  alice  '), {
    query: 'alice', userId: null,
  });
  assert.deepEqual(diagnostics.normalizeLookup('42'), {
    query: '42', userId: 42,
  });
  assert.throws(
    () => diagnostics.normalizeLookup('x'.repeat(diagnostics.MAX_LOOKUP_LENGTH + 1)),
    diagnostics.MobilePushDiagnosticsInputError
  );
});

function diagnosticPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const source = String(sql);
      calls.push({ sql: source, params });
      if (source.includes('FROM mobile_push_deployment_state')) {
        return { rows: [{
          environment: 'production', firebase_project_id: 'usernode-project',
          send_enabled: true, send_not_before: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-10T00:00:00Z',
        }] };
      }
      if (source.includes('COUNT(*)::int AS total')
          && source.includes('FROM mobile_push_registrations')) {
        return { rows: [
          { platform: 'android', total: 1, eligible: 1, last_seen_at: '2026-08-11T10:00:00Z' },
          { platform: 'ios', total: 1, eligible: 1, last_seen_at: '2026-08-11T10:00:00Z' },
        ] };
      }
      if (source.includes("INTERVAL '24 hours'")
          && source.includes('FROM mobile_push_deliveries')) {
        return { rows: [{
          platform: 'ios', status: 'dead',
          last_error_code: 'messaging/registration-token-not-registered',
          total: 1, last_updated_at: '2026-08-11T10:01:00Z',
        }] };
      }
      if (source.includes('SELECT id, username') && source.includes('FROM users')) {
        assert.deepEqual(params, ['alice', null]);
        return { rows: [{ id: 7, username: 'alice' }] };
      }
      if (source.includes('SELECT id, installation_id')
          && source.includes('FROM mobile_push_registrations')) {
        return { rows: [
          {
            id: '21', installation_id: '11111111-1111-1111-1111-111111111111',
            environment: 'production', platform: 'ios', permission_status: 'authorized',
            session_expires_at: '2026-08-12T10:00:00Z',
            last_seen_at: '2026-08-11T10:00:00Z', created_at: '2026-08-10T10:00:00Z',
            updated_at: '2026-08-11T10:00:00Z', delivery_eligible: true,
          },
          {
            id: '22', installation_id: '22222222-2222-2222-2222-222222222222',
            environment: 'production', platform: 'android', permission_status: 'authorized',
            session_expires_at: '2026-08-12T10:00:00Z',
            last_seen_at: '2026-08-11T10:00:00Z', created_at: '2026-08-10T10:00:00Z',
            updated_at: '2026-08-11T10:00:00Z', delivery_eligible: true,
          },
        ] };
      }
      if (source.includes('SELECT policy.category')) {
        return { rows: [{ category: 'direct_interactions', enabled: true }] };
      }
      if (source.includes('WITH recent AS')) {
        const base = {
          notification_id: 91, kind: 'mention', read_at: null,
          notification_created_at: '2026-08-11T10:00:00Z',
          push_category: 'direct_interactions', push_enabled: true,
          delivery_environment: 'production', delivery_attempts: 1,
          delivery_available_at: '2026-08-11T10:00:00Z',
          delivery_expires_at: '2026-08-12T10:00:00Z',
          delivery_created_at: '2026-08-11T10:00:00Z',
          delivery_updated_at: '2026-08-11T10:01:00Z',
        };
        return { rows: [
          {
            ...base, delivery_id: '31', delivery_platform: 'ios',
            delivery_installation_id: '11111111-1111-1111-1111-111111111111',
            delivery_status: 'dead', delivery_sent_at: null,
            delivery_error_code: 'messaging/registration-token-not-registered',
          },
          {
            ...base, delivery_id: '32', delivery_platform: 'android',
            delivery_installation_id: '22222222-2222-2222-2222-222222222222',
            delivery_status: 'sent', delivery_sent_at: '2026-08-11T10:00:01Z',
            delivery_error_code: null,
          },
        ] };
      }
      throw new Error(`Unexpected diagnostics query: ${source}`);
    },
  };
}

test('gather correlates one inbox notification with per-platform outcomes', async () => {
  const pool = diagnosticPool();
  const result = await diagnostics.gather(pool, 'alice');
  assert.equal(result.lookup.found, true);
  assert.equal(result.user.username, 'alice');
  assert.equal(result.notifications.length, 1);
  assert.deepEqual(
    result.notifications[0].deliveries.map((row) => [row.platform, row.status]),
    [['ios', 'dead'], ['android', 'sent']]
  );
  assert.ok(result.diagnostics.some((row) => (
    row.platform === 'ios'
      && row.code === 'messaging/registration-token-not-registered'
      && row.severity === 'error'
  )));
  assert.ok(result.diagnostics.some((row) => (
    row.platform === 'android'
      && row.code === 'provider_accepted'
      && row.severity === 'success'
  )));
});

test('diagnostics queries and UI never expose provider registrations or credentials', () => {
  for (const forbidden of [
    'registration_enc', 'registration_hash', 'private_key',
    'FIREBASE_SERVICE_ACCOUNT_JSON_B64', 'APNS_KEY',
  ]) {
    assert.ok(!serviceSource.includes(forbidden), `${forbidden} must not enter the response path`);
    assert.ok(!moduleSource.includes(forbidden), `${forbidden} must not enter the browser module`);
  }
  assert.ok(!/process\.env/.test(serviceSource), 'the service reads operational tables only');
});

test('admin route is read-only, admin-gated by the existing mount, and value-safe', () => {
  assert.match(routeSource, /router\.use\('\/api\/admin', adminMiddleware\)/);
  const route = routeSource.slice(
    routeSource.indexOf("router.get('/api/admin/mobile-push/diagnostics'"),
    routeSource.indexOf('// ── Container rollover')
  );
  assert.ok(route.length > 0, 'diagnostics route exists');
  assert.ok(!route.includes('requireAdminWrite'), 'view-only admins may diagnose delivery');
  assert.ok(!/router\.(post|put|patch|delete)/.test(route), 'the diagnostics block has no mutation');
  assert.match(route, /enabled: config\.mobilePushEnabled === true/);
  assert.match(route, /firebaseProjectId: config\.firebaseProjectId \|\| null/);
  assert.ok(!route.includes('firebaseServiceAccountJsonB64'));
});

test('Push delivery is a lifecycle-managed admin section', () => {
  assert.match(consoleSource, /key: 'push', label: 'Push delivery', group: 'Operations'/);
  assert.match(consoleSource, /push: 'AdminPush'/);
  assert.ok(islandSource.includes("import './admin-push.js';"));
  assert.match(moduleSource, /render\(hostEl\) \{/);
  assert.match(moduleSource, /destroy\(\) \{/);
  assert.match(moduleSource,
    /if \(typeof window !== 'undefined'\) window\.AdminPush = AdminPush;/);
  assert.match(moduleSource, /username, email address or numeric user ID/);
  assert.match(serviceSource, /device presentation is not confirmed/);
});
