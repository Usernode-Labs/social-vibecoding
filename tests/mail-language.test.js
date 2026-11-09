'use strict';

// An email in its recipient's language. The words of every mail are the stored
// templates (src/services/mail/template-store.js), written and translated in the
// admin console: a reader with a language gets that language's row where there
// is one, and the English row where there is not. What is left of the email
// catalog (frontend/locales/en/email.json) is the few words an action builds in
// code (src/services/mail/actions.js: build_ready, invite_activity), asked of
// the translator at send time for a translated row. These say the door
// (src/services/mail/index.js) picks the language and reads only what can
// matter, that a translation is untrusted text that can never become markup or
// a header, and that a problem anywhere costs a mail its translation, never its
// code or its link.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { hash } = require('../scripts/language-packs');
const cache = require('../src/services/language-cache');
const dbPool = require('../src/db/pool');
const mail = require('../src/services/mail');
const { buildMessage } = require('../src/services/mail/templates');
const { ACTIONS } = require('../src/services/mail/actions');
const { renderResolved } = require('../src/services/mail/render');
const { translatorFor, requestLanguage } = require('../src/services/mail/language');
const { translator, reset } = require('../src/services/push-language');
const { SEEDS, englishTemplate } = require('../src/db/email-template-seeds');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const english = (key) => ENGLISH[key].text;
const row = (key, text) => ({ language: 'es', key, source: hash(english(key)), text });
const SEEDED = (kind) => englishTemplate(kind);

function sourceWith(committed = {}) {
  return {
    files: {
      'config.json': { sourceLanguage: 'en', languages: { en: 'English', es: 'Español' } },
      'glossary.json': { doNotTranslate: ['Homeroom'] },
      'en/email.json': ENGLISH,
      'es/email.json': committed,
    },
  };
}

// A Spanish otp, as Translate or an admin would store it.
const SPANISH_OTP = {
  subject: 'Tu código de Homeroom',
  preheader: '',
  why: 'Lo recibes por la actividad de tu cuenta.',
  html: '<p>Tu código de Homeroom es:</p><p style="font-size:28px">{{code}}</p><p>Caduca en 10 minutos.</p>',
  text: 'Tu código de Homeroom es {{code}}.\n\nCaduca en 10 minutos.',
};

// A Spanish invite_activity row: the same template, so what changes is only the
// words built in code, which a translated row asks the translator for.
const SPANISH_INVITE = (({ name: _n, layout: _l, ...words }) => ({ ...words, why: 'Hubo novedades para ti en Homeroom.' }))(SEEDED('invite_activity'));

/** The stored templates: every kind's seed in English, with `spanish` rows by kind. */
function storedTemplates(spanish) {
  const templates = Object.keys(ACTIONS).map((kind, i) => {
    const { name, layout, ...fields } = SEEDED(kind);
    const translations = spanish[kind] ? { es: spanish[kind] } : {};
    return { id: i + 1, action: kind, name, layout_family_id: layout ? 1 : null, translations, ...fields };
  });
  const [layout] = SEEDS.layouts;
  return { templates, layouts: [{ id: 1, family_id: 1, name: layout.name, html: layout.html, text: layout.text, translations: {} }] };
}

/**
 * A pool holding `rows` as language_translations (the words built in code), the
 * stored templates with `spanish` rows, and what the door reads and writes.
 */
function poolWith(rows = [], { fail = null, hang = false, spanish = { otp: SPANISH_OTP, invite_activity: SPANISH_INVITE } } = {}) {
  const db = { reads: 0, namespaces: [], templateReads: 0 };
  const stored = storedTemplates(spanish);
  const query = async (sql, params) => {
    if (/FROM language_translations/.test(sql)) {
      db.reads += 1;
      db.namespaces.push(params[1]);
      if (hang) await new Promise(() => {});
      if (fail) throw fail;
      return { rows: rows.filter((r) => r.language === params[0] && params[1] === 'email') };
    }
    if (/FROM email_templates/.test(sql)) {
      db.templateReads += 1;
      return { rows: stored.templates };
    }
    if (/FROM email_layouts/.test(sql)) return { rows: stored.layouts };
    return { rows: [], rowCount: 0 };
  };
  return {
    db,
    query,
    async connect() { return { query, release() {} }; },
  };
}

