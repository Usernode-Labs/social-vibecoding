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
