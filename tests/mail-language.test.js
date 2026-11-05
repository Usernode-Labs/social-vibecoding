'use strict';

// An email in its recipient's language: the catalog
// (frontend/locales/en/email.json), the templates' use of it, and the door
// (src/services/mail/index.js) that asks for a translator. These say the mail
// follows the rule the push follows (frontend/locales/README.md, "An email"),
// that a translation is untrusted text that can never become markup or a
// header, and that a problem anywhere costs a mail its translation, never its
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
const { buildMessage, KINDS, ENGLISH_ONLY_KINDS } = require('../src/services/mail/templates');
const { translatorFor, requestLanguage } = require('../src/services/mail/language');
const { translator, reset } = require('../src/services/push-language');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const ENGLISH = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const english = (key) => ENGLISH[key].text;
const row = (key, text) => ({ language: 'es', key, source: hash(english(key)), text });
const URL_RESET = 'https://app.onhomeroom.com/#reset-password/abc';

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

/**
 * The email templates a database seeded with `rows` holds: every kind in
 * English, and in Spanish where the seed would write it (email-template-seeds.js
 * translationsToSeed), from the same translations through the same pipeline.
 */
async function templatesSeededWith(rows) {
  const { SEEDS, englishTemplate, translatedTemplate, saysAnything } = require('../src/db/email-template-seeds');
  const { ACTIONS } = require('../src/services/mail/actions');
  const source = sourceWith();
  const t = await translator({ query: async (_, params) => ({ rows: rows.filter((r) => r.language === params[0]) }) },
    'es', { namespace: 'email', source });
  reset();
  const says = t && saysAnything(t, { source });
  const templates = Object.keys(ACTIONS).map((kind, i) => {
    const { name, layout, ...fields } = englishTemplate(kind, { source });
    const spanish = says && !ACTIONS[kind].englishOnly ? translatedTemplate(kind, t, { source }) : null;
    const translations = spanish ? { es: (({ name: _n, layout: _l, ...words }) => words)(spanish) } : {};
    return { id: i + 1, action: kind, name, layout_family_id: layout ? 1 : null, translations, ...fields };
  });
  const [layout] = SEEDS.layouts;
  return { templates, layouts: [{ id: 1, family_id: 1, name: layout.name, html: layout.html, text: layout.text, translations: {} }] };
}

/**
 * A pool holding `rows` as language_translations, the email templates a seed of
 * them gives, and what the door reads and writes.
 */
function poolWith(rows = [], { fail = null, hang = false } = {}) {
  const db = { reads: 0, namespaces: [], templateReads: 0 };
  let seeded;
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
      seeded ||= await templatesSeededWith(rows);
      return { rows: seeded.templates };
    }
    if (/FROM email_layouts/.test(sql)) {
      seeded ||= await templatesSeededWith(rows);
      return { rows: seeded.layouts };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    db,
    query,
    async connect() { return { query, release() {} }; },
  };
}

/** Everything `t` asks for, translated by `rows` over the real English. */
async function es(rows, options = {}) {
  return translator(poolWith(rows), 'es', { namespace: 'email', source: sourceWith(), ...options });
}

test.beforeEach(() => reset());

// ── Translated, with its parameters ──────────────────────────────────────

test('a translated mail has its subject, text and html in the language, with its parameters', async () => {
  const translate = await es([
    row('otp.subject', 'Tu código de Homeroom'),
    row('otp.text.code', 'Tu código de Homeroom es {{code}}.'),
    row('otp.html.code', 'Tu código de Homeroom es:'),
    row('otp.expiry', 'Caduca en 10 minutos.'),
    row('frame.why', 'Lo recibes por la actividad de tu cuenta.'),
  ]);
  const sent = buildMessage('otp', { code: '123456', translate });
  assert.equal(sent.subject, 'Tu código de Homeroom');
  assert.equal(sent.text, 'Tu código de Homeroom es 123456.\n\nCaduca en 10 minutos.');
  assert.match(sent.html, /<p>Tu código de Homeroom es:<\/p>/);
  assert.match(sent.html, />123456<\/p>/);
  assert.match(sent.html, /<p>Caduca en 10 minutos\.<\/p>/);
  assert.match(sent.html, /Lo recibes por la actividad de tu cuenta\./);
});

