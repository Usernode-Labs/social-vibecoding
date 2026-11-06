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
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const config = { databaseUrl: String(url), adminUsername: 'tpl-admin', adminPassword: 'only-for-tests', selfAppSlug: 'tpl-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  await migrate(config); await migrate(config);
  // Booting seeds the first templates (src/db/email-template-seeds.js). This
  // suite is about the store from empty.
  await pool.query('TRUNCATE email_template_translations, email_layout_translations, email_templates, email_layouts');
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

  await t.test('delete is soft, and a deleted version cannot be a replacement', async () => {
    const [current] = await live(OTP);
    const { rows: [gone] } = await pool.query("SELECT id FROM email_templates WHERE action = $1 AND deleted_at IS NOT NULL LIMIT 1", [OTP]);
    assert.ok(gone, 'the earlier delete kept its row');
    await rejects(store.deleteTemplate(pool, current.id, { replacementId: gone.id }, userId), 'invalid_replacement');
  });

  await t.test('restore puts a deleted or archived version live and archives the current one', async () => {
    const [current] = await live(OTP);
    const { rows: [gone] } = await pool.query("SELECT id FROM email_templates WHERE action = $1 AND deleted_at IS NOT NULL LIMIT 1", [OTP]);
    await rejects(store.restoreTemplate(pool, gone.id, { expectedLiveId: current.id + 1000 }, userId), 'conflict');
    await rejects(store.restoreTemplate(pool, gone.id, {}, userId), 'conflict');
    const restored = await store.restoreTemplate(pool, gone.id, { expectedLiveId: current.id }, userId);
    assert.equal(restored.deleted_at, null); assert.equal(restored.status, 'live');
    assert.deepEqual((await live(OTP)).map((r) => r.id), [gone.id]);
    assert.equal((await pool.query('SELECT status FROM email_templates WHERE id = $1', [current.id])).rows[0].status, 'archived');
    assert.equal((await store.restoreTemplate(pool, gone.id, { expectedLiveId: gone.id }, userId)).id, gone.id);
    const back = await store.restoreTemplate(pool, current.id, { expectedLiveId: gone.id }, userId);
    assert.equal(back.status, 'live');
    await rejects(store.restoreTemplate(pool, 999999, {}, userId), 'not_found');
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

  await t.test('a version on a deleted layout cannot become live by replacement or restore', async () => {
    const mk = (n) => store.saveLayout(pool, { familyId: null, name: n, html: 'h', text: 't', expectedLiveId: null }, userId);
    const F = await mk('F'); const G = await mk('G');
    const v1 = await save({ action: 'waitlist_joined', layoutFamilyId: F.family_id });
    const v2 = await save({ action: 'waitlist_joined', layoutFamilyId: G.family_id, expectedLiveId: v1.id });
    await store.deleteLayout(pool, F.family_id, {}, userId);
    await rejects(store.deleteTemplate(pool, v2.id, { replacementId: v1.id }, userId), 'invalid_replacement');
    assert.deepEqual((await live('waitlist_joined')).map((r) => r.id), [v2.id]);
    await rejects(store.restoreTemplate(pool, v1.id, { expectedLiveId: v2.id }, userId), 'invalid_replacement');
    assert.deepEqual((await live('waitlist_joined')).map((r) => r.id), [v2.id]);
  });

  await t.test('deleteLayout waits for an uncommitted save that points at the layout, then moves it', async () => {
    const mk = (n) => store.saveLayout(pool, { familyId: null, name: n, html: 'h', text: 't', expectedLiveId: null }, userId);
    const A = await mk('A'); const B = await mk('B');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL FOR SHARE", [A.family_id]);
      let settled = false;
      const deleting = store.deleteLayout(pool, A.family_id, { replacementFamilyId: B.family_id }, userId).then(() => { settled = true; });
      // fixed wait: proves the delete is still blocked, so there is no event to wait for
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(settled, false, 'the delete waits for the share-locked save');
      await holder.query(
        "INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, html, text) VALUES ('content_report', 'n', $1, 1, 'live', 's', 'h', 't')", [A.family_id]);
      await holder.query('COMMIT');
      await deleting;
    } finally { holder.release(); }
    const [moved] = await live('content_report');
    assert.equal(moved.layout_family_id, B.family_id);
    await rejects(save({ action: 'content_report', layoutFamilyId: A.family_id, expectedLiveId: moved.id }), 'not_found');
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
    const next = await save({ action: 'password_reset', subject: 'New words', expectedLiveId: current.id });
    const snap = await store.snapshot(pool);
    assert.deepEqual(snap.templates.password_reset.translations, {});
    assert.equal(snap.templates.password_reset.id, next.id);
    const { rows: [layout] } = await pool.query("SELECT id, family_id FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL ORDER BY id LIMIT 1");
    const layoutFamily = layout.family_id;
    await store.saveTranslation(pool, 'layout', layout.id, 'de', { html: '<i>d</i>', text: 'd' }, 'machine');
    assert.equal((await store.snapshot(pool)).layouts[layoutFamily].translations.de.html, '<i>d</i>');
  });

  await t.test('snapshot reads only live, non-deleted rows with their translations', async () => {
    const snap = await store.snapshot(pool);
    const [otp] = await live(OTP);
    assert.equal(snap.templates[OTP].id, otp.id);
    assert.ok(['password_reset', 'waitlist_joined', 'content_report'].every((a) => snap.templates[a]));
    assert.ok(Object.values(snap.templates).every((r) => r.status === 'live' && r.deleted_at === null));
    assert.ok(Object.values(snap.layouts).every((r) => r.status === 'live' && r.deleted_at === null));
    assert.ok(Object.values(snap.layouts).some((r) => r.translations.de && r.translations.de.html === '<i>d</i>'));
    await store.saveTranslation(pool, 'template', otp.id, 'es', { subject: 's', preheader: '', why: '', html: 'h', text: 't' }, 'machine');
    assert.equal((await store.snapshot(pool)).templates[OTP].translations.es.subject, 's');
  });

  await t.test('restoreLayout puts an archived version of a live family back, and checks the templates first', async () => {
    const one = await store.saveLayout(pool, { familyId: null, name: 'Restorable', html: '<p>{{content}}</p>', text: '{{content}}', expectedLiveId: null }, userId);
    const two = await store.saveLayout(pool, { familyId: one.family_id, name: 'Restorable 2', html: '<b>{{content}}</b>', text: '{{content}}', expectedLiveId: one.id }, userId);
    const [tpl] = await live('project_invite');
    const wearer = await save({ action: 'project_invite', layoutFamilyId: one.family_id, expectedLiveId: tpl ? tpl.id : null });
    await rejects(store.restoreLayout(pool, one.id, { expectedLiveId: one.id }, userId), 'conflict');
    let seen = null;
    const refusal = Object.assign(new Error('no'), { code: 'invalid', errors: [] });
    await rejects(store.restoreLayout(pool, one.id, { expectedLiveId: two.id }, userId, { check: async (ctx) => { seen = ctx; throw refusal; } }), 'invalid');
    assert.equal(seen.row.id, one.id);
    assert.deepEqual(seen.templates.map((r) => r.id), [wearer.id]);
    const liveLayout = async () => (await pool.query("SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL", [one.family_id])).rows.map((r) => r.id);
    assert.deepEqual(await liveLayout(), [two.id], 'a refused check changes nothing');
    const restored = await store.restoreLayout(pool, one.id, { expectedLiveId: two.id }, userId);
    assert.equal(restored.status, 'live');
    assert.deepEqual(await liveLayout(), [one.id]);
    assert.equal((await store.restoreLayout(pool, one.id, { expectedLiveId: one.id }, userId)).id, one.id, 'already live: nothing to do');
    await rejects(store.restoreLayout(pool, 999999, {}, userId), 'not_found');
    const other = await store.saveLayout(pool, { familyId: null, name: 'Doomed', html: '{{content}}', text: '{{content}}', expectedLiveId: null }, userId);
    const other2 = await store.saveLayout(pool, { familyId: other.family_id, name: 'Doomed 2', html: '<i>{{content}}</i>', text: '{{content}}', expectedLiveId: other.id }, userId);
    await store.deleteLayout(pool, other.family_id, {}, userId);
    await rejects(store.restoreLayout(pool, other.id, { expectedLiveId: other2.id }, userId), 'not_found');
    await rejects(store.restoreLayout(pool, other.id, {}, userId), 'not_found');
  });

  await t.test('a check refusal inside a save, restore or delete changes nothing', async () => {
    const refuse = { check: async () => { throw Object.assign(new Error('no'), { code: 'invalid', errors: [{ field: 'html', message: 'no' }] }); } };
    const [current] = await live(OTP);
    await rejects(store.saveTemplate(pool, body({ action: OTP, subject: 'A refused change', expectedLiveId: current.id }), userId, refuse), 'invalid');
    assert.deepEqual((await live(OTP)).map((r) => r.id), [current.id]);
    let ctx = null;
    const peek = { check: async (c) => { ctx = c; } };
    const { rows: [layoutRow] } = await pool.query("SELECT * FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL ORDER BY id LIMIT 1");
    const next = await store.saveTemplate(pool, body({ action: OTP, layoutFamilyId: layoutRow.family_id, expectedLiveId: current.id }), userId, peek);
    assert.equal(ctx.layout.id, layoutRow.id, 'the check sees the live layout the template will wear');
    await rejects(store.restoreTemplate(pool, current.id, { expectedLiveId: next.id }, userId, refuse), 'invalid');
    await rejects(store.deleteTemplate(pool, next.id, { replacementId: current.id }, userId, refuse), 'invalid');
    assert.deepEqual((await live(OTP)).map((r) => r.id), [next.id]);
    await rejects(store.saveLayout(pool, { familyId: layoutRow.family_id, name: 'x', html: '{{content}}', text: '{{content}}', expectedLiveId: layoutRow.id }, userId, refuse), 'invalid');
    const after = await pool.query("SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL", [layoutRow.family_id]);
    assert.deepEqual(after.rows.map((r) => r.id), [layoutRow.id]);
  });

  await t.test('a translation with an empty subject, html or text is refused', async () => {
    const [current] = await live('password_reset');
    const fields = { subject: 'S', preheader: '', why: '', html: '<p>h</p>', text: 't' };
    for (const blank of ['subject', 'html', 'text']) {
      await assert.rejects(store.saveTranslation(pool, 'template', current.id, 'fr', { ...fields, [blank]: '  ' }, 'admin'), (err) => {
        assert.equal(err.code, 'invalid'); assert.equal(err.errors[0].field, blank); return true;
      });
    }
    const { rows: [layoutRow] } = await pool.query("SELECT id FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL LIMIT 1");
    await rejects(store.saveTranslation(pool, 'layout', layoutRow.id, 'fr', { html: '', text: 't' }, 'admin'), 'invalid');
  });

  await t.test('a deadlock or lock timeout comes back as retry', async () => {
    for (const pgCode of ['40P01', '55P03']) {
      const client = { query: async (sql) => { if (/SELECT pg_advisory/.test(sql)) throw Object.assign(new Error('busy'), { code: pgCode }); return { rows: [] }; }, release: () => {} };
      await rejects(store.saveTemplate({ connect: async () => client }, body({ action: OTP }), userId), 'retry');
    }
  });

  await t.test('a save identical to the live version is refused and changes nothing', async () => {
    const action = 'waitlist_joined';
    const [current] = await live(action);
    const same = { action, name: current.name, layoutFamilyId: current.layout_family_id, subject: current.subject, preheader: current.preheader, why: current.why, html: current.html, text: current.text, expectedLiveId: current.id };
    await rejects(store.saveTemplate(pool, same, userId), 'unchanged');
    assert.deepEqual((await live(action)).map((r) => r.id), [current.id]);
    const { rows: [layout] } = await pool.query("SELECT * FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL ORDER BY id LIMIT 1");
    await rejects(store.saveLayout(pool, { familyId: layout.family_id, name: layout.name, html: layout.html, text: layout.text, expectedLiveId: layout.id }, userId), 'unchanged');
    const still = await pool.query("SELECT id FROM email_layouts WHERE family_id = $1 AND status = 'live' AND deleted_at IS NULL", [layout.family_id]);
    assert.deepEqual(still.rows.map((r) => r.id), [layout.id]);
  });

  await t.test('a new name or layout keeps the translations; new English words start with none', async () => {
    const action = 'waitlist_joined';
    const [current] = await live(action);
    const words = { subject: 'Hola', preheader: '', why: 'w', html: '<p>hola</p>', text: 'hola' };
    await store.saveTranslation(pool, 'template', current.id, 'es', words, 'admin');
    await pool.query("UPDATE email_template_translations SET unusable = 'a reason' WHERE template_id = $1 AND locale = 'es'", [current.id]);
    await store.saveTranslation(pool, 'template', current.id, 'fr', { ...words, subject: 'Salut' }, 'machine');
    const english = { action, layoutFamilyId: current.layout_family_id, subject: current.subject, preheader: current.preheader, why: current.why, html: current.html, text: current.text };
    let seen = null;
    const renamed = await store.saveTemplate(pool, { ...english, name: 'Renamed', expectedLiveId: current.id }, userId, { afterSave: async (c) => { seen = c; } });
    assert.equal(seen.carried, true, 'afterSave is told the translations came along');
    assert.equal(seen.row.id, renamed.id);
    const { rows } = await pool.query('SELECT locale, subject, origin, unusable FROM email_template_translations WHERE template_id = $1 ORDER BY locale', [renamed.id]);
    assert.deepEqual(rows, [
      { locale: 'es', subject: 'Hola', origin: 'admin', unusable: 'a reason' },
      { locale: 'fr', subject: 'Salut', origin: 'machine', unusable: null },
    ], 'each translation comes along as it was, its origin and mark included');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_template_translations WHERE template_id = $1', [current.id])).rows[0].n, 2, 'the archived version keeps its own');
    const reworded = await store.saveTemplate(pool, { ...english, name: 'Renamed', text: `${english.text} More.`, expectedLiveId: renamed.id }, userId, { afterSave: async (c) => { seen = c; } });
    assert.equal(seen.carried, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_template_translations WHERE template_id = $1', [reworded.id])).rows[0].n, 0);
  });

  await t.test('a renamed layout keeps its translations; new layout words start with none', async () => {
    const { rows: [layout] } = await pool.query("SELECT * FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL ORDER BY id LIMIT 1");
    await store.saveTranslation(pool, 'layout', layout.id, 'es', { html: '<b>{{content}}</b>', text: '{{content}}' }, 'machine');
    const renamed = await store.saveLayout(pool, { familyId: layout.family_id, name: `${layout.name} (renamed)`, html: layout.html, text: layout.text, expectedLiveId: layout.id }, userId);
    const carried = await pool.query('SELECT locale, html FROM email_layout_translations WHERE layout_id = $1 ORDER BY locale', [renamed.id]);
    assert.ok(carried.rows.some((r) => r.locale === 'es' && r.html === '<b>{{content}}</b>'));
    const reworded = await store.saveLayout(pool, { familyId: layout.family_id, name: renamed.name, html: `${layout.html}<p>.</p>`, text: layout.text, expectedLiveId: renamed.id }, userId);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_layout_translations WHERE layout_id = $1', [reworded.id])).rows[0].n, 0);
  });

  await t.test('listAll returns every version including archived and deleted', async () => {
    const { rows: [old] } = await pool.query("SELECT id FROM email_templates WHERE action = $1 AND status = 'archived' AND deleted_at IS NULL LIMIT 1", [OTP]);
    await store.deleteTemplate(pool, old.id, {}, userId);
    const all = await store.listAll(pool);
    assert.ok(all.templates.some((r) => r.status === 'archived'));
    assert.ok(all.templates.some((r) => r.deleted_at));
    assert.ok(all.layouts.some((r) => r.deleted_at));
  });
});
