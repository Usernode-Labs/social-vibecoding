'use strict';

// src/db/email-template-seeds.js, src/services/mail/render.js: the seeded
// templates render what the hard-coded ones in src/services/mail/templates.js
// render, byte for byte, across every branch and in every language shape. The
// next proposal sends from the seeds on the strength of this file, so a payload
// here is never narrowed to make a difference go away: a difference is either a
// bug or an entry in the "accepted differences" tests at the end.
//
// There is no committed French email catalog (frontend/locales has only
// en/email.json; translations live in the cache), so French is a fixture read
// through the real translation pipeline, usableMessages included. "Hostile" is a
// translator that bypasses that pipeline with every character that matters.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { hash } = require('../scripts/language-packs');
const { PRODUCTION_ORIGIN } = require('../src/services/cli-auth-constants');
const { buildMessage, KINDS, ENGLISH_ONLY_KINDS } = require('../src/services/mail/templates');
const tracking = require('../src/services/mail/tracking');
const { ACTIONS } = require('../src/services/mail/actions');
const { renderMessage } = require('../src/services/mail/render');
const { parse, placeholdersIn } = require('../src/services/mail/template-language');
const { translator, reset } = require('../src/services/push-language');
const { translatorFrom } = require('../src/services/push-text');
const {
  SEEDS, englishTemplate, translatedTemplate, seededLayout,
} = require('../src/db/email-template-seeds');

const ROOT = path.join(__dirname, '..');
const ENGLISH_ENTRIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend/locales/en/email.json'), 'utf8'));
const ENGLISH = Object.fromEntries(Object.entries(ENGLISH_ENTRIES).map(([k, v]) => [k, v.text]));
const FRENCH = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mail-seed-french.json'), 'utf8'));

const SOURCE = {
  files: {
    'config.json': { sourceLanguage: 'en', languages: { en: 'English', fr: 'Français', es: 'Español' } },
    'glossary.json': { doNotTranslate: ['Homeroom'] },
    'en/email.json': ENGLISH_ENTRIES,
  },
};

const poolWith = (language, messages) => ({
  async query(sql, params) {
    if (!/FROM language_translations/.test(sql) || params[0] !== language) return { rows: [] };
    return { rows: Object.entries(messages).map(([key, text]) => ({ key, source: hash(ENGLISH[key]), text })) };
  },
});

async function pipelineTranslator(language, messages) {
  reset();
  return translator(poolWith(language, messages), language, { namespace: 'email', source: SOURCE });
}

// Every character the escaping treats specially, a tag no wrapper has, and a
// double space for the subject's clean-up, in front of every message.
const HOSTILE = Object.fromEntries(Object.entries(ENGLISH).map(([key, text]) => [key, `L'"<&>  <7>x</7> &amp; ${text}`]));
const hostile = translatorFrom('fr', HOSTILE, ENGLISH);

// ── The payload matrix. No value has an apostrophe: see the last tests. ──

const cross = (dimensions) => Object.entries(dimensions).reduce(
  (rows, [name, options]) => rows.flatMap((row) => options.map((option) => (
    option === undefined ? row : { ...row, [name]: option }
  ))),
  [{}],
);

const URL_PLAIN = 'https://app.onhomeroom.com/#a/b';
const URL_AWKWARD = 'https://x.test/a?b=1&c="d"&e=<f>&g={{code}}&h=$&';
const UNSUBSCRIBE = `${PRODUCTION_ORIGIN}/mail/unsubscribe?t=abc&u=1`;
const NASTY = 'A  <b>&"{{code}}$&.';
const LONG = 'L'.repeat(400);

const CODES = ['123456', '<&>"9', 654321];