test('a link inside a translated sentence is the code\'s, and the words around it are the translation\'s', async () => {
  const translate = await es([
    row('passwordReset.link', 'Elige una contraseña: {{url}}'),
    row('passwordReset.subject', 'Cambia tu contraseña'),
  ]);
  const sent = buildMessage('password_reset', { url: URL_RESET, translate });
  assert.equal(sent.subject, 'Cambia tu contraseña');
  assert.ok(sent.text.includes(`Elige una contraseña: ${URL_RESET}`));
  assert.ok(sent.html.includes(`<p>Elige una contraseña: <a href="${URL_RESET}"`));
});

test('numbered tags keep their elements in code, whichever order a language wants them in', async () => {
  const translate = await es([
    row('waitlistReleased.mobile.ios.html', '<1>abre la invitación</1> en <0>iPhone</0>.'),
  ]);
  const sent = buildMessage('waitlist_released', { url: 'https://x/', mobile: { ios: 'https://store/i?a=1&b=2' }, translate });
  assert.ok(sent.html.includes('<a href="https://store/i?a=1&amp;b=2" style="color:#0a6ee0">abre la invitación</a> en <strong>iPhone</strong>.'));
});

test('an invite is worded for what it knows, and only English is the default', async () => {
  const translate = await es([
    row('projectInvite.named.subject', '@{{inviter}} te invitó a {{project}}'),
    row('projectInvite.noInviter.subject', 'Alguien te invitó a {{project}}'),
    row('projectInvite.noProject.subject', '@{{inviter}} te invitó a un proyecto'),
    row('projectInvite.nothing.subject', 'Alguien te invitó a un proyecto'),
  ]);
  const subject = (payload) => buildMessage('project_invite', { ...payload, translate }).subject;
  assert.equal(subject({ inviter: 'ada', project: 'Plant Pal' }), '@ada te invitó a Plant Pal');
  assert.equal(subject({ project: 'Plant Pal' }), 'Alguien te invitó a Plant Pal');
  assert.equal(subject({ inviter: 'ada' }), '@ada te invitó a un proyecto');
  assert.equal(subject({}), 'Alguien te invitó a un proyecto');
});

test('an invite-activity mail takes its line from the notice it stands for', async () => {
  const translate = await es([row('inviteActivity.firstMessage', '@{{actor}} saludó en {{app}}.')]);
  const notice = { id: 'first_message', values: { actor: 'sam', app: 'Run Club' } };
  const sent = buildMessage('invite_activity', {
    appName: 'Run Club', line: message('email:inviteActivity.firstMessage', { actor: 'sam', app: 'Run Club' }), notice, url: 'https://x/', translate,
  });
  assert.equal(sent.subject, '@sam saludó en Run Club');
  const inEnglish = buildMessage('invite_activity', { appName: 'Run Club', line: '@sam said hi in Run Club.', notice, url: 'https://x/' });
  assert.equal(inEnglish.subject, '@sam said hi in Run Club');
});

// ── Falling back ─────────────────────────────────────────────────────────

test('a message with no translation is English, on its own', async () => {
  const translate = await es([row('otp.subject', 'Tu código')]);
  const sent = buildMessage('otp', { code: '123456', translate });
  assert.equal(sent.subject, 'Tu código');
  assert.ok(sent.text.startsWith('Your Homeroom login code is 123456.'));
});

test('a translator that throws, returns nothing, or is not text, is the whole mail in English', () => {
  const plain = buildMessage('otp', { code: '123456' });
  const translators = [
    () => { throw new Error('boom'); },
    () => '',
    () => undefined,
    () => 42,
    () => ({ toString() { return '<script>'; } }),
  ];
  for (const translate of translators) {
    assert.deepEqual(buildMessage('otp', { code: '123456', translate }), plain);
  }
});

