// QA 2026-09-24 Q12: "Sign in with an email code" for an address with no
// account used to create one silently. After the code it said "Code verified.
// Now choose a password for your account.", then dropped the person in the
// waiting room under a handle they never chose ("Your account qaflowfive
// doesn't have platform access yet"). Nothing said an account was being made,
// or that there was a waitlist.
//
// Now /api/auth/otp/verify reports what it did (additive fields, pinned
// against real PostgreSQL in tests/email-signup-postgres.test.js), and the
// account step (the sign-in sheet's, since the sheet became the one sign-in):
//   * says the code created the account,
//   * asks for the username and sends it (the first-run gate's rules and
//     endpoint semantics), and, since #4891, no password: the account signs
//     in with an emailed code and adds a password in Settings,
//   * says plainly, before the waiting room, that new accounts join a
//     waitlist.
//
// #3575 changed the second point twice over. The field used to arrive
// prefilled with a handle derived from the address, and was optional: one
// press of "Create account" signed up under a username generated from the
// email. Now it starts EMPTY, says beside it "Your username will be public to
// other users on Homeroom.", and the server refuses to finish without it.
// #4596 brought the prefill back for this step, on purpose: the field arrives
// holding the letters and digits before the @ and any "+" (#4891; made free
// by a number when taken), the person can change it, and it is still
// required.
//
// Run with: node --test tests/otp-signup-onboarding.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SHEET = read('frontend/src/features/auth/sign-in-sheet.tsx');
const AUTH = read('src/routes/auth.js');
const SIGNUP = read('src/services/email-signup.js');

