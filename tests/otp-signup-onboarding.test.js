// QA 2026-09-24 Q12: "Sign in with an email code" for an address with no
// account used to create one silently. After the code it said "Code verified.
// Now choose a password for your account.", then dropped the person in the
// waiting room under a handle they never chose ("Your account qaflowfive
// doesn't have platform access yet"). Nothing said an account was being made,
// or that there was a waitlist.
//
// Now /api/auth/otp/verify reports what it did (additive fields, pinned
// against real PostgreSQL in tests/email-signup-postgres.test.js), and the
// set-password step:
//   * says the code created the account,
//   * asks for the username, prefilled with the suggestion, and sends it with
//     the password (the first-run gate's rules and endpoint semantics),
//   * says plainly, before the waiting room, that new accounts join a
//     waitlist.
//
// Run with: node --test tests/otp-signup-onboarding.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const LOGIN = read('frontend/src/features/auth/login.tsx');
const AUTH = read('src/routes/auth.js');
const SIGNUP = read('src/services/email-signup.js');

test('the verify answer says what happened, additively', () => {
  const route = AUTH.slice(AUTH.indexOf("router.post('/api/auth/otp/verify'"));
  assert.match(route, /next: 'set-password',\s+created: !!verified\.created,\s+needsUsername: !!verified\.needsUsernameChoice,\s+suggestedUsername: verified\.suggestedUsername \|\| null,\s+waitlisted:/);
  // Read after linkUserByEmail, which releases an address the waitlist already let in.
  assert.ok(SIGNUP.indexOf('result.waitlisted = await isWaitlisted') > SIGNUP.indexOf('await waitlist.linkUserByEmail'));
});

test('the password step says the account is new, and asks for its handle', () => {
  assert.match(LOGIN, /"Code verified\. No account uses this email yet, so we'll create one\. Choose a username and a password\."/);
  assert.match(LOGIN, /otpSignup\?\.created\s+\? OTP_PASSWORD_INTRO_NEW/);
  const field = LOGIN.slice(LOGIN.indexOf('id="otp-username"'), LOGIN.indexOf('id="otp-username-hint"'));
  assert.match(field, /\{\.\.\.HANDLE_FIELD\}/, 'no auto-capitalising a handle');
  assert.match(field, /defaultValue=\{otpSignup\.suggestedUsername \|\| ''\}/, 'prefilled with the suggestion');
  assert.match(LOGIN, /\{otpSignup\?\.needsUsername \? \(/, 'only when the account still owes a choice');
  // The handle rides with the password, and a refusal lands under the field.
  assert.match(LOGIN, /\.\.\.\(handle \? \{ username: handle \} : \{\}\)/);
  assert.match(LOGIN, /if \(data\.field === 'username' && data\.error\) \{\s+setOtpUsernameError\(data\.error\);/);
});

test('the waitlist is named before the waiting room, not by it', () => {
  assert.match(LOGIN, /"New accounts join a short waitlist\. After this step you'll wait in the queue, and you'll get in automatically when it's your turn\."/);
  assert.match(LOGIN, /\{otpSignup\?\.waitlisted \? \(\s+<p id="otp-waitlist-note"/);
});

test('set-password spends the signup session only on a name it accepts', () => {
  const complete = SIGNUP.slice(SIGNUP.indexOf('async function completePassword'));
  const check = complete.indexOf('usernames.checkAvailability(client, chosen, signup.user_id)');
  const spend = complete.indexOf('DELETE FROM web_signup_sessions');
  assert.ok(check > 0 && check < spend, 'availability is checked before the session is deleted');
  assert.match(complete, /usernames\.chooseFirstUsername\(client, signup\.user_id, chosen\)/,
    'the same needs_username_choice-guarded write as the first-run gate');
  const route = AUTH.slice(AUTH.indexOf("router.post('/api/auth/otp/set-password'"));
  assert.match(route, /error\.code === 'invalid_username' \|\| error\.code === 'username_taken'\) \{\s+return res\.status\(422\)\.json\(\{ error: error\.message, code: error\.code, field: 'username' \}\);/,
    'and the route keeps the signup cookie for a username refusal');
});
