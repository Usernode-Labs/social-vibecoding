'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PRODUCTION_ORIGIN } = require('../src/services/cli-auth-constants');
const templates = require('../src/services/mail/templates');
const { ACTIONS, actionFor } = require('../src/services/mail/actions');

test('covers every kind', () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), [...templates.KINDS].sort());
  assert.equal(templates.KINDS.length, 13);
  assert.equal(actionFor('otp'), ACTIONS.otp);
  assert.equal(actionFor('nope'), null);
  assert.equal(actionFor('constructor'), null);
});

test('every action is well formed', () => {
  for (const [kind, a] of Object.entries(ACTIONS)) {
    assert.ok(a.label, kind);
    assert.equal(typeof a.englishOnly, 'boolean', kind);
    assert.equal(typeof a.values, 'function', kind);
    for (const form of ['html', 'text']) {
      for (const name of a.required[form]) assert.ok(a.placeholders[name], `${kind} requires unknown ${name}`);
    }
    for (const [name, p] of Object.entries(a.placeholders)) {
      assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
      assert.ok(p.description, `${kind}.${name}`);
      assert.ok(['text', 'url', 'flag'].includes(p.kind), `${kind}.${name}`);
    }
  }
});

test('otp requires code in both forms, password_reset its link', () => {
  assert.deepEqual(ACTIONS.otp.required, { html: ['code'], text: ['code'] });
  assert.deepEqual(ACTIONS.password_reset.required, { html: ['url'], text: ['url'] });
  assert.equal(ACTIONS.otp.label, 'Sign-in code (OTP)');
  assert.equal(ACTIONS.waitlist_released.label, 'Waitlist release');
});

test('activity mails require the unsubscribe link', () => {
  for (const kind of ['build_ready', 'invite_activity', 'project_opened']) {
    assert.deepEqual(ACTIONS[kind].required, { html: ['unsubscribeUrl'], text: ['unsubscribeUrl'] }, kind);
  }
});

test('words built in code are marked fromCode', () => {
  assert.equal(ACTIONS.build_ready.placeholders.subject.fromCode, true);
  assert.equal(ACTIONS.build_ready.placeholders.lead.fromCode, true);
  assert.equal(ACTIONS.invite_activity.placeholders.line.fromCode, true);
  assert.equal(ACTIONS.otp.placeholders.code.fromCode, undefined);
});

test('only admin_test and content_report are English only', () => {
  const only = Object.entries(ACTIONS).filter(([, a]) => a.englishOnly).map(([k]) => k).sort();
  assert.deepEqual(only, ['admin_test', 'content_report']);
  assert.deepEqual(only, [...templates.ENGLISH_ONLY_KINDS].sort());
});

test('url values are checked', () => {
  const bad = 'javascript:alert(1)';
  assert.equal(ACTIONS.password_reset.values({ url: bad }).url, '');
  assert.equal(ACTIONS.password_reset.values({ url: 'https://x.test/a?b=1' }).url, 'https://x.test/a?b=1');
  assert.equal(ACTIONS.waitlist_joined.values({ confirmUrl: bad }).confirmUrl, '');
  assert.equal(ACTIONS.waitlist_joined.values({ confirmUrl: bad }).hasConfirmUrl, false);
  assert.equal(ACTIONS.waitlist_code.values({ statusUrl: bad }).statusUrl, '');
  assert.equal(ACTIONS.build_ready.values({ url: bad, unsubscribeUrl: bad }).unsubscribeUrl, '');
  assert.equal(ACTIONS.waitlist_released.values({ mobile: { ios: bad } }).hasIos, false);
  assert.equal(ACTIONS.content_report.values({ url: bad }).url, PRODUCTION_ORIGIN);
});

test('every value of every placeholder kind is declared and typed', () => {
  for (const [kind, a] of Object.entries(ACTIONS)) {
    const v = a.values(a.sample);
    assert.deepEqual(Object.keys(v).sort(), Object.keys(a.placeholders).sort(), kind);
    for (const [name, p] of Object.entries(a.placeholders)) {
      if (p.kind === 'flag') assert.equal(typeof v[name], 'boolean', `${kind}.${name}`);
      else assert.equal(typeof v[name], 'string', `${kind}.${name}`);
    }
    // Empty payloads still give every value.
    assert.deepEqual(Object.keys(a.values({})).sort(), Object.keys(a.placeholders).sort(), kind);
  }
});

test('sample satisfies required', () => {
  for (const [kind, a] of Object.entries(ACTIONS)) {
    const v = a.values(a.sample);
    for (const form of ['html', 'text']) {
      for (const name of a.required[form]) assert.ok(v[name], `${kind}.${name} (${form})`);
    }
  }
});

test('values carry what the templates compute today', () => {
  const rel = ACTIONS.waitlist_released.values({ url: 'https://x.test/r', hasAccount: false, mobile: { android: 'https://play.test/a' } });
  assert.equal(rel.hasAccount, false);
  assert.equal(rel.needsCodeNote, true);
  assert.equal(rel.hasIos, false);
  assert.equal(rel.hasAndroid, true);
  assert.equal(rel.androidLink, 'https://play.test/a');
  assert.equal(rel.hasMobile, true);
  assert.equal(ACTIONS.waitlist_released.values({ url: 'https://x.test/r', signInLink: true }).needsCodeNote, false);
  assert.equal(ACTIONS.waitlist_released.values({ url: 'https://x.test/r', hasAccount: true }).needsCodeNote, false);

  const code = ACTIONS.waitlist_code.values({ code: '123456', confirmed: true });
  assert.equal(code.hasCode, true);
  assert.equal(code.isConfirmed, true);
  assert.equal(ACTIONS.waitlist_code.values({}).hasCode, false);

  const ready = ACTIONS.build_ready.values({ appName: 'Plant Pal' });
  assert.equal(ready.app, 'Plant Pal');
  assert.match(ready.lead, /^Ready to try\./);
  assert.equal(ready.subject, 'Plant Pal: Ready to try');
  assert.equal(ready.url, PRODUCTION_ORIGIN);
  assert.equal(ACTIONS.build_ready.values({ lead: '  Hi  ', subject: ' S ' }).lead, 'Hi');
  assert.equal(ACTIONS.build_ready.values({ appName: 'x'.repeat(200) }).app.length, 80);

  const joined = ACTIONS.invite_activity.values({ appName: 'Run Club', line: '@sam joined Run Club through your invite.' });
  assert.equal(joined.line, '@sam joined Run Club through your invite.');
  assert.equal(joined.subject, '@sam joined Run Club through your invite');
  assert.equal(joined.hasApp, true);
  const noted = ACTIONS.invite_activity.values({ appName: 'Run Club', notice: { id: 'member_joined', values: { actor: '@sam', app: 'Run Club' } } });
  assert.match(noted.line, /@sam/);
  assert.equal(ACTIONS.invite_activity.values({}).hasApp, false);

  const inv = ACTIONS.project_invite.values({ inviter: 'Sam' });
  assert.deepEqual([inv.hasInviter, inv.hasProject, inv.hasUrl], [true, false, false]);

  const rep = ACTIONS.content_report.values({ reason: 'hate_speech', targetType: 'app_message', reporter: 'sam', detail: '  ' });
  assert.equal(rep.reason, 'hate speech');
  assert.equal(rep.typeLabel, 'App message');
  assert.equal(rep.reporter, '@sam');
  assert.equal(rep.detail, 'None given');
  assert.equal(rep.caseId, '?');
});