test('the verify answer says what happened, additively, and suggests a name from the address', () => {
  // The code's answer and the release link's (#4594) are one: answerProvenEmail.
  const route = AUTH.slice(AUTH.indexOf('async function answerProvenEmail'));
  // #4596 (overturning #3575 for this step): a suggestion made from the
  // address, only for an account that still owes its handle (null when
  // none fits), and absent otherwise.
  assert.match(route, /next: 'set-password',\s+created: !!verified\.created,\s+needsUsername: !!verified\.needsUsernameChoice,\s+\.\.\.\(verified\.needsUsernameChoice \? \{ suggestedUsername: verified\.suggestedUsername \|\| null \} : \{\}\),\s+waitlisted:/);
  assert.match(SIGNUP, /if \(result\.next === 'set-password' && result\.needsUsernameChoice\) \{\s*result\.suggestedUsername = await suggestedUsername\(pool, email, result\.userId\);/);
  // Best effort: a failed read is an empty field, never a failed code.
  const helper = SIGNUP.slice(SIGNUP.indexOf('async function suggestedUsername'));
  assert.match(helper, /try \{\s*return await usernames\.suggestUsernameForEmail\(pool, email, userId\);\s*\} catch \(error\) \{[\s\S]*?return null;/);
  // Read after linkUserByEmail, which releases an address the waitlist already let in.
  assert.ok(SIGNUP.indexOf('result.waitlisted = await isWaitlisted') > SIGNUP.indexOf('await waitlist.linkUserByEmail'));
  // #4083: a waiting account gets its own spot, after the link (which lets a
  // released address in) and before the waiting state is read.
  const spot = SIGNUP.indexOf('await waitlist.ensureAccountSignup(pool, { userId: result.userId })');
  assert.ok(spot > SIGNUP.indexOf('await waitlist.linkUserByEmail'));
  assert.ok(spot < SIGNUP.indexOf('result.waitlisted = await isWaitlisted'));
});

test('the account step says the account is being made, and asks for its handle with the suggestion in the field', () => {
  // The sign-in sheet's account step (the one sign-in since the full-page
  // sign-in screen went): titled for the choice, the field holding the
  // server's suggestion, who sees the name, and the rule.
  assert.match(SHEET, /needsUsername && !welcome \? t\('auth:signInSheet\.account\.titleUsername'\)/);
  assert.equal(message('auth:signInSheet.account.titleUsername'), 'Pick your username');
  assert.match(SHEET, /\(needsUsername \? t\('auth:signInSheet\.account\.leadPublic'\) : ''\)/);
  assert.match(message('auth:signInSheet.account.leadPublic'), /^Everyone on Homeroom sees it/);
  const field = SHEET.slice(SHEET.indexOf('id="sign-in-sheet-username"'), SHEET.indexOf('id="sign-in-sheet-username-check"'));
  assert.match(field, /\{\.\.\.HANDLE_FIELD\}/, 'no auto-capitalising a handle');
  // #4596: the field arrives holding the server's suggestion ('' for none),
  // and stays the person's to change.
  assert.match(field, /defaultValue=\{suggestedUsername\}/);
  assert.match(SHEET, /const suggested = typeof data\.suggestedUsername === 'string' \? data\.suggestedUsername : '';/);
  assert.doesNotMatch(field, /readOnly/);
  assert.match(SHEET, /\{t\('auth:signInSheet\.account\.rules'\)\}/);
  assert.match(SHEET, /\{needsUsername \? \(\s+<>/, 'only when the account still owes a choice');
  // An empty field is caught before the round trip, and a refusal names the field.
  assert.match(SHEET, /if \(handle === ''\) \{ setError\(translate\('auth:signInSheet\.account\.usernameMissing'\)\);/);
  assert.equal(message('auth:signInSheet.account.usernameMissing'), 'Enter a username.');
  assert.match(SHEET, /\.\.\.\(handle \? \{ username: handle \} : \{\}\)/);
  assert.match(SHEET, /if \(saved\.field === 'username'\) usernameField\.current\?\.focus/);
});

test('the account step asks for no password, and says how they sign in (#4891)', () => {
  const step = SHEET.slice(SHEET.indexOf("{step === 'account' ? ("), SHEET.indexOf('{error ? (', SHEET.indexOf("{step === 'account' ? (")));
  assert.ok(step.length > 0, 'the step renders');
  assert.doesNotMatch(step, /PasswordInput|new-password/);
  // The request carries the handle and, only when ticked, the sign-up
  // form's "Homeroom news by email" box (#6044); never a password.
  const save = SHEET.slice(SHEET.indexOf('export async function saveAccount('), SHEET.indexOf('export function linkSigningIn('));
  assert.match(save, /\.\.\.\(handle \? \{ username: handle \} : \{\}\),/);
  assert.match(save, /\.\.\.\(optIns\.marketingEmail \? \{ marketingEmail: true \} : \{\}\),/);
  assert.doesNotMatch(save, /password:|passwordConfirmation/);
  // In the password's place, how they sign in and where a password is added.
  assert.match(step, /<p data-sign-in-sheet-code-note="" className="text-\[13px\] text-zinc-500 dark:text-zinc-400">\{t\('auth:signInSheet\.account\.codeNote'\)\}<\/p>/);
  assert.equal(message('auth:signInSheet.account.codeNote'),
    'You sign in with a code we email you. You can add a password later in Settings.');
});

test('the waitlist is named before the waiting room, not by it', () => {
  // The verify answer says whether the new account will wait; the account
  // step says so under its button, and only then.
  assert.match(SHEET, /setWaitlisted\(data\.waitlisted === true\);/);
  assert.match(SHEET, /\{waitlisted \? \(\s+<p data-sign-in-sheet-waitlist-note=""/);
  assert.equal(message('auth:signInSheet.account.waitlistNote'), 'New accounts get a spot on the waitlist. We’re letting people in a few at a time.');
  assert.doesNotMatch(message('auth:signInSheet.account.waitlistNote'), /in the queue|your turn/);
});

test('set-password spends the signup session only on a name it accepts', () => {
  const complete = SIGNUP.slice(SIGNUP.indexOf('async function completePassword'));
  const required = complete.indexOf('return { usernameRequired: true };');
  const check = complete.indexOf('usernames.checkAvailability(client, chosen, signup.user_id)');
  const spend = complete.indexOf('DELETE FROM web_signup_sessions');
  assert.ok(required > 0 && required < spend, 'a missing name is refused before the session is deleted');
  assert.ok(check > 0 && check < spend, 'availability is checked before the session is deleted');
  assert.match(complete, /usernames\.chooseFirstUsername\(client, signup\.user_id, chosen\)/,
    'the same needs_username_choice-guarded write as the first-run gate');
  const route = AUTH.slice(AUTH.indexOf("router.post('/api/auth/otp/set-password'"));
  assert.match(route, /error\.code === 'invalid_username' \|\| error\.code === 'username_taken'\s+\|\| error\.code === 'username_required'\) \{\s+return res\.status\(422\)\.json\(\{ error: error\.message, code: error\.code, field: 'username' \}\);/,
    'and the route keeps the signup cookie for every username refusal');
});
