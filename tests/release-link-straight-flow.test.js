'use strict';

// A "You're in" mail's link for a new account, straight to "Signing you
// in…" and the full-page Welcome (Evan, 12 Oct 2026, from the hand-drawn
// boards; follows #4898 and #4908).
//
//   * As the page opens with `/?signup=1&t=<token>&key=<one-time link>`, the
//     story is not shown: "Signing you in…" is up from the first frame
//     (landing.tsx `straightLink`, committed in flushSync before the router
//     reveals the screen), while the story's lookup of the address
//     (GET /api/public/waitlist/more/:token, which spends nothing) says
//     whether the account is still new (`new_account`).
//   * Only then is the link spent, and with `newAccountOnly`, which the
//     server answers with the account step alone: an account already set up
//     is refused, its link unspent and no session made, so a mail scanner or
//     an app's own browser that runs the page can never sign it in
//     (tests/release-link-postgres.test.js runs that against the schema).
//     An account already set up gets the story, and its link still waits
//     for Get started.
//   * Spent: the Welcome as a page of its own, in the make screen's frame
//     (welcome-page.tsx). Refused as used or expired: the story with Get
//     started, no code on load; Get started sends the code, and the right
//     code leads to the same full-page Welcome.
//
// Effects do not run here (tests/lib/render-tsx.js), so the decisions are
// plain functions and the wiring is read from the sources.
//
// Run with: node --test tests/release-link-straight-flow.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { message } = require('./lib/platform-i18n');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const LANDING = 'frontend/src/features/auth/landing.tsx';
const SHEET = 'frontend/src/features/auth/sign-in-sheet.tsx';
const LOGIN = 'frontend/src/features/auth/login.tsx';
const WELCOME = 'frontend/src/features/auth/welcome-page.tsx';
const MAKE = 'frontend/src/features/first-session/make.tsx';

const KEY = 'K'.repeat(43);
const NEW_LINK = { route: 'signup', token: 'AbC_def-123456', signIn: KEY };

/** Run `fn` with these globals in place, and put the old ones back after. */
async function withGlobals(globals, fn) {
  const prior = {};
  for (const key of Object.keys(globals)) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(globals)) {
      if (prior[key]) Object.defineProperty(globalThis, key, prior[key]);
      else delete globalThis[key];
    }
  }
}

