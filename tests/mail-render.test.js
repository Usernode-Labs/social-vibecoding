'use strict';

// src/services/mail/render.js: a template inside a layout, a template that opted
// out of layouts, and what the tail of buildMessage needs from the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMessage } = require('../src/services/mail/render');
const tracking = require('../src/services/mail/tracking');

const LAYOUT = {
  html: '<html><body>{{#if preheader}}<i>{{preheader}}</i>{{/if}}<main>{{content}}</main><footer>{{why}}</footer></body></html>',
  text: '{{content}}\n--\n{{why}}',
};
const OTP = {
  subject: 'Code {{code}}',
  preheader: 'Use {{code}}',
  why: "You're here because of {{code}}",
  html: '<p>{{code}}</p>',
  text: 'Code: {{code}}',
};

test('a template inside a layout: content goes in raw, once', () => {
  const out = renderMessage('otp', { template: OTP, layout: LAYOUT }, { code: '<1>' });
  assert.equal(out.subject, 'Code <1>');
  assert.equal(out.text, "Code: <1>\n--\nYou're here because of <1>");
  assert.equal(out.preheader, 'Use &lt;1&gt;');
  assert.equal(out.why, "You're here because of &lt;1&gt;");
  assert.equal(out.html, "<html><body><i>Use &lt;1&gt;</i><main><p>&lt;1&gt;</p></main><footer>You're here because of &lt;1&gt;</footer></body></html>");
  assert.equal(out.headers, null);
});

test('an empty preheader draws nothing', () => {
  const out = renderMessage('otp', { template: { ...OTP, preheader: '' }, layout: LAYOUT }, { code: '1' });
  assert.doesNotMatch(out.html, /<i>/);
  assert.equal(out.preheader, '');
});

test('a value that looks like a placeholder is not read again by the layout', () => {
  const out = renderMessage('otp', { template: OTP, layout: LAYOUT }, { code: '{{why}}' });
  assert.match(out.html, /<p>\{\{why\}\}<\/p>/);
  assert.match(out.text, /^Code: \{\{why\}\}\n/);
});

test('a template that opted out has no layout around it', () => {
  const out = renderMessage('otp', { template: OTP, layout: null }, { code: '1' });
  assert.equal(out.html, '<p>1</p>');
  assert.equal(out.text, 'Code: 1');
  assert.equal(out.why, "You're here because of 1");
});