test.beforeEach(() => reset());

// ── Words built in code ──────────────────────────────────────────────────

test('a failed cache read, a hung one or a lookup that breaks is English, soon', async (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const failing = await translatorFor(poolWith([], { fail: new Error('connection lost') }), 'es');
  assert.equal(failing('email:buildReady.lead.ready'), english('buildReady.lead.ready'), 'a failed read');
  reset();
  // The patience timer is unref'd, as a live server needs nothing else to stay
  // up. A test does: with only that timer, the loop empties and the test is cancelled.
  const keepAlive = setInterval(() => {}, 50);
  t.after(() => clearInterval(keepAlive));
  const started = Date.now();
  assert.equal(await translatorFor(poolWith([], { hang: true }), 'es'), null, 'a read that does not answer');
  assert.ok(Date.now() - started < 1500, 'it is not waited for');
  reset();
  t.mock.method(cache, 'readSource', () => { throw new Error('no such file'); });
  assert.equal(await translatorFor(poolWith(), 'es'), null, 'the lookup itself');
});

test('no language, English, or one Homeroom does not have: no translator and no read', async (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const pool = poolWith();
  for (const locale of [null, undefined, '', 'en', 'en-GB', 'EN_us', 'xx', '<script>', 42, {}]) {
    assert.equal(await translatorFor(pool, locale), null, String(locale));
  }
  assert.equal(pool.db.reads, 0);
});

test('words built in code carrying markup reach the html as text', () => {
  const HOSTILE = '<script>alert(1)</script><a href="https://evil.example">x</a><0>y</0>{{code}}$&$1';
  const t = (_id, values) => `${HOSTILE} ${Object.values(values || {}).join(' ')}`;
  const layout = { html: SEEDS.layouts[0].html, text: SEEDS.layouts[0].text };
  for (const kind of ['build_ready', 'invite_activity']) {
    const english = SEEDED(kind);
    const spanish = { ...english, why: 'Hubo novedades.' };
    const sent = renderResolved(kind, { template: spanish, layout, english: { template: english, layout }, t },
      { url: 'https://x/o', unsubscribeUrl: 'https://x/u' });
    assert.ok(sent.html.includes('&lt;script&gt;'), `${kind} used the translation`);
    assert.doesNotMatch(sent.html, /<script/i, kind);
    assert.doesNotMatch(sent.html, /<a href="https:\/\/evil/, kind);
    assert.doesNotMatch(sent.html, /<0>/, kind);
    assert.doesNotMatch(sent.subject, /[\r\n]/, kind);
  }
});

test('what only an admin or an operator receives is English, whatever is asked', async (t) => {
  const only = Object.entries(ACTIONS).filter(([, action]) => action.englishOnly).map(([kind]) => kind).sort();
  assert.deepEqual(only, ['admin_test', 'content_report']);
  t.mock.method(cache, 'readSource', () => sourceWith());
  const sends = [];
  const pool = poolWith([row('buildReady.lead.ready', 'NO')]);
  t.mock.method(dbPool, 'getPool', () => pool);
  await mail.send({ databaseUrl: 'x', mailStagingLogOnly: false, mailTransport: { provider: 'test', send: async (p) => { sends.push(p); } } },
    { kind: 'content_report', to: 'ops@example.com', locale: 'es', reason: 'spam' });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].translate, undefined);
  assert.equal(sends[0].resolved.readerHasLanguage, false);
  assert.equal(pool.db.reads, 0);
});

// ── Hostile text ─────────────────────────────────────────────────────────

