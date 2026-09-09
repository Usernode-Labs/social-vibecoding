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
// `.tsx` since #1120 slice 10 — the section renders in React now. Every
// assertion below is about the module's CONTENT (what it must show an
// operator, and what it must never receive), which the renderer does not
// change; only the path, the import line and the two shape regexes moved.
const MODULE_EXT = ['tsx', 'js'].find((ext) => fs.existsSync(
  path.join(ROOT, `frontend/src/features/admin/admin-push.${ext}`)
));
const moduleSource = fs.readFileSync(
  path.join(ROOT, `frontend/src/features/admin/admin-push.${MODULE_EXT}`), 'utf8'
);
const islandSource = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/admin/index.tsx'), 'utf8'
) + fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/admin/sections.ts'), 'utf8'
);

test('lookup accepts exact username/email/id text and rejects oversized input', () => {
  assert.equal(diagnostics.RECENT_REGISTRATION_EVENT_LIMIT, 50);
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
      if (source.includes('FROM mobile_push_registration_events')) {
        assert.deepEqual(params, [7]);
        return { rows: [{
          id: '41', registration_id: '21', environment: 'production',
          installation_id: '11111111-1111-1111-1111-111111111111',
          platform: 'ios', permission_status: 'authorized',
          event_kind: 'provider_invalidated',
          reason_code: 'messaging/registration-token-not-registered',
          created_at: '2026-08-11T10:02:00Z',
        }] };
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
  assert.deepEqual(result.registrationEvents, [{
    id: '41',
    registrationId: '21',
    environment: 'production',
    installationId: '11111111-1111-1111-1111-111111111111',
    platform: 'ios',
    permissionStatus: 'authorized',
    eventKind: 'provider_invalidated',
    reasonCode: 'messaging/registration-token-not-registered',
    createdAt: '2026-08-11T10:02:00Z',
  }]);
  const eventQuery = pool.calls.find(({ sql }) => (
    sql.includes('FROM mobile_push_registration_events')
  ));
  assert.match(eventQuery.sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(eventQuery.sql, /LIMIT 50/);
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

test('diagnostics do not infer missing historical delivery state from current registrations', () => {
  const diagnosticsRows = diagnostics.diagnose(
    [{ platform: 'ios', delivery_eligible: true, permission_status: 'authorized' }],
    [{ kind: 'mention', deliveries: [] }]
  );
  const missing = diagnosticsRows.find((row) => (
    row.platform === 'ios' && row.area === 'delivery'
  ));
  assert.equal(missing.code, 'delivery_missing');
  assert.match(missing.message, /cannot determine whether one was never created or was later removed/);
  assert.doesNotMatch(missing.message, /was not eligible|because no eligible/);
});

test('pending, sending and cancelled delivery copy states only what Social recorded', () => {
  const notification = (status, errorCode = null) => [{
    kind: 'mention',
    deliveries: [{
      platform: 'ios', status, errorCode, attempts: 0,
      createdAt: '2026-08-11T10:00:00Z',
    }],
  }];
  const pending = diagnostics.diagnose([], notification('pending'))
    .find((row) => row.platform === 'ios' && row.area === 'delivery');
  assert.equal(pending.code, 'provider_retrying');
  assert.match(pending.message, /queued or waiting for retry/);

  const sending = diagnostics.diagnose([], notification('sending'))
    .find((row) => row.platform === 'ios' && row.area === 'delivery');
  assert.match(sending.message, /marked .* as sending; no FCM acceptance is recorded/);

  const cancelled = diagnostics.diagnose([], notification('cancelled', 'sender_interrupted'))
    .find((row) => row.platform === 'ios' && row.area === 'delivery');
  assert.match(cancelled.message, /no FCM acceptance is recorded/);
  assert.doesNotMatch(cancelled.message, /before provider acceptance/);
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
  assert.ok(islandSource.includes(`import './admin-push.${MODULE_EXT}';`));
  assert.match(moduleSource, /render\(\w+(?:: [\w.<>[\] |]+)?\) \{/);
  assert.match(moduleSource, /destroy\(\) \{/);
  assert.match(moduleSource,
    /if \(typeof window !== 'undefined'\) \(?window(?: as any\))?\.AdminPush = AdminPush;/);
  assert.match(moduleSource, /username, email address or numeric user ID/);
  assert.match(serviceSource, /device presentation is not confirmed/);
  assert.match(moduleSource, /Recent registration lifecycle/);
  assert.match(moduleSource, /Short-lived, best-effort debugging history/);
  assert.match(moduleSource, /missing events do not prove that nothing happened/);
  assert.match(moduleSource, /FCM acceptance does not confirm device receipt/);
  assert.match(moduleSource, /No retained delivery row is available/);
  assert.match(moduleSource, /event\.registrationId/);
  assert.match(moduleSource, /event\.permissionStatus/);
  assert.doesNotMatch(moduleSource, /event\.firebaseProjectId|event\.previousPermissionStatus/);
});