const MATRIX = {
  otp: cross({ code: CODES }),
  account_email: cross({ code: CODES }),
  username_change: cross({ code: CODES }),
  waitlist_joined: cross({
    code: [undefined, '', ...CODES],
    confirmUrl: [undefined, '', URL_PLAIN, URL_AWKWARD],
    url: [undefined, URL_PLAIN],
  }),
  waitlist_code: cross({
    code: [undefined, '', ...CODES],
    confirmed: [undefined, false, true],
    confirmUrl: [undefined, URL_AWKWARD],
    statusUrl: [undefined, '', URL_PLAIN, URL_AWKWARD],
  }),
  waitlist_released: cross({
    url: [URL_PLAIN, URL_AWKWARD, `${PRODUCTION_ORIGIN}/r?key=secret`],
    hasAccount: [undefined, false, true],
    signInLink: [undefined, false, true],
    mobile: [
      undefined, {},
      { ios: URL_PLAIN }, { android: URL_AWKWARD }, { ios: '', android: URL_PLAIN },
      { ios: URL_AWKWARD, android: URL_PLAIN },
    ],
  }),
  password_reset: cross({ url: [URL_PLAIN, URL_AWKWARD] }),
  admin_test: cross({
    provider: [undefined, '', 'brevo', NASTY],
    from: [undefined, 'Homeroom <hello@my.onhomeroom.com>'],
    sentAt: [undefined, '', 0, '2026-11-05T09:00:00.000Z'],
    reference: [undefined, NASTY],
  }),
  content_report: cross({
    reason: [undefined, '', 'hate_speech', 'x_'.repeat(70), NASTY],
    targetType: [undefined, 'app', 'user', 'app_message', 'conversation_message', 'nonsense'],
    targetLabel: [undefined, NASTY, LONG],
    reporter: [undefined, 'sam'],
    caseId: [undefined, 0, 12],
    reportId: [undefined, 0, 34],
    detail: [undefined, '  ', 'line one\nline <two> & "three"  '],
    url: [undefined, URL_AWKWARD],
  }),
  project_invite: cross({
    inviter: [undefined, '', 'sam', NASTY],
    project: [undefined, '', 'Run Club', NASTY],
    url: [undefined, '', URL_PLAIN, URL_AWKWARD],
  }),
  build_ready: cross({
    appName: [undefined, '', 'Plant Pal', NASTY, LONG],
    lead: [undefined, '', '   ', '  Dark mode is ready.  ', 12, NASTY, LONG],
    subject: [undefined, '  ', ' Dark mode · Plant Pal ', 12, NASTY, LONG],
    notWorking: [undefined, true],
    url: [undefined, URL_AWKWARD],
    unsubscribeUrl: [undefined, '', UNSUBSCRIBE],
  }),
  invite_activity: cross({
    appName: [undefined, '', 'Run Club', NASTY, LONG],
    line: [undefined, '', '@sam joined.', NASTY, LONG],
    notice: [
      undefined,
      { id: 'nonsense', values: { actor: 'sam', app: 'Run Club' } },
      { id: 'first_message', values: { actor: 'sam', app: 'Run Club' } },
      { id: 'first_message', values: { actor: null, app: NASTY } },
      { id: 'member_joined', values: { actor: NASTY, app: 'Run Club' } },
      { id: 'member_joined', values: { actor: 'sam', app: LONG } },
      { id: 'member_joined_someone', values: { app: 'Run Club.' } },
      { id: 'member_joined' },
    ],
    url: [undefined, URL_AWKWARD],
    unsubscribeUrl: [undefined, UNSUBSCRIBE],
  }),
  project_opened: cross({
    appName: [undefined, '', 'Run Club', NASTY, LONG],
    url: [undefined, URL_AWKWARD],
    unsubscribeUrl: [undefined, '', UNSUBSCRIBE],
  }),
};

test('the matrix holds no apostrophe, and names every kind', () => {
  assert.deepEqual(Object.keys(MATRIX).sort(), [...KINDS].sort());
  assert.ok(!JSON.stringify(MATRIX).includes("'"));
});

test('the matrix takes every conditional of every seed both ways', () => {
  const on = (value) => !(value === undefined || value === null || value === false || value === '');
  for (const kind of KINDS) {
    const template = englishTemplate(kind);
    for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
      const seen = new Map();
      const walk = (nodes, values, path) => nodes.forEach((node, index) => {
        if (node.type !== 'if' && node.type !== 'unless') return;
        const where = `${path}/${index}:${node.name}`;
        const taken = on(values[node.name]) === (node.type === 'if');
        seen.set(where, (seen.get(where) || new Set()).add(taken));
        walk(taken ? node.then : node.else, values, where);
      });
      const { nodes } = parse(template[field]);
      for (const row of MATRIX[kind]) walk(nodes, ACTIONS[kind].values(row), '');
      for (const [where, ways] of seen) assert.equal(ways.size, 2, `${kind}.${field} ${where}`);
    }
  }
});

