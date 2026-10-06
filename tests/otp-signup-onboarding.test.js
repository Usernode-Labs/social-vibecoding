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
//   * asks for the username and sends it with the password (the first-run
//     gate's rules and endpoint semantics),
//   * says plainly, before the waiting room, that new accounts join a
//     waitlist.
//
// #3575 changed the second point twice over. The field used to arrive
// prefilled with a handle derived from the address, and was optional: one
// press of "Create account" signed up under a username generated from the
// email. Now it starts EMPTY, says beside it "Your username will be public to
// other users on Homeroom.", and the server refuses to finish without it.
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

test('the verify answer says what happened, additively, and suggests no name', () => {
  const route = AUTH.slice(AUTH.indexOf("router.post('/api/auth/otp/verify'"));
  assert.match(route, /next: 'username',\s+created: !!verified\.created,\s+needsUsername: !!verified\.needsUsernameChoice,\s+waitlisted:/);
  // #3575: the email-derived suggestion is gone from the answer and the service.
  assert.doesNotMatch(route.slice(0, route.indexOf("router.post(['/api/auth/otp/finish'")),
    /suggestedUsername: verified/);
  assert.doesNotMatch(SIGNUP, /suggestedUsername/);
  // Read after linkUserByEmail, which releases an address the waitlist already let in.
  assert.ok(SIGNUP.indexOf('result.waitlisted = await isWaitlisted') > SIGNUP.indexOf('await waitlist.linkUserByEmail'));
});

test('the username step says the account is new, and asks for its handle with an empty field', () => {
  assert.match(LOGIN, /"Code verified\. No account uses this email yet, so we'll create one\. Choose a username\."/);
  assert.match(LOGIN, /\{otpSignup\?\.created \? OTP_USERNAME_INTRO_NEW : OTP_USERNAME_INTRO\}/);
  const field = LOGIN.slice(LOGIN.indexOf('id="otp-username"'), LOGIN.indexOf('id="otp-username-hint"'));
  assert.match(field, /\{\.\.\.HANDLE_FIELD\}/, 'no auto-capitalising a handle');
  // #3575: nothing is put in the field for the person to accept.
  assert.doesNotMatch(field, /defaultValue=|data-username-suggested/, 'the field starts empty');
  assert.doesNotMatch(LOGIN, /suggestedUsername/);
  // Beside it, who will see it; then the rule, or the server's refusal.
  assert.match(field, /aria-describedby="otp-username-public otp-username-hint"/);
  assert.match(field, /<p id="otp-username-public" className=\{FIELD_HINT\}>\s*\{USERNAME_PUBLIC_NOTE\}\s*<\/p>/);
  assert.match(LOGIN, /\{otpUsernameError \|\| USERNAME_RULE\}/);
  // The handle is all the step sends (no password: the code signs the
  // account in every time), an empty field is caught before the round trip,
  // and a refusal lands under the field.
  assert.match(LOGIN, /if \(!handle\) \{\s+setOtpUsernameError\('Enter a username\.'\);/);
  assert.match(LOGIN, /fetchSessionMint\('\/api\/auth\/otp\/finish', \{[\s\S]{0,160}body: JSON\.stringify\(\{ username: handle \}\),/);
  assert.doesNotMatch(LOGIN, /id="otp-new-password"|id="otp-confirm-password"/);
  assert.match(LOGIN, /if \(data\.field === 'username' && data\.error\) \{\s+setOtpUsernameError\(data\.error\);/);
});

test('the waitlist is named before the waiting room, not by it', () => {
  assert.match(LOGIN, /"New accounts join a short waitlist\. After this step you'll wait in the queue, and you'll get in automatically when it's your turn\."/);
  assert.match(LOGIN, /\{otpSignup\?\.waitlisted \? \(\s+<p id="otp-waitlist-note"/);
});

test('the username step spends the signup session only on a name it accepts', () => {
  const complete = SIGNUP.slice(SIGNUP.indexOf('async function completeSignup'));
  const required = complete.indexOf('return { usernameRequired: true };');
  const check = complete.indexOf('usernames.checkAvailability(client, chosen, signup.user_id)');
  const spend = complete.indexOf('DELETE FROM web_signup_sessions');
  assert.ok(required > 0 && required < spend, 'a missing name is refused before the session is deleted');
  assert.ok(check > 0 && check < spend, 'availability is checked before the session is deleted');
  assert.match(complete, /usernames\.chooseFirstUsername\(client, signup\.user_id, chosen\)/,
    'the same needs_username_choice-guarded write as the first-run gate');
  const route = AUTH.slice(AUTH.indexOf("router.post(['/api/auth/otp/finish', '/api/auth/otp/set-password']"));
  assert.match(route, /error\.code === 'invalid_username' \|\| error\.code === 'username_taken'\s+\|\| error\.code === 'username_required'\) \{\s+return res\.status\(422\)\.json\(\{ error: error\.message, code: error\.code, field: 'username' \}\);/,
    'and the route keeps the signup cookie for every username refusal');
});
