'use strict';

// Email and text opt-ins (#6044, src/services/contact-preferences.js): the
// three choices Settings › Privacy › Email & texts shows, what saving each
// one writes, the proof of consent every change leaves, and the sign-up
// form's boxes. No live Postgres: a small in-memory pool answers the queries
// the service makes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const prefs = require('../src/services/contact-preferences');

function memoryPool({ user = {}, phone = null, consent = null } = {}) {
  const state = {
    user: { email: 'ada@example.test', email_confirmed: true, marketing_email: false, activity_email: true, ...user },
    phone,
    consent,
    events: [],
    calls: [],
  };
  return {
    state,
    async query(sql, params = []) {
      state.calls.push(sql);
      if (/FROM users u\s+LEFT JOIN user_phone_identities/.test(sql)) {
        return { rows: state.user ? [{ ...state.user, phone_e164: state.phone }] : [] };
      }
      if (/SELECT opted_in_at, opted_out_at FROM sms_marketing_consents/.test(sql)) {
        return { rows: state.consent ? [state.consent] : [] };
      }
      if (/UPDATE users SET marketing_email/.test(sql)) { state.user.marketing_email = params[0]; return { rows: [] }; }
      if (/UPDATE users SET activity_email/.test(sql)) { state.user.activity_email = params[0]; return { rows: [] }; }
      if (/INSERT INTO sms_marketing_consents \(phone_e164, user_id, opted_in_at/.test(sql)) {
        state.consent = { ...(state.consent || {}), opted_in_at: new Date(Date.now() + 1000).toISOString() };
        return { rows: [] };
      }
      if (/INSERT INTO sms_marketing_consents \(phone_e164, opted_out_at/.test(sql)) {
        state.consent = { ...(state.consent || {}), opted_out_at: new Date(Date.now() + 2000).toISOString() };
        return { rows: [] };
      }
      if (/INSERT INTO contact_consent_events/.test(sql)) {
        const [userId, channel, granted, source, wording, email, phoneE164] = params;
        state.events.push({ userId, channel, granted, source, wording, email, phone: phoneE164 });
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

test('defaults: news by email and by text off, activity emails on', async () => {
  const pool = memoryPool({ phone: '+41791234567' });
  assert.deepEqual(await prefs.read(pool, 7), {
    marketingEmail: false,
    activityEmail: true,
    marketingSms: false,
    email: true,
    phone: '•••• 4567',
  });
});

test('no account reads null', async () => {
  const pool = memoryPool();
  pool.state.user = null;
  assert.equal(await prefs.read(pool, 7), null);
});

test('switching news by email on saves it and records the consent with its wording', async () => {
  const pool = memoryPool();
  const out = await prefs.update(pool, 7, { marketingEmail: true }, { source: 'settings' });
  assert.equal(out.marketingEmail, true);
  assert.deepEqual(pool.state.events, [{
    userId: 7, channel: 'marketing_email', granted: true, source: 'settings',
    wording: prefs.WORDING.marketing_email, email: 'ada@example.test', phone: null,
  }]);
});

test('a choice that already has the value records nothing', async () => {
  const pool = memoryPool();
  await prefs.update(pool, 7, { activityEmail: true });
  assert.equal(pool.state.events.length, 0);
});

test('turning activity emails off is recorded as a withdrawal', async () => {
  const pool = memoryPool();
  const out = await prefs.update(pool, 7, { activityEmail: false });
  assert.equal(out.activityEmail, false);
  assert.equal(pool.state.events[0].channel, 'activity_email');
  assert.equal(pool.state.events[0].granted, false);
});

test('news by email needs a confirmed address', async () => {
  const pool = memoryPool({ user: { email_confirmed: false } });
  await assert.rejects(prefs.update(pool, 7, { marketingEmail: true }), (err) => err.code === 'no_email');
  assert.equal(pool.state.events.length, 0);
});

test('news by text needs a verified number', async () => {
  const pool = memoryPool();
  await assert.rejects(prefs.update(pool, 7, { marketingSms: true }), (err) => err.code === 'no_phone');
});

test('news by text: on writes the per-number consent, off writes the opt-out a STOP writes', async () => {
  const pool = memoryPool({ phone: '+41791234567' });
  let out = await prefs.update(pool, 7, { marketingSms: true });
  assert.equal(out.marketingSms, true);
  out = await prefs.update(pool, 7, { marketingSms: false });
  assert.equal(out.marketingSms, false);
  assert.deepEqual(pool.state.events.map((e) => [e.channel, e.granted, e.phone]), [
    ['marketing_sms', true, '+41791234567'],
    ['marketing_sms', false, '+41791234567'],
  ]);
});

test('a new yes after a STOP turns texts back on', async () => {
  const pool = memoryPool({
    phone: '+41791234567',
    consent: { opted_in_at: '2026-01-01T00:00:00Z', opted_out_at: '2026-02-01T00:00:00Z' },
  });
  assert.equal((await prefs.read(pool, 7)).marketingSms, false);
  const out = await prefs.update(pool, 7, { marketingSms: true });
  assert.equal(out.marketingSms, true);
});

test('sign-up: only ticked boxes are saved, and recorded as given at sign-up', async () => {
  const pool = memoryPool({ phone: '+41791234567' });
  await prefs.recordSignupChoices(pool, 7, { marketingEmail: true, marketingSms: false });
  assert.deepEqual(pool.state.events.map((e) => [e.channel, e.granted, e.source]), [
    ['marketing_email', true, 'signup'],
  ]);
});

test('sign-up: nothing ticked touches nothing', async () => {
  const pool = memoryPool();
  await prefs.recordSignupChoices(pool, 7, { marketingEmail: false, marketingSms: false });
  assert.equal(pool.state.calls.length, 0);
});

test('sign-up: a box that does not apply is ignored, never a failed sign-up', async () => {
  // A phone-made account has no address; an email one has no number.
  const pool = memoryPool({ user: { email: null, email_confirmed: false } });
  await prefs.recordSignupChoices(pool, 7, { marketingEmail: true, marketingSms: true });
  assert.equal(pool.state.events.length, 0);
});

test('sign-up: a failure is logged, never thrown', async () => {
  const warnings = [];
  const pool = { async query() { throw new Error('down'); } };
  await prefs.recordSignupChoices(pool, 7, { marketingEmail: true }, { warn: (...a) => warnings.push(a) });
  assert.equal(warnings.length, 1);
});

test('the request body reads only explicit trues', () => {
  assert.deepEqual(prefs.signupChoicesFrom({ marketingEmail: 'yes', marketingSms: true }), { marketingEmail: false, marketingSms: true });
  assert.deepEqual(prefs.signupChoicesFrom(undefined), { marketingEmail: false, marketingSms: false });
});

test('every account-creating route saves the sign-up boxes', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const auth = read('src', 'routes', 'auth.js');
  const phone = read('src', 'routes', 'phone-auth.js');
  const oauth = read('src', 'routes', 'sign-in-providers.js');
  assert.match(auth, /emailSignup\.completePassword[\s\S]{0,1200}contactPreferences\.recordSignupChoices/);
  assert.equal((phone.match(/contactPreferences\.recordSignupChoices/g) || []).length, 2, 'phone verify (created) and phone finish');
  assert.match(oauth, /providers\.completeUsername[\s\S]{0,800}contactPreferences\.recordSignupChoices/);
});

test('the consent record keeps its history: append-only, private, outlives a deletion', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS contact_consent_events/);
  assert.match(schema, /COMMENT ON TABLE contact_consent_events IS 'staging:private'/);
  assert.match(schema, /user_id\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL,\n\s+channel/);
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_email BOOLEAN NOT NULL DEFAULT FALSE;/);
});
