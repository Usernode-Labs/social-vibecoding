'use strict';

// src/db/email-template-seeds.js, src/db/migrate.js: the first templates reach
// the database at boot, once, in English, safely with several servers starting
// together, and never come back once deleted. Their other languages are
// Translate's, in the admin console; a seed run never writes or undoes one.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { KINDS } = require('../src/services/mail/templates');
const log = require('../src/services/logger');
const languageCache = require('../src/services/language-cache');
const { SEEDS, FINGERPRINT, seedEmailTemplates, englishTemplate, kindsWithoutTemplate } = require('../src/db/email-template-seeds');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const SOURCE = {
  files: {
    'config.json': { sourceLanguage: 'en', languages: { en: 'English', fr: 'Français', es: 'Español' } },
    'glossary.json': { doNotTranslate: ['Homeroom'] },
    'en/email.json': ENGLISH,
  },
};

// The seeds as a later release might word them: `change` is { kind: { field: value } }.
async function withSeeds(change, work) {
  const before = {};
  for (const [kind, fields] of Object.entries(change)) {
    before[kind] = { ...SEEDS.templates[kind] };
    Object.assign(SEEDS.templates[kind], fields);
  }
  try {
    return await work();
  } finally {
    for (const [kind, fields] of Object.entries(before)) SEEDS.templates[kind] = fields;
  }
}