test('a failed cache read, a hung one or a lookup that breaks is English, soon', async (t) => {
  t.mock.method(cache, 'readSource', () => sourceWith());
  const failing = await translatorFor(poolWith([], { fail: new Error('connection lost') }), 'es');
  assert.equal(failing('email:otp.subject'), english('otp.subject'), 'a failed read');
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

test('a translation that drops a code or a link is not used for that mail', () => {
  // The catalog rule already refuses one (parameters must match); the mail
  // does not rest on it, because a lost code is a person locked out.
  const otp = buildMessage('otp', { code: '123456', translate: () => 'Sin código' });
  assert.deepEqual(otp, buildMessage('otp', { code: '123456' }));
  const reset = buildMessage('password_reset', { url: URL_RESET, translate: () => 'Sin enlace' });
  assert.deepEqual(reset, buildMessage('password_reset', { url: URL_RESET }));
  const joined = { code: '123456', confirmUrl: 'https://x/confirm/abc', url: 'https://x/#more/abc' };
  assert.deepEqual(buildMessage('waitlist_joined', { ...joined, translate: () => 'Nada' }), buildMessage('waitlist_joined', joined));
});

test('what only an admin or an operator receives is English, whatever is asked', async (t) => {
  assert.deepEqual([...ENGLISH_ONLY_KINDS].sort(), ['admin_test', 'content_report']);
  const everything = () => 'TRADUCIDO';
  for (const kind of ENGLISH_ONLY_KINDS) {
    assert.deepEqual(buildMessage(kind, { translate: everything }), buildMessage(kind, {}), kind);
  }
  t.mock.method(cache, 'readSource', () => sourceWith());
  const sends = [];
  const pool = poolWith([row('otp.subject', 'NO')]);
  t.mock.method(dbPool, 'getPool', () => pool);
  await mail.send({ databaseUrl: 'x', mailStagingLogOnly: false, mailTransport: { provider: 'test', send: async (p) => { sends.push(p); } } },
    { kind: 'content_report', to: 'ops@example.com', locale: 'es', reason: 'spam' });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].translate, undefined);
  assert.equal(pool.db.reads, 0);
});

// ── Hostile text ─────────────────────────────────────────────────────────

const HOSTILE = '<script>alert(1)</script><a href="https://evil.example">x</a><0>y</0>{{code}}$&$1';

