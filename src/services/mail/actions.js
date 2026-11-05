'use strict';

// The registry of email actions: one entry per kind of mail the platform
// sends. It is configuration, not email content. For each kind it says what a
// template may use (`placeholders`), what a template must use so the mail
// still does its one job (`required`, per form), whether the mail stays in
// English, a `sample` payload for previews and test sends, and `values()`,
// which turns a send's payload into the named values a template renders with.
//
// `values()` returns everything today's template functions in templates.js
// compute or branch on, named after the catalog's own parameters where one
// exists ({{code}}, {{url}}, {{app}}, {{inviter}}, {{project}}), so a template
// written in the template language can say what the code says. A placeholder
// marked `fromCode` holds wording that is built in code from the payload (an
// activity mail's line, the bot's subject), not words an admin edits.
//
// Every URL goes through the same check the click tracker uses, so a link that
// is not plain http(s) becomes '' and is never rendered as an address.
//
// `htmlValues()`, on the actions that have it, gives the html form of the words
// built in code, already escaped. The template language would escape every
// apostrophe in such a value, and those words are partly catalog wording, whose
// apostrophes have always gone out bare. So what came from a sender keeps the
// template language's escaping and the catalog's words keep their bytes.
//
// `headers()`, where present, gives the extra mail headers a send carries.
//
// `codeWords` marks the actions whose `values()` build words from the email
// catalog. A send asks for the reader's translator only for these, and only when
// their template is translated, so a login code never waits on that read.

const { PRODUCTION_ORIGIN } = require('../cli-auth-constants');
const { destination } = require('./tracking');
const { englishFrom, englishTexts } = require('../push-text');

// The email catalog's English, for the wording a value builds in code. Read when
// asked, like templates.js does, so a catalog edit is seen on the next send.
const english = (id, values) => englishFrom(englishTexts(undefined, 'email'))(id, values);

const url = (value) => destination(value) || '';
const str = (value) => (value == null ? '' : String(value));
const clip = (value, max) => str(value).slice(0, max);

const text = (description, extra) => ({ description, kind: 'text', ...extra });
const link = (description) => ({ description, kind: 'url' });
// `presenceOf` names the value a flag is the presence of: true exactly when
// that value prints something, so `{{#if hasCode}}{{code}}{{/if}}` still always
// prints the code whenever there is one (template-validation.js).
const flag = (description, presenceOf) => ({ description, kind: 'flag', ...(presenceOf ? { presenceOf } : {}) });

