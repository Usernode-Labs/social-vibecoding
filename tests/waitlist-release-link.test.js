// The access-ready mail's link survives a desktop mail client (#1545).
//
// "Your Homeroom access is ready" is a mail whose whole job is one link, and
// following it from desktop landed on the home page while the same mail worked
// from a phone. That asymmetry is the signature of a link rewriter: the link
// was `https://…/#signup`, a fragment is client-side only, and a scanner or
// tracker that rebuilds the URL has nothing to lose by dropping it. What
// arrives is a bare `/`, which is the home page.
//
// So the mail links to a QUERY — `/?signup=1` — which a rewriter has to carry
// in order to reconstruct the address at all. `AuthScreens.enter()` honours
// it and `?login=1`, and takes either off the address on arrival. Both open
// the story with the sign-in sheet over it now, rather than the sign-in
// screen (tests/sign-in-sheet-flow.test.js runs that end of it).
//
// Run with: node --test tests/waitlist-release-link.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AUTH_SCREENS = fs.readFileSync(path.join(ROOT, 'public/js/auth-screens.js'), 'utf8');
const MAIL = fs.readFileSync(path.join(ROOT, 'src/services/mail/index.js'), 'utf8');

test('the release mail carries no fragment for a rewriter to drop', () => {
  const fn = MAIL.slice(MAIL.indexOf('async function sendWaitlistReleaseMail'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // #1548 split the one ternary into two arms so the no-account link can
  // carry an invite token. Both are still QUERIES, which is what this test
  // is actually about: a fragment is client-side only, so a link rewriter
  // rebuilding the URL drops it, which is the bug #1545 fixed here.
  assert.ok(body.includes('/?login=1'), 'the existing-account arm is a query');
  assert.ok(body.includes('/?signup=1'), 'the no-account arm is a query');
  assert.doesNotMatch(body, /\/#\$\{/, 'the fragment spelling is gone from this mail');
  // Comments stripped: the reasoning at that site necessarily quotes the
  // fragment shape it rejects, and a scan over the body would flag its own
  // explanation.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /#signup/, 'no fragment spelling survives in the code');
});

test('the status-code mail links to a query too (#1538)', () => {
  // Same reasoning, one mail later: check-my-status is reached from a mail a
  // desktop client may rewrite, so it points at `/?status=1` and never at a
  // fragment. It also carries no more_token: the confirmed branch has nothing
  // left to confirm, and a capability in an unsolicited mail is a capability
  // handed to whoever the mailbox forwards to.
  const fn = MAIL.slice(MAIL.indexOf('async function sendWaitlistCodeMail'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /\/\?status=1/);
  const statusLine = body.slice(body.indexOf('statusUrl:'));
  const confirmedBranch = statusLine.slice(0, statusLine.indexOf(':') + 40);
  assert.match(confirmedBranch, /confirmed/,
    'the query spelling is the CONFIRMED branch, not a blanket change');
});

test('the survey fallback keeps its fragment, because the token IS the path', () => {
  // The mint-failure degradation still mails `#more/<token>`, and that is
  // right for the same reason the other token routes keep theirs: a segment
  // route has nothing to reconstruct from a query.
  const fn = MAIL.slice(MAIL.indexOf('async function sendWaitlistCodeMail'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /\/#more\/\$\{moreToken\}/);
});

test('the anonymous boot honours the status spelling as well', () => {
  const enter = AUTH_SCREENS.slice(AUTH_SCREENS.indexOf('    enter() {'));
  const body = enter.slice(0, enter.indexOf('\n    },'));
  assert.match(body, /params\.has\('status'\)/);
  // It lands on the confirm step of the waitlist screen, which is where the
  // code from the mail is typed. Not a screen of its own (#1538).
  assert.match(body, /'waitlist\?confirm=1'/);
});

test('the other mails are untouched: their fragments carry a token', () => {
  // #more/<token> and #reset-password/<token> are segment routes; the token IS
  // the path, and they were not what was reported. Changing them would be a
  // different change with a different risk.
  assert.match(MAIL, /\/#more\/\$\{moreToken\}/);
  assert.match(MAIL, /\/#reset-password\/\$\{token\}/);
});

test('the anonymous boot honours both query spellings, and rewrites them', () => {
  const enter = AUTH_SCREENS.slice(AUTH_SCREENS.indexOf('    enter() {'));
  const body = enter.slice(0, enter.indexOf('\n    },'));
  assert.match(body, /params\.has\('signup'\)/);
  assert.match(body, /params\.has\('login'\)/);
  // The release mail's two land on the story's own address, the link kept
  // for the landing to open its sheet; the status mail's on its hash route.
  assert.match(body, /AuthScreens\._releaseLink = \{/);
  assert.match(body, /history\.replaceState\(null, '', '\/'\);/);
  assert.match(body, /history\.replaceState\(null, '', `\/#\$\{route\}`\)/);
  // Only when there is no hash already: an explicit fragment still wins.
  assert.match(body, /if \(!location\.hash\) \{/);
});

test('signup wins over login when a link somehow carries both', () => {
  // Not a real address, but the precedence must be stated rather than left to
  // whichever `has()` ran first.
  const enter = AUTH_SCREENS.slice(AUTH_SCREENS.indexOf('    enter() {'));
  const body = enter.slice(0, enter.indexOf('\n    },'));
  assert.ok(
    body.indexOf("params.has('signup')") < body.indexOf("params.has('login')"),
    'signup is tested first');
});

test('the whole thing stays inside a try/catch', () => {
  // location.search is readable in every browser this ships to, but the
  // original guarded it and a boot path is the worst place to learn otherwise.
  const enter = AUTH_SCREENS.slice(AUTH_SCREENS.indexOf('    enter() {'));
  const body = enter.slice(0, enter.indexOf('\n    },'));
  assert.ok(body.indexOf('try {') < body.indexOf('URLSearchParams'));
  assert.match(body, /\} catch \(_\) \{\}/);
});

test('the release mail\'s one-time sign-in link is its own credential, kept off the GET (#4594)', () => {
  const fn = MAIL.slice(MAIL.indexOf('async function sendWaitlistReleaseMail'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /signInToken \? `&\$\{CREDENTIAL_PARAM\}=/, 'a separate parameter, not more_token');
  // Arrival keeps it for the sheet, which spends it with a POST.
  assert.match(AUTH_SCREENS, /signIn: route === 'signup' && key && \/\^\[A-Za-z0-9_-\]\{43\}\$\/\.test\(key\) \? key : null/);
  assert.doesNotMatch(AUTH_SCREENS, /release-link/, 'nothing spends it on arrival');
  const sheet = fs.readFileSync(path.join(ROOT, 'frontend/src/features/auth/sign-in-sheet.tsx'), 'utf8');
  assert.match(sheet, /fetchSessionMint\('\/api\/auth\/release-link', \{\s*method: 'POST'/);
});

test('a new account\'s link waits for Get started, and only the sheet spends it (Evan, 10 Oct 2026)', () => {
  const landing = fs.readFileSync(path.join(ROOT, 'frontend/src/features/auth/landing.tsx'), 'utf8');
  const onShow = landing.slice(landing.indexOf('  const landingOnShow = useCallback(() => {'));
  const body = onShow.slice(0, onShow.indexOf('\n  }, ['));
  // Kept for the sheet, with the sign-in noted as begun, but no sheet opened
  // for a new account: the story shows, and Get started opens it.
  assert.match(body, /if \(link\) \{\s+noteSignInBegun\(\);\s+setRelease\(link\);\s+setResume\(null\);\s+if \(link\.route !== 'signup'\) setSheet\('signin'\);\s+\}/);
  assert.doesNotMatch(body, /setSheet\('start'\)/);
  assert.match(landing, /onStart=\{\(\) => setSheet\('start'\)\}/, 'Get started opens the story\'s sheet');
  // That sheet carries the link while `release` holds it, and spends it on open.
  assert.match(landing, /releaseToken=\{sheet === 'start' \? release\?\.token \?\? null : null\}/);
  assert.match(landing, /releaseSignIn=\{sheet === 'start' \? release\?\.signIn \?\? null : null\}/);
  const sheet = fs.readFileSync(path.join(ROOT, 'frontend/src/features/auth/sign-in-sheet.tsx'), 'utf8');
  assert.match(sheet, /if \(!open \|\| !seen \|\| releaseSeen\.current === seen\) return undefined;/, 'spent only once the sheet is open');
});
