// Content pins for the waitlist-release invite link (#1548).
//
// The reported bug: the "get started" link in the release email lands on a
// screen that asks for a code nobody has been sent, next to an empty email
// field. So the link now carries the released address, and arriving is what
// asks for the code.
//
// That behaviour spans four files with nothing structural tying them
// together — the mail builds the link, the legacy router forwards its
// segment, the React login screen decodes it and sends, and the server
// decides whether a repeat request mints a new code. A change to any one of
// them alone is silent breakage, so these pin the joins. Source pins in the
// style of tests/password-reset-ui.test.js; the behaviour itself is covered
// by tests/topochain-mail-transport.test.js, tests/platform-mail.test.js and
// tests/email-signup-postgres.test.js.
//
// Run with: node --test tests/signup-invite-link.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const LOGIN_TSX = 'frontend/src/features/auth/login.tsx';

// ─── the link and the route that receives it ────────────────────────

test('the release link carries the address as a route segment, not a query', () => {
  const js = read('src/services/mail/index.js');
  // AuthScreens.routeFromHash splits a hash route on '/', so a ?email=
  // query in the fragment would never reach a handler. Same reason
  // #reset-password/<token> is shaped this way.
  assert.match(js, /#signup\/\$\{encodeURIComponent\(email\)\}/,
    'the no-account link must url-encode the address into a segment');
  assert.match(js, /hasAccount\s*\?\s*`\$\{PRODUCTION_ORIGIN\}\/#login`/,
    'somebody who already has an account still goes to #login');
});

test('signup is a login-screen route and the segment reaches the screen', () => {
  const js = read('public/js/auth-screens.js');
  assert.match(js, /signup:\s*'auth-login-screen'/,
    'signup renders on the login screen');
  assert.match(js, /if \(route === 'signup'\) AuthScreens\._loginOnShow\(true, seg\)/,
    'the router must forward the segment, not just open the signup view');
  assert.match(read(LOGIN_TSX),
    /_loginOnShow: \(openSignup\?: boolean, seg\?: string \| null\) =>/,
    'the React screen accepts the segment on the patched dispatcher');
});

// ─── arriving from the link ─────────────────────────────────────────

test('the screen decodes the segment and refuses anything but an address', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /decodeURIComponent\(seg\)/, 'the segment arrives url-encoded');
  // A malformed segment throws out of decodeURIComponent, and a segment
  // that is not an address must not be posted to the OTP endpoint.
  assert.match(tsx, /function inviteFromSegment/);
  assert.match(tsx, /includes\('@'\)/, 'only an address prefills and sends');
});

test('the code is requested once per address per tab, not once per load', () => {
  const tsx = read(LOGIN_TSX);
  // sessionStorage rather than a ref: a reload is exactly the case a ref
  // forgets, and a reload is the common way to arrive here twice.
  assert.match(tsx, /const AUTO_SEND_KEY = 'usernode\.signup\.otp\.v1'/);
  assert.match(tsx, /sessionStorage\.getItem\(AUTO_SEND_KEY\)/);
  assert.match(tsx, /sessionStorage\.setItem\(AUTO_SEND_KEY/);
  // The guard is read again on every pass rather than remembered, and the
  // record is written BEFORE the request so a failed send is not retried
  // on a loop.
  assert.match(tsx, /writeAutoSend\(inviteEmail\);\s*\n\s*void otpRequestCode\(inviteEmail\);/);
});

test('a second visit lands back on the code step instead of an empty form', () => {
  const tsx = read(LOGIN_TSX);
  // loginOnShow's showOtpView() resets the screen to the email step, and
  // the router calls it again on a re-entry that leaves the address
  // unchanged — so this has to be painted from loginOnShow itself, not
  // from an effect keyed on the address.
  const onShow = tsx.slice(tsx.indexOf('const loginOnShow'), tsx.indexOf('// ── The OTP'));
  assert.ok(onShow.length > 0, 'loginOnShow must still exist');
  assert.match(onShow, /readAutoSend\(\)/,
    'the standing confirmation is restored inside loginOnShow');
  assert.match(onShow, /setOtpStatus\(CODE_SENT_MSG\)/);
  assert.match(onShow, /setCooldownUntil\(/,
    'the remaining cooldown is restored, not restarted');
});

test('the resend is held for the same gap the mail layer enforces', () => {
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /const RESEND_COOLDOWN_MS = 60 \* 1000/);
  // The button says how long is left rather than looking broken, and both
  // arms of every conditional class are whole literals — Tailwind's
  // extractor is a regex over source text.
  assert.match(tsx, /Send a new code in \$\{cooldownLeft\}s/);
  assert.match(tsx, /Email me a code in \$\{cooldownLeft\}s/);
  assert.match(tsx, /const QUIET_BUTTON_WAITING =\s*\n?\s*'[^']*'/);
  assert.doesNotMatch(tsx, /className=\{`[^`]*\$\{[^`]*\}[^`]*`\}/,
    'no computed Tailwind class names');

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
  const tsx = read(LOGIN_TSX);
  assert.match(tsx, /shot === 'signup-code-sent'/);
  // It paints; it must never send. The shot has to be deterministic, and
  // staging mail is log-only, so a real request would prove nothing.
  assert.match(tsx, /if \(currentShot\(\) === 'signup-code-sent'\) return;/,
    'the auto-send effect must short-circuit on the shot');

  const dapp = JSON.parse(read('dapp.json'));
  const declared = dapp.tests.filter((t) => t.path.includes('shot=signup-code-sent'));
  assert.equal(declared.length, 2, 'both halves of the screen are checked');
  for (const t of declared) {
    assert.match(t.path, /#signup\/demo%40example\.invalid$/,
      'the check must carry an encoded address, like a real link');
  }
});

// ─── copy ───────────────────────────────────────────────────────────

test('no em dash reaches a reader on any surface this touched', () => {
  for (const rel of [LOGIN_TSX, 'src/services/mail/templates.js']) {
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
