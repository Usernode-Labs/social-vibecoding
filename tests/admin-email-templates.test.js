'use strict';

// src/routes/admin-email-templates.js: the admin routes behind Admin > Email
// templates, mounted by src/routes/admin.js, against real PostgreSQL because
// what they promise (validation inside the save, conflicts, one live row) is
// the store's transactions.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('server.js gives the email template writes and corrections a parser that fits a 100 KB template', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /\/\^\\\/api\\\/admin\\\/email-\(\?:templates\|layouts\)\(\?:\\\/\|\$\)\/\.test\(req\.path\)\) \{\n\s+return express\.json\(\{ limit: '1mb' \}\)/);
  // A language's correction (PUT .../translations/:locale) carries a whole email too.
  assert.match(server, /if \(\(req\.method === 'POST' \|\| req\.method === 'PUT'\) && \/\^\\\/api\\\/admin\\\/email-/);
});

test('admin.js mounts the routes behind its admin gate', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
  const gate = admin.indexOf("router.use('/api/admin', adminMiddleware);");
  const mount = admin.indexOf('router.use(emailTemplateAdminRoutes(pool, config));');
  assert.ok(gate > 0 && mount > gate);
});

test('email template admin routes against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_tpl_routes_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    poolModule.getPool = original; await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  });
  const config = { databaseUrl: String(url), adminUsername: 'tpl-route-admin', adminPassword: 'only-for-tests', selfAppSlug: 'tpl-route-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  await migrate(config);
  const { seedEmailTemplates } = require('../src/db/email-template-seeds');
  await seedEmailTemplates(pool);
  const { rows: [user] } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  await pool.query("UPDATE users SET email = 'route-admin@example.invalid' WHERE id = $1", [user.id]);

  const sent = [];
  config.mailTransport = { provider: 'http', send: async (payload) => { sent.push(payload); return { providerMessageId: 'r' + sent.length }; } };

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'] || 'full';
    req.user = { id: user.id, username: 'tpl-route-admin', isAdmin: role !== 'none', canAdminWrite: role === 'full' };
    next();
  });
  app.use(require('../src/routes/admin').adminRoutes(config));
  server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, role = 'full') => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-role': role }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const live = async (action) => (await pool.query("SELECT * FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL", [action])).rows[0];
  const liveLayout = async () => (await pool.query("SELECT * FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL ORDER BY family_id LIMIT 1")).rows[0];
  const eventsOf = async () => (await pool.query("SELECT event_type, metadata FROM events WHERE event_type IN ('email_template_changed', 'mail_test_sent') ORDER BY id")).rows;
  const otpBody = (current, extra) => ({
    action: 'otp', name: current.name, layoutFamilyId: current.layout_family_id, subject: current.subject,
    preheader: current.preheader, why: current.why, html: current.html, text: current.text, expectedLiveId: current.id, ...extra,
  });

  await t.test('the list answers any admin with every action, template and layout', async () => {
    const res = await call('GET', '/api/admin/email-templates', undefined, 'view');
    assert.equal(res.status, 200);
    assert.equal(res.body.actions.length, 16);
    const otp = res.body.actions.find((a) => a.action === 'otp');
    assert.deepEqual(otp.required, { html: ['code'], text: ['code'] });
    assert.ok(otp.placeholders.some((p) => p.name === 'code'));
    assert.ok(res.body.actions.find((a) => a.action === 'build_ready').placeholders.find((p) => p.name === 'lead').fromCode);
    assert.equal(res.body.templates.filter((r) => r.status === 'live').length, 16);
    assert.ok(Array.isArray(res.body.templates[0].locales));
    assert.ok(res.body.layouts.length >= 1);
    const layouts = await call('GET', '/api/admin/email-layouts', undefined, 'view');
    assert.equal(layouts.status, 200);
    assert.equal(layouts.body.layouts[0].usedBy.length, 16);
    const outsider = await call('GET', '/api/admin/email-templates', undefined, 'none');
    assert.notEqual(outsider.status, 200, 'not an admin: adminMiddleware turns them away');
  });

  await t.test('view-only admin gets 403 on every write', async () => {
    const current = await live('otp');
    const layout = await liveLayout();
    const writes = [
      ['POST', '/api/admin/email-templates', otpBody(current)],
      ['POST', `/api/admin/email-templates/${current.id}/restore`, { expectedLiveId: current.id }],
      ['DELETE', `/api/admin/email-templates/${current.id}`, { replacementId: current.id }],
      ['POST', '/api/admin/email-templates/test', { action: 'otp', fields: otpBody(current) }],
      ['POST', '/api/admin/email-layouts', { familyId: layout.family_id, name: 'x', html: '{{content}}', text: '{{content}}', expectedLiveId: layout.id }],
      ['POST', `/api/admin/email-layouts/${layout.id}/restore`, { expectedLiveId: layout.id }],
      ['DELETE', `/api/admin/email-layouts/${layout.family_id}`, {}],
      ['POST', '/api/admin/email-layouts/test', { action: 'otp', fields: { html: '{{content}}', text: '{{content}}' } }],
    ];
    const before = (await eventsOf()).length;
    for (const [method, p, body] of writes) {
      const res = await call(method, p, body, 'view');
      assert.equal(res.status, 403, `${method} ${p}`);
    }
    assert.equal((await eventsOf()).length, before);
    assert.equal((await live('otp')).id, current.id);
    assert.equal(sent.length, 0);
  });

  await t.test('saving otp without {{code}} is 400 naming code', async () => {
    const current = await live('otp');
    const res = await call('POST', '/api/admin/email-templates', otpBody(current, { html: '<p>Your code is below.</p>' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid');
    assert.ok(res.body.errors.some((e) => e.field === 'html' && e.message.includes('{{code}}')), JSON.stringify(res.body));
    assert.match(res.body.error, /\w/);
    assert.equal((await live('otp')).id, current.id, 'nothing saved');
  });

  await t.test('an empty subject, unsafe HTML or a bad id is refused with a reason', async () => {
    const current = await live('otp');
    const empty = await call('POST', '/api/admin/email-templates', otpBody(current, { subject: '' }));
    assert.equal(empty.status, 400); assert.ok(empty.body.errors.some((e) => e.field === 'subject'));
    const unsafe = await call('POST', '/api/admin/email-templates', otpBody(current, { html: '<p onclick="x">{{code}}</p>' }));
    assert.equal(unsafe.status, 400); assert.ok(unsafe.body.errors.some((e) => /onclick/.test(e.message)));
    const action = await call('POST', '/api/admin/email-templates', otpBody(current, { action: 'nope' }));
    assert.equal(action.status, 400); assert.equal(action.body.errors[0].field, 'action');
    const layout = await call('POST', '/api/admin/email-templates', otpBody(current, { layoutFamilyId: 'abc' }));
    assert.equal(layout.status, 400); assert.equal(layout.body.errors[0].field, 'layoutFamilyId');
    const gone = await call('POST', '/api/admin/email-templates', otpBody(current, { layoutFamilyId: 424242 }));
    assert.equal(gone.status, 404); assert.match(gone.body.error, /layout/i);
    assert.equal((await call('POST', '/api/admin/email-templates/abc/restore', {})).status, 404);
  });

  await t.test('a save identical to the live version is 409 unchanged and records nothing', async () => {
    const current = await live('otp');
    const before = (await eventsOf()).length;
    const res = await call('POST', '/api/admin/email-templates', otpBody(current));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'unchanged');
    assert.match(res.body.error, /Nothing has changed/);
    assert.equal((await live('otp')).id, current.id);
    assert.equal((await eventsOf()).length, before);
    const layout = await liveLayout();
    const same = await call('POST', '/api/admin/email-layouts', { familyId: layout.family_id, name: layout.name, html: layout.html, text: layout.text, expectedLiveId: layout.id });
    assert.equal(same.status, 409); assert.equal(same.body.code, 'unchanged');
  });

  await t.test('a new name keeps the translations and says so; new words do not', async () => {
    const current = await live('otp');
    await pool.query(
      `INSERT INTO email_template_translations (template_id, locale, subject, preheader, why, html, text, origin)
       VALUES ($1, 'fr', $2, $3, $4, $5, $6, 'machine')`,
      [current.id, current.subject, current.preheader, current.why, current.html, current.text]);
    const renamed = await call('POST', '/api/admin/email-templates', otpBody(current, { name: `${current.name} (renamed)` }));
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.translationsKept, true);
    const kept = await pool.query('SELECT locale FROM email_template_translations WHERE template_id = $1', [renamed.body.template.id]);
    assert.deepEqual(kept.rows.map((r) => r.locale), ['fr']);
    const reworded = await call('POST', '/api/admin/email-templates', otpBody(await live('otp'), { subject: 'Your Homeroom code, reworded' }));
    assert.equal(reworded.status, 200, JSON.stringify(reworded.body));
    assert.equal(reworded.body.translationsKept, false);
  });

  await t.test('a valid save goes live, archives the last version and records an event', async () => {
    const current = await live('otp');
    const res = await call('POST', '/api/admin/email-templates', otpBody(current, { subject: 'Your Homeroom code, edited' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.template.status, 'live');
    assert.equal(res.body.template.subject, 'Your Homeroom code, edited');
    assert.equal((await live('otp')).id, res.body.template.id);
    const last = (await eventsOf()).at(-1);
    assert.equal(last.event_type, 'email_template_changed');
    assert.deepEqual(last.metadata, { what: 'template', change: 'saved', id: res.body.template.id, action: 'otp', version: res.body.template.version });
  });

  await t.test('stale expectedLiveId is 409', async () => {
    const current = await live('otp');
    const res = await call('POST', '/api/admin/email-templates', otpBody(current, { expectedLiveId: current.id - 1 }));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'conflict');
    assert.match(res.body.error, /reload/i);
    const layout = await liveLayout();
    const stale = await call('POST', '/api/admin/email-layouts', { familyId: layout.family_id, name: layout.name, html: layout.html, text: layout.text, expectedLiveId: layout.id + 1000 });
    assert.equal(stale.status, 409);
  });

  await t.test('restoring a version that fails validation is 400', async () => {
    const current = await live('otp');
    // An old version written before today's rules, straight into the table.
    const { rows: [bad] } = await pool.query(
      `INSERT INTO email_templates (action, name, layout_family_id, version, status, subject, html, text)
       VALUES ('otp', 'Old', $1, 900, 'archived', 'Old', '<p>no code here</p>', 'no code') RETURNING id`, [current.layout_family_id]);
    const res = await call('POST', `/api/admin/email-templates/${bad.id}/restore`, { expectedLiveId: current.id });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some((e) => e.message.includes('{{code}}')));
    assert.equal((await live('otp')).id, current.id);
    const del = await call('DELETE', `/api/admin/email-templates/${current.id}`, { replacementId: bad.id });
    assert.equal(del.status, 400, 'a replacement must validate too');
    assert.equal((await live('otp')).id, current.id);
  });

  await t.test('restore and delete with a good version work and record events', async () => {
    const current = await live('otp');
    const { rows: [older] } = await pool.query("SELECT id FROM email_templates WHERE action = 'otp' AND status = 'archived' AND version = 1");
    const restored = await call('POST', `/api/admin/email-templates/${older.id}/restore`, { expectedLiveId: current.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await live('otp')).id, older.id);
    assert.deepEqual((await eventsOf()).at(-1).metadata, { what: 'template', change: 'restored', id: older.id, action: 'otp', version: 1 });
    const missing = await call('DELETE', `/api/admin/email-templates/${older.id}`, {});
    assert.equal(missing.status, 422); assert.equal(missing.body.code, 'replacement_required');
    const wrong = await call('DELETE', `/api/admin/email-templates/${older.id}`, { replacementId: (await live('password_reset')).id });
    assert.equal(wrong.status, 422); assert.equal(wrong.body.code, 'invalid_replacement');
    const deleted = await call('DELETE', `/api/admin/email-templates/${older.id}`, { replacementId: current.id });
    assert.equal(deleted.status, 200);
    assert.equal((await live('otp')).id, current.id);
    assert.deepEqual((await eventsOf()).at(-1).metadata, { what: 'template', change: 'deleted', id: older.id, action: 'otp', replacementId: current.id });
    assert.equal((await call('DELETE', '/api/admin/email-templates/999999', {})).status, 404);
  });

  await t.test('a delete from a stale screen is 409 and changes nothing', async () => {
    // The screen saw `seen` live with `other` archived. Someone restores
    // `other` before the delete arrives.
    const other = await live('otp');
    const saved = await call('POST', '/api/admin/email-templates', otpBody(other, { subject: 'Seen on the stale screen' }));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const seen = saved.body.template;
    const restored = await call('POST', `/api/admin/email-templates/${other.id}/restore`, { expectedLiveId: seen.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const before = (await pool.query("SELECT id, status, deleted_at FROM email_templates WHERE action = 'otp' ORDER BY id")).rows;
    const stale = await call('DELETE', `/api/admin/email-templates/${seen.id}`, { replacementId: other.id, expectedLiveId: seen.id });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'conflict');
    assert.match(stale.body.error, /reload/i);
    // Even without expectedLiveId, a replacement named for a row that is no
    // longer live is the same stale belief.
    const unnamed = await call('DELETE', `/api/admin/email-templates/${seen.id}`, { replacementId: other.id });
    assert.equal(unnamed.status, 409);
    assert.deepEqual((await pool.query("SELECT id, status, deleted_at FROM email_templates WHERE action = 'otp' ORDER BY id")).rows, before, 'nothing deleted');
    // With the live id it saw, the same delete works and says what is live.
    const fresh = await call('DELETE', `/api/admin/email-templates/${other.id}`, { replacementId: seen.id, expectedLiveId: other.id });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.liveId, seen.id);
    assert.equal((await live('otp')).id, seen.id);

    const layout = await liveLayout();
    const staleLayout = await call('DELETE', `/api/admin/email-layouts/${layout.family_id}`, { expectedLiveId: layout.id + 1000 });
    assert.equal(staleLayout.status, 409);
    assert.equal((await liveLayout()).id, layout.id, 'the layout is still live');
  });

  await t.test('layout edit dropping {{content}} is 400', async () => {
    const layout = await liveLayout();
    const res = await call('POST', '/api/admin/email-layouts', { familyId: layout.family_id, name: layout.name, html: '<div>No slot</div>', text: layout.text, expectedLiveId: layout.id });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some((e) => e.field === 'html' && e.message.includes('{{content}}')));
    assert.equal((await liveLayout()).id, layout.id);
  });

  await t.test('layout edit dropping {{unsubscribeUrl}} is 400 and names the templates', async () => {
    // A template whose unsubscribe link lives in its "why" line, which the
    // standard layout prints: a layout without {{why}} would drop the link.
    const opened = await live('project_opened');
    const moved = await call('POST', '/api/admin/email-templates', {
      action: 'project_opened', name: 'Opened, link in why', layoutFamilyId: opened.layout_family_id, subject: opened.subject,
      preheader: opened.preheader, why: 'Stop these: <a href="{{unsubscribeUrl}}">unsubscribe</a>', html: '<p>Opened</p>',
      text: opened.text, expectedLiveId: opened.id,
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const layout = await liveLayout();
    const withoutWhy = layout.html.replace(/\{\{why\}\}/g, '');
    assert.notEqual(withoutWhy, layout.html);
    const res = await call('POST', '/api/admin/email-layouts', { familyId: layout.family_id, name: layout.name, html: withoutWhy, text: layout.text, expectedLiveId: layout.id });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some((e) => e.message.includes('Opened, link in why') && e.message.includes('{{unsubscribeUrl}}')), JSON.stringify(res.body));
    // The first waitlist reminder's stop link lives in its why line too.
    assert.deepEqual(res.body.templates.map((x) => x.action), ['project_opened', 'waitlist_reminder']);
    assert.equal((await liveLayout()).id, layout.id);
  });

  await t.test('layout save, restore and delete', async () => {
    const layout = await liveLayout();
    const saved = await call('POST', '/api/admin/email-layouts', { familyId: layout.family_id, name: layout.name, html: `<!-- v2 -->${layout.html}`, text: layout.text, expectedLiveId: layout.id });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual((await eventsOf()).at(-1).metadata, { what: 'layout', change: 'saved', id: saved.body.layout.id, familyId: layout.family_id, version: saved.body.layout.version });
    const restored = await call('POST', `/api/admin/email-layouts/${layout.id}/restore`, { expectedLiveId: saved.body.layout.id });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal((await liveLayout()).id, layout.id);
    const fresh = await call('POST', '/api/admin/email-layouts', { name: 'Plain', html: '<div>{{content}}<p>{{why}}</p></div>', text: '{{content}}' });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const inUse = await call('DELETE', `/api/admin/email-layouts/${layout.family_id}`, {});
    assert.equal(inUse.status, 422);
    const breaking = await call('POST', '/api/admin/email-layouts', { name: 'Bare', html: '<div>{{content}}</div>', text: '{{content}}' });
    const refused = await call('DELETE', `/api/admin/email-layouts/${layout.family_id}`, { replacementId: breaking.body.layout.family_id });
    assert.equal(refused.status, 400, 'the moved templates must validate in the replacement');
    assert.ok(refused.body.errors.some((e) => e.message.includes('Opened, link in why')));
    const moved = await call('DELETE', `/api/admin/email-layouts/${layout.family_id}`, { replacementId: fresh.body.layout.family_id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await live('otp')).layout_family_id, fresh.body.layout.family_id);
    assert.deepEqual((await eventsOf()).at(-1).metadata, { what: 'layout', change: 'deleted', familyId: layout.family_id, replacementId: fresh.body.layout.family_id });
    const again = await call('POST', `/api/admin/email-layouts/${layout.id}/restore`, {});
    assert.equal(again.status, 404, 'a deleted layout stays deleted');
  });

  await t.test('the review\'s ways past validation are refused at the route', async () => {
    const opened = await live('project_opened');
    const conditional = await call('POST', '/api/admin/email-templates', {
      action: 'project_opened', name: 'Unsub only with an app', layoutFamilyId: opened.layout_family_id, subject: 's', preheader: '', why: '',
      html: '<p>Hi</p>{{#if hasApp}}<a href="{{unsubscribeUrl}}">Unsub</a>{{/if}}', text: 'Hi {{#if hasApp}}{{unsubscribeUrl}}{{/if}}', expectedLiveId: opened.id,
    });
    assert.equal(conditional.status, 400);
    assert.ok(conditional.body.errors.some((e) => e.message.includes('{{unsubscribeUrl}}')));
    const released = await live('waitlist_released');
    const openers = '{{#if hasAccount}}<!x{{/if}}{{#unless hasSignInLink}}<!x{{/unless}}{{#if needsCodeNote}}<!x{{/if}}{{#unless hasIos}}<!x{{/unless}}'
      + '{{#if url}}{{/if}}{{#if iosLink}}{{/if}}{{#if hasAndroid}}{{/if}}{{#if androidLink}}{{/if}}{{#if hasMobile}}{{/if}}';
    const hidden = await call('POST', '/api/admin/email-templates', {
      action: 'waitlist_released', name: 'n', layoutFamilyId: released.layout_family_id, subject: 's', preheader: '', why: '',
      html: '<p><a href="{{url}}">Sign in</a></p>' + openers + ' <img src="https://x.test/a.png" onerror="alert(1)">', text: '{{url}}', expectedLiveId: released.id,
    });
    assert.equal(hidden.status, 400);
    assert.equal((await live('waitlist_released')).id, released.id);
  });

  await t.test('a preview that fails for a reason other than the template shows no server detail', async (st) => {
    const render = require('../src/services/mail/render');
    const log = require('../src/services/logger');
    st.mock.method(log, 'error', () => {});
    st.mock.method(render, 'renderMessage', () => { throw new Error('internal detail /srv/app'); });
    const current = await live('password_reset');
    const res = await call('POST', '/api/admin/email-templates/preview', { action: 'password_reset', fields: { ...current, layoutFamilyId: current.layout_family_id } });
    assert.equal(res.status, 400);
    assert.ok(!JSON.stringify(res.body).includes('internal detail'), JSON.stringify(res.body));
  });

  await t.test('a part left open swallows nothing: refused at the route', async () => {
    const plain = await call('POST', '/api/admin/email-layouts', { name: 'Why after content', html: '<div>{{content}}{{why}}</div>', text: '{{content}}\n{{why}}' });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    const opened = await live('project_opened');
    const res = await call('POST', '/api/admin/email-templates', {
      action: 'project_opened', name: 'T', layoutFamilyId: plain.body.layout.family_id, subject: 'Opened', preheader: '',
      why: '{{#unless hasApp}}img src=x onerror=alert(1)//{{/unless}}', html: '<p>Hi</p><a href="{{unsubscribeUrl}}">stop</a><',
      text: 'Hi {{unsubscribeUrl}}', expectedLiveId: opened.id,
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some((e) => e.field === 'html' && /ends/.test(e.message)), JSON.stringify(res.body));
    const otp = await live('otp');
    const swallow = await call('POST', '/api/admin/email-templates', {
      action: 'otp', name: otp.name, layoutFamilyId: otp.layout_family_id, subject: otp.subject, preheader: 'Your code<style>',
      why: otp.why, html: otp.html, text: otp.text, expectedLiveId: otp.id,
    });
    assert.equal(swallow.status, 400);
    assert.ok(swallow.body.errors.some((e) => e.field === 'preheader'));
    assert.equal((await live('otp')).id, otp.id);
  });

  await t.test('preview never stores or sends', async () => {
    const before = { templates: (await pool.query('SELECT count(*)::int AS n FROM email_templates')).rows[0].n, events: (await eventsOf()).length, sent: sent.length };
    const current = await live('otp');
    const res = await call('POST', '/api/admin/email-templates/preview', {
      action: 'otp', locale: 'fr', fields: { ...otpBody(current), subject: 'Code: {{code}}', html: '<p>Unsaved {{code}}</p>' },
    }, 'view');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.subject, 'Code: 123456');
    assert.ok(res.body.html.includes('<p>Unsaved 123456</p>'));
    assert.ok(res.body.html.length > '<p>Unsaved 123456</p>'.length, 'inside its layout');
    assert.match(res.body.text, /123456/);
    assert.deepEqual(res.body.problems, []);
    const missing = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', fields: { ...otpBody(current), html: '<p>none</p>' } });
    assert.equal(missing.status, 200);
    assert.ok(missing.body.problems.some((e) => e.message.includes('{{code}}')), 'shown, not blocking');
    const broken = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', fields: { ...otpBody(current), html: '{{#if code}}' } });
    assert.equal(broken.status, 400);
    const layoutPreview = await call('POST', '/api/admin/email-layouts/preview', { action: 'password_reset', fields: { html: '<main>{{content}}</main>', text: 'Top\n{{content}}' } });
    assert.equal(layoutPreview.status, 200, JSON.stringify(layoutPreview.body));
    assert.match(layoutPreview.body.html, /^<main>[\s\S]*<\/main>$/);
    assert.match(layoutPreview.body.text, /^Top\n/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_templates')).rows[0].n, before.templates);
    assert.equal((await eventsOf()).length, before.events);
    assert.equal(sent.length, before.sent);
  });

  await t.test('a preview in another language shows the saved translation only for the unchanged live version', async () => {
    const current = await live('otp');
    const french = { subject: 'Votre code {{code}}', preheader: current.preheader, why: current.why, html: '<p>Code : {{code}}</p>', text: 'Code : {{code}}' };
    await pool.query(
      `INSERT INTO email_template_translations (template_id, locale, subject, preheader, why, html, text, origin)
       VALUES ($1, 'fr', $2, $3, $4, $5, $6, 'admin')`,
      [current.id, french.subject, french.preheader, french.why, french.html, french.text]);
    try {
      const unchanged = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', locale: 'fr', fields: otpBody(current) }, 'view');
      assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
      assert.equal(unchanged.body.subject, 'Votre code 123456');
      assert.ok(unchanged.body.html.includes('<p>Code : 123456</p>'));
      assert.equal(unchanged.body.untranslated, false);
      const edited = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', locale: 'fr', fields: { ...otpBody(current), subject: 'New {{code}}' } }, 'view');
      assert.equal(edited.status, 200);
      assert.equal(edited.body.subject, 'New 123456', 'an edited draft has no translation yet: its English');
      assert.equal(edited.body.untranslated, true);
      const english = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', locale: 'en', fields: otpBody(current) }, 'view');
      assert.equal(english.body.untranslated, false);
      // A language's own words being corrected are shown as they are.
      const own = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', locale: 'fr', ownWords: true, fields: { ...otpBody(current), subject: 'Mon code {{code}}' } }, 'view');
      assert.equal(own.body.subject, 'Mon code 123456');
      assert.equal(own.body.untranslated, false);
      const ownUnchanged = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', locale: 'fr', ownWords: true, fields: otpBody(current) }, 'view');
      assert.equal(ownUnchanged.body.subject, current.subject.replace('{{code}}', '123456'), 'never swapped for the saved translation');
      const untranslatedLanguage = await call('POST', '/api/admin/email-templates/preview', { action: 'otp', locale: 'es', fields: otpBody(current) }, 'view');
      assert.equal(untranslatedLanguage.body.untranslated, true, 'no Spanish translation: Spanish readers get the English');
    } finally {
      await pool.query("DELETE FROM email_template_translations WHERE template_id = $1 AND locale = 'fr'", [current.id]);
    }
  });

  await t.test('the preview routes are rate limited per admin', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin-email-templates.js'), 'utf8');
    assert.match(source, /router\.post\('\/api\/admin\/email-templates\/preview', emailPreviewLimiter,/);
    assert.match(source, /router\.post\('\/api\/admin\/email-layouts\/preview', emailPreviewLimiter,/);
    const limits = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'rate-limits.js'), 'utf8');
    const decl = limits.slice(limits.indexOf('const emailPreviewLimiter = makeLimiter('));
    assert.match(decl.slice(0, 300), /keyByUser: true/);
    assert.ok(!/exemptAdmins/.test(decl.slice(0, 300)), 'every preview route is admin-only, so exempting admins would disable it');
  });

  await t.test('the test send goes to the signed-in admin only, with the unsaved fields, and stores nothing', async () => {
    const current = await live('otp');
    const templates = (await pool.query('SELECT count(*)::int AS n FROM email_templates')).rows[0].n;
    const res = await call('POST', '/api/admin/email-templates/test', {
      action: 'otp', to: 'someone-else@example.invalid', fields: { ...otpBody(current), subject: 'Unsaved test {{code}}' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.outcome.status, 'sent');
    assert.equal(res.body.to, 'route-admin@example.invalid');
    const mail = sent.at(-1);
    assert.equal(mail.to, 'route-admin@example.invalid');
    const { buildMessage } = require('../src/services/mail/templates');
    const built = buildMessage(mail.kind, mail);
    assert.equal(built.subject, 'Unsaved test 123456');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM email_templates')).rows[0].n, templates);
    const { rows: [delivery] } = await pool.query("SELECT kind, recipient FROM mail_deliveries ORDER BY id DESC LIMIT 1");
    assert.deepEqual(delivery, { kind: 'admin_test', recipient: 'route-admin@example.invalid' });
    const last = (await eventsOf()).at(-1);
    assert.equal(last.event_type, 'mail_test_sent');
    assert.equal(last.metadata.action, 'otp');
    const invalid = await call('POST', '/api/admin/email-templates/test', { action: 'otp', fields: { ...otpBody(current), html: '<p>none</p>' } });
    assert.equal(invalid.status, 400);
    const layoutFields = { action: 'otp', fields: { html: '<main>{{content}}</main>', text: '{{content}}' } };
    const throttled = await call('POST', '/api/admin/email-layouts/test', layoutFields);
    assert.equal(throttled.status, 200);
    assert.equal(throttled.body.outcome.status, 'suppressed_rate_limit', 'the real send path, with its throttle');
    await pool.query("DELETE FROM mail_deliveries WHERE recipient = 'route-admin@example.invalid'");
    const layoutTest = await call('POST', '/api/admin/email-layouts/test', layoutFields);
    assert.equal(layoutTest.status, 200, JSON.stringify(layoutTest.body));
    assert.equal(layoutTest.body.outcome.status, 'sent');
    assert.match(buildMessage(sent.at(-1).kind, sent.at(-1)).html, /^<main>[\s\S]*<\/main>$/);
    // The live template shown in an unsaved layout must still work in it:
    // project_opened keeps its unsubscribe link in its why line, which this
    // layout does not print.
    assert.match((await live('project_opened')).why, /unsubscribeUrl/);
    const before = sent.length;
    const breaking = await call('POST', '/api/admin/email-layouts/test', { action: 'project_opened', fields: { html: '<main>{{content}}</main>', text: '{{content}}' } });
    assert.equal(breaking.status, 400, JSON.stringify(breaking.body));
    assert.ok(breaking.body.errors.some((e) => e.message.includes('{{unsubscribeUrl}}')));
    assert.equal(sent.length, before, 'nothing sent');
    await pool.query('UPDATE users SET email = NULL WHERE id = $1', [user.id]);
    const nowhere = await call('POST', '/api/admin/email-templates/test', { action: 'otp', fields: otpBody(current) });
    assert.equal(nowhere.status, 400);
    assert.match(nowhere.body.error, /email address/);
  });
});
