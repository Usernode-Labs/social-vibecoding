'use strict';

// src/db/schema.sql, src/db/migrate.js, src/services/mail/index.js,
// src/services/mail/events.js: real PostgreSQL identity, retry and retention guarantees.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const events = require('../src/services/mail/events');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('mail migrations are repeatable; callbacks, suppression and retention work against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_events_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  t.after(async () => {
    poolModule.getPool = original; await pool.end();
    await admin.query(`DROP DATABASE ${name}`); await admin.end();
  });
  const config = { databaseUrl: String(url), adminUsername: 'mail-test-admin', adminPassword: 'only-for-tests', selfAppSlug: 'mail-test-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate, seedStagingPlatformMail } = require('../src/db/migrate');
  await migrate(config); await migrate(config);
  const { rows: privacy } = await pool.query("SELECT relname, obj_description(oid) AS comment FROM pg_class WHERE relname IN ('mail_events', 'mail_suppressions')");
  assert.equal(privacy.length, 2); assert.ok(privacy.every((row) => row.comment === 'staging:private'));
  const mail = require('../src/services/mail');
  const sent = [];
  config.mailTransport = { provider: 'http', send: async (payload) => { sent.push(payload); return { providerMessageId: 'receipt-' + sent.length }; } };
  await mail.send(config, { kind: 'project_invite', to: 'Alice@example.invalid', url: 'https://example.invalid/waitlist', messageId: 'caller-cannot-set-identity' });
  const { rows: [delivery] } = await pool.query("SELECT * FROM mail_deliveries WHERE recipient = 'Alice@example.invalid'");
  assert.equal(delivery.status, 'sent'); assert.match(delivery.message_id, /^[a-f0-9]{48}$/);
  assert.equal(delivery.provider_message_id, 'receipt-1'); assert.equal(sent[0].messageId, delivery.message_id);
  const event = (type, bounce) => ({ type, data: { email_id: 'receipt-1', bounce, subject: 'secret body never retained', to: ['wrong@example.invalid'] } });
  await Promise.all(Array.from({ length: 5 }, () => events.ingestResend(pool, event('email.delivered'), 'delivery-event')));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM mail_events')).rows[0].n, 1);
  await events.ingestResend(pool, event('email.bounced', { type: 'Transient' }), 'soft-bounce');
  assert.equal(await events.suppression(pool, 'alice@example.invalid'), null);
  await events.ingestResend(pool, event('email.bounced', { type: 'Permanent' }), 'hard-bounce');
  assert.equal(await events.suppression(pool, 'ALICE@example.invalid'), 'bounce');
  assert.equal(await events.suppression(pool, 'wrong@example.invalid'), null);
  await mail.send(config, { kind: 'otp', to: 'alice@example.invalid', code: '123456' });
  assert.equal(sent.length, 1);
  assert.equal((await pool.query("SELECT status FROM mail_deliveries WHERE kind = 'otp'")).rows[0].status, 'suppressed_bounce');
  assert.equal((await mail.sendTest(config, { to: 'alice@example.invalid' })).status, 'suppressed_bounce');
  await events.ingestResend(pool, event('email.complained'), 'complaint');
  await events.ingestResend(pool, event('email.bounced', { type: 'Permanent' }), 'hard-bounce');
  assert.equal(await events.suppression(pool, 'alice@example.invalid'), 'complaint');
  const { rows: ledger } = await pool.query('SELECT * FROM mail_events');
  assert.doesNotMatch(JSON.stringify(ledger), /secret body|wrong@example|Alice@example/);
  // Transactional events do not enter engagement reports; provider safety
  // still suppresses an address that complains about a transactional mail.
  await pool.query("INSERT INTO mail_deliveries (kind, recipient, provider, status, provider_message_id) VALUES ('otp', 'codes@example.invalid', 'http', 'sent', 'code-receipt')");
  await events.ingestResend(pool, { type: 'email.complained', data: { email_id: 'code-receipt' } }, 'code-complaint');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM mail_events WHERE event_key = 'resend:code-complaint'")).rows[0].n, 0);
  assert.equal(await events.suppression(pool, 'codes@example.invalid'), 'complaint');
  await pool.query("UPDATE mail_deliveries SET created_at = NOW() - INTERVAL '31 days' WHERE id = $1", [delivery.id]);
  assert.equal(await mail.pruneDeliveries(pool), 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM mail_events WHERE delivery_id = $1', [delivery.id])).rows[0].n, 0);
  assert.equal(await events.suppression(pool, 'alice@example.invalid'), 'complaint');
  await t.test('signed clicks, pixels, one-click unsubscribe and unique-message reports', async (t) => {
    const tracking = require('../src/services/mail/tracking');
    const previous = process.env.PLATFORM_MAIL_TRACKING_SECRET;
    process.env.PLATFORM_MAIL_TRACKING_SECRET = 'test-only-tracking-secret';
    t.after(() => { if (previous === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET; else process.env.PLATFORM_MAIL_TRACKING_SECRET = previous; });
    const { rows: [user] } = await pool.query("INSERT INTO users (username, password, email) VALUES ('tracked-reader', 'x', 'tracked@example.invalid') RETURNING id");
    const activityMail = require('../src/services/activity-mail');
    activityMail.init({ sessionSecret: 'test-only-unsubscribe' });
    const payload = { kind: 'build_ready', to: 'tracked@example.invalid', url: 'https://app.onhomeroom.com/#home', unsubscribeUrl: activityMail.unsubscribeUrl(user.id) };
    await mail.send(config, payload);
    const { rows: [tracked] } = await pool.query("SELECT * FROM mail_deliveries WHERE recipient = 'tracked@example.invalid'");
    assert.deepEqual(tracked.tracking_links, [payload.url]);
    assert.equal(sent.at(-1).trackingEnabled, true);
    const message = mail.buildMessage('build_ready', { ...payload, messageId: tracked.message_id, trackingEnabled: true });
    assert.ok(message.html.includes(`/mail/c/${tracked.message_id}/0?s=`));
    assert.ok(message.html.includes(`/mail/o/${tracked.message_id}.gif?s=`));
    assert.ok(message.text.includes(payload.url), 'plain-text action links stay readable');
    assert.ok(message.headers['List-Unsubscribe'].includes(`m=${tracked.message_id}`));
    const express = require('express'); const app = express();
    app.use((req, _res, next) => { req.user = { id: user.id, isAdmin: req.headers['x-test-admin'] !== 'no', canAdminWrite: false }; next(); });
    app.use(require('../src/routes/admin').adminRoutes(config));
    app.use(require('../src/routes/mail-tracking').mailTrackingRoutes(config));
    app.use(require('../src/routes/activity-mail').activityMailRoutes(config));
    const server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const click = `/mail/c/${tracked.message_id}/0?s=${tracking.sign('click:0', tracked.message_id)}`;
    const response = await fetch(base + click + '&url=https://attacker.invalid', { redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), payload.url);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((await fetch(base + click.replace(/s=.*/, 's=bad'), { redirect: 'manual' })).status, 404);
    assert.equal((await fetch(base + click.replace('/0?', '/1?'), { redirect: 'manual' })).status, 404);
    const pixel = `/mail/o/${tracked.message_id}.gif?s=${tracking.sign('open', tracked.message_id)}`;
    for (let i = 0; i < 3; i++) {
      const image = await fetch(base + pixel, { headers: { 'user-agent': 'GoogleImageProxy very-specific-agent' } });
      assert.equal(image.headers.get('content-type'), 'image/gif'); assert.match(image.headers.get('cache-control'), /no-store/);
      const bytes = Buffer.from(await image.arrayBuffer()); assert.equal(bytes.readUInt16LE(6), 1); assert.equal(bytes.readUInt16LE(8), 1);
    }
    await fetch(base + pixel.replace(/s=.*/, 's=bad'));
    const { rows: opens } = await pool.query("SELECT * FROM mail_events WHERE delivery_id = $1 AND type = 'opened'", [tracked.id]);
    assert.equal(opens.length, 3); assert.ok(opens.every((r) => r.user_agent_class === 'image_proxy' && r.meta.proxyOrPrefetch));
    assert.doesNotMatch(JSON.stringify(opens), /very-specific-agent/);
    const off = new URL(message.headers['List-Unsubscribe'].slice(1, -1));
    const getOff = await fetch(base + off.pathname + off.search); const form = await getOff.text();
    assert.ok(form.includes(`m=${tracked.message_id}`));
    assert.equal((await pool.query('SELECT activity_email FROM users WHERE id = $1', [user.id])).rows[0].activity_email, true);
    for (let i = 0; i < 2; i++) assert.equal((await fetch(base + off.pathname + off.search, { method: 'POST', body: 'List-Unsubscribe=One-Click' })).status, 200);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM mail_events WHERE delivery_id = $1 AND type = 'unsubscribed'", [tracked.id])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT activity_email FROM users WHERE id = $1', [user.id])).rows[0].activity_email, false);
    const reports = await require('../src/services/mail/reports').readReports(pool);
    const cohort = reports.byKind.find((r) => r.label === 'build_ready');
    assert.deepEqual([cohort.sent, cohort.tracked_sent, cohort.opened, cohort.clicked, cohort.unsubscribed], [1, 1, 1, 1, 1]);
    assert.equal(reports.trackingEnabled, true); assert.ok(reports.byDay.length);
    const adminRead = await fetch(base + '/api/admin/mail/activity?limit=25');
    assert.equal(adminRead.status, 200, 'read-only admins can see reports');
    assert.deepEqual((await adminRead.json()).reports.byKind, reports.byKind);
    const refused = await fetch(base + '/api/admin/mail/activity', { headers: { 'x-test-admin': 'no' }, redirect: 'manual' });
    assert.equal(refused.status, 302); assert.equal(refused.headers.get('location'), '/');
    assert.ok(reports.recentEvents.some((r) => r.url === payload.url));
    // A signed identity of another mailbox cannot attribute this user's opt-out.
    await tracking.recordUnsubscribe(pool, { userId: user.id, messageId: delivery.message_id, signature: tracking.sign('unsubscribe', delivery.message_id) });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM mail_events WHERE delivery_id = $1 AND type = 'unsubscribed'", [delivery.id])).rows[0].n, 0);
  });
  const envBefore = process.env.USERNODE_ENV; process.env.USERNODE_ENV = 'staging';
  try {
    await seedStagingPlatformMail(pool); await seedStagingPlatformMail(pool);
    const { rows: demo } = await pool.query("SELECT e.meta, d.recipient FROM mail_events e JOIN mail_deliveries d ON d.id = e.delivery_id WHERE event_key = 'staging-demo:delivered'");
    assert.equal(demo.length, 1); assert.equal(demo[0].meta.demo, 'Staging demo'); assert.match(demo[0].recipient, /@example.invalid$/);
  } finally { if (envBefore === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = envBefore; }
});