test('headers are kept, and a tail like buildMessage\'s can use the result', () => {
  const template = { subject: 'S', preheader: '', why: '', html: '<a href="{{url}}">x</a>', text: '{{url}}' };
  const unsubscribeUrl = 'https://app.onhomeroom.com/mail/unsubscribe?x=1';
  const payload = { url: 'https://x.test/', unsubscribeUrl };
  const out = renderMessage('project_opened', { template, layout: LAYOUT }, payload);
  assert.deepEqual(out.headers, {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  assert.equal(renderMessage('project_opened', { template, layout: LAYOUT }, { url: 'https://x.test/' }).headers, null);

  const before = process.env.PLATFORM_MAIL_TRACKING_SECRET;
  process.env.PLATFORM_MAIL_TRACKING_SECRET = 'only-for-tests';
  try {
    const { why, preheader, headers, ...message } = out;
    const tracked = tracking.decorate('build_ready', message, { trackingEnabled: true, messageId: 'b'.repeat(48) });
    assert.deepEqual(tracked.trackingLinks, ['https://x.test/']);
    assert.match(tracked.html, /mail\/o\/b{48}\.gif/);
  } finally {
    if (before === undefined) delete process.env.PLATFORM_MAIL_TRACKING_SECRET;
    else process.env.PLATFORM_MAIL_TRACKING_SECRET = before;
  }
});

test('the subject is cleaned when it is translated, and only then, as today', () => {
  const template = { ...OTP, subject: 'A  {{code}}\nB ' };
  assert.equal(renderMessage('otp', { template, layout: null }, { code: '1' }).subject, 'A  1\nB ');
  assert.equal(renderMessage('otp', { template, layout: null }, { code: '1' }, () => '').subject, 'A 1 B');
});

test('a reader with a language has the subject cleaned with or without a row, and English-only mail never', () => {
  const template = { ...OTP, subject: 'A  {{code}}\nB ' };
  const parts = { template, layout: null };
  assert.equal(renderMessage('otp', parts, { code: '1' }, undefined, { readerHasLanguage: true }).subject, 'A 1 B');
  assert.equal(renderMessage('otp', parts, { code: '1' }, undefined, { readerHasLanguage: false }).subject, 'A  1\nB ');
  const report = { template: { ...OTP, subject: 'A  {{reason}}\nB ' }, layout: null };
  assert.equal(renderMessage('content_report', report, { reason: 'x' }, undefined, { readerHasLanguage: true }).subject, 'A  x\nB ');
  assert.equal(renderMessage('content_report', report, { reason: 'x' }, () => '').subject, 'A  x\nB ');
});

test('an unknown kind throws, as buildMessage does', () => {
  assert.throws(() => renderMessage('nope', { template: OTP, layout: null }, {}), /unknown mail kind/);
  assert.throws(() => renderMessage('constructor', { template: OTP, layout: null }, {}), /unknown mail kind/);
});

test('a broken template throws for the caller to fall back', () => {
  assert.throws(() => renderMessage('otp', { template: { ...OTP, html: '{{#if code}}' }, layout: null }, { code: '1' }), { name: 'TemplateSyntaxError' });
});

// ── Per part, and what a translation must keep (the send path's own render) ──

const { renderResolved } = require('../src/services/mail/render');
const { resolve } = require('../src/services/mail/template-store');

const FR_OTP = { subject: 'Code FR {{code}}', preheader: '', why: 'Pourquoi', html: '<p>FR {{code}}</p>', text: 'FR {{code}}' };
const FR_LAYOUT = { html: '<html><body><main>{{content}}</main><footer>Bas de page</footer></body></html>', text: '{{content}}\nFR' };
const snapshotOf = (templateTranslations, layoutTranslations, layoutFamily = 7) => ({
  templates: { otp: { ...OTP, action: 'otp', layout_family_id: layoutFamily, translations: templateTranslations } },
  layouts: { 7: { ...LAYOUT, family_id: 7, translations: layoutTranslations } },
});
const rendered = (snapshot, locale, payload = { code: '111' }) => renderResolved('otp', {
  ...resolve(snapshot, 'otp', locale), t: undefined, readerHasLanguage: !!locale,
}, payload);

test('per part: an English body in a translated layout', () => {
  const out = rendered(snapshotOf({}, { fr: FR_LAYOUT }), 'fr');
  assert.match(out.html, /<main><p>111<\/p><\/main><footer>Bas de page<\/footer>/);
  assert.equal(out.subject, 'Code 111');
});

test('per part: a translated body in an English layout', () => {
  const out = rendered(snapshotOf({ fr: FR_OTP }, {}), 'fr');
  assert.match(out.html, /<main><p>FR 111<\/p><\/main><footer>Pourquoi<\/footer>/);
  assert.equal(out.subject, 'Code FR 111');
  assert.equal(out.text, 'FR 111\n--\nPourquoi');
});

test('opted-out templates render their own html with no layout', () => {
  const out = rendered(snapshotOf({ fr: FR_OTP }, { fr: FR_LAYOUT }, null), 'fr');
  assert.equal(out.html, '<p>FR 111</p>');
  assert.equal(out.text, 'FR 111');
});

test('a translation losing a required value falls back to English', () => {
  const lost = { ...FR_OTP, html: '<p>Votre code est ci-dessous</p>' };
  const out = rendered(snapshotOf({ fr: lost }, {}), 'fr');
  assert.equal(out.subject, 'Code 111');
  assert.match(out.html, /<p>111<\/p>/);
  // A translated layout that loses the body loses the code the same way.
  const noBody = rendered(snapshotOf({}, { fr: { html: '<html>Vide</html>', text: 'Vide' } }), 'fr');
  assert.match(noBody.html, /<p>111<\/p>/);
  assert.match(noBody.text, /111/);
  // A translation that does not parse costs that language, not the mail.
  assert.match(rendered(snapshotOf({ fr: { ...FR_OTP, html: '{{#if code}}' } }, {}), 'fr').html, /<p>111<\/p>/);
});

test('subject control characters are stripped', () => {
  const broken = { ...FR_OTP, subject: 'Code  {{code}}\nBcc: x@y.z ' };
  assert.equal(rendered(snapshotOf({ fr: broken }, {}), 'fr').subject, 'Code 111 Bcc: x@y.z');
  assert.equal(rendered(snapshotOf({}, {}), 'fr', { code: '1\n2' }).subject, 'Code 1 2');
});

test('resolve: another language, an unusable translation and odd names all mean English', () => {
  const snapshot = snapshotOf({ fr: FR_OTP, de: { ...FR_OTP, html: '' } }, { fr: FR_LAYOUT });
  assert.equal(resolve(snapshot, 'otp', 'fr').template.subject, FR_OTP.subject);
  for (const locale of ['es', 'de', null, undefined, 'constructor', '__proto__']) {
    assert.equal(resolve(snapshot, 'otp', locale).template.subject, OTP.subject, String(locale));
  }
  assert.equal(resolve(snapshot, 'otp', 'es').layout.html, LAYOUT.html);
  assert.equal(resolve(snapshot, 'otp', 'fr').layout.html, FR_LAYOUT.html);
});

test('resolve: nothing to send with is a null template, never a throw', () => {
  const none = { template: null, layout: null };
  assert.deepEqual(resolve(null, 'otp', 'fr'), none);
  assert.deepEqual(resolve({ templates: {}, layouts: {} }, 'otp', null), none);
  assert.deepEqual(resolve(snapshotOf({}, {}), 'constructor', null), none);
  // A template whose layout is gone must not go out unframed by accident.
  assert.deepEqual(resolve(snapshotOf({}, {}, 8), 'otp', null), none);
});

test('resolve: an English-only kind stays English whatever the row holds', () => {
  const snapshot = { templates: { content_report: { ...OTP, action: 'content_report', layout_family_id: null, translations: { fr: FR_OTP } } }, layouts: {} };
  assert.equal(resolve(snapshot, 'content_report', 'fr').template.subject, OTP.subject);
});

test('a word built in code whose translation adds a line break is English, that word only', () => {
  const { renderResolved } = require('../src/services/mail/render');
  const english = (id) => require('./lib/platform-i18n').message(id);
  const template = {
    subject: '{{subject}}', preheader: '', why: 'w', html: '<p>{{app}}: {{lead}}</p>', text: '{{app}}: {{lead}}\n{{unsubscribeUrl}}',
  };
  const spanish = { ...template, why: 'Por qué' };
  const t = (id) => ({
    'email:buildReady.lead.ready': 'Prêt\nBcc: x',
    'email:buildReady.subject.ready': 'Listo para probar',
  }[id] || '');
  const out = renderResolved('build_ready', { template: spanish, layout: null, english: { template, layout: null }, t, readerHasLanguage: true },
    { appName: 'Pal', unsubscribeUrl: 'https://x.test/u' });
  assert.equal(out.text, `Pal: ${english('email:buildReady.lead.ready')}\nhttps://x.test/u`);
  assert.doesNotMatch(out.html, /Bcc/);
  assert.equal(out.subject, 'Listo para probar', 'the other word keeps its translation');
});
