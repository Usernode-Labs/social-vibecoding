// Content pins for the waitlist-release invite link (#1548).
//
// The reported bug: the "get started" link in the release email lands on a
// screen that asks for a code nobody has been sent, next to an empty email
// field. So the link now carries the released address, and arriving is what
// asks for the code.
//
// That behaviour spans four files with nothing structural tying them
// together — the mail builds the link, the legacy router forwards its
// segment, the sign-in sheet (the one sign-in, over the landing) decodes it
// and sends, and the server decides whether a repeat request mints a new code. A change to any one of
// them alone is silent breakage, so these pin the joins. Source pins in the
// style of tests/password-reset-ui.test.js; the behaviour itself is covered
// by tests/topochain-mail-transport.test.js, tests/platform-mail.test.js and
// tests/email-signup-postgres.test.js.
//
// Run with: node --test tests/signup-invite-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const { loadTsx } = require('./lib/render-tsx');

const SHEET_TSX = 'frontend/src/features/auth/sign-in-sheet.tsx';
const ROUTES_TSX = 'frontend/src/features/auth/sign-in-routes.ts';
const LANDING_TSX = 'frontend/src/features/auth/landing.tsx';

// ─── the link and the route that receives it ────────────────────────

test('#1548: the release link carries a TOKEN in a query, not the address', () => {
  const js = read('src/services/mail/index.js');
  // Two things this must not be, and both were tried:
  //
  //   A FRAGMENT is client-side only, so a link rewriter rebuilding the URL
  //   drops it. That is the bug #1545 fixed on this exact mail — it landed on
  //   the home page from a desktop client and worked from a phone.
  //
  //   THE ADDRESS IN A QUERY survives the rewriter but puts an email into
  //   server logs and referrers. For a waitlist, membership is precisely the
  //   fact people would not want there.
  assert.ok(js.includes('/?signup=1${moreToken'),
    'the no-account link is a query and carries the token');
  assert.ok(js.includes('&t=${encodeURIComponent(moreToken)}'),
    'the token is url-encoded, never interpolated raw');
  assert.ok(js.includes('/?login=1'),
    'somebody who already has an account still goes to the sign-in link');
  // Comments stripped first. The reasoning above lives at the site it
  // applies to, and that prose necessarily quotes the shape it forbids — a
  // scan over the whole file flags its own explanation.
  const code = js
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /#signup\//, 'no fragment a rewriter is free to drop');
  // The token must be optional: a signup row without one still gets a usable
  // link rather than `&t=undefined`.
  assert.ok(js.includes("` : ''}`"), 'absent token degrades to a plain signup link');
});

test('#1548: the release path supplies the token it promises', () => {
  // The mail can only carry a token the caller hands it, so the release
  // query has to return one and the admin route has to pass it on.
  assert.match(read('src/services/waitlist.js'), /RETURNING w\.id, w\.email, w\.released_at, w\.linked_user_id, w\.more_token,/,
    'releaseWaitlistSignup returns more_token');
  // The notice is one function, shared by the admin routes and "Let them
  // all in" (#6633): it passes the token on, and the route sends through it.
  assert.match(read('src/services/waitlist-release-mail.js'), /moreToken: released\.more_token \|\| null,/,
    'the release notice passes it to the mail');
  assert.match(read('src/routes/topochain/admin/waitlist.js'),
    /const sendReleaseMail = \(released, mobile\) => releaseMail\.sendReleaseMail\(config, pool, released, mobile\);/,
    'and the release route sends that notice');
});

test('signup is the landing\'s route, and its segment reaches the sheet', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /signup: 'auth-landing-screen'/, 'signup is the landing, with the sheet over it');
  assert.match(js, /AuthScreens\._signInRoute = signIn \? \{ route, seg: seg \|\| null \} : null;/,
    'the router must forward the segment, not just open the sheet');
  const landing = read(LANDING_TSX);
  assert.match(landing, /const signInRoute = takeSignInRoute\(\);/);
  assert.match(landing, /opening: sheetOpening\(signInRoute\.route, signInRoute\.seg\),/);
  assert.match(landing, /route=\{routeSheet\.opening\}/);
});

// ─── arriving from the link ─────────────────────────────────────────

test('#1548: the sheet resolves the token, and still refuses a non-address', () => {
  const routes = read(ROUTES_TSX);
  // The token is resolved through the endpoint that already exists for it.
  // Nothing new is minted: more_token is already an unguessable capability
  // delivered to that address, and /api/public/waitlist/more/:token already
  // returns the email.
  assert.match(routes, /export async function inviteEmailFromToken/);
  assert.match(routes, /export function releaseTokenFromQuery/);
  assert.match(routes, /waitlist\/more\/\$\{encodeURIComponent\(token\)\}/,
    'resolved through the existing rate-limited endpoint');
  // Whatever comes back is still validated before it can reach the OTP
  // endpoint: a prefill is a convenience, not a reason to trust a response.
  assert.match(routes, /includes\('@'\)/, 'only an address prefills and sends');
  // The segment form stays for the screenshot state, which cannot carry a
  // live token and must paint without a network round trip.
  const { addressFromSegment, sheetOpening } = loadTsx(ROUTES_TSX);
  assert.equal(addressFromSegment('Ada%40Example.com'), 'ada@example.com');
  assert.equal(addressFromSegment('not-an-address'), null);
  assert.equal(addressFromSegment('%E0%A4%A'), null, 'a stray % fills in nothing');
  assert.deepEqual(
    JSON.parse(JSON.stringify(sheetOpening('signup', 'demo%40example.invalid', null))),
    { route: 'signup', step: 'email', email: 'demo@example.invalid', codeSent: false, token: null, code: null, resetSent: false, notice: null },
  );
  assert.equal(sheetOpening('signup', null, null).email, null, 'a bare #signup is the empty email step');
});

