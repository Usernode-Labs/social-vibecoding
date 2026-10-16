// Platform outbound SMS — src/services/sms/.
//
// The phone twin of tests/platform-mail.test.js, and pointed at the same
// three properties, because the same constraints hold:
//
//  - provider SELECTION, including the two that are safety rules rather
//    than preferences: a staging preview can never reach a real carrier
//    (it runs against a clone of production data, so it holds real
//    numbers), and production never falls back to logging (which would
//    print waitlist codes into the production log).
//  - the OUTBOUND THROTTLE. The waitlist join is unauthenticated and
//    always-200, and its express limiter is keyed by IP, so without a
//    per-RECIPIENT cap a distributed caller can aim unbounded texts at one
//    number using the platform as the amplifier.
//  - the one-segment ceiling on every body, which is what stops a code
//    arriving after the sentence that explains it.
//
// Run with: node --test tests/platform-sms.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const select = require(path.join(ROOT, 'src/services/sms/select.js'));
const rateLimit = require(path.join(ROOT, 'src/services/sms/rate-limit.js'));
const templates = require(path.join(ROOT, 'src/services/sms/templates.js'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─── selection ──────────────────────────────────────────────────────────

const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'test-token',
  PLATFORM_SMS_FROM: '+18005550100',
};
const HTTP_ENV = {
  TOPOCHAIN_SMS_API_URL: 'https://sms.example.invalid/send',
  TOPOCHAIN_SMS_API_KEY: 'test-key',
  TOPOCHAIN_SMS_FROM: '+18005550100',
};

test('a staging preview ALWAYS logs, even with a carrier configured', () => {
  // The single most important rule here. A staging preview is a clone of
  // production data, so reaching a real carrier would text real people
  // from a branch nobody has voted on.
  const chosen = select.chooseTransport({
    ...TWILIO_ENV, ...HTTP_ENV,
    USERNODE_ENV: 'staging',
    PLATFORM_SMS_PROVIDER: 'twilio', // an explicit request is overridden too
  });
  assert.equal(chosen.provider, 'log');
  assert.equal(chosen.stagingLogOnly, true);
  assert.ok(chosen.transport, 'staging still has a transport — it just logs');
});

test('auto prefers twilio, falls back to http', () => {
  assert.equal(select.chooseTransport({ ...TWILIO_ENV, ...HTTP_ENV }).provider, 'twilio');
  assert.equal(select.chooseTransport({ ...HTTP_ENV }).provider, 'http');
});

test('production with nothing configured sends nothing rather than logging', () => {
  // Falling back to the log transport in production would print waitlist
  // codes into the production log. Null is what makes the loud error fire.
  const chosen = select.chooseTransport({ USERNODE_ENV: 'production' });
  assert.equal(chosen.transport, null);
  assert.equal(chosen.provider, null);
});

test('an explicitly named provider is never silently downgraded', () => {
  // An operator who wrote PLATFORM_SMS_PROVIDER=twilio wants to find out it
  // is misconfigured, not to be quietly moved onto another provider.
  const chosen = select.chooseTransport({ ...HTTP_ENV, PLATFORM_SMS_PROVIDER: 'twilio' });
  assert.equal(chosen.transport, null);
  assert.equal(chosen.provider, null);
  assert.equal(chosen.requested, 'twilio');
});

test('a partially configured provider is not a candidate', () => {
  const partial = { ...TWILIO_ENV };
  delete partial.TWILIO_AUTH_TOKEN;
  // Falls THROUGH to http rather than building a half-working twilio.
  assert.equal(select.chooseTransport({ ...partial, ...HTTP_ENV }).provider, 'http');
});

test('a twilio send can be named by a Messaging Service SID, and still needs its SID and token', () => {
  // SID + token + a messaging service is a complete config without a From.
  const completeNoFrom = {
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'test-token',
    TWILIO_MESSAGING_SERVICE_SID: 'MGtest',
  };
  assert.equal(select.chooseTransport({ ...completeNoFrom }).provider, 'twilio');
});

test('the committed default sender is the single platform number', () => {
  assert.equal(select.DEFAULT_FROM, '+18005550100');
  // A fresh deploy that set nothing still has a correct From.
  assert.equal(select.resolveFrom({}), select.DEFAULT_FROM);
  // PLATFORM_SMS_FROM wins when set.
  assert.equal(select.resolveFrom({ PLATFORM_SMS_FROM: '+15550001111' }), '+15550001111');
});

test('an unrecognised PLATFORM_SMS_PROVIDER degrades to auto, not to nothing', () => {
  const chosen = select.chooseTransport({ ...HTTP_ENV, PLATFORM_SMS_PROVIDER: 'twillio' });
  assert.equal(chosen.provider, 'http', 'a typo must not stop all texts');
});

test('describe() reports staging honestly and never a value', () => {
  const d = select.describe({ ...TWILIO_ENV, USERNODE_ENV: 'staging' });
  assert.equal(d.stagingLogOnly, true);
  assert.equal(d.configured, false,
    'nothing is delivered, so the card must not read as configured');
  assert.equal(d.provider, 'log');
  // Presence only. The SID and the token must not leak through the shape
  // an admin card renders.
  const serialized = JSON.stringify(d);
  assert.doesNotMatch(serialized, /ACtest/);
  assert.doesNotMatch(serialized, /test-token/);
  // The sender number IS public (it is on every text), so it is allowed.
  assert.equal(d.from, '+18005550100');
});

test('describe() marks a provider configured only when its keys are all present', () => {
  const d = select.describe({ ...TWILIO_ENV });
  assert.equal(d.configured, true);
  assert.equal(d.provider, 'twilio');
  const partial = select.describe({ ...TWILIO_ENV, TWILIO_AUTH_TOKEN: '' });
  const twilio = partial.providers.find((p) => p.name === 'twilio');
  assert.equal(twilio.configured, false);
  assert.ok(twilio.missing.includes('TWILIO_AUTH_TOKEN'));
});

// ─── the throttle ───────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const ago = (ms) => new Date(T0 - ms);

test('a second requested code within a minute is suppressed; a later one is not', () => {
  const history = [{ status: 'sent', created_at: ago(10_000) }];
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: history,
  }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: [{ status: 'sent', created_at: ago(90_000) }],
  }).allowed, true);
});

