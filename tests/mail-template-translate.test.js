'use strict';

// src/services/mail/template-translate.js and its routes in
// src/routes/admin-email-templates.js: Translate fills every other language of
// a template or layout version from its English, with a fake model, and holds
// each answer to the same checks as the English (and to the English itself),
// against real PostgreSQL because the job's state and the per-language saves
// are rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const translate = require('../src/services/mail/template-translate');

const LANGUAGES = { en: 'English', fr: 'Français', es: 'Español', ru: 'Русский', ja: '日本語', ko: '한국어', 'zh-CN': '简体中文', 'pt-BR': 'Português (Brasil)', vi: 'Tiếng Việt' };

// A "translation" that keeps everything but marks the words, so it passes.
function faithful(language, parts) {
  const out = {};
  for (const [field, value] of Object.entries(parts)) {
    out[field] = field === 'subject' ? `[${language}] ${value}` : value.replace(/<p>([A-Z])/g, `<p>[${language}] $1`);
  }
  return out;
}

// A model that answers each request with `answerFor(language, parts)`: an
// object of parts, an Error for a failed request, or a promise of either.
function fakeModel(answerFor = faithful) {
  const calls = [];
  return {
    calls,
    isEnabled: () => true,
    translateCatalogDirect: async (requests) => {
      const answers = new Map();
      for (const request of requests) {
        calls.push(request);
        const { parts } = JSON.parse(request.params.messages[0].content);
        const out = await answerFor(request.language, parts, request);
        answers.set(request.customId, out instanceof Error
          ? { error: out.message }
          : { text: JSON.stringify(out), usage: { input_tokens: 1000, output_tokens: 500 } });
      }
      return answers;
    },
  };
}

function fakeLimits() {
  const spent = [];
  return { spent, checkSystemBudget: async () => ({ ok: true }), recordSystemSpend: async (_pool, cents) => { spent.push(cents); } };
}

const GLOSSARY = { doNotTranslate: ['Homeroom'], terms: {}, style: {} };

test('a translation is compared with its English', () => {
  const english = { subject: 'Hi {{name}}', html: '{{#if hasUrl}}<p><a href="{{url}}">Open</a></p>{{/if}}<p>Bye</p>', text: '{{url}}' };
  assert.equal(translate.englishDifference(english, { ...english, subject: 'Salut {{name}}' }), null);
  assert.match(translate.englishDifference(english, { ...english, subject: 'Salut' }), /subject.*\{\{name\}\}/);
  assert.match(translate.englishDifference(english, { ...english, subject: 'Salut {{nom}}' }), /\{\{nom\}\}/);
  assert.match(translate.englishDifference(english, { ...english, html: '<p><a href="{{url}}">Ouvrir</a></p><p>Au revoir</p>' }), /\{\{hasUrl\}\}/);
  assert.match(translate.englishDifference(english, { ...english, html: '{{#unless hasUrl}}<p><a href="{{url}}">Open</a></p>{{/unless}}<p>Bye</p>' }), /condition/);
  assert.match(translate.englishDifference(english, { ...english, html: '{{#if hasUrl}}<p>Open</p>{{/if}}<p><a href="{{url}}">Bye</a></p>' }), /condition/);
  assert.match(translate.englishDifference(english, { ...english, html: english.html.replace('{{url}}', 'https://evil.example') }), /\{\{url\}\}/);
  assert.match(translate.englishDifference({ text: 'Go to https://a.example/x' }, { text: 'Allez sur https://b.example/x' }), /link/);
  assert.match(translate.englishDifference(english, { ...english, html: `${english.html}<b>x</b>` }), /tag/);
  // Words a reader sees in an attribute may be translated.
  const img = { html: '<p><img src="https://x.example/a.png" alt="Logo"></p>' };
  assert.equal(translate.englishDifference(img, { html: '<p><img src="https://x.example/a.png" alt="Logotipo"></p>' }), null);
  assert.match(translate.englishDifference(img, { html: '<p><img src="https://x.example/b.png" alt="Logo"></p>' }), /link|tag/);
  // HTML that does not even scan is a difference, never a skipped comparison.
  assert.match(translate.englishDifference(img, { html: '<p><img src="https://x.example/a.png" alt="Logo">\u0000</p>' }), /HTML/);
});

