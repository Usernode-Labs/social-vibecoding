'use strict';

// The payloads every email action is rendered with in
// tests/mail-seed-equivalence.test.js, and that
// tests/fixtures/mail-snapshot-english.json was taken with. The snapshot keeps
// one hash per row in this order, so a row of a kind it holds is never added,
// removed or reordered; the test checks each such kind's rows are still the ones
// it was taken with. A new kind adds its own entry, or none.

const { PRODUCTION_ORIGIN } = require('../../src/services/cli-auth-constants');

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
// A header's worth of line break and a double space, which a translated mail's
// subject has cleaned out of it and an English one does not.
const BROKEN = 'A  B\nBcc: x@y.z';

const CODES = ['123456', '<&>"9', 654321];

// No value has an apostrophe: the seeds escape one in a value as &#39;, where
// the code they replaced left it bare (see WITH_APOSTROPHE).
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
    targetLabel: [undefined, NASTY, LONG, BROKEN],
    reporter: [undefined, 'sam'],
    caseId: [undefined, 0, 12],
    reportId: [undefined, 0, 34],
    detail: [undefined, '  ', 'line one\nline <two> & "three"  '],
    url: [undefined, URL_AWKWARD],
  }),
  project_invite: cross({
    inviter: [undefined, '', 'sam', NASTY, BROKEN],
    project: [undefined, '', 'Run Club', NASTY, BROKEN],
    url: [undefined, '', URL_PLAIN, URL_AWKWARD],
  }),
  build_ready: cross({
    appName: [undefined, '', 'Plant Pal', NASTY, LONG, BROKEN],
    lead: [undefined, '', '   ', '  Dark mode is ready.  ', 12, NASTY, LONG],
    subject: [undefined, '  ', ' Dark mode · Plant Pal ', 12, NASTY, LONG],
    notWorking: [undefined, true],
    url: [undefined, URL_AWKWARD],
    unsubscribeUrl: [undefined, '', UNSUBSCRIBE],
  }),
  invite_activity: cross({
    appName: [undefined, '', 'Run Club', NASTY, LONG, BROKEN],
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
    appName: [undefined, '', 'Run Club', NASTY, LONG, BROKEN],
    url: [undefined, URL_AWKWARD],
    unsubscribeUrl: [undefined, '', UNSUBSCRIBE],
  }),
};

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

// The tracked rows of the snapshot were rendered with these.
const TRACKING_SECRET = 'only-for-tests';
const TRACKED = { trackingEnabled: true, messageId: 'a'.repeat(48) };

// A rendered message as one string, keys sorted at every depth, so two messages
// that are deepEqual give the same text whatever order their keys were built in.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Eight base64url characters (48 bits) of the message's sha256: a row's hash is
// only ever compared with the same row's, so this is plenty.
function digest(message) {
  return require('node:crypto').createHash('sha256').update(canonical(message)).digest('base64url').slice(0, 8);
}

// One kind's rows, hashed: the snapshot pins each kind's rows it was taken with.
const matrixHash = (kind) => require('node:crypto').createHash('sha256').update(canonical(MATRIX[kind])).digest('hex');

module.exports = {
  MATRIX, WITH_APOSTROPHE, APOSTROPHE, TRACKING_SECRET, TRACKED,
  URL_PLAIN, URL_AWKWARD, UNSUBSCRIBE, NASTY, LONG, BROKEN,
  canonical, digest, matrixHash,
};