// ── What the two sides produce ───────────────────────────────────────────

function viaSeeds(kind, payload, t) {
  // A language the seed refused or has nothing for sends English, as today's
  // fallback does, and asks no translator for the words built in code.
  const translated = t && !ENGLISH_ONLY_KINDS.has(kind) ? translatedTemplate(kind, t) : null;
  const template = translated || englishTemplate(kind);
  const layout = template.layout ? seededLayout(template.layout) : null;
  const attributed = tracking.attributedPayload(kind, payload);
  const { why, preheader, headers, ...message } = renderMessage(kind, { template, layout }, attributed, translated ? t : undefined);
  return tracking.decorate(kind, { ...message, ...(headers ? { headers } : {}) }, payload);
}

function assertMatrix(language, t, extra = {}) {
  let compared = 0;
  for (const kind of KINDS) {
    for (const row of MATRIX[kind]) {
      const payload = { ...row, ...extra };
      const today = buildMessage(kind, t ? { ...payload, translate: t } : payload);
      const seeded = viaSeeds(kind, payload, t);
      assert.deepEqual(seeded, today, `${language} ${kind} ${JSON.stringify(row)}`);
      compared += 1;
    }
  }
  return compared;
}

test('English: seeded mail is byte-identical to today', () => {
  const compared = assertMatrix('en');
  assert.ok(compared > 1000);
  console.log(`payloads per language: ${compared}`);
});