test('email template translation against PostgreSQL', { timeout: 300000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_tpl_tr_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  let server;
  const llm = require('../src/services/llm');
  const llmOriginal = { isEnabled: llm.isEnabled, translateCatalogDirect: llm.translateCatalogDirect };
  t.after(async () => {
    Object.assign(llm, llmOriginal);
    if (server) await new Promise((resolve) => server.close(resolve));
    poolModule.getPool = original; await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
  });
  const config = { databaseUrl: String(url), adminUsername: 'tpl-tr-admin', adminPassword: 'only-for-tests', selfAppSlug: 'tpl-tr-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  await migrate(config); await migrate(config);
  const seeds = require('../src/db/email-template-seeds');
  await seeds.seedEmailTemplates(pool);
  const store = require('../src/services/mail/template-store');
  const { rows: [user] } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');

  const live = async (action) => (await pool.query("SELECT * FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL", [action])).rows[0];
  const liveLayout = async () => (await pool.query("SELECT * FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL ORDER BY family_id LIMIT 1")).rows[0];
  const rowsOf = async (id) => Object.fromEntries((await pool.query('SELECT * FROM email_template_translations WHERE template_id = $1', [id])).rows.map((r) => [r.locale, r]));
  // A fresh version of an action, so each test starts with no translations.
  const freshVersion = async (action, edit = (x) => x) => {
    const current = await live(action);
    return store.saveTemplate(pool, edit({
      action, name: current.name, layoutFamilyId: current.layout_family_id, subject: current.subject,
      preheader: current.preheader, why: current.why, html: current.html, text: current.text, expectedLiveId: current.id,
    }), user.id);
  };
  const run = (kind, id, model, { deps = {}, ...extra } = {}) => translate.translateVersion(pool, kind, id, {
    ...extra, deps: { llm: model, limits: fakeLimits(), languages: LANGUAGES, glossary: GLOSSARY, ...deps },
  });

  await t.test('saves every language but English', async () => {
    const row = await freshVersion('otp');
    const model = fakeModel();
    const limits = fakeLimits();
    const result = await run('template', row.id, model, { deps: { limits } });
    const others = Object.keys(LANGUAGES).filter((l) => l !== 'en');
    assert.deepEqual(Object.keys(result.perLanguage).sort(), others.sort());
    for (const l of others) assert.equal(result.perLanguage[l], 'saved', l);
    const saved = await rowsOf(row.id);
    assert.deepEqual(Object.keys(saved).sort(), others.sort());
    assert.equal(saved.fr.origin, 'machine');
    assert.equal(saved.fr.subject, '[fr] Your Homeroom login code');
    assert.match(saved.fr.html, /\{\{code\}\}/);
    // One request per language, with the existing model and the glossary.
    assert.equal(model.calls.length, others.length);
    assert.equal(model.calls[0].params.model, require('../src/services/language-sync').MODEL);
    const system = model.calls[0].params.system.map((b) => b.text).join('\n');
    assert.match(system, /Homeroom/);
    assert.match(system, /keep every \{\{…\}\} and every HTML tag and attribute exactly; translate only text/i);
    assert.doesNotMatch(system, /"translations": \[/);
    assert.deepEqual(Object.keys(JSON.parse(model.calls[0].params.messages[0].content).parts).sort(), ['html', 'preheader', 'subject', 'text', 'why']);
    assert.ok(limits.spent.length > 0 && limits.spent.every((c) => c > 0));
    const status = await translate.jobStatus(pool, 'template', row.id);
    assert.equal(status.state, 'done');
    assert.equal(status.perLanguage.fr, 'saved');
    // The sender reads them.
    const snap = await store.snapshot(pool);
    assert.equal(store.resolve(snap, 'otp', 'fr').template.subject, '[fr] Your Homeroom login code');
  });

  await t.test('an answer dropping a required placeholder, a conditional or a link is rejected for that language and others save', async () => {
    const row = await freshVersion('waitlist_joined');
    const hostile = {
      fr: (p) => ({ ...p, html: p.html.replace('{{code}}', ''), text: p.text.replace('{{code}}', '') }),
      es: (p) => ({ ...p, html: p.html.replace('{{code}}', '{{codigo}}'), text: p.text.replace('{{code}}', '{{codigo}}') }),
      ru: (p) => ({ ...p, html: `${p.html}<p><b>Bonus</b></p>` }),
      ja: (p) => ({ ...p, html: p.html.replace('href="{{confirmUrl}}"', 'href="https://evil.example/?next={{confirmUrl}}"') }),
      ko: (p) => ({ ...p, html: p.html.replace('</strong></p>', '</strong>') }),
      'zh-CN': (p) => ({ ...p, html: p.html.replace('{{#if hasConfirmUrl}}', '').replace(/\{\{\/if\}\}$/, '') }),
      vi: (p) => ({ ...p, subject: p.subject.replace('Homeroom', '{{#if code}}Homeroom{{/if}}') }),
    };
    const model = fakeModel((language, parts) => (hostile[language] ? hostile[language](parts) : faithful(language, parts)));
    const result = await run('template', row.id, model);
    const why = { fr: /\{\{code\}\}/, es: /\{\{codigo\}\}/, ru: /tags/, ja: /link/, ko: /close|open/i, 'zh-CN': /hasConfirmUrl/, vi: /\{\{code\}\}/ };
    for (const l of Object.keys(hostile)) assert.match(result.perLanguage[l], new RegExp(`^failed: .*${why[l].source}`, why[l].flags), `${l}: ${result.perLanguage[l]}`);
    assert.equal(result.perLanguage['pt-BR'], 'saved');
    const saved = await rowsOf(row.id);
    assert.deepEqual(Object.keys(saved), ['pt-BR']);
  });

  await t.test('an answer with markup a save would refuse is rejected', async () => {
    const row = await freshVersion('otp');
    const model = fakeModel((language, parts) => (language === 'fr'
      ? { ...parts, html: `${parts.html}<script>alert(1)</script>` }
      : language === 'es' ? { ...parts, html: parts.html.replace('<p>', '<p onclick="x()">') } : faithful(language, parts)));
    const result = await run('template', row.id, model);
    assert.match(result.perLanguage.fr, /^failed: .*script/i);
    assert.match(result.perLanguage.es, /^failed: /);
    assert.equal(result.perLanguage.ru, 'saved');
    assert.ok(!(await rowsOf(row.id)).fr);
  });

  await t.test('model failure on one chunk reports that language', async () => {
    const row = await freshVersion('otp');
    const model = fakeModel((language, parts) => {
      if (language === 'fr') return new Error('overloaded');
      if (language === 'es') return { not: 'an email' };
      return faithful(language, parts);
    });
    const result = await run('template', row.id, model);
    assert.match(result.perLanguage.fr, /^failed: .*overloaded/);
    assert.match(result.perLanguage.es, /^failed: /);
    assert.equal(result.perLanguage.ru, 'saved');
    // A chunk whose whole call throws fails only its own languages.
    const row2 = await freshVersion('otp');
    let n = 0;
    const throwing = { isEnabled: () => true, translateCatalogDirect: async (requests) => {
      n += 1;
      if (n === 1) throw new Error('network down');
      return fakeModel().translateCatalogDirect(requests);
    } };
    const second = await run('template', row2.id, throwing);
    const failed = Object.values(second.perLanguage).filter((s) => /network down/.test(s));
    assert.ok(failed.length > 0 && failed.length < 8, JSON.stringify(second.perLanguage));
    assert.ok(Object.values(second.perLanguage).includes('saved'));
  });

  await t.test('a new version starts with none, so it is out of date', async () => {
    const row = await freshVersion('otp');
    await run('template', row.id, fakeModel());
    const next = await freshVersion('otp', (b) => ({ ...b, subject: 'Your new Homeroom code' }));
    assert.deepEqual(await rowsOf(next.id), {});
    assert.equal((await translate.jobStatus(pool, 'template', next.id)).state, 'none');
    const snap = await store.snapshot(pool);
    assert.equal(store.resolve(snap, 'otp', 'fr').template.subject, 'Your new Homeroom code');
  });

  await t.test('two presses do not run two jobs', async () => {
    const row = await freshVersion('otp');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const model = fakeModel(async (language, parts) => { await gate; return faithful(language, parts); });
    const deps = { llm: model, limits: fakeLimits(), languages: LANGUAGES, glossary: GLOSSARY };
    const first = await translate.startTranslation(pool, 'template', row.id, { deps });
    const second = await translate.startTranslation(pool, 'template', row.id, { deps });
    assert.equal(first.started, true);
    assert.equal(second.started, false);
    assert.equal(second.job.state, 'running');
    assert.equal((await translate.jobStatus(pool, 'template', row.id)).perLanguage.fr, 'pending');
    release();
    await first.done;
    assert.equal(model.calls.length, Object.keys(LANGUAGES).length - 1);
    assert.equal((await translate.jobStatus(pool, 'template', row.id)).state, 'done');
  });

  await t.test('an admin correction is kept by a later press unless asked to overwrite', async () => {
    const row = await freshVersion('otp');
    const english = await live('otp');
    const corrected = { ...english, subject: 'Votre code Homeroom' };
    await translate.saveCorrection(pool, 'template', row.id, 'fr', corrected);
    assert.equal((await rowsOf(row.id)).fr.origin, 'admin');
    const result = await run('template', row.id, fakeModel());
    assert.equal(result.perLanguage.fr, 'skipped: admin');
    assert.equal((await rowsOf(row.id)).fr.subject, 'Votre code Homeroom');
    const again = await run('template', row.id, fakeModel(), { overwrite: true });
    assert.equal(again.perLanguage.fr, 'saved');
    assert.equal((await rowsOf(row.id)).fr.origin, 'machine');
  });

  await t.test('a correction is checked like the English', async () => {
    const row = await live('otp');
    await assert.rejects(translate.saveCorrection(pool, 'template', row.id, 'fr', { ...row, html: '<p>Votre code</p>' }), (err) => {
      assert.equal(err.code, 'invalid');
      assert.ok(err.errors.length);
      return true;
    });
    await assert.rejects(translate.saveCorrection(pool, 'template', row.id, 'en', row), (err) => err.code === 'invalid');
    await assert.rejects(translate.saveCorrection(pool, 'template', row.id, 'xx', row), (err) => err.code === 'invalid');
  });

  await t.test('English-only actions are refused', async () => {
    const row = await live('admin_test');
    await assert.rejects(run('template', row.id, fakeModel()), (err) => err.code === 'english_only');
    await assert.rejects(translate.saveCorrection(pool, 'template', row.id, 'fr', row), (err) => err.code === 'english_only');
  });

  await t.test('a layout is translated and checked with the templates it frames', async () => {
    const layout = await liveLayout();
    const result = await run('layout', layout.id, fakeModel((language, parts) => (language === 'fr'
      ? { ...parts, html: parts.html.replace('{{content}}', '') }
      : { ...parts, html: parts.html.replace('>Homeroom<br>', `>Homeroom (${language})<br>`) })));
    assert.match(result.perLanguage.fr, /^failed: /);
    assert.equal(result.perLanguage.es, 'saved');
    const { rows } = await pool.query('SELECT locale, origin FROM email_layout_translations WHERE layout_id = $1 ORDER BY locale', [layout.id]);
    assert.ok(rows.some((r) => r.locale === 'es' && r.origin === 'machine'));
    assert.ok(!rows.some((r) => r.locale === 'fr'));
  });

  await t.test('a bad machine translation never blocks a layout save: it is marked unusable and reported', async () => {
    const row = await freshVersion('otp');
    // Written past the checks, as an older pass might have left it.
    await store.saveTranslation(pool, 'template', row.id, 'fr', { ...row, subject: 'Code', html: '<p>Sans code</p>', text: 'Sans code' }, 'machine');
    const layout = await liveLayout();
    const express = require('express');
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use((req, _res, next) => {
      const role = req.headers['x-test-role'] || 'full';
      req.user = { id: user.id, username: 'tpl-tr-admin', isAdmin: role !== 'none', canAdminWrite: role === 'full' };
      next();
    });
    app.use(require('../src/routes/admin').adminRoutes(config));
    server = app.listen(0); await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/email-layouts`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ familyId: layout.family_id, name: layout.name, html: layout.html, text: layout.text, expectedLiveId: layout.id }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.unusableTranslations.some((u) => u.templateId === row.id && u.locale === 'fr' && u.reason));
    const fr = (await rowsOf(row.id)).fr;
    assert.ok(fr.unusable);
    const snap = await store.snapshot(pool);
    assert.equal(store.resolve(snap, 'otp', 'fr').template.subject, row.subject);
    // A later press puts a good one back.
    const again = await run('template', row.id, fakeModel());
    assert.equal(again.perLanguage.fr, 'saved');
    assert.equal((await rowsOf(row.id)).fr.unusable, null);
  });

  await t.test('routes: start, progress, correction, and who may do which', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, p, body, role = 'full') => {
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-role': role }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const model = fakeModel();
    llm.isEnabled = model.isEnabled;
    llm.translateCatalogDirect = model.translateCatalogDirect;
    const row = await freshVersion('otp');
    assert.equal((await call('POST', `/api/admin/email-templates/${row.id}/translate`, {}, 'view')).status, 403);
    const started = await call('POST', `/api/admin/email-templates/${row.id}/translate`, {});
    assert.equal(started.status, 202, JSON.stringify(started.body));
    let progress;
    for (let i = 0; i < 100; i++) {
      progress = await call('GET', `/api/admin/email-templates/${row.id}/translate`, undefined, 'view');
      if (progress.body.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(progress.status, 200);
    assert.equal(progress.body.state, 'done');
    assert.equal(progress.body.perLanguage.fr, 'saved');
    const english = await live('otp');
    const fields = { subject: 'Votre code', preheader: english.preheader, why: english.why, html: english.html, text: english.text };
    assert.equal((await call('PUT', `/api/admin/email-templates/${row.id}/translations/fr`, fields, 'view')).status, 403);
    const put = await call('PUT', `/api/admin/email-templates/${row.id}/translations/fr`, fields);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.translation.origin, 'admin');
    const bad = await call('PUT', `/api/admin/email-templates/${row.id}/translations/fr`, { ...fields, html: '<p>x</p>' });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.errors.length);
    const read = await call('GET', `/api/admin/email-templates/${row.id}/translations`, undefined, 'view');
    assert.equal(read.status, 200);
    assert.equal(read.body.translations.fr.subject, 'Votre code');
    const englishOnly = await live('admin_test');
    assert.equal((await call('POST', `/api/admin/email-templates/${englishOnly.id}/translate`, {})).status, 400);
    const layout = await liveLayout();
    const layoutStart = await call('POST', `/api/admin/email-layouts/${layout.id}/translate`, {});
    assert.equal(layoutStart.status, 202, JSON.stringify(layoutStart.body));
    assert.equal((await call('POST', '/api/admin/email-templates/999999/translate', {})).status, 404);
    for (let i = 0; i < 100; i++) {
      if ((await call('GET', `/api/admin/email-layouts/${layout.id}/translate`)).body.state !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  await t.test('a run taken over as stale stops and writes nothing more', async () => {
    const row = await freshVersion('otp');
    const gates = [];
    const gated = () => {
      let open;
      const gate = new Promise((resolve) => { open = resolve; });
      gates.push(open);
      return fakeModel(async (language, parts) => { await gate; return faithful(language, parts); });
    };
    const deps = (model) => ({ llm: model, limits: fakeLimits(), languages: LANGUAGES, glossary: GLOSSARY });
    const first = await translate.startTranslation(pool, 'template', row.id, { deps: deps(gated()) });
    await pool.query("UPDATE email_translation_jobs SET updated_at = NOW() - interval '1 hour' WHERE kind = 'template' AND version_id = $1", [row.id]);
    assert.equal((await translate.jobStatus(pool, 'template', row.id)).state, 'stopped');
    const second = await translate.startTranslation(pool, 'template', row.id, { deps: deps(gated()) });
    assert.equal(second.started, true);
    gates[0]();
    await first.done;
    const during = await translate.jobStatus(pool, 'template', row.id);
    assert.equal(during.state, 'running', 'the old run did not finish the new one');
    assert.ok(Object.values(during.perLanguage).every((s) => s === 'pending'), JSON.stringify(during.perLanguage));
    assert.deepEqual(await rowsOf(row.id), {}, 'the old run saved nothing');
    gates[1]();
    await second.done;
    const after = await translate.jobStatus(pool, 'template', row.id);
    assert.equal(after.state, 'done');
    assert.equal(after.perLanguage.fr, 'saved');
  });
});