test('seeding email templates against PostgreSQL', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end(); if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('Set TEST_DATABASE_URL for PostgreSQL'); return;
  }
  const name = 'mail_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  const config = { databaseUrl: String(url), adminUsername: 'seed-admin', adminPassword: 'only-for-tests', selfAppSlug: 'seed-platform', platformRepoUrl: 'https://github.com/Usernode-Labs/social-vibecoding' };
  const { migrate } = require('../src/db/migrate');
  const dbPool = require('../src/db/pool');
  const originalGetPool = dbPool.getPool;
  dbPool.getPool = () => pool;
  t.after(() => { dbPool.getPool = originalGetPool; });
  // A checkout may not have built its language source; the seed never reads it.
  const readSource = t.mock.method(languageCache, 'readSource', () => SOURCE);
  await migrate(config);
  const store = require('../src/services/mail/template-store');

  const count = async (sql) => (await pool.query(sql)).rows[0].n;
  const empty = () => pool.query('TRUNCATE email_template_translations, email_layout_translations, email_templates, email_layouts');

  await t.test('booting seeds every kind and the one layout, and booting again adds nothing', async () => {
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
    await migrate(config);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
    const { rows } = await pool.query("SELECT e.action, e.version, e.status, e.layout_family_id, l.name AS layout FROM email_templates e JOIN email_layouts l ON l.family_id = e.layout_family_id");
    assert.equal(rows.length, KINDS.length);
    assert.ok(rows.every((row) => row.version === 1 && row.status === 'live' && row.layout === 'Homeroom standard'));
  });

  await t.test('the snapshot the sender will read holds the seeds as written', async () => {
    const { templates, layouts } = await store.snapshot(pool);
    assert.deepEqual(Object.keys(templates).sort(), [...KINDS].sort());
    assert.equal(Object.keys(layouts).length, 1);
    const expected = englishTemplate('waitlist_released');
    for (const field of ['name', 'subject', 'preheader', 'why', 'html', 'text']) {
      assert.equal(templates.waitlist_released[field], expected[field], field);
    }
    assert.equal(Object.values(layouts)[0].html, SEEDS.layouts[0].html);
  });

  await t.test('re-seeding after delete adds nothing', async () => {
    const { templates } = await store.snapshot(pool);
    const v1 = templates.otp;
    const v2 = await store.saveTemplate(pool, { action: 'otp', name: v1.name, layoutFamilyId: v1.layout_family_id, subject: 'Edited', preheader: '', why: v1.why, html: v1.html, text: v1.text, expectedLiveId: v1.id }, null);
    await store.deleteTemplate(pool, v2.id, { replacementId: v1.id }, null);
    // The store always keeps one live, so the last version goes by hand.
    await pool.query("UPDATE email_templates SET status = 'archived', deleted_at = NOW() WHERE action = 'otp'");
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'otp' AND deleted_at IS NULL"), 0);
    const before = await count('SELECT count(*)::int AS n FROM email_templates');

    await seedEmailTemplates(pool);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), before);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'otp' AND deleted_at IS NULL"), 0);
  });

  await t.test('a deleted layout is not brought back', async () => {
    await pool.query("UPDATE email_layouts SET status = 'archived', deleted_at = NOW()");
    await seedEmailTemplates(pool);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_layouts WHERE deleted_at IS NULL"), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);

    // A new kind whose layout an admin deleted waits for an admin, and the rest of
    // the seeding still works.
    await pool.query("DELETE FROM email_templates WHERE action = 'password_reset'");
    await seedEmailTemplates(pool);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'password_reset'"), 0);
  });

  await t.test('a renamed layout has not been deleted', async () => {
    await empty();
    await seedEmailTemplates(pool);
    const { layouts } = await store.snapshot(pool);
    const [v1] = Object.values(layouts);
    await store.saveLayout(pool, { familyId: v1.family_id, name: 'Our frame', html: v1.html, text: v1.text, expectedLiveId: v1.id }, null);
    await pool.query("DELETE FROM email_templates WHERE action = 'password_reset'");
    await seedEmailTemplates(pool);
    const { rows } = await pool.query("SELECT layout_family_id FROM email_templates WHERE action = 'password_reset'");
    assert.deepEqual(rows, [{ layout_family_id: v1.family_id }]);
    assert.equal(await count('SELECT count(DISTINCT family_id)::int AS n FROM email_layouts'), 1);
  });

  await t.test('only the missing kind is added, and an edited one is left alone', async () => {
    await empty();
    await seedEmailTemplates(pool);
    // An admin's save is what makes an action theirs (a raw edit of version 1 is
    // what the refresh puts back; see below).
    const [v1] = (await pool.query("SELECT * FROM email_templates WHERE action = 'otp'")).rows;
    await store.saveTemplate(pool, { action: 'otp', name: v1.name, layoutFamilyId: v1.layout_family_id, subject: 'Edited', preheader: v1.preheader, why: v1.why, html: v1.html, text: v1.text, expectedLiveId: v1.id }, null);
    await pool.query("DELETE FROM email_templates WHERE action = 'password_reset'");
    await seedEmailTemplates(pool);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'password_reset' AND version = 1 AND status = 'live'"), 1);
    assert.equal((await pool.query("SELECT subject FROM email_templates WHERE action = 'otp' AND status = 'live'")).rows[0].subject, 'Edited');
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
  });

  await t.test('servers booting together seed once', async () => {
    await empty();
    await Promise.all(Array.from({ length: 6 }, () => seedEmailTemplates(pool)));
    // A server that lost the lock left the work to the winner, which has finished.
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 1);
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE version <> 1"), 0);
  });

  await t.test('with nothing to do, a boot costs one query and no connection held', async () => {
    const seen = [];
    const spy = { query: (...args) => { seen.push(args[0]); return pool.query(...args); }, connect: () => { throw new Error('no connection needed'); } };
    await seedEmailTemplates(spy);
    assert.equal(seen.length, 1);
  });

  await t.test('a fresh database gets English only, whatever the translation cache holds, and never reads the language source', async (st) => {
    const info = st.mock.method(log, 'info', () => {});
    await empty();
    await pool.query(
      "INSERT INTO language_translations (language, namespace, key, source, text) VALUES ('fr', 'email', 'buildReady.lead.ready', 'x', 'Prêt') ON CONFLICT DO NOTHING");
    const reads = readSource.mock.callCount();
    await seedEmailTemplates(pool);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_template_translations'), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layout_translations'), 0);
    assert.deepEqual(info.mock.calls.at(-1).arguments[2], { kinds: KINDS.length });
    assert.equal(readSource.mock.callCount(), reads);
    await pool.query("DELETE FROM language_translations WHERE language = 'fr' AND namespace = 'email'");
  });

  await t.test('a failed seed changes nothing and the next boot tries again', async () => {
    await empty();
    const failing = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: () => client.release(),
          query: (sql, params) => (/INSERT INTO email_templates/.test(sql) && params[0] === 'password_reset'
            ? Promise.reject(new Error('no such luck'))
            : client.query(sql, params)),
        };
      },
    };
    await seedEmailTemplates(failing);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), 0);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_layouts'), 0);
    await seedEmailTemplates(pool);
    assert.equal(await count('SELECT count(*)::int AS n FROM email_templates'), KINDS.length);
  });

  await t.test('a database that cannot be reached is logged, and never fails the boot', async (st) => {
    const errors = st.mock.method(log, 'error', () => {});
    const broken = { query: () => Promise.reject(new Error('connection refused')), connect: () => Promise.reject(new Error('connection refused')) };
    await seedEmailTemplates(broken);
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(errors.mock.calls[0].arguments[1], 'Could not seed email templates');
  });

  await t.test('a send reads the stored rows through one consistent snapshot and records its delivery', async () => {
    const mail = require('../src/services/mail');
    const { buildMessage } = require('../src/services/mail/templates');
    const { rows: [otp] } = await pool.query("SELECT id FROM email_templates WHERE action = 'otp' AND status = 'live' AND deleted_at IS NULL");
    await store.saveTranslation(pool, 'template', otp.id, 'fr',
      { subject: 'Votre code Homeroom', preheader: '', why: 'Pourquoi', html: '<p>{{code}}</p>', text: 'Votre code : {{code}}' }, 'admin');
    const isolation = [];
    const timeouts = [];
    const spied = { ...pool, query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (/^SELECT e\.\*/.test(sql)) {
          isolation.push((await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation);
          timeouts.push((await client.query('SHOW statement_timeout')).rows[0].statement_timeout);
        }
        return result;
      }, release: () => client.release() };
    } };
    dbPool.getPool = () => spied;
    try {
      const snapshot = await store.getSnapshot(spied);
      assert.deepEqual(Object.keys(snapshot.templates).sort(), [...KINDS].sort());
      assert.deepEqual(isolation, ['repeatable read', 'repeatable read']);
      // The read's own bound, local to its transaction: the pool's next user gets the default back.
      assert.deepEqual(timeouts, [`${store.LOAD_LIMIT_MS / 1000}s`, `${store.LOAD_LIMIT_MS / 1000}s`]);
      const after = await pool.connect();
      try { assert.equal((await after.query('SHOW statement_timeout')).rows[0].statement_timeout, '0'); } finally { after.release(); }
      const rendered = [];
      const config = { databaseUrl: String(url), mailStagingLogOnly: false, mailTransport: { provider: 'test', async send({ to, kind, ...payload }) { rendered.push(buildMessage(kind, payload)); } } };
      await mail.sendOtpMail(config, 'fr@example.com', '654321', { locale: 'fr' });
      await mail.sendOtpMail(config, 'en@example.com', '654321');
      assert.equal(rendered[0].subject, 'Votre code Homeroom');
      assert.equal(rendered[0].text, 'Votre code : 654321');
      assert.deepEqual(rendered[1], buildMessage('otp', { code: '654321' }));
      const { rows } = await pool.query("SELECT recipient, status FROM mail_deliveries WHERE kind = 'otp' ORDER BY id");
      assert.deepEqual(rows, [{ recipient: 'fr@example.com', status: 'sent' }, { recipient: 'en@example.com', status: 'sent' }]);
    } finally {
      dbPool.getPool = () => pool;
    }
  });

  // ── Untouched seed rows follow the seeds, and only in English ──────────

  const liveRow = async (action) => (await pool.query(
    "SELECT * FROM email_templates WHERE action = $1 AND status = 'live' AND deleted_at IS NULL", [action])).rows[0];
  const frRow = async (id) => (await pool.query("SELECT * FROM email_template_translations WHERE template_id = $1 AND locale = 'fr'", [id])).rows[0];
  const reseed = async () => {
    await pool.query("DELETE FROM platform_settings WHERE key = 'email_template_seed_fingerprint'");
    await seedEmailTemplates(pool);
  };
  const machineFrench = (id, subject = 'Votre code Homeroom') => pool.query(
    `INSERT INTO email_template_translations (template_id, locale, subject, preheader, why, html, text, origin)
     SELECT id, 'fr', $2, preheader, 'Pourquoi', html, text, 'machine' FROM email_templates WHERE id = $1
     ON CONFLICT (template_id, locale) DO UPDATE SET subject = EXCLUDED.subject, origin = 'machine'`, [id, subject]);
  const NEW_SUBJECT = { otp: { subject: 'Your Homeroom sign-in code' } };

  await t.test('a seed change refreshes an untouched row in place, and an admin\'s action never', async (st) => {
    st.mock.method(log, 'info', () => {});
    await empty();
    await seedEmailTemplates(pool);
    const otp = await liveRow('otp');
    const reset = await liveRow('password_reset');
    // An admin's first save makes password_reset theirs, even with the seed's
    // words (a new name: a save identical to the live version is refused).
    const theirs = await store.saveTemplate(pool, { action: 'password_reset', name: `${reset.name} (mine)`, layoutFamilyId: reset.layout_family_id,
      subject: reset.subject, preheader: reset.preheader, why: reset.why, html: reset.html, text: reset.text, expectedLiveId: reset.id }, null);
    // And a version 1 an admin wrote (created_by set) is theirs too.
    const { rows: [{ id: userId }] } = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
    await pool.query("UPDATE email_templates SET created_by = $1, subject = 'Mine' WHERE action = 'account_email'", [userId]);

    await withSeeds({ ...NEW_SUBJECT, password_reset: { subject: 'Seeded' }, account_email: { subject: 'Seeded' } }, reseed);
    const after = await liveRow('otp');
    assert.equal(after.id, otp.id, 'in place');
    assert.equal(after.version, 1);
    assert.equal(after.subject, 'Your Homeroom sign-in code');
    assert.equal((await liveRow('password_reset')).id, theirs.id);
    assert.equal((await liveRow('password_reset')).subject, reset.subject);
    assert.equal((await liveRow('account_email')).subject, 'Mine');
    assert.equal(await count("SELECT count(*)::int AS n FROM email_templates WHERE action = 'password_reset'"), 2);

    // Back to the first wording: the untouched row follows again.
    await reseed();
    assert.equal((await liveRow('otp')).subject, otp.subject);
  });

  await t.test('a change to the seeds is seen on the next boot without help: the fingerprint is the seeds\'', async (st) => {
    st.mock.method(log, 'info', () => {});
    await empty();
    await seedEmailTemplates(pool);
    const recorded = (await pool.query("SELECT value FROM platform_settings WHERE key = 'email_template_seed_fingerprint'")).rows[0].value;
    assert.equal(recorded, FINGERPRINT);
    // An older release's fingerprint (the catalog's) is not this one, so the first
    // boot of this release compares every row once.
    await pool.query("UPDATE platform_settings SET value = 'from the catalog' WHERE key = 'email_template_seed_fingerprint'");
    await pool.query("UPDATE email_templates SET subject = 'stale' WHERE action = 'otp'");
    await seedEmailTemplates(pool);
    assert.equal((await liveRow('otp')).subject, englishTemplate('otp').subject);
  });

  await t.test('a refresh compares, and writes only what differs', async () => {
    await empty();
    await seedEmailTemplates(pool);
    await pool.query("UPDATE email_templates SET html = 'stale' WHERE action = 'otp'");
    await pool.query("UPDATE email_layouts SET text = 'stale'");
    // Nothing in the seeds changed, so a fresh boot does not even look.
    await seedEmailTemplates(pool);
    assert.equal((await liveRow('otp')).html, 'stale');
    await pool.query("DELETE FROM platform_settings WHERE key = 'email_template_seed_fingerprint'");
    const writes = [];
    const spy = {
      query: (...args) => pool.query(...args),
      connect: async () => {
        const client = await pool.connect();
        return { release: (err) => client.release(err), query: (sql, params) => { if (/^\s*(UPDATE|INSERT|DELETE)/.test(sql)) writes.push(sql.trim().split(/\s+/).slice(0, 3).join(' ')); return client.query(sql, params); } };
      },
    };
    await seedEmailTemplates(spy);
    assert.equal((await liveRow('otp')).html, englishTemplate('otp').html);
    assert.equal((await pool.query('SELECT text FROM email_layouts')).rows[0].text, SEEDS.layouts[0].text);
    assert.deepEqual(writes.sort(), ['INSERT INTO platform_settings', 'UPDATE email_layouts SET', 'UPDATE email_templates SET']);
  });

  await t.test('the refresh leaves the translations of an unchanged row alone; new English drops the machine\'s and keeps an admin\'s', async (st) => {
    st.mock.method(log, 'info', () => {});
    st.mock.method(log, 'warn', () => {});
    await empty();
    await seedEmailTemplates(pool);
    const otp = await liveRow('otp');
    const reset = await liveRow('password_reset');
    await machineFrench(otp.id);
    await store.saveTranslation(pool, 'template', reset.id, 'fr',
      { subject: 'Admin', preheader: '', why: 'w', html: reset.html, text: reset.text }, 'admin');
    // The seeds' own English: nothing is compared but the English, so the
    // translations Translate or an admin wrote stay as they are.
    await reseed();
    assert.equal((await frRow(otp.id)).subject, 'Votre code Homeroom');
    assert.equal((await frRow(reset.id)).subject, 'Admin');

    await withSeeds({ ...NEW_SUBJECT, password_reset: { subject: 'Reset your Homeroom password now' } }, reseed);
    assert.equal(await frRow(otp.id), undefined, 'the machine translated the English just replaced');
    const admin = await frRow(reset.id);
    assert.equal(admin.subject, 'Admin');
    assert.equal(admin.origin, 'admin');
    assert.equal(admin.unusable, null, 'rechecked, and it still fits');
    await reseed();
  });

  await t.test('what the stored rows send is what the seeds send in memory', async () => {
    // After a seed run, read back as a send reads them: the snapshot, resolve and
    // the stored-template render, against buildMessage with no template in hand.
    const mailTemplates = require('../src/services/mail/templates');
    await empty();
    await seedEmailTemplates(pool);
    const snap = await store.snapshot(pool);
    const UNSUB = 'https://app.onhomeroom.com/mail/unsubscribe?token=abc';
    const payloads = {
      otp: [{ code: '123456' }], account_email: [{ code: '123456' }], username_change: [{ code: '123456' }],
      waitlist_joined: [{ code: '123456', confirmUrl: 'https://x.test/c' }, {}],
      waitlist_code: [{ code: '123456', confirmUrl: 'https://x.test/c' }, { confirmed: true, statusUrl: 'https://x.test/s' }],
      waitlist_released: [{ url: 'https://x.test/', mobile: { ios: 'https://x.test/i' } }, { url: 'https://x.test/l', hasAccount: true }],
      password_reset: [{ url: 'https://x.test/r' }],
      admin_test: [{ provider: 'p', from: 'f', sentAt: 'n', reference: 'r' }],
      content_report: [{ reason: 'spam', targetType: 'app', targetLabel: 'T', url: 'https://x.test/m' }],
      project_invite: [{ inviter: 'Sam', project: 'P', url: 'https://x.test/w' }, { url: 'https://x.test/w' }],
      build_ready: [{ appName: 'Run Club', url: 'https://x.test/a', unsubscribeUrl: UNSUB }, { notWorking: true, unsubscribeUrl: UNSUB }],
      invite_activity: [{ appName: 'Run Club', notice: { id: 'member_joined', values: { name: 'sam' } }, unsubscribeUrl: UNSUB }],
      project_opened: [{ appName: 'Run Club', url: 'https://x.test/a', unsubscribeUrl: UNSUB }],
      waitlist_reminder: [
        { url: 'https://x.test/s', signInLink: true, signInExpiresAt: '2026-11-13T10:00:00Z', releasedAt: '2026-11-06T09:00:00Z', now: '2026-11-09T09:00:00Z', unsubscribeUrl: UNSUB },
        { url: 'https://x.test/l', hasAccount: true, releasedAt: '2026-10-01T09:00:00Z', unsubscribeUrl: UNSUB },
      ],
      waitlist_reminder_last: [{ url: 'https://x.test/s', releasedAt: '2026-10-01T09:00:00Z', unsubscribeUrl: UNSUB, replyTo: 'support@usernodelabs.org' }],
    };
    assert.deepEqual(Object.keys(payloads).sort(), [...KINDS].sort());
    let compared = 0;
    for (const kind of KINDS) {
      for (const payload of payloads[kind]) {
        const english = store.resolve(snap, kind, null);
        assert.deepEqual(mailTemplates.buildMessage(kind, { ...payload, resolved: { ...english, t: null, readerHasLanguage: false } }),
          mailTemplates.buildMessage(kind, payload), `en ${kind}`);
        compared += 1;
      }
    }
    assert.ok(compared > 15);
  });

  // ── Translate (services/mail/template-translate.js) and the refresh ──────

  const fresh = async () => {
    await empty();
    await pool.query('TRUNCATE email_translation_jobs');
    await seedEmailTemplates(pool);
  };

  await t.test('a translation left by a refresh is checked inside the layout it is sent in', async (st) => {
    st.mock.method(log, 'info', () => {});
    st.mock.method(log, 'warn', () => {});
    await fresh();
    const otp = await liveRow('otp');
    // An admin's French, longer than the English.
    const french = { subject: 'Votre code Homeroom', preheader: '', why: otp.why, html: `${otp.html}<p>Merci de votre confiance.</p>`, text: otp.text };
    await store.saveTranslation(pool, 'template', otp.id, 'fr', french, 'admin');
    const fr = await frRow(otp.id);
    const { rows: [layout] } = await pool.query("SELECT * FROM email_layouts WHERE status = 'live' AND deleted_at IS NULL");
    const { renderMessage } = require('../src/services/mail/render');
    const { actionFor } = require('../src/services/mail/actions');
    const size = (template) => Buffer.byteLength(renderMessage('otp', { template, layout }, actionFor('otp').sample || {}).html, 'utf8');
    const en = size(otp);
    const longer = size(fr);
    assert.ok(longer - en >= 4, `French is longer (${en} / ${longer})`);
    // An admin's layout, padded so the English otp fits the 100 KB limit and the French does not.
    const filler = 100 * 1024 - en - 7 - Math.floor((longer - en) / 2);
    const padded = layout.html.replace('{{content}}', `<p>${'x'.repeat(filler)}</p>{{content}}`);
    const theirs = await store.saveLayout(pool, { name: 'Admin padded', html: padded, text: layout.text }, null);
    await pool.query('UPDATE email_templates SET layout_family_id = $2 WHERE id = $1', [otp.id, theirs.family_id]);
    await withSeeds({ otp: { subject: 'Your Homeroom code' } }, reseed);
    const after = await frRow(otp.id);
    assert.equal(after.subject, fr.subject, 'an admin\'s words stay');
    assert.ok(after.unusable, 'and are marked, not sent');
    const snap = await store.snapshot(pool);
    assert.equal(store.resolve(snap, 'otp', 'fr').template.subject, 'Your Homeroom code');
    await pool.query('UPDATE email_templates SET layout_family_id = $2 WHERE id = $1', [otp.id, layout.family_id]);
  });

  await t.test('Translate\'s job: a run in progress holds its version, and one gone quiet does not', async (st) => {
    st.mock.method(log, 'info', () => {});
    st.mock.method(log, 'warn', () => {});
    await fresh();
    const otp = await liveRow('otp');
    const job = (state, perLanguage, ageSeconds = 0) => pool.query(
      `INSERT INTO email_translation_jobs (kind, version_id, state, per_language, run_id, updated_at)
       VALUES ('template', $1, $2, $3::jsonb, gen_random_uuid(), NOW() - make_interval(secs => $4))
       ON CONFLICT (kind, version_id) DO UPDATE SET state = EXCLUDED.state, per_language = EXCLUDED.per_language, updated_at = EXCLUDED.updated_at`,
      [otp.id, state, JSON.stringify(perLanguage), ageSeconds]);
    const jobs = async () => (await pool.query("SELECT count(*)::int AS n FROM email_translation_jobs WHERE version_id = $1", [otp.id])).rows[0].n;
    await machineFrench(otp.id, 'Translated');

    // What Translate saved on the same English stays, whatever the job says.
    await job('done', { fr: 'saved', es: 'failed: x' });
    await reseed();
    assert.equal((await frRow(otp.id)).subject, 'Translated');
    assert.equal(await jobs(), 1);

    // A run in progress holds the whole version, English included.
    await job('running', { fr: 'pending' });
    await withSeeds(NEW_SUBJECT, reseed);
    assert.equal((await liveRow('otp')).subject, otp.subject);
    assert.equal((await frRow(otp.id)).subject, 'Translated');

    // One gone quiet does not, and new English replaces the machine's words and the job.
    await job('running', { fr: 'pending' }, 60 * 60);
    await withSeeds(NEW_SUBJECT, reseed);
    assert.equal((await liveRow('otp')).subject, 'Your Homeroom sign-in code');
    assert.equal(await frRow(otp.id), undefined);
    assert.equal(await jobs(), 0);
    await reseed();
  });

  await t.test('a lost or skipped seed is found: every kind needs a live template on a live layout', async () => {
    assert.deepEqual(await kindsWithoutTemplate(pool), []);
    await pool.query("UPDATE email_templates SET status = 'archived', deleted_at = NOW() WHERE action = 'otp'");
    assert.deepEqual(await kindsWithoutTemplate(pool), ['otp']);
    await pool.query("UPDATE email_layouts SET status = 'archived', deleted_at = NOW()");
    assert.deepEqual(await kindsWithoutTemplate(pool), [...KINDS].sort());
  });
});