test('one number cannot be made to receive more than ten codes a day', () => {
  // The text-bomb case: the express limiter is keyed by IP, so this is the
  // only cap that survives a distributed caller.
  const nine = Array.from({ length: 9 }, (_, i) => ({
    status: 'sent', created_at: ago((i + 2) * 60 * 60 * 1000),
  }));
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: nine,
  }).allowed, true, 'the tenth of the day is allowed');
  const d = rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0,
    recipientHistory: [...nine, { status: 'sent', created_at: ago(11 * 60 * 60 * 1000) }],
  });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /already sent/);
  assert.ok(d.retryAfterMs > 0);
  assert.equal(rateLimit.RULES.waitlist_code_sms.windowMs, 24 * 60 * 60 * 1000);
});

test('failed and suppressed attempts do not consume a recipient budget', () => {
  // Otherwise one broken carrier call would lock a number out of the retry
  // that would have worked.
  const history = Array.from({ length: 9 }, () => ({
    status: 'failed', created_at: ago(120_000),
  }));
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: history,
  }).allowed, true);
  const suppressed = [{ status: 'suppressed_rate_limit', created_at: ago(1_000) }];
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: suppressed,
  }).allowed, true);
});

test('a staging log-only send DOES consume budget', () => {
  // So a staging preview exercises the identical throttle it will meet in
  // production, instead of behaving more permissively than the real thing.
  const history = [{ status: 'skipped_staging', created_at: ago(1_000) }];
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: history,
  }).allowed, false);
});

test('a waitlist welcome goes out once a day per number', () => {
  assert.equal(rateLimit.decide({
    kind: 'waitlist_joined_sms', now: T0,
    recipientHistory: [{ status: 'sent', created_at: ago(3 * 60 * 60 * 1000) }],
  }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'waitlist_joined_sms', now: T0,
    recipientHistory: [{ status: 'sent', created_at: ago(25 * 60 * 60 * 1000) }],
  }).allowed, true);
});

