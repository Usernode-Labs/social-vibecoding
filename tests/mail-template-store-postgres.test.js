'use strict';

// src/db/migrations/email-templates.sql, src/services/mail/template-store.js:
// versions, the one live template per action, soft deletion and translations,
// against real PostgreSQL because the guarantees are locks and unique indexes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const body = (extra) => ({ name: 'Sign-in code', layoutFamilyId: null, subject: 'Your code', preheader: '', why: 'You asked to sign in', html: '<p>{{code}}</p>', text: '{{code}}', expectedLiveId: null, ...extra });
const rejects = (promise, code) => assert.rejects(promise, (err) => { assert.equal(err.code, code); return true; });

test('email template store against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_tpl_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); });
  const config = { databaseUrl: String(url), adminUsername: 'tpl-admin', adminPassword: 'only-for-tests', selfAppSlug: 'tpl-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  await migrate(config); await migrate(config);
  const store = require('../src/services/mail/template-store');
  const { rows: [{ id: userId }] } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  const live = async (action) => (await pool.query("SELECT * FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL", [action])).rows;

  const OTP = 'otp';
  const save = (extra, user = userId) => store.saveTemplate(pool, body(extra), user);

  await t.test('saving archives the previous version', async () => {
    const one = await save({ action: OTP });
    assert.equal(one.version, 1); assert.equal(one.status, 'live'); assert.equal(one.created_by, userId);
    const two = await save({ action: OTP, subject: 'Newer', expectedLiveId: one.id });
    assert.equal(two.version, 2); assert.equal(two.status, 'live');
    const { rows } = await pool.query('SELECT id, status FROM email_templates WHERE action = $1 ORDER BY version', [OTP]);
    assert.deepEqual(rows.map((r) => r.status), ['archived', 'live']);
    assert.equal((await live(OTP)).length, 1);
  });

  await t.test('a stale expectedLiveId, or null when one is live, conflicts', async () => {
    const [current] = await live(OTP);
    await rejects(save({ action: OTP, expectedLiveId: current.id - 1 }), 'conflict');
    await rejects(save({ action: OTP, expectedLiveId: null }), 'conflict');
  });

  await t.test('an action outside the registry is refused', async () => {
    await rejects(save({ action: 'not_a_real_action' }), 'unknown_action');
  });

  await t.test('concurrent saves: one success, one conflict, one live row', async () => {
    const [current] = await live(OTP);
    const results = await Promise.allSettled([
      save({ action: OTP, subject: 'A', expectedLiveId: current.id }),
      save({ action: OTP, subject: 'B', expectedLiveId: current.id }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const failed = results.find((r) => r.status === 'rejected');
    assert.equal(failed.reason.code, 'conflict');
    assert.equal((await live(OTP)).length, 1);
  });

  await t.test('concurrent first saves for one action also give one winner', async () => {
    const results = await Promise.allSettled([save({ action: 'password_reset' }), save({ action: 'password_reset' })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'conflict');
    assert.equal((await live('password_reset')).length, 1);
  });

  await t.test('deleting a live template without a replacement is refused', async () => {
    const [current] = await live(OTP);
    await rejects(store.deleteTemplate(pool, current.id, {}, userId), 'replacement_required');
    assert.equal((await live(OTP)).length, 1);
  });

  await t.test('deleting with an archived replacement makes it live', async () => {
    const [current] = await live(OTP);
    const { rows: [older] } = await pool.query("SELECT id FROM email_templates WHERE action = $1 AND status = 'archived' ORDER BY version LIMIT 1", [OTP]);
    await store.deleteTemplate(pool, current.id, { replacementId: older.id }, userId);
    const now = await live(OTP);
    assert.deepEqual(now.map((r) => r.id), [older.id]);
  });

  await t.test('the replacement must be the same action', async () => {
    const [current] = await live(OTP);
    const [other] = await live('password_reset');
    await rejects(store.deleteTemplate(pool, current.id, { replacementId: other.id }, userId), 'invalid_replacement');
    await rejects(store.deleteTemplate(pool, current.id, { replacementId: current.id }, userId), 'invalid_replacement');
    await rejects(store.deleteTemplate(pool, current.id, { replacementId: 999999 }, userId), 'invalid_replacement');
    assert.equal((await live(OTP)).length, 1);
  });

  await t.test('delete is soft, and a deleted version cannot be a replacement; restore brings it back', async () => {
    const [current] = await live(OTP);
    const { rows: [gone] } = await pool.query("SELECT id FROM email_templates WHERE action = $1 AND deleted_at IS NOT NULL LIMIT 1", [OTP]);
    assert.ok(gone, 'the earlier delete kept its row');
    await rejects(store.deleteTemplate(pool, current.id, { replacementId: gone.id }, userId), 'invalid_replacement');
    const restored = await store.restoreTemplate(pool, gone.id, userId);
    assert.equal(restored.deleted_at, null); assert.equal(restored.status, 'archived');
    assert.equal((await live(OTP)).length, 1);
    await rejects(store.restoreTemplate(pool, 999999, userId), 'not_found');
  });

  await t.test('layouts version per family and archive the previous version', async () => {
    const a = await store.saveLayout(pool, { familyId: null, name: 'Plain', html: '<main>{{content}}</main>', text: '{{content}}', expectedLiveId: null }, userId);
    assert.equal(a.version, 1); assert.ok(a.family_id);
    const b = await store.saveLayout(pool, { familyId: null, name: 'Other', html: '<i>{{content}}</i>', text: '{{content}}', expectedLiveId: null }, userId);
    assert.notEqual(b.family_id, a.family_id); assert.equal(b.version, 1);
    const a2 = await store.saveLayout(pool, { familyId: a.family_id, name: 'Plain 2', html: '<b>{{content}}</b>', text: '{{content}}', expectedLiveId: a.id }, userId);
    assert.equal(a2.version, 2); assert.equal(a2.family_id, a.family_id); assert.equal(a2.name, 'Plain 2');
    await rejects(store.saveLayout(pool, { familyId: a.family_id, name: 'x', html: 'x', text: 'x', expectedLiveId: a.id }, userId), 'conflict');
    await rejects(store.saveLayout(pool, { familyId: 424242, name: 'x', html: 'x', text: 'x', expectedLiveId: null }, userId), 'not_found');
  });

  await t.test('deleting a layout in use requires a replacement and moves its templates', async () => {
    const { rows: [{ family_id: from }, { family_id: to }] } = await pool.query("SELECT family_id FROM email_layouts WHERE status = 'live' ORDER BY family_id");
    const [tpl] = await live('password_reset');
    const used = await save({ action: 'password_reset', layoutFamilyId: from, expectedLiveId: tpl.id });
    assert.equal(used.layout_family_id, from);
    await rejects(store.deleteLayout(pool, from, {}, userId), 'replacement_required');
    await rejects(store.deleteLayout(pool, from, { replacementFamilyId: from }, userId), 'invalid_replacement');
    await rejects(store.deleteLayout(pool, from, { replacementFamilyId: 424242 }, userId), 'invalid_replacement');
    await store.deleteLayout(pool, from, { replacementFamilyId: to }, userId);
    assert.equal((await live('password_reset'))[0].layout_family_id, to);
    const { rows } = await pool.query('SELECT deleted_at FROM email_layouts WHERE family_id = $1', [from]);
    assert.ok(rows.length >= 2 && rows.every((r) => r.deleted_at), 'soft: every version kept, marked deleted');
    await rejects(store.saveTemplate(pool, body({ action: 'password_reset', layoutFamilyId: from, expectedLiveId: used.id }), userId), 'not_found');
  });

  await t.test('deleting an unused layout needs no replacement', async () => {
    const c = await store.saveLayout(pool, { familyId: null, name: 'Spare', html: 'h', text: 't', expectedLiveId: null }, userId);
    await store.deleteLayout(pool, c.family_id, {}, userId);
    await rejects(store.deleteLayout(pool, c.family_id, {}, userId), 'not_found');
  });

  await t.test('translations belong to one version, upsert, and a new version has none', async () => {
    const [current] = await live('password_reset');
    const fields = { subject: 'Code', preheader: '', why: 'w', html: '<p>x</p>', text: 'x' };
    await store.saveTranslation(pool, 'template', current.id, 'fr', fields, 'machine');
    const again = await store.saveTranslation(pool, 'template', current.id, 'fr', { ...fields, subject: 'Code 2' }, 'admin');
    assert.equal(again.subject, 'Code 2'); assert.equal(again.origin, 'admin');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_template_translations WHERE template_id = $1', [current.id])).rows[0].n, 1);
    await rejects(store.saveTranslation(pool, 'template', current.id, 'fr', fields, 'robot'), 'invalid_origin');
    await rejects(store.saveTranslation(pool, 'template', 999999, 'fr', fields, 'admin'), 'not_found');
    const next = await save({ action: 'password_reset', expectedLiveId: current.id });
    const snap = await store.snapshot(pool);
    assert.deepEqual(snap.templates.password_reset.translations, {});
    assert.equal(snap.templates.password_reset.id, next.id);
    const { rows: [layout] } = await pool.query("SELECT id FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL LIMIT 1");
    await store.saveTranslation(pool, 'layout', layout.id, 'de', { html: '<i>d</i>', text: 'd' }, 'machine');
    assert.equal(Object.keys((await store.snapshot(pool)).layouts).length, 1);
  });

  await t.test('snapshot reads only live, non-deleted rows with their translations', async () => {
    const snap = await store.snapshot(pool);
    const [otp] = await live(OTP);
    assert.equal(snap.templates[OTP].id, otp.id);
    assert.deepEqual(Object.keys(snap.templates).sort(), [OTP, 'password_reset']);
    const fam = Object.values(snap.layouts)[0];
    assert.equal(fam.status, 'live'); assert.equal(fam.translations.de.html, '<i>d</i>');
    await store.saveTranslation(pool, 'template', otp.id, 'es', { subject: 's', preheader: '', why: '', html: 'h', text: 't' }, 'machine');
    assert.equal((await store.snapshot(pool)).templates[OTP].translations.es.subject, 's');
  });

  await t.test('listAll returns every version including archived and deleted', async () => {
    const all = await store.listAll(pool);
    assert.ok(all.templates.some((r) => r.status === 'archived'));
    assert.ok(all.templates.some((r) => r.deleted_at));
    assert.ok(all.layouts.some((r) => r.deleted_at));
  });
});