/** A fetch that answers from `routes` (url → [status, body]) and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const answer = typeof routes === 'function' ? routes(url, init) : routes[url];
    const [status, body] = answer || [404, {}];
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

// ─── deciding: spent on load only for a new account ─────────────────────

test('only a new account\'s link, with its token and its one-time sign-in, holds the page for the check', () => {
  const { straightLink } = loadTsx(LANDING);
  assert.equal(straightLink(NEW_LINK), true);
  assert.equal(straightLink({ ...NEW_LINK, signIn: null }), false, 'no one-time sign-in: the story, as before');
  assert.equal(straightLink({ ...NEW_LINK, token: null }), false, 'nothing to check it with');
  assert.equal(straightLink({ route: 'login', token: null, signIn: null }), false, 'an existing account opens Sign in');
  assert.equal(straightLink(null), false);
});

test('the link is spent on load only when the check says the account is new, and the story is on', () => {
  const { spendsOnLoad } = loadTsx(LANDING);
  const fresh = { email: 'ada@example.com', newAccount: true };
  assert.equal(spendsOnLoad({ link: NEW_LINK, account: fresh, options: {} }), true);
  assert.equal(spendsOnLoad({ link: NEW_LINK, account: fresh, options: null }), true, 'options that failed leave the story on');
  // An account already set up waits for Get started: the 10 Oct rule.
  assert.equal(spendsOnLoad({ link: NEW_LINK, account: { ...fresh, newAccount: false }, options: {} }), false);
  // A check that failed decides nothing, so nothing is spent.
  assert.equal(spendsOnLoad({ link: NEW_LINK, account: null, options: {} }), false);
  // The story switched off: the sign-in screen takes the link, as before.
  assert.equal(spendsOnLoad({ link: NEW_LINK, account: fresh, options: { story_landing: false } }), false);
  assert.equal(spendsOnLoad({ link: { ...NEW_LINK, signIn: null }, account: fresh, options: {} }), false);
});

test('a spend on load leads to the Welcome, or back to the story, and never signs anybody in', () => {
  const { afterLoadSpend } = loadTsx(LANDING);
  assert.deepEqual(
    afterLoadSpend({ next: 'set-password', email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' }),
    { email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' },
  );
  assert.equal(afterLoadSpend('refused'), 'used', 'used or expired: the story, and its Get started sends a code');
  // No answer, or the server's refusal of an account set up meanwhile: the
  // story with the link still unspent for Get started.
  assert.equal(afterLoadSpend(null), 'story');
  // `newAccountOnly` rules a session out on the server; were one ever
  // answered, it would still not be finished here.
  assert.equal(afterLoadSpend({ next: 'signed-in', email: 'ada@example.com', needsUsername: false, suggestedUsername: '' }), 'story');
  assert.doesNotMatch(read(LANDING).slice(read(LANDING).indexOf('export function afterLoadSpend')).split('\n}\n')[0], /finishLogin|finish\(/);
});

test('the check is a GET that reads `new_account` strictly, and spends nothing', async () => {
  const login = loadTsx(LOGIN);
  const fetch = fakeFetch({
    '/api/public/waitlist/more/New_token_0001': [200, { email: ' Ada@Example.com ', new_account: true }],
    '/api/public/waitlist/more/Set_token_0001': [200, { email: 'ben@example.com', new_account: false }],
    '/api/public/waitlist/more/Odd_token_0001': [200, { email: 'cy@example.com', new_account: 'true' }],
    '/api/public/waitlist/more/Old_token_0001': [200, { email: 'di@example.com' }],
    '/api/public/waitlist/more/Gone_token_000': [404, { error: 'Unknown or expired link.' }],
  });
  await withGlobals({ window: {}, fetch }, async () => {
    assert.deepEqual(await login.releaseAccountFromToken('New_token_0001'), { email: 'ada@example.com', newAccount: true });
    assert.deepEqual(await login.releaseAccountFromToken('Set_token_0001'), { email: 'ben@example.com', newAccount: false });
    assert.equal((await login.releaseAccountFromToken('Odd_token_0001')).newAccount, false, 'anything but true is not new');
    assert.equal((await login.releaseAccountFromToken('Old_token_0001')).newAccount, false, 'a server without the field: the story');
    assert.equal(await login.releaseAccountFromToken('Gone_token_000'), null);
    // The sign-in screen's own lookup is the same read.
    assert.equal(await login.inviteEmailFromToken('New_token_0001'), 'ada@example.com');
  });
  for (const call of fetch.calls) {
    assert.equal(call.init.method, undefined, 'a plain GET');
    assert.equal(call.init.body, undefined);
  }
});

test('the spend on load asks the server for a new account only; the sheet\'s spend does not', async () => {
  const sheet = loadTsx(SHEET);
  const fetch = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.newAccountOnly === true && body.token === 'S'.repeat(43)) {
      return [422, { error: 'This account is already set up. Tap Get started to sign in.', code: 'account_set_up' }];
    }
    return [200, { ok: true, next: 'set-password', email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' }];
  });
  await withGlobals({ window: {}, fetch }, async () => {
    assert.equal((await sheet.spendReleaseLink(KEY, { newAccountOnly: true })).next, 'set-password');
    // Set up meanwhile: no refusal of the link (it is unspent), the story.
    assert.equal(await sheet.spendReleaseLink('S'.repeat(43), { newAccountOnly: true }), null);
    await sheet.spendReleaseLink(KEY);
  });
  assert.deepEqual(fetch.calls.map((c) => [c.url, c.init.method, JSON.parse(c.init.body)]), [
    ['/api/auth/release-link', 'POST', { token: KEY, newAccountOnly: true }],
    ['/api/auth/release-link', 'POST', { token: 'S'.repeat(43), newAccountOnly: true }],
    ['/api/auth/release-link', 'POST', { token: KEY }],
  ]);
});

// ─── the wiring ─────────────────────────────────────────────────────────

test('the page holds on "Signing you in…" from its first frame, checks, and only then spends', () => {
  const src = read(LANDING);
  // Committed before AuthScreens.show() reveals the screen.
  assert.match(src, /import \{ flushSync \} from 'react-dom';/);
  const onShow = src.slice(src.indexOf('const landingOnShow = useCallback(() => {'), src.indexOf('}, [loadLandingApps, refreshHeader, runAnonBackShot, st]);'));
  assert.match(onShow, /flushSync\(\(\) => \{\s+setRelease\(link\);\s+setResume\(null\);\s+setHolding\(straightLink\(link\)\);/);
  // The check and the address in one read; the options for the story's switch.
  const effect = src.slice(src.indexOf("if (!release || release.route !== 'signup' || !release.token) return undefined;"), src.indexOf('}, [release]);'));
  assert.ok(effect.length > 0, 'the effect is there');
  const check = effect.indexOf('releaseAccountFromToken(token)');
  const decide = effect.indexOf('spendsOnLoad({ link, account, options })');
  const spend = effect.indexOf('spendReleaseLink(link.signIn!, { newAccountOnly: true })');
  assert.ok(check >= 0 && decide > check && spend > decide, 'look up, decide, then spend');
  assert.equal((effect.match(/spendReleaseLink\(/g) || []).length, 1);
  // Spent: the Welcome; used or expired: the story whose Get started sends a code.
  assert.match(effect, /if \(run !== straightRun\.current\) return;\s+if \(next === 'used'\) setReleaseUsed\(true\);\s+else if \(next !== 'story'\) setWelcome\(next\);\s+setHolding\(false\);/);
  // "Signing you in…" while it holds, and the story once it lets go.
  assert.match(src, /const signingInShown = holding \|\| sheetSigningIn;/);
  assert.match(src, /\{welcome \? <WelcomePage account=\{welcome\} beforeFinish=\{startedFromStory\} \/> : null\}\s+\{signingInShown \? <SigningIn \/> : null\}/);
  // Past SIGNING_IN_MAX_MS the story takes over, and a late answer changes nothing.
  assert.match(src, /const timer = window\.setTimeout\(\(\) => \{ straightRun\.current \+= 1; setHolding\(false\); \}, SIGNING_IN_MAX_MS\);/);
  // Its first render is the markup it always had: nothing held, nobody welcomed.
  assert.match(src, /const \[holding, setHolding\] = useState\(false\);\s+const \[welcome, setWelcome\] = useState<AccountStep \| null>\(null\);\s+const \[releaseUsed, setReleaseUsed\] = useState\(false\);/);
});

test('a used link\'s Get started sends the code, says why, and the right code leads to the full-page Welcome', () => {
  const landing = read(LANDING);
  // The story's sheet: no one-time sign-in to spend again, the reason for the
  // code, and the account handed to the page.
  assert.match(landing, /releaseSignIn=\{sheet === 'start' && !releaseUsed \? release\?\.signIn \?\? null : null\}\s+linkUsed=\{sheet === 'start' && releaseUsed\}\s+onAccount=\{sheet === 'start' && release\?\.route === 'signup' \? toWelcome : undefined\}/);
  assert.match(landing, /const toWelcome = useCallback\(\(account: AccountStep\) => \{\s+setWelcome\(account\);\s+setSheet\(null\);\s+setResume\(null\);\s+\}, \[\]\);/);
  const sheet = read(SHEET);
  // Opened with `linkUsed`, the code step says the link was used.
  assert.match(sheet, /setLinkRefused\(linkUsedRef\.current\);/);
  assert.match(sheet, /linkRefused \? t\('auth:signInSheet\.code\.leadLinkUsed', \{ email \}\)/);
  // Without its one-time sign-in the sheet fills in the address and sends the code.
  assert.match(sheet, /setStep\(releaseSignIn \? 'link' : 'email'\);/);
  // A right code that leaves the account to set up: the page, not the step.
  const verify = sheet.slice(sheet.indexOf('const verify = useCallback('), sheet.indexOf('const requestPhoneCode = useCallback('));
  assert.match(verify, /if \(data\.next === 'signed-in'\) \{\s+await finish\('existing'\);\s+return;\s+\}/);
  assert.match(verify, /if \(onAccountRef\.current\) \{\s+onAccountRef\.current\(\{ email, needsUsername: data\.needsUsername === true, suggestedUsername: suggested \}\);\s+return;\s+\}/);
  // And a link Get started spends (the story could not decide, or ran long).
  assert.match(sheet, /if \(spent\.next === 'signed-in'\) \{ await finishRef\.current\('existing'\); return; \}\s+if \(onAccountRef\.current\) \{\s+onAccountRef\.current\(\{ email: spent\.email, needsUsername: spent\.needsUsername, suggestedUsername: spent\.suggestedUsername \}\);\s+return;\s+\}/);
  // A sheet given no hand-off (an invite's Join, Sign in) keeps its own step.
  assert.match(sheet, /setStep\('account'\);/);
  assert.match(landing, /<SignInSheet\s+open=\{sheet === 'join'\}/);
  const join = landing.slice(landing.indexOf("open={sheet === 'join'}"), landing.indexOf('/>', landing.indexOf("open={sheet === 'join'}")));
  assert.doesNotMatch(join, /onAccount|releaseSignIn/);
});

// ─── the full-page Welcome ──────────────────────────────────────────────

test('the Welcome is a page in the make screen\'s frame: picture, eyebrow, heading, address, username, note, Continue, terms', () => {
  const html = renderComponent(WELCOME, 'WelcomePage', {
    account: { email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' },
    beforeFinish() { return true; },
  });
  // The make screen's root, over the landing, on the wallpaper.
  assert.match(html, /<div role="dialog" aria-labelledby="welcome-page-title" data-welcome-page="" class="platform-kb-surface fixed inset-0 z-\[60\] flex flex-col text-zinc-900 dark:text-zinc-100" style="background:var\(--home-wallpaper, #f4f2e4\)">/);
  // The wordmark bar, 24px, centred, at least 32px under the status bar.
  assert.match(html, /<div class="relative flex h-\[max\(52px,calc\(env\(safe-area-inset-top\)\+32px\)\)\] shrink-0 items-center justify-center pt-\[env\(safe-area-inset-top\)\] translate-y-6 opacity-0[^"]*"><svg class="h-6 w-auto text-zinc-950 dark:text-white"/);
  // The 384px column with the 16px gutter.
  assert.match(html, /<form class="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-\[max\(34px,env\(safe-area-inset-bottom\)\)\] /);
  // Top to bottom, in this order.
  const order = [
    /<img src="\/brand\/people\.png" alt="" width="816" height="612" draggable="false" class="mx-auto mt-4 block h-auto w-\[200px\] max-w-full"\/>/,
    /<p class="mt-4 text-\[13px\] font-semibold uppercase tracking-\[0\.8px\] text-zinc-500 dark:text-zinc-400">You(?:&#x27;|')re in<\/p>/,
    /<h1 id="welcome-page-title" class="mt-2\.5 text-balance text-\[30px\] font-extrabold leading-\[34px\]">Welcome to Homeroom<\/h1>/,
    /<p data-welcome-page-email="" class="mt-2 max-w-full text-\[15px\] leading-5 font-semibold text-zinc-700 dark:text-zinc-300 \[overflow-wrap:anywhere\]">ada@example\.com<\/p>/,
    /<p class="mt-6 pb-2 text-\[13px\] text-zinc-500 dark:text-zinc-400">Pick a username\. It is public on Homeroom\.<\/p>/,
    /<div class="overflow-hidden rounded-2xl bg-white shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] dark:bg-zinc-900">/,
    /<input id="welcome-page-username" autoComplete="username" enterKeyHint="go" class="[^"]*" placeholder="[^"]*" autoCapitalize="none" autoCorrect="off" spellCheck="false" value="ada"\/>/,
    /<p data-welcome-page-code-note="" class="mt-3 text-\[13px\] text-zinc-500 dark:text-zinc-400">You sign in with a code we email you\. You can add a password later in Settings\.<\/p>/,
    /<div class="grow"><\/div>/,
    /<div data-welcome-page-continue=""><button[^>]*type="submit"[^>]*>Continue<\/button>/,
    /<p class="text-center text-\[13px\] text-zinc-500 dark:text-zinc-400 mt-3">By continuing, you agree to Homeroom(?:&#x27;|')s terms\.<\/p><\/div><\/form>/,
  ];
  let at = 0;
  for (const re of order) {
    const m = re.exec(html.slice(at));
    assert.ok(m, `in order: ${re.source}`);
    at += m.index + m[0].length;
  }
  // No sheet: no handle, no ✕, no dim. No password field (#4891).
  assert.doesNotMatch(html, /data-sign-in-sheet|aria-label="Close"|bg-black\/40|type="password"/);
  // The Continue pill is the make screen's.
  assert.match(html, /<button type="submit" class="[^"]*mt-6 flex items-center justify-center disabled:opacity-50">Continue<\/button>/);
  // Nothing on the page is a dash.
  assert.doesNotMatch(html, /—/);

  // An account with its username chosen asks for none.
  const named = renderComponent(WELCOME, 'WelcomePage', {
    account: { email: 'ada@example.com', needsUsername: false, suggestedUsername: '' },
    beforeFinish() { return true; },
  });
  assert.doesNotMatch(named, /welcome-page-username|Pick a username/);
  assert.match(named, /data-welcome-page-code-note=""/);
});

test('with the keys up the page moves once: the picture folds, the spacer goes, Continue rides (onboarding run two)', () => {
  const html = renderComponent(WELCOME, 'WelcomePage', {
    account: { email: 'ada@example.com', needsUsername: true, suggestedUsername: 'ada' },
    beforeFinish() { return true; },
  });
  // First drawn as it always was: the picture shown, the spacer in place.
  assert.match(html, /<div data-welcome-page-picture="shown" class="max-h-\[180px\] overflow-hidden opacity-100 transition-\[max-height,opacity\] duration-300 ease-out motion-reduce:transition-none"><img src="\/brand\/people\.png"/);
  const src = read(WELCOME);
  // Only on a touch screen, and never while it hands off to the make screen.
  assert.match(src, /if \(\(next && !touchScreen\(\)\) \|\| handingOff\.current\) return;/);
  assert.match(src, /onFocus=\{\(\) => fold\(true\)\}\s+onBlur=\{\(\) => fold\(false\)\}/);
  assert.match(src, /\{typing \? null : <div className="grow" \/>\}/);
  // Continue rides from where it was, over the keys' own 300ms, transform only.
  assert.match(src, /const RIDE = \{ duration: 300, easing: 'cubic-bezier\(0\.33, 1, 0\.68, 1\)' \} as const;/);
  assert.match(src, /el\.animate\(\[\{ transform: `translateY\(\$\{d\}px\)` \}, \{ transform: 'translateY\(0\)' \}\], RIDE\)/);
  assert.match(src, /handingOff\.current = true;\s+const active = document\.activeElement;/);
});

test('its frame is the make screen\'s own literals', () => {
  const welcome = loadTsx(WELCOME);
  const make = read(MAKE);
  for (const name of ['WELCOME_BAR', 'WELCOME_COLUMN', 'WELCOME_EYEBROW', 'WELCOME_TITLE', 'WELCOME_LABEL', 'WELCOME_CARD']) {
    assert.ok(make.includes(welcome[name]), `${name} is the make screen's: ${welcome[name]}`);
  }
  // The make screen's root, at the landing's own layer.
  assert.equal(welcome.WELCOME_ROOT, loadTsx(MAKE).MAKE_ROOT.replace('z-[9000]', 'z-[60]'));
  assert.match(make, /style=\{\{ background: 'var\(--home-wallpaper, #f4f2e4\)' \}\}/);
  assert.match(read(WELCOME), /style=\{\{ background: 'var\(--home-wallpaper, #f4f2e4\)' \}\}/);
});

test('Continue saves the username with the sheet\'s request, then hands off to the make screen only once the shell is ready (#4904)', () => {
  const src = read(WELCOME);
  const submit = src.slice(src.indexOf('const submit = useCallback('), src.indexOf('return (\n'));
  assert.match(submit, /const saved = await saveAccount\(handle\);/);
  // Busy through the session read, then away: the sheet's `finish`, here.
  assert.match(submit, /clearConfirmation\(\);\s+const toMake = \(await beforeFinish\('new'\)\) === true;\s+const opened = await confirmSession\(toMake \? handOff : undefined\);\s+if \(!opened\) setLeaving\(false\);/);
  assert.match(submit, /\} finally \{\s+setBusy\(false\);\s+\}/);
  assert.match(src, /\{busy \? <><FinishingSpinner \/>\{t\('auth:signInSheet\.account\.finishing'\)\}<\/> : t\('auth:signInSheet\.account\.submit'\)\}/);
  assert.match(src, /<SessionConfirmationNotice completion=\{completion\} \/>/);
  // The hand-off fades what stands on the wallpaper, transform and opacity
  // only, no delay; the make screen rises on the same ground.
  assert.match(src, /const ms = prefersReducedMotion\(\) \? 0 : HAND_OFF_MS;/);
  assert.match(src, /const LEAVING = 'pointer-events-none translate-y-0 opacity-0 transition-\[transform,opacity\] duration-200 ease-out motion-reduce:transition-none';/);
  assert.doesNotMatch(src, /\bdelay-\d|transition-delay|animation-delay|transition-all/);
  // The one request, shared with the sheet: the username and no password.
  const sheet = read(SHEET);
  const save = sheet.slice(sheet.indexOf('export async function saveAccount('), sheet.indexOf('export function linkSigningIn('));
  assert.match(save, /fetchSessionMint\('\/api\/auth\/otp\/set-password'/);
  assert.doesNotMatch(save, /\bpassword:/);
  // Errors in the shell's one red.
  assert.match(src, /<p role="alert" className="mt-3 text-\[14px\] text-red-700 dark:text-red-400">\{error\}<\/p>/);
});

test('the copy: one new line, the rest the sheet\'s and the story\'s own', () => {
  assert.equal(message('auth:welcomePage.eyebrow'), 'You\'re in');
  assert.equal(message('auth:story.welcome'), 'Welcome to Homeroom');
  assert.equal(message('auth:signInSheet.account.leadWithUsername'), 'Pick a username. It is public on Homeroom.');
  assert.equal(message('auth:signInSheet.account.codeNote'), 'You sign in with a code we email you. You can add a password later in Settings.');
  assert.equal(message('auth:signInSheet.account.submit'), 'Continue');
  assert.equal(message('auth:signInSheet.account.finishing'), 'Finishing…');
  assert.equal(message('auth:landing.signingIn'), 'Signing you in…');
  const src = read(WELCOME);
  for (const id of ['auth:welcomePage.eyebrow', 'auth:story.welcome', 'auth:signInSheet.account.leadWithUsername',
    'auth:signInSheet.account.usernameLabel', 'auth:signInSheet.account.codeNote']) {
    assert.ok(src.includes(`t('${id}')`), id);
  }
});

// ─── the server holds the line too ──────────────────────────────────────

test('the server: the check is a read, and the on-load spend can only reach the account step', () => {
  const routes = read('src/routes/auth.js');
  assert.match(routes, /releaseLinks\.spend\(pool, req\.body\?\.token, \{\s+createSession,\s+newAccountOnly: req\.body\?\.newAccountOnly === true,\s+\}\)/);
  const signup = read('src/services/email-signup.js');
  const cont = signup.slice(signup.indexOf('async function continueProvenEmail('), signup.indexOf('async function finishProvenEmail('));
  // Refused before any branch that signs in or refuses, and thrown, so the
  // transaction (with the link's consumption in it) rolls back.
  const guard = cont.indexOf("if (newAccountOnly && !isUnfinishedAccount(user)) {\n    throw new EmailSignupError('account_set_up', ACCOUNT_SET_UP_MESSAGE);");
  assert.ok(guard > 0, 'the guard');
  assert.ok(guard < cont.indexOf('createSession(client'), 'before any session');
  assert.ok(guard < cont.indexOf("if (user && user.is_admin)"), 'before the refusals');
  const { isUnfinishedAccount } = require('../src/services/email-signup');
  assert.equal(isUnfinishedAccount(null), true, 'no account yet');
  assert.equal(isUnfinishedAccount({ is_admin: false, password_set: false, needs_username_choice: true }), true);
  assert.equal(isUnfinishedAccount({ is_admin: false, password_set: false, needs_username_choice: false }), false, 'a username chosen');
  assert.equal(isUnfinishedAccount({ is_admin: false, password_set: true, needs_username_choice: true }), false, 'a password set');
  assert.equal(isUnfinishedAccount({ is_admin: true, password_set: false, needs_username_choice: true }), false, 'an admin');
  const links = read('src/services/release-links.js');
  assert.match(links, /return emailSignup\.continueProvenEmail\(client, email, \{ createSession, newAccountOnly \}\);/);
  assert.match(read('src/routes/public-api.js'), /new_account: await releaseLinks\.isNewAccount\(pool, row\),/);
});