test('French through the translation pipeline: seeded mail is byte-identical to today', async () => {
  const t = await pipelineTranslator('fr', FRENCH);
  // The fixture is whole and usable: a message the pipeline refused would be
  // English here and would quietly test nothing.
  for (const [key, text] of Object.entries(FRENCH)) {
    if (/\{\{/.test(text)) continue;
    assert.equal(t(`email:${key}`), text, key);
  }
  assert.deepEqual(Object.keys(FRENCH).sort(), Object.keys(ENGLISH).sort());
  assertMatrix('fr', t);
});

test('a hostile translation stays words, byte-identical to today', () => {
  assert.equal(hostile('email:otp.subject'), HOSTILE['otp.subject']);
  assertMatrix('hostile', hostile);
});

test('a partly translated language mixes per message, as today', async () => {
  const some = {
    'otp.subject': FRENCH['otp.subject'],
    'passwordReset.link': FRENCH['passwordReset.link'],
    'buildReady.lead.ready': FRENCH['buildReady.lead.ready'],
    'inviteActivity.joinedSomeone': FRENCH['inviteActivity.joinedSomeone'],
    'waitlistReleased.mobile.ios.html': FRENCH['waitlistReleased.mobile.ios.html'],
  };
  assertMatrix('partial', await pipelineTranslator('fr', some));
});

test('tracking on: links, pixel, attributed unsubscribe and headers match', (t) => {
  const before = process.env.PLATFORM_MAIL_TRACKING_SECRET;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = 'only-for-tests';
  t.after(() => {
    if (before === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET;
    else process.env.PLATFORM_MAIL_TRACKING_SECRET = before;
  });
  const extra = { trackingEnabled: true, messageId: 'a'.repeat(48) };
  assertMatrix('en tracked', undefined, extra);
  assertMatrix('hostile tracked', hostile, extra);
  const message = viaSeeds('build_ready', { appName: 'Run Club', unsubscribeUrl: UNSUBSCRIBE, ...extra });
  assert.ok(message.trackingLinks.length > 0);
  assert.match(message.headers['List-Unsubscribe'], /[?&]m=a{48}/);
});

// ── The seeds themselves ─────────────────────────────────────────────────

test('every kind has a seed that uses only declared placeholders and carries what is required', () => {
  assert.deepEqual(Object.keys(SEEDS.templates).sort(), [...KINDS].sort());
  for (const kind of KINDS) {
    const action = ACTIONS[kind];
    const template = englishTemplate(kind);
    for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
      for (const name of placeholdersIn(template[field])) assert.ok(action.placeholders[name], `${kind}.${field}: ${name}`);
    }
    for (const form of ['html', 'text']) {
      const named = placeholdersIn(template[form]);
      for (const name of action.required[form]) assert.ok(named.has(name), `${kind}.${form} must use ${name}`);
    }
    assert.equal(template.name, action.label);
  }
});

test('catalog wording with an apostrophe is source text, never escaped', () => {
  assert.match(englishTemplate('waitlist_joined').html, /We'll email you/);
  assert.match(englishTemplate('waitlist_released').preheader, /Here's how/);
  assert.match(englishTemplate('content_report').why, /Homeroom's compliance/);
  assert.match(viaSeeds('build_ready', { appName: 'Run Club', notWorking: true }).html, /isn't working yet/);
});

test('every catalog reference exists, and no counted message is referred to', () => {
  const raw = JSON.stringify(SEEDS);
  const ids = [...raw.matchAll(/\{\{t:email:([^|}]+)/g)].map((m) => m[1]);
  assert.ok(ids.length > 50);
  for (const id of ids) {
    assert.ok(Object.hasOwn(ENGLISH, id), id);
    assert.doesNotMatch(id, /_(one|other)$/);
  }
  assert.deepEqual(Object.keys(ENGLISH).filter((key) => /_(one|other)$/.test(key)), []);
});

test('no {{t:}} reference survives expansion', () => {
  for (const kind of KINDS) {
    assert.doesNotMatch(JSON.stringify(englishTemplate(kind)), /\{\{t:/, kind);
    assert.doesNotMatch(JSON.stringify(translatedTemplate(kind, hostile) || {}), /\{\{t:/, kind);
  }
  assert.doesNotMatch(JSON.stringify(seededLayout('Homeroom standard')), /\{\{t:/);
});

// ── A translation that loses what the mail carries is not seeded ─────────

const breaking = (overrides) => translatorFrom('fr', { ...FRENCH, ...overrides }, ENGLISH);

test('a translation that loses its code, link or placeholders is not seeded, and that mail goes in English as today', () => {
  const cases = [
    ['otp', { 'otp.text.code': 'Votre code est prêt.' }, { code: '123456' }],
    ['password_reset', { 'passwordReset.link': 'Cliquez plus bas.' }, { url: URL_PLAIN }],
    ['waitlist_released', { 'waitlistReleased.mobile.ios.html': '<0>iPhone</0> : installez TestFlight.' }, { url: URL_PLAIN, mobile: { ios: URL_AWKWARD } }],
    ['waitlist_released', { 'waitlistReleased.mobile.ios.text': 'iPhone : installez TestFlight.' }, { url: URL_PLAIN, mobile: { ios: URL_AWKWARD } }],
    ['build_ready', { 'buildReady.text.open': 'Ouvrez-le.' }, { url: URL_PLAIN, unsubscribeUrl: UNSUBSCRIBE }],
    ['build_ready', { 'activity.stop.text': 'Pour arrêter : répondez.' }, { url: URL_PLAIN, unsubscribeUrl: UNSUBSCRIBE }],
    ['waitlist_code', { 'waitlistCode.status.text.code': 'Votre code est prêt.' }, { code: '123456', confirmed: true }],
  ];
  for (const [kind, overrides, payload] of cases) {
    const t = breaking(overrides);
    assert.equal(translatedTemplate(kind, t), null, `${kind} ${Object.keys(overrides)}`);
    const today = buildMessage(kind, { ...payload, translate: t });
    assert.deepEqual(viaSeeds(kind, payload, t), today, kind);
    assert.deepEqual(viaSeeds(kind, payload, t), buildMessage(kind, payload), `${kind} is the English`);
  }
});

test('other wrong placeholders and template syntax in a translation are not seeded', () => {
  for (const words of ['Bonjour {{inconnu}}.', 'Bonjour {{#if code}}x{{/if}}.', 'Bonjour {{code', 'Bonjour {{else}}.']) {
    assert.equal(translatedTemplate('otp', breaking({ 'otp.expiry': words })), null, words);
  }
  assert.ok(translatedTemplate('otp', breaking({})));
});

test('a translation that adds a line break is English for that one message, as today', () => {
  const t = breaking({ 'otp.expiry': 'Une ligne\nde plus.' });
  const payload = { code: '123456' };
  assert.deepEqual(viaSeeds('otp', payload, t), buildMessage('otp', { ...payload, translate: t }));
  assert.match(translatedTemplate('otp', t).text, /It expires in 10 minutes/);
});

test('words built in code get the same message-by-message guard', () => {
  const lines = {
    'buildReady.lead.ready': 'Une ligne\nde plus.',
    'buildReady.subject.ready': '   ',
    'inviteActivity.joinedSomeone': 'Une ligne\nde plus pour {{app}}.',
  };
  const t = translatorFrom('fr', { ...FRENCH, ...lines }, ENGLISH);
  for (const [kind, payload] of [['build_ready', { appName: 'Run Club' }], ['invite_activity', { appName: 'Run Club' }]]) {
    const seeded = viaSeeds(kind, payload, t);
    assert.deepEqual(seeded, buildMessage(kind, { ...payload, translate: t }), kind);
    assert.doesNotMatch(seeded.text, /Une ligne/, kind);
  }
});

// ── Accepted differences ─────────────────────────────────────────────────

const APOSTROPHE = "O'Brien";
const WITH_APOSTROPHE = {
  otp: { code: `1'2` },
  account_email: { code: `1'2` },
  username_change: { code: `1'2` },
  waitlist_joined: { code: `1'2`, confirmUrl: `https://x.test/${APOSTROPHE}` },
  waitlist_code: { code: `1'2`, statusUrl: `https://x.test/${APOSTROPHE}`, confirmed: true },
  waitlist_released: { url: `https://x.test/${APOSTROPHE}`, mobile: { ios: `https://x.test/${APOSTROPHE}` } },
  password_reset: { url: `https://x.test/${APOSTROPHE}` },
  admin_test: { provider: APOSTROPHE },
  content_report: { reason: APOSTROPHE, targetLabel: APOSTROPHE },
  project_invite: { inviter: APOSTROPHE, project: APOSTROPHE },
  build_ready: { appName: APOSTROPHE, lead: APOSTROPHE, unsubscribeUrl: UNSUBSCRIBE },
  invite_activity: { appName: APOSTROPHE, notice: { id: 'member_joined', values: { actor: APOSTROPHE, app: APOSTROPHE } }, unsubscribeUrl: UNSUBSCRIBE },
  project_opened: { appName: APOSTROPHE, unsubscribeUrl: UNSUBSCRIBE },
};

test('a value with an apostrophe: the html differs only by &#39;, and subject, text and headers not at all', async () => {
  const french = await pipelineTranslator('fr', FRENCH);
  for (const t of [undefined, french, hostile]) {
    for (const kind of KINDS) {
      const payload = WITH_APOSTROPHE[kind];
      const today = buildMessage(kind, t ? { ...payload, translate: t } : payload);
      const seeded = viaSeeds(kind, payload, t);
      assert.match(seeded.html, /&#39;/, kind);
      assert.equal(seeded.html.replaceAll('&#39;', "'"), today.html, kind);
      assert.deepEqual({ ...seeded, html: '' }, { ...today, html: '' }, kind);
    }
  }
});

test('a catalog apostrophe stays bare beside an escaped value in words built in code', async () => {
  const t = await pipelineTranslator('fr', FRENCH);
  const payload = { appName: APOSTROPHE, unsubscribeUrl: UNSUBSCRIBE };
  const html = viaSeeds('invite_activity', payload, t).html;
  assert.ok(html.includes('Quelqu\'un a rejoint O&#39;Brien grâce'), html);
});

test('accepted: a link that is not plain http(s) is dropped rather than rendered', () => {
  const bad = 'javascript:alert(1)';
  assert.match(buildMessage('waitlist_joined', { confirmUrl: bad }).html, /javascript:/);
  assert.doesNotMatch(viaSeeds('waitlist_joined', { confirmUrl: bad }).html, /javascript:/);
});

test('accepted: a required value that is missing renders empty, not the word undefined', () => {
  assert.match(buildMessage('otp', {}).text, /undefined/);
  assert.doesNotMatch(viaSeeds('otp', {}).text, /undefined/);
});