test('the code is requested once per address per tab, not once per load', () => {
  const routes = read(ROUTES_TSX);
  // sessionStorage rather than a ref: a reload is exactly the case a ref
  // forgets, and a reload is the common way to arrive here twice.
  assert.match(routes, /const AUTO_SEND_KEY = 'usernode\.signup\.otp\.v1'/);
  assert.match(routes, /sessionStorage\.getItem\(AUTO_SEND_KEY\)/);
  assert.match(routes, /sessionStorage\.setItem\(AUTO_SEND_KEY/);
  // The record is read again on every arrival rather than remembered, and
  // written BEFORE the request so a failed send is not retried on a loop.
  const sheet = read(SHEET_TSX);
  const arrival = sheet.slice(sheet.indexOf('export function addressArrival('), sheet.indexOf('/** A waitlist "you\'re in" link\'s one-time sign-in, spent'));
  assert.match(arrival, /const prior = readAutoSend\(\);/);
  assert.match(arrival, /writeAutoSend\(address\);\s+return \{ address, send: true \};/);
  assert.match(sheet, /: addressArrival\(address\);\s+if \(arrival\.send\) \{ void requestCode\(address\); return; \}/);
});

test('a second visit lands back on the code step instead of an empty form', () => {
  const sheet = read(SHEET_TSX);
  // A code this tab already sent for the address: the code step, with what
  // is left of the wait, and nothing sent again.
  const prefill = sheet.slice(sheet.indexOf('// #signup/<address> (`route.email`)'), sheet.indexOf('// Inside the Homeroom app, the wallet is asked once'));
  assert.match(prefill, /if \(!open \|\| !route\?\.email \|\| routeSeen\.current === route\) return;/, 'once per opening');
  assert.match(prefill, /setStep\('code'\);\s+setCooldownUntil\(arrival\.cooldownUntil\);/,
    'the remaining wait is restored, not restarted');
});

test('the resend is held for the same gap the mail layer enforces', () => {
  const sheet = read(SHEET_TSX);
  assert.match(sheet, /const RESEND_COOLDOWN_MS = 60 \* 1000;/);
  // The button says how long is left rather than looking broken.
  assert.match(sheet, /t\('auth:signInSheet\.code\.resendIn', \{ count: waitLeft \}\)/);
  assert.match(message('auth:signInSheet.code.resendIn', { count: 42 }), /42/);
  // Client-side politeness only. The server-side gap is the mail layer's,
  // and requestCode reuses the outstanding code inside it rather than
  // minting one it then refuses to send.
  const rules = read('src/services/mail/rate-limit.js');
  assert.match(rules, /\n\s*otp: \{ minGapMs: 60 \* 1000,/);
  const signup = read('src/services/email-signup.js');
  assert.match(signup, /const OTP_REUSE_WINDOW_SECONDS = 60;/);
  assert.match(signup, /RULES\.otp\.minGapMs|rate-limit/,
    'the reuse window must name where its 60 comes from');
});

// ─── the screenshot state ───────────────────────────────────────────

test('the post-send screen is URL-reachable for captures and checks', () => {
  // Checks and before/after shots can only navigate. Without this the
  // reviewer sees the empty email step, which is the screen #1548 is
  // about getting rid of.
  assert.match(read('public/js/app.js'), /shot !== 'signup-code-sent'/,
    'the shot must survive restoreFromHash for a signed-in reviewer');
  const { sheetOpening } = loadTsx(ROUTES_TSX);
  const shot = sheetOpening('signup', 'demo%40example.invalid', 'signup-code-sent');
  assert.equal(shot.step, 'code');
  assert.equal(shot.codeSent, true);
  // It paints; it must never send. The shot has to be deterministic, and
  // staging mail is log-only, so a real request would prove nothing.
  assert.match(read(SHEET_TSX), /const arrival: ReleaseArrival = route\.codeSent\s+\? \{ address, send: false, cooldownUntil: Date\.now\(\) \+ RESEND_COOLDOWN_MS \}/,
    'the shot paints the code step with the resend held, and sends nothing');

  const dapp = JSON.parse(read('dapp.json'));
  const declared = dapp.tests.filter((t) => t.path.includes('shot=signup-code-sent'));
  assert.equal(declared.length, 1, 'one check holds both halves: the address and the held resend');
  for (const t of declared) {
    assert.match(t.path, /#signup\/demo%40example\.invalid$/,
      'the check must carry an encoded address, like a real link');
    assert.match(t.expectSelector, /button\[disabled\]/);
    // The sheet draws the address as two parts (the name part shortens on a
    // phone, ./sign-in-sheet.tsx SentAddress), which the page's text reads on
    // two lines, so the check reads the provider's part.
    assert.equal(t.expectText, '@example.invalid');
  }
});

// ─── copy ───────────────────────────────────────────────────────────

test('no em dash reaches a reader on any surface this touched', () => {
  for (const rel of [SHEET_TSX, ROUTES_TSX, 'src/services/mail/templates.js']) {
    const src = read(rel);
    // Comments in these files are agent-facing and may use one; the strings
    // are not. Check every quoted literal rather than the whole file.
    for (const m of src.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
      const literal = m[1] || m[2] || '';
      assert.doesNotMatch(literal, /—|&mdash;|&#8212;/,
        `em dash in a user-facing string in ${rel}: ${literal}`);
    }
  }
});