test('a name cannot become markup, a parameter or a tag, and is read once', async () => {
  const inviter = '<img src=x>{{project}}$&';
  const project = '{{inviter}}<0>$1</0>"><script>';
  const payload = { inviter, project, url: 'https://x/w?a="><script>' };
  const sent = buildMessage('project_invite', payload);
  assert.doesNotMatch(sent.html, /<img src=x/);
  assert.doesNotMatch(sent.html, /<script/);
  assert.doesNotMatch(sent.html, /<0>/);
  assert.ok(sent.html.includes(`@&lt;img src=x&gt;{{project}}$&amp;`), 'a name is escaped once and read no further');
  assert.ok(sent.subject.includes(`@${inviter}`) && sent.subject.includes(project), 'read once');
});

// ── English stays as it was ──────────────────────────────────────────────

test('a bare ampersand the English always had is still bare', () => {
  assert.ok(buildMessage('account_email', { code: '1' }).html.includes('Settings → Email & recovery to link'));
});

test('with no email catalog at all, every mail still arrives with its code and its link', () => {
  // The runtime image has only .source.json; a build that somehow lost it must
  // not send a blank mail. Only the words built in code read the catalog.
  const script = `
    const fs = require('node:fs');
    const real = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('frontend/locales/en/email.json')) throw new Error('ENOENT');
      return real(file, ...rest);
    };
    require('./src/services/language-cache').readSource = () => null;
    const { buildMessage } = require('./src/services/mail/templates');
    process.stdout.write(JSON.stringify([
      buildMessage('otp', { code: '123456' }),
      buildMessage('password_reset', { url: 'https://x/#reset-password/abc' }),
      buildMessage('waitlist_code', { code: '654321', confirmUrl: 'https://x/c' }),
      buildMessage('project_opened', { appName: 'Pal', url: 'https://x/o', unsubscribeUrl: 'https://x/u' }),
      buildMessage('build_ready', { appName: 'Pal', url: 'https://x/b', unsubscribeUrl: 'https://x/u' }),
      buildMessage('admin_test', { provider: 'p' }),
    ]));
  `;
  const { stdout, status, stderr } = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  const [otp, reset, code, opened, ready, admin] = JSON.parse(stdout);
  assert.equal(otp.subject, 'Your Homeroom login code');
  assert.ok(otp.text.includes('123456'));
  assert.ok(otp.html.includes('123456'));
  assert.ok(reset.text.includes('https://x/#reset-password/abc'));
  assert.ok(reset.html.includes('href="https://x/#reset-password/abc"'));
  assert.ok(code.text.includes('654321') && code.text.includes('https://x/c'));
  assert.deepEqual(opened.headers, { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.ok(opened.text.includes('https://x/o'));
  assert.ok(ready.text.includes('https://x/b'));
  assert.deepEqual(ready.headers, opened.headers);
  assert.equal(admin.subject, 'Homeroom test email');
});

test('with no frontend/, as in the runtime image, the words built in code are the running build\'s', () => {
  const script = `
    const fs = require('node:fs');
    const real = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('frontend/locales/en/email.json')) throw new Error('ENOENT');
      return real(file, ...rest);
    };
    const english = JSON.parse(real('frontend/locales/en/email.json', 'utf8'));
    english['buildReady.lead.ready'].text = 'FROM THE BUILD';
    require('./src/services/language-cache').readSource = () => ({ files: { 'en/email.json': english } });
    const { buildMessage } = require('./src/services/mail/templates');
    process.stdout.write(buildMessage('build_ready', { appName: 'Pal', unsubscribeUrl: 'https://x/u' }).text);
  `;
  const { stdout, status, stderr } = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  assert.ok(stdout.startsWith('FROM THE BUILD'), stdout);
});

// ── The door ─────────────────────────────────────────────────────────────

function doorFor(t, pool) {
  t.mock.method(cache, 'readSource', () => sourceWith());
  t.mock.method(dbPool, 'getPool', () => pool);
  const sends = [];
  const rendered = [];
  return {
    sends,
    rendered,
    config: {
      databaseUrl: 'x',
      mailStagingLogOnly: false,
      mailTransport: {
        provider: 'test',
        // What a real transport does: renders from what it is handed.
        async send({ to, kind, ...payload }) { sends.push({ to, kind, ...payload }); rendered.push(buildMessage(kind, payload)); },
      },
    },
  };
}

test('the door words a mail in the language it is told, and never hands the language on', async (t) => {
  const pool = poolWith();
  const { config, sends, rendered } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456', { locale: 'es' });
  assert.equal(rendered[0].subject, 'Tu código de Homeroom');
  assert.equal(rendered[0].text, 'Tu código de Homeroom es 123456.\n\nCaduca en 10 minutos.');
  assert.match(rendered[0].html, /Lo recibes por la actividad de tu cuenta\./);
  assert.equal(sends[0].locale, undefined);
  // The words are the stored template's Spanish row: a login code reads no
  // translation of its own at send time.
  assert.equal(pool.db.templateReads, 1);
  assert.deepEqual(pool.db.namespaces, []);
});

test('an invite-activity mail takes its line from the notice it stands for, translated for a translated row', async (t) => {
  const pool = poolWith([row('inviteActivity.firstMessage', '@{{actor}} saludó en {{app}}.')]);
  const { config, rendered } = doorFor(t, pool);
  const notice = { id: 'first_message', values: { actor: 'sam', app: 'Run Club' } };
  const payload = { appName: 'Run Club', line: message('email:inviteActivity.firstMessage', { actor: 'sam', app: 'Run Club' }), notice, url: 'https://x/', unsubscribeUrl: 'https://x/u' };
  await mail.send(config, { kind: 'invite_activity', to: 'a@example.com', locale: 'es', ...payload });
  assert.equal(rendered[0].subject, '@sam saludó en Run Club');
  assert.deepEqual(pool.db.namespaces, ['email']);
  await mail.send(config, { kind: 'invite_activity', to: 'b@example.com', ...payload });
  assert.equal(rendered[1].subject, '@sam said hi in Run Club');
});

test('a mail with no language costs the door no read and hands nothing new on', async (t) => {
  const pool = poolWith();
  const { config, sends, rendered } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  await mail.send(config, { kind: 'otp', to: 'b@example.com', code: '1', locale: 'en' });
  await mail.send(config, { kind: 'otp', to: 'c@example.com', code: '1', locale: null });
  assert.equal(pool.db.reads, 0);
  assert.equal(rendered[0].subject, SEEDED('otp').subject);
  for (const sent of sends) assert.ok(!('translate' in sent) && !('locale' in sent));
});

test('a reader whose language has no row gets the English, with its code', async (t) => {
  const pool = poolWith([], { fail: new Error('connection lost'), spanish: {} });
  const { config, rendered } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456', { locale: 'es' });
  assert.equal(rendered[0].subject, SEEDED('otp').subject);
  assert.ok(rendered[0].text.includes('123456'));
});

test('a throttled or suppressed mail reads no translation', async (t) => {
  const pool = poolWith();
  const real = pool.query;
  pool.query = async (sql, params) => {
    if (/mail_suppressions|suppress/i.test(sql)) return { rows: [{ reason: 'bounce', email: params[0], last_event_at: new Date() }], rowCount: 1 };
    return real(sql, params);
  };
  const { config, sends } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456', { locale: 'es' });
  assert.equal(sends.length, 0);
  assert.equal(pool.db.reads, 0);
});

test('the push and the email keep their translations apart', async () => {
  const rows = [{ language: 'es', key: 'buildReady.lead.ready', source: hash(english('buildReady.lead.ready')), text: 'CORREO' }];
  const pool = {
    async query(_sql, params) {
      return { rows: params[1] === 'email' ? rows : [] };
    },
  };
  const source = sourceWith();
  const email = await translator(pool, 'es', { namespace: 'email', source, now: 1000 });
  const push = await translator(pool, 'es', { source, now: 1000 });
  assert.equal(email('email:buildReady.lead.ready'), 'CORREO');
  assert.equal(typeof push, 'function');
  assert.notEqual(push('email:buildReady.lead.ready'), 'CORREO');
});

// ── Which language ───────────────────────────────────────────────────────

test('a request\'s language is the first of its Accept-Language that Homeroom has, or nothing', (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const of = (header) => requestLanguage({ headers: { 'accept-language': header } });
  assert.equal(of('es-MX,es;q=0.9,en;q=0.8'), 'es');
  assert.equal(of('fr,es;q=0.5'), 'es');
  assert.equal(of('en-GB,es;q=0.5'), null, 'English first is English');
  assert.equal(of('*'), null);
  assert.equal(of('xx'), null);
  assert.equal(of(undefined), null);
  assert.equal(requestLanguage(undefined), null);
  assert.equal(requestLanguage({}), null);
  t.mock.method(cache, 'readSource', () => { throw new Error('boom'); });
  assert.equal(of('es'), null, 'it never throws');
});

const SOURCE = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('each sender knows who it is writing to', () => {
  assert.match(SOURCE('src/services/email-signup.js'), /SELECT u\.locale FROM users u WHERE lower\(u\.email\) = \$1 AND u\.email_confirmed = TRUE/);
  assert.match(SOURCE('src/routes/auth.js'), /SELECT id, email, locale FROM users/);
  assert.match(SOURCE('src/routes/auth.js'), /emailSignup\.requestCode\(pool, config, req\.body\?\.email, \{ locale: mailLanguage\.requestLanguage\(req\) \}\)/);
  assert.match(SOURCE('src/routes/profile.js'), /req\.body\?\.currentPassword, \{ locale: req\.user\.locale \}\)/);
  assert.match(SOURCE('src/routes/profile.js'), /requestUsernameCode\(pool, config, req\.user\.id, \{ locale: req\.user\.locale \}\)/);
  assert.match(SOURCE('src/services/activity-mail.js'), /SELECT email, email_confirmed, activity_email, is_synthetic, locale FROM users/);
  assert.match(SOURCE('src/services/waitlist.js'), /AS recipient_locale/);
  assert.match(SOURCE('src/services/test-accounts.js'), /locale: release\.account\.locale/);
  assert.match(SOURCE('src/routes/public-api.js'), /mailLanguage\.requestLanguage\(req\)/);
  assert.match(SOURCE('src/routes/member-waitlist.js'), /req\.user\.locale \|\| mailLanguage\.requestLanguage\(req\)/);
  assert.match(SOURCE('src/routes/apps.js'), /locale: req\.user\.locale \|\| mailLanguage\.requestLanguage\(req\)/);
});

test('the activity mail\'s request carries the recipient\'s language, and a notice carries its own line', async () => {
  const activity = require('../src/services/activity-mail');
  activity.init({ sessionSecret: 's'.repeat(32) });
  const sent = [];
  const real = mail.send;
  mail.send = async (_config, payload) => { sent.push(payload); };
  try {
    const pool = {
      async query(sql) {
        if (/FROM users/.test(sql)) return { rows: [{ email: 'a@example.com', email_confirmed: true, activity_email: true, is_synthetic: false, locale: 'es' }] };
        return { rows: [] };
      },
    };
    await activity.emailIfNoPush(pool, { userId: 1, kind: 'project_opened', appName: 'Pal', appSlug: 'pal' });
    assert.equal(sent[0].locale, 'es');
  } finally {
    mail.send = real;
    activity.init(null);
  }
});

test('a login code follows the account, then the request, then English, and reads nothing extra', async () => {
  const emailSignup = require('../src/services/email-signup');
  const real = mail.sendOtpMail;
  const calls = [];
  mail.sendOtpMail = async (...args) => { calls.push(args.slice(1)); };
  const poolFor = (accountLocale) => {
    const statements = [];
    const answer = async (sql) => {
      statements.push(sql);
      if (/INSERT INTO mobile_otp_codes/.test(sql)) return { rows: [{ account_locale: accountLocale }] };
      return { rows: [], rowCount: 0 };
    };
    return { statements, query: answer, connect: async () => ({ query: answer, release() {} }) };
  };
  try {
    await emailSignup.requestCode(poolFor('es'), {}, 'a@example.com', { locale: 'fr' });
    await emailSignup.requestCode(poolFor(null), {}, 'b@example.com', { locale: 'fr' });
    const plain = poolFor(null);
    await emailSignup.requestCode(plain, {}, 'c@example.com');
    assert.deepEqual(calls[0][2], { locale: 'es' });
    assert.deepEqual(calls[1][2], { locale: 'fr' });
    assert.equal(calls[2].length, 2, 'as it was called before');
    assert.deepEqual(plain.statements.filter((sql) => /FROM users/.test(sql)).length, 1, 'only inside the one insert');
    assert.ok(plain.statements.find((sql) => /FROM users/.test(sql)).includes('INSERT INTO mobile_otp_codes'));
  } finally {
    mail.sendOtpMail = real;
  }
});

test('a notice\'s English line reads as it always has, whatever its names hold', () => {
  const noticeLine = (row) => {
    const activity = require('../src/services/activity-mail');
    const seen = [];
    const realIfNoPush = activity.emailIfNoPush;
    activity.emailIfNoPush = async (_pool, args) => { seen.push(args); return 'sent'; };
    return activity.mailNotice({
      async query(sql) {
        if (/FROM notifications n/.test(sql)) return { rows: [{ id: 1, user_id: 2, recent: true, mailed_at: null, ...row }] };
        return { rows: [], rowCount: 1 };
      },
    }, 1, { once: (_name, fn) => fn() }).then(() => { activity.emailIfNoPush = realIfNoPush; return seen[0]; });
  };
  return (async () => {
    const said = await noticeLine({ kind: 'first_message', username: 'sam', app_name: 'Run $& {{app}}', app_slug: 'r' });
    assert.equal(said.line, '@sam said hi in Run $& {{app}}.');
    assert.deepEqual(said.notice, { id: 'first_message', values: { actor: 'sam', app: 'Run $& {{app}}' } });
    assert.equal((await noticeLine({ kind: 'member_joined', username: 'lee', app_name: 'Pal' })).line, '@lee joined Pal through your invite.');
    assert.equal((await noticeLine({ kind: 'member_joined', username: null, app_name: 'Pal' })).line, 'Someone joined Pal through your invite.');
    assert.equal((await noticeLine({ kind: 'first_message', username: 'sam', app_name: null })).line, '@sam said hi in null.', 'as before, for a project since deleted');
    assert.equal((await noticeLine({ kind: 'project_opened', username: null, app_name: 'Pal' })).line, undefined);
  })();
});

// ── The catalog and the code agree ───────────────────────────────────────

test('every email id in the code is in the catalog whole, and every entry is asked for', () => {
  const sources = ['src/services/mail/actions.js', 'src/services/activity-mail.js'].map(SOURCE).join('\n');
  assert.deepEqual(sources.match(/[`"]email:[^`"]*[`"]/g) || [], [], 'an id is one plain quoted literal');
  const used = new Set([...sources.matchAll(/'email:([A-Za-z0-9_.-]+)'/g)].map((match) => match[1]));
  // Only the words built in code: the mails themselves are stored templates.
  assert.deepEqual([...used].sort(), [
    'buildReady.lead.notWorking', 'buildReady.lead.ready', 'buildReady.subject.notWorking', 'buildReady.subject.ready', 'buildReady.unnamedProject',
    'inviteActivity.firstMessage', 'inviteActivity.joined', 'inviteActivity.joinedSomeone', 'inviteActivity.joinedUnnamed',
  ]);
  const stems = new Set(Object.keys(ENGLISH));
  assert.deepEqual([...used].filter((id) => !stems.has(id)), [], 'an id the catalog does not have');
  assert.deepEqual([...stems].filter((id) => !used.has(id)), [], 'an entry nothing asks for');
});

test('the catalog holds no markup but numbered tags, and is server-only', () => {
  const packs = require('../scripts/language-packs');
  assert.ok(packs.isServerNamespace('email'));
  for (const [key, entry] of Object.entries(ENGLISH)) {
    assert.deepEqual(entry.text.match(/<(?!\/?\d+>)[^>]*>/g), null, key);
    assert.ok(entry.description.trim(), key);
  }
});
