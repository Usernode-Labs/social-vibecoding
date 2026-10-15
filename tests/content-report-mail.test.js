'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const templates = require(path.join(ROOT, 'src/services/mail/templates.js'));
const moderationSrc = fs.readFileSync(path.join(ROOT, 'src/services/moderation.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');

const PAYLOAD = {
  caseId: 312,
  reportId: 977,
  reason: 'harassment',
  detail: 'Keeps posting the same insult under my requests.',
  targetType: 'app_message',
  targetLabel: 'App message #48213',
  reporter: 'sam',
  url: 'https://app.onhomeroom.com/#admin/reports/312',
};

test('the content_report kind exists and renders all three parts', () => {
  assert.ok(templates.KINDS.includes('content_report'), 'registered in TEMPLATES');
  const mail = templates.buildMessage('content_report', PAYLOAD);
  assert.equal(mail.subject, 'New report: harassment · App message #48213');
  assert.ok(mail.text.trim().length > 0);
  assert.ok(mail.html.includes('<!doctype html>'));
  assert.doesNotMatch(mail.text, /undefined/);
  assert.doesNotMatch(mail.html, /undefined/);
});

test('the mail carries the report details and the admin console link', () => {
  const mail = templates.buildMessage('content_report', PAYLOAD);
  assert.match(mail.text, /Reason: harassment/);
  assert.match(mail.text, /Reported: App message · App message #48213/);
  assert.match(mail.text, /Reporter: @sam/);
  assert.match(mail.text, /Case #312 · Report #977/);
  assert.match(mail.text, /Details from the reporter:\nKeeps posting the same insult/);
  assert.match(mail.text, /Open in Moderation: https:\/\/app\.onhomeroom\.com\/#admin\/reports\/312/);
  assert.match(mail.html, /Reason: <strong>harassment<\/strong>/);
  assert.match(mail.html, /Case #312 · Report #977/);
  assert.match(mail.html, /href="https:\/\/app\.onhomeroom\.com\/#admin\/reports\/312"/);
  assert.match(mail.html, /Open in Moderation/);
});

test('the html detail is escaped and keeps its line breaks', () => {
  const mail = templates.buildMessage('content_report', { ...PAYLOAD, detail: 'line one\n<script>alert(1)</script>' });
  assert.doesNotMatch(mail.html, /<script>/);
  assert.match(mail.html, /&lt;script&gt;/);
  const mailText = templates.buildMessage('content_report', { ...PAYLOAD, detail: 'line one\nline two' });
  assert.match(mailText.text, /line one\nline two/);
  assert.match(mailText.html, /line one\n?line two|line one<br>line two|line one\nline two/);
});

test('an empty detail reads "None given", and unknown fields never render "undefined"', () => {
  const mail = templates.buildMessage('content_report', { ...PAYLOAD, detail: '' });
  assert.match(mail.text, /Details from the reporter:\nNone given/);
  assert.match(mail.html, /None given/);
  const sparse = templates.buildMessage('content_report', {});
  assert.doesNotMatch(sparse.text, /undefined/);
  assert.doesNotMatch(sparse.html, /undefined/);
  assert.match(sparse.subject, /New report:/);
});

test('the footer says why the compliance inbox received it', () => {
  const mail = templates.buildMessage('content_report', PAYLOAD);
  assert.match(mail.html, /You are receiving this because this address is Homeroom's compliance inbox for content reports\./);
});

test('submitReport sends after the transaction commits, with the config recipient', () => {
  // Source assertions: the send sits after the awaited transaction and reads
  // the deployment's compliance inbox, so a rolled-back report never mails.
  assert.match(moderationSrc, /const result = await transaction\(pool, async \(db\) => \{/);
  assert.match(moderationSrc, /if \(config && mailPayload\) sendComplianceMail/);
  assert.match(moderationSrc, /kind: 'content_report'/);
  assert.match(moderationSrc, /config\.complianceEmail\) \|\| 'compliance@usernodelabs\.org'/);
  assert.match(moderationSrc, /#admin\/reports\/\$\{payload\.caseId\}/);
  assert.doesNotMatch(moderationSrc, /mailPayload = \{[\s\S]*?\}\);\s*return \{ id: rows\[0\]\.id, received: true/);
  // The mail payload must never reach the client receipt: the return line
  // names only the receipt fields.
  const receipt = moderationSrc.match(/return \{ id: rows\[0\]\.id, received: true[^\n]*\}/);
  assert.ok(receipt, 'the receipt return is present');
  assert.doesNotMatch(receipt[0], /mailPayload/);
});

test('the compliance recipient defaults to compliance@usernodelabs.org and is overridable', () => {
  assert.match(configSrc, /complianceEmail: \(process\.env\.PLATFORM_COMPLIANCE_EMAIL \|\| ''\)\.trim\(\) \|\| 'compliance@usernodelabs\.org'/);
});

test('content_report is not open- or click-tracked', () => {
  const events = require(path.join(ROOT, 'src/services/mail/events.js'));
  assert.ok(!events.isTracked('content_report'));
  const mail = templates.buildMessage('content_report', { ...PAYLOAD, trackingEnabled: true, messageId: events.messageId() });
  assert.doesNotMatch(mail.html, /\/mail\/o\//);
  assert.doesNotMatch(mail.html, /\/mail\/c\//);
});