test('a translation carrying markup reaches the html as text, in every kind', () => {
  // Anything that keeps the credentials goes through, so this keeps them.
  const keeping = (_id, values) => `${HOSTILE} ${Object.values(values || {}).join(' ')}`;
  const shapes = {
    otp: { code: '123456' },
    account_email: { code: '123456' },
    username_change: { code: '123456' },
    waitlist_joined: { code: '123456', confirmUrl: 'https://x/c' },
    waitlist_code: { code: '123456', confirmUrl: 'https://x/c' },
    waitlist_released: { url: 'https://x/' },
    password_reset: { url: URL_RESET },
    project_invite: { inviter: 'ada', project: 'Pal', url: 'https://x/w' },
    build_ready: { appName: 'Pal', url: 'https://x/o', unsubscribeUrl: 'https://x/u' },
    invite_activity: { appName: 'Pal', url: 'https://x/o', unsubscribeUrl: 'https://x/u' },
    project_opened: { appName: 'Pal', url: 'https://x/o', unsubscribeUrl: 'https://x/u' },
  };
  assert.deepEqual(Object.keys(shapes).concat([...ENGLISH_ONLY_KINDS]).sort(), [...KINDS].sort(), 'every kind is here');
  for (const [kind, payload] of Object.entries(shapes)) {
    const sent = buildMessage(kind, { ...payload, translate: keeping });
    assert.ok(sent.html.includes('&lt;script&gt;'), `${kind} used the translation`);
    assert.doesNotMatch(sent.html, /<script/i, kind);
    assert.doesNotMatch(sent.html, /evil\.example"/, `${kind}: an href`);
    assert.doesNotMatch(sent.html, /<a href="https:\/\/evil/, kind);
    assert.doesNotMatch(sent.html, /<0>/, kind);
  }
});

test('a tag the message does not have, or a typed entity, stays text', async () => {
  const translate = await es([row('waitlistReleased.mobile.ios.html', '<0>iPhone</0> <1>abre</1> <2>x</2> &lt;1&gt;y&lt;/1&gt;')]);
  // The catalog rule refuses the extra tag, so it never gets this far...
  const refused = buildMessage('waitlist_released', { url: 'https://x/', mobile: { ios: 'https://i/' }, translate });
  assert.ok(refused.html.includes('Install TestFlight'));
  // ...and if a translator handed it over anyway, it is text.
  const handed = buildMessage('waitlist_released', {
    url: 'https://x/', mobile: { ios: 'https://i/' }, translate: (id) => (id.endsWith('ios.html') ? '<0>iPhone</0> <1>abre</1> <2>x</2> &lt;1&gt;y&lt;/1&gt;' : ''),
  });
  assert.ok(handed.html.includes('<strong>iPhone</strong> <a href="https://i/" style="color:#0a6ee0">abre</a> &lt;2&gt;x&lt;/2&gt; &amp;lt;1&amp;gt;y&amp;lt;/1&amp;gt;'));
});

test('a name cannot become markup, a parameter or a tag, in English or translated', async () => {
  const inviter = '<img src=x>{{project}}$&';
  const project = '{{inviter}}<0>$1</0>"><script>';
  const payload = { inviter, project, url: 'https://x/w?a="><script>' };
  const translate = await es([
    row('projectInvite.named.subject', 'De @{{inviter}} para {{project}}'),
    row('projectInvite.named.lead', 'De @{{inviter}} para {{project}}, en Homeroom.'),
    row('projectInvite.named.headline', 'De @{{inviter}} para {{project}}.'),
  ]);
  for (const options of [{}, { translate }]) {
    const sent = buildMessage('project_invite', { ...payload, ...options });
    assert.doesNotMatch(sent.html, /<img src=x/);
    assert.doesNotMatch(sent.html, /<script/);
    assert.doesNotMatch(sent.html, /<0>/);
    assert.ok(sent.html.includes(`@&lt;img src=x&gt;{{project}}$&amp;`), 'a name is escaped once and read no further');
  }
  const sent = buildMessage('project_invite', { ...payload, translate });
  assert.equal(sent.subject, `De @${inviter} para ${project}`, 'read once');
  assert.ok(sent.text.startsWith(`De @${inviter} para ${project}, en Homeroom.`));
});

test('a subject carries no line break or control character, and the text keeps the English\'s lines', async () => {
  const injected = 'Hola\r\nBcc: victim@example.com';
  const translate = await es([
    row('otp.subject', injected),
    row('otp.expiry', 'Caduca\n\nX-Evil: yes'),
  ]);
  const sent = buildMessage('otp', { code: '123456', translate });
  assert.equal(sent.subject, english('otp.subject'), 'a translated line break costs that message its translation');
  assert.equal(sent.text, `Your Homeroom login code is 123456.\n\n${english('otp.expiry')}`);
  // A name is outside the translation's control: it cannot break the subject either.
  const named = await es([row('projectInvite.named.subject', 'De @{{inviter}} para {{project}}')]);
  const header = buildMessage('project_invite', { inviter: 'ada', project: 'Pal\r\nBcc: x@example.com', translate: named }).subject;
  assert.doesNotMatch(header, /[\r\n]/);
  assert.equal(header, 'De @ada para Pal Bcc: x@example.com');
  // A translation with the English's own line break is fine.
  const signoff = await es([row('waitlistReleased.signoff', 'Hasta pronto,\nEvan de Homeroom')]);
  const released = buildMessage('waitlist_released', { url: 'https://x/', translate: signoff });
  assert.ok(released.text.endsWith('Hasta pronto,\nEvan de Homeroom'));
  assert.ok(released.html.includes('<p>Hasta pronto,<br>Evan de Homeroom</p>'));
});

test('a stray private-use mark in a translation cannot move a link anywhere but its own place', () => {
  const sent = buildMessage('password_reset', { url: URL_RESET, translate: (id, values) => (id === 'email:passwordReset.link' ? `<b> ${values.url}` : 'x') });
  assert.doesNotMatch(sent.html, /<b>/);
});

// ── English stays as it was ──────────────────────────────────────────────

test('with no translator, a bare ampersand the English always had is still bare', () => {
  assert.ok(buildMessage('account_email', { code: '1' }).html.includes('Settings → Email & recovery to link'));
});

test('with no English at all, a code and a link still arrive', () => {
  // The runtime image has only .source.json; a build that somehow lost it must
  // not send a blank login mail.
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
      buildMessage('admin_test', { provider: 'p' }),
    ]));
  `;
  const { stdout, status, stderr } = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  const [otp, reset, code, opened, admin] = JSON.parse(stdout);
  assert.ok(otp.subject);
  assert.ok(otp.text.includes('123456'));
  assert.ok(otp.html.includes('123456'));
  assert.ok(reset.text.includes('https://x/#reset-password/abc'));
  assert.ok(reset.html.includes('href="https://x/#reset-password/abc"'));
  assert.ok(code.text.includes('654321') && code.text.includes('https://x/c'));
  assert.deepEqual(opened.headers, { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.ok(opened.text.includes('https://x/o'));
  assert.equal(admin.subject, 'Homeroom test email', 'an operator\'s mail never needed the catalog');
});

test('with no frontend/, as in the runtime image, the English is the running build\'s', () => {
  const script = `
    const fs = require('node:fs');
    const real = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('frontend/locales/en/email.json')) throw new Error('ENOENT');
      return real(file, ...rest);
    };
    const english = JSON.parse(real('frontend/locales/en/email.json', 'utf8'));
    english['otp.subject'].text = 'FROM THE BUILD';
    require('./src/services/language-cache').readSource = () => ({ files: { 'en/email.json': english } });
    const { buildMessage } = require('./src/services/mail/templates');
    process.stdout.write(buildMessage('otp', { code: '1' }).subject);
  `;
  const { stdout, status, stderr } = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(status, 0, stderr);
  assert.equal(stdout, 'FROM THE BUILD');
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
  const pool = poolWith([row('otp.subject', 'Tu código')]);
  const { config, sends, rendered } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456', { locale: 'es' });
  assert.equal(rendered[0].subject, 'Tu código');
  assert.ok(rendered[0].text.includes('123456'));
  assert.equal(sends[0].locale, undefined);
  // The words are the stored template's Spanish row: a login code reads no
  // translation of its own at send time.
  assert.equal(pool.db.templateReads, 1);
  assert.deepEqual(pool.db.namespaces, []);
});

test('a mail with no language costs the door no read and hands nothing new on', async (t) => {
  const pool = poolWith();
  const { config, sends, rendered } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456');
  await mail.send(config, { kind: 'otp', to: 'b@example.com', code: '1', locale: 'en' });
  await mail.send(config, { kind: 'otp', to: 'c@example.com', code: '1', locale: null });
  assert.equal(pool.db.reads, 0);
  assert.equal(rendered[0].subject, english('otp.subject'));
  for (const sent of sends) assert.ok(!('translate' in sent) && !('locale' in sent));
});

test('a login code goes out in English when the translations cannot be read', async (t) => {
  const pool = poolWith([], { fail: new Error('connection lost') });
  const { config, rendered } = doorFor(t, pool);
  await mail.sendOtpMail(config, 'a@example.com', '123456', { locale: 'es' });
  assert.equal(rendered[0].subject, english('otp.subject'));
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
  const rows = [{ language: 'es', key: 'otp.subject', source: hash(english('otp.subject')), text: 'CORREO' }];
  const pool = {
    async query(_sql, params) {
      return { rows: params[1] === 'email' ? rows : [] };
    },
  };
  const source = sourceWith();
  const email = await translator(pool, 'es', { namespace: 'email', source, now: 1000 });
  const push = await translator(pool, 'es', { source, now: 1000 });
  assert.equal(email('email:otp.subject'), 'CORREO');
  assert.equal(typeof push, 'function');
  assert.notEqual(push('email:otp.subject'), 'CORREO');
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
  const sources = ['src/services/mail/templates.js', 'src/services/activity-mail.js'].map(SOURCE).join('\n');
  assert.deepEqual(sources.match(/[`"]email:[^`"]*[`"]/g) || [], [], 'an id is one plain quoted literal');
  const used = new Set([...sources.matchAll(/'email:([A-Za-z0-9_.-]+)'/g)].map((match) => match[1]));
  assert.ok(used.size > 50, 'the templates are read');
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