test('a requested code is not swallowed by the welcome text\'s daily cap', () => {
  // The bug the separate kind exists to prevent: reusing the join kind for a
  // resend means the second send of the day is recorded suppressed and
  // silently dropped, which is precisely the situation somebody pressing
  // "send a new code" is already in.
  const joined = [{ status: 'sent', created_at: new Date(T0 - 2 * 60 * 1000) }];
  assert.equal(rateLimit.decide({
    kind: 'waitlist_joined_sms', now: T0, recipientHistory: joined,
  }).allowed, false);
  assert.equal(rateLimit.decide({
    kind: 'waitlist_code_sms', now: T0, recipientHistory: joined,
  }).allowed, true, 'a different kind keeps its own history');
});

test('the global hourly ceiling refuses every kind once it is reached', () => {
  const d = rateLimit.decide({
    kind: 'waitlist_released_sms', now: T0, recipientHistory: [], globalCount: 200,
  });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /global cap/);
});

test('a release text is a backstop, not a normal path: three a day per number', () => {
  // Sent once per signup by construction (newly_released), so this only
  // catches a stuck admin button.
  assert.equal(rateLimit.RULES.waitlist_released_sms.perWindow, 3);
});

// ─── templates ──────────────────────────────────────────────────────────

test('every body stays inside one SMS segment', () => {
  // A body that splits is billed twice and, worse, the two halves can
  // arrive out of order, so a code lands after the sentence introducing it.
  const bodies = [
    templates.buildBody('waitlist_joined_sms', { code: '123456' }),
    templates.buildBody('waitlist_joined_sms', {}),
    templates.buildBody('waitlist_code_sms', { code: '123456' }),
    templates.buildBody('waitlist_released_sms', { url: 'https://app.onhomeroom.com/?signup=1' }),
    templates.buildBody('waitlist_released_sms', { hasAccount: true, url: 'https://app.onhomeroom.com/?login=1' }),
  ];
  for (const body of bodies) {
    assert.ok(body.length <= templates.MAX_SEGMENT_CHARS,
      `body over one segment (${body.length}): ${body}`);
  }
});

test('the code text carries the six digits and nothing to misread', () => {
  assert.match(templates.buildBody('waitlist_code_sms', { code: '042918' }), /042918/);
});

test('a welcome with no code does not grow an empty code line', () => {
  const body = templates.buildBody('waitlist_joined_sms', {});
  assert.doesNotMatch(body, /undefined/);
  assert.doesNotMatch(body, /code is \./);
});

test('an unknown kind throws rather than sending a blank text', () => {
  assert.throws(() => templates.buildBody('whatever', {}), /unknown sms kind/);
});

// ─── The phone join screen is photographable ─────────────────────────────

test('the phone-channel join screen is reachable by URL for a screenshot', () => {
  // A capture can only navigate, so the channel switch and the phone field
  // need a shot of their own. `?shot=waitlist-phone` boots the anonymous
  // shell and paints the phone channel; without it the before/after images
  // of this change would both photograph the landing page.
  const APP = read('public/js/app.js');
  const WAITLIST = read('frontend/src/features/auth/waitlist.tsx');
  const DAPP = JSON.parse(read('dapp.json'));

  assert.match(APP, /shot !== 'waitlist-phone'/, 'the shot is not allowlisted in app.js');
  assert.match(APP, /shot === 'waitlist-phone'/, 'the hash is not normalised to #waitlist');
  assert.match(WAITLIST, /const shotPhone = shot === 'waitlist-phone';/);

  // And a declared check points at it, so a deep link that stops rendering
  // the switch fails checks instead of silently regressing to the landing.
  const shot = DAPP.tests.filter((t) => t.path === '/?shot=waitlist-phone');
  assert.ok(shot.length > 0, 'the phone join state is unchecked');
  const selectors = shot.map((t) => t.expectSelector).join(' ');
  assert.match(selectors, /#waitlist-channel-phone/);
  assert.match(selectors, /#waitlist-phone/);
});