// A sender's apostrophes are held as this private-use character (one character
// for one, so a clip to a length cuts in the same place) while their sentence is
// built, then become &#39; once the whole of it has been escaped.
const SENDER_APOSTROPHE = '\uE001';
const asIs = (value) => value;
const markSender = (value) => (typeof value === 'string' ? value.replace(/'/g, SENDER_APOSTROPHE) : value);
const wordsToHtml = (words) => String(words)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .split(SENDER_APOSTROPHE).join('&#39;');

const BOTH = (...names) => ({ html: [...names], text: [...names] });
const NONE = { html: [], text: [] };

const REPORT_TYPE_LABELS = {
  app: 'App',
  user: 'User',
  app_message: 'App message',
  conversation_message: 'Private message',
};

// The activity mails share one tail: the link that opens the thing, and the
// one-click unsubscribe every one of them carries.
const ACTIVITY_PLACEHOLDERS = {
  url: link('Where the button goes'),
  unsubscribeUrl: link('One-click link that stops these emails'),
  hasUnsubscribeUrl: flag('True when the unsubscribe link is present', 'unsubscribeUrl'),
};
function activityValues(payload) {
  const unsubscribeUrl = url(payload.unsubscribeUrl);
  return {
    url: url(payload.url) || PRODUCTION_ORIGIN,
    unsubscribeUrl,
    hasUnsubscribeUrl: !!unsubscribeUrl,
  };
}
// RFC 8058: `List-Unsubscribe` with `List-Unsubscribe-Post`.
function activityHeaders(payload) {
  const unsubscribeUrl = url(payload.unsubscribeUrl);
  return unsubscribeUrl ? {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  } : null;
}

function buildReadyWords(payload, t, sender = asIs) {
  const app = payload.appName ? sender(clip(payload.appName, 80)) : clip(t('email:buildReady.unnamedProject'), 80);
  const lead = typeof payload.lead === 'string' && payload.lead.trim()
    ? sender(payload.lead.trim().slice(0, 300))
    : (payload.notWorking ? t('email:buildReady.lead.notWorking') : t('email:buildReady.lead.ready'));
  const subject = typeof payload.subject === 'string' && payload.subject.trim()
    ? payload.subject.trim().slice(0, 200)
    : (payload.notWorking ? t('email:buildReady.subject.notWorking', { app }) : t('email:buildReady.subject.ready', { app }));
  return { app, lead, subject };
}

const INVITE_NOTICES = {
  first_message: 'email:inviteActivity.firstMessage',
  member_joined: 'email:inviteActivity.joined',
  member_joined_someone: 'email:inviteActivity.joinedSomeone',
};
function inviteLine(payload, t, sender = asIs) {
  const app = payload.appName ? clip(payload.appName, 80) : '';
  // The notice it stands for names its own message; `line` is its English.
  const noticeId = Object.hasOwn(INVITE_NOTICES, payload.notice?.id) ? INVITE_NOTICES[payload.notice.id] : null;
  const noticeValues = Object.fromEntries(Object.entries(payload.notice?.values || {}).map(([name, value]) => [name, sender(value)]));
  const fallback = app ? t('email:inviteActivity.joinedSomeone', { app: sender(app) }) : t('email:inviteActivity.joinedUnnamed');
  return String((noticeId ? t(noticeId, noticeValues) : '') || sender(payload.line) || fallback).slice(0, 200);
}

const codeAction = (label, expiry) => ({
  label,
  placeholders: { code: text(`The six-digit code, valid ${expiry}`) },
  required: BOTH('code'),
  englishOnly: false,
  sample: { code: '123456' },
  values: (payload) => ({ code: str(payload.code) }),
});

const ACTIONS = {
  otp: codeAction('Sign-in code (OTP)', 'for 10 minutes'),

  account_email: codeAction('Account email verification', 'for 10 minutes'),

  username_change: codeAction('Username change confirmation', 'for 10 minutes'),

  waitlist_joined: {
    label: 'Waitlist welcome',
    placeholders: {
      code: text('Six-digit verification code, valid for 15 minutes'),
      hasCode: flag('True when the mail carries a verification code', 'code'),
      confirmUrl: link('One-click link that confirms the address'),
      hasConfirmUrl: flag('True when the confirmation link is present', 'confirmUrl'),
    },
    required: BOTH('code'),
    englishOnly: false,
    sample: { code: '123456', confirmUrl: 'https://app.onhomeroom.com/api/public/waitlist/confirm/sample' },
    values: (payload) => ({
      code: str(payload.code),
      hasCode: !!payload.code,
      confirmUrl: url(payload.confirmUrl),
      hasConfirmUrl: !!url(payload.confirmUrl),
    }),
  },

  waitlist_code: {
    label: 'Waitlist confirmation or status code',
    placeholders: {
      code: text('Six-digit code, valid for 15 minutes'),
      hasCode: flag('False when no code could be made and the mail only points to the status page', 'code'),
      isConfirmed: flag('True when the address is already confirmed, so the code is a status code'),
      confirmUrl: link('One-click link that confirms the address'),
      hasConfirmUrl: flag('True when the confirmation link is present', 'confirmUrl'),
      statusUrl: link('Where the waitlist status is checked'),
      hasStatusUrl: flag('True when the status link is present', 'statusUrl'),
    },
    required: BOTH('code'),
    englishOnly: false,
    sample: { code: '123456', confirmed: false, confirmUrl: 'https://app.onhomeroom.com/api/public/waitlist/confirm/sample', statusUrl: 'https://app.onhomeroom.com/#waitlist-status' },
    values: (payload) => ({
      code: str(payload.code),
      hasCode: !!payload.code,
      isConfirmed: !!payload.confirmed,
      confirmUrl: url(payload.confirmUrl),
      hasConfirmUrl: !!url(payload.confirmUrl),
      statusUrl: url(payload.statusUrl),
      hasStatusUrl: !!url(payload.statusUrl),
    }),
  },

  waitlist_released: {
    label: 'Waitlist release',
    placeholders: {
      url: link('The button: signs the person in or starts their account'),
      hasAccount: flag('True when the person already has an account'),
      hasSignInLink: flag('True when the link signs them in at once'),
      needsCodeNote: flag('True when opening the link sends a sign-in code, so the mail says to expect it'),
      hasIos: flag('True when the iOS app has a published listing', 'iosLink'),
      iosLink: link('The iOS app listing'),
      hasAndroid: flag('True when the Android app has a published listing', 'androidLink'),
      androidLink: link('The Android app listing'),
      hasMobile: flag('True when at least one app listing is published'),
    },
    required: BOTH('url'),
    englishOnly: false,
    sample: { url: 'https://app.onhomeroom.com/#release', hasAccount: false, signInLink: false, mobile: { ios: 'https://apps.apple.com/app/sample', android: 'https://play.google.com/store/apps/sample' } },
    values: (payload) => {
      const mobile = payload.mobile || {};
      const iosLink = url(mobile.ios);
      const androidLink = url(mobile.android);
      const hasAccount = !!payload.hasAccount;
      return {
        url: url(payload.url),
        hasAccount,
        hasSignInLink: !!payload.signInLink,
        needsCodeNote: !hasAccount && !payload.signInLink,
        hasIos: !!iosLink,
        iosLink,
        hasAndroid: !!androidLink,
        androidLink,
        hasMobile: !!(iosLink || androidLink),
      };
    },
  },

  password_reset: {
    label: 'Password reset',
    placeholders: { url: link('The reset link, valid for 30 minutes') },
    required: BOTH('url'),
    englishOnly: false,
    sample: { url: 'https://app.onhomeroom.com/#reset/sample' },
    values: (payload) => ({ url: url(payload.url) }),
  },

  admin_test: {
    label: 'Admin test email',
    placeholders: {
      provider: text('The mail provider that sent it'),
      from: text('The sender address'),
      sentAt: text('When it was sent'),
      reference: text('The short reference shown in the console activity table'),
    },
    required: NONE,
    englishOnly: true,
    sample: { provider: 'brevo', from: 'Homeroom <hello@my.onhomeroom.com>', sentAt: '2026-11-05T09:00:00.000Z', reference: 'a1b2c3' },
    values: (payload) => ({
      provider: payload.provider || 'unknown',
      from: payload.from || '(unset)',
      sentAt: payload.sentAt || '',
      reference: payload.reference || '(none)',
    }),
  },

  content_report: {
    label: 'Content report',
    placeholders: {
      subject: text('The subject line: the reason and what was reported, at most 200 characters', { fromCode: true }),
      reason: text('The report reason, in words'),
      typeLabel: text('What kind of thing was reported'),
      targetLabel: text('Name of the reported thing, at most 120 characters'),
      reporter: text('The reporter, as @username'),
      caseId: text('The moderation case number'),
      reportId: text('The report number'),
      detail: text('What the reporter wrote, or "None given"'),
      url: link('Opens the case in the admin console'),
    },
    required: BOTH('url'),
    englishOnly: true,
    sample: { reason: 'spam', targetType: 'app', targetLabel: 'Sample project', reporter: 'sample', caseId: 12, reportId: 34, detail: 'Looks like advertising.', url: 'https://app.onhomeroom.com/#admin/moderation' },
    values: (payload) => {
      const reason = String(payload.reason || 'unknown').replace(/_/g, ' ');
      const targetLabel = clip(payload.targetLabel || 'Unknown target', 120);
      return {
        subject: `New report: ${reason} · ${targetLabel}`.slice(0, 200),
        reason,
        typeLabel: REPORT_TYPE_LABELS[payload.targetType] || 'Unknown',
        targetLabel,
        reporter: payload.reporter ? `@${payload.reporter}` : 'Unknown',
        caseId: payload.caseId != null ? String(payload.caseId) : '?',
        reportId: payload.reportId != null ? String(payload.reportId) : '?',
        detail: String(payload.detail || '').trim() || 'None given',
        url: url(payload.url) || PRODUCTION_ORIGIN,
      };
    },
  },

  project_invite: {
    label: 'Project invite',
    placeholders: {
      inviter: text('Who invited them, when known'),
      hasInviter: flag('True when the inviter is known'),
      project: text('The project they were invited to, when known'),
      hasProject: flag('True when the project is known'),
      url: link('Joins the waitlist with this address'),
      hasUrl: flag('True when the link is present', 'url'),
    },
    required: BOTH('url'),
    englishOnly: false,
    sample: { inviter: 'Sam', project: 'Run Club', url: 'https://app.onhomeroom.com/#waitlist' },
    values: (payload) => ({
      inviter: str(payload.inviter),
      hasInviter: !!payload.inviter,
      project: str(payload.project),
      hasProject: !!payload.project,
      url: url(payload.url),
      hasUrl: !!url(payload.url),
    }),
  },

  build_ready: {
    label: 'Homeroom bot: ready to try',
    placeholders: {
      // With no name, the catalog's word for an unnamed project.
      app: text('The project\'s name, at most 80 characters', { fromCode: true }),
      subject: text('The subject line, as the bot\'s push words it', { fromCode: true }),
      lead: text('The headline: what is ready', { fromCode: true }),
      ...ACTIVITY_PLACEHOLDERS,
    },
    required: BOTH('unsubscribeUrl'),
    englishOnly: false,
    codeWords: true,
    sample: { appName: 'Plant Pal', subject: 'Dark mode · Plant Pal: Ready to try', lead: 'Dark mode is ready to try.', url: 'https://app.onhomeroom.com/#app/plant-pal', unsubscribeUrl: 'https://app.onhomeroom.com/mail/unsubscribe?sample=1' },
    values: (payload, t = english) => ({ ...buildReadyWords(payload, t), ...activityValues(payload) }),
    htmlValues: (payload, t = english) => {
      const { app, lead } = buildReadyWords(payload, t, markSender);
      return { app: wordsToHtml(app), lead: wordsToHtml(lead) };
    },
    headers: activityHeaders,
  },

  invite_activity: {
    label: 'Invite activity',
    placeholders: {
      app: text('The project\'s name, at most 80 characters, when known'),
      hasApp: flag('True when the project is named'),
      line: text('The sentence saying what happened, such as "@sam joined Run Club through your invite."', { fromCode: true }),
      subject: text('The same sentence without its final full stop', { fromCode: true }),
      ...ACTIVITY_PLACEHOLDERS,
    },
    required: BOTH('unsubscribeUrl'),
    englishOnly: false,
    codeWords: true,
    sample: { appName: 'Run Club', line: '@sam joined Run Club through your invite.', url: 'https://app.onhomeroom.com/#app/run-club', unsubscribeUrl: 'https://app.onhomeroom.com/mail/unsubscribe?sample=1' },
    values: (payload, t = english) => {
      const app = payload.appName ? clip(payload.appName, 80) : '';
      const line = inviteLine(payload, t);
      return { app, hasApp: !!app, line, subject: line.replace(/\.$/, ''), ...activityValues(payload) };
    },
    htmlValues: (payload, t = english) => ({ line: wordsToHtml(inviteLine(payload, t, markSender)) }),
    headers: activityHeaders,
  },

  project_opened: {
    label: 'Project opened',
    placeholders: {
      app: text('The project\'s name, at most 80 characters, when known'),
      hasApp: flag('True when the project is named'),
      ...ACTIVITY_PLACEHOLDERS,
    },
    required: BOTH('unsubscribeUrl'),
    englishOnly: false,
    sample: { appName: 'Run Club', url: 'https://app.onhomeroom.com/#app/run-club', unsubscribeUrl: 'https://app.onhomeroom.com/mail/unsubscribe?sample=1' },
    values: (payload) => {
      const app = payload.appName ? clip(payload.appName, 80) : '';
      return { app, hasApp: !!app, ...activityValues(payload) };
    },
    headers: activityHeaders,
  },
};

// Own properties only, so a kind named "constructor" is not an action.
function actionFor(kind) {
  return Object.hasOwn(ACTIONS, kind) ? ACTIONS[kind] : null;
}

module.exports = { ACTIONS, actionFor };
