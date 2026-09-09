// Show/hide on every password field (#1606).
//
// The report was one sentence: "There is no way to make passwords visible
// when typing them." A long password typed blind on a phone keyboard is a
// guess, and the only feedback the screens gave was a failed sign-in.
//
// The toggle is one primitive — frontend/@/components/ui/password-input.tsx —
// used at every platform-shell password field, plus one hand-written twin in
// the admin console, which is the other surface and builds from its own class
// vocabulary (tests/admin-ui-registry.test.js).
//
// Effects do not run under renderToStaticMarkup, so what is asserted here is
// the INITIAL render (the masked state every field must ship in, including the
// one a dapp.json check selects on) and the structure that makes the toggle
// work. The click handler itself is three lines of state in the primitive.
//
// Run with: node --test tests/password-visibility-toggle.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, createElement, renderToHtml } = require('./lib/render-tsx');
const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PRIMITIVE = 'frontend/@/components/ui/password-input.tsx';

// `renderComponent` type-guards its export as a function, and the primitive is
// a forwardRef object like every other one in @/components/ui.
function renderField(props) {
  const { PasswordInput } = loadTsx(PRIMITIVE);
  return renderToHtml(createElement(PasswordInput, props));
}
const ADMIN_DB_EXPORT = read('frontend/src/features/admin/admin-db-export.tsx');

// The screens that hold a password field, and how many each holds.
const SHELL_FIELDS = {
  'frontend/src/features/auth/login.tsx': 7,
  'frontend/src/features/auth/register.tsx': 1,
  'frontend/src/features/settings/sections/password.tsx': 3,
  'frontend/src/features/settings/sections/username.tsx': 1,
  // The two API-key fields are `type="password"` too, and a viewer who cannot
  // read back what they pasted is the same complaint. They sit in a flex row
  // beside their buttons, so the width moves to the wrapper.
  'frontend/src/features/settings/sections/api-key.tsx': 1,
  'frontend/src/features/settings/sections/openrouter.tsx': 1,
};

/** Every `<input>` tag in `html` that renders as a password field. */
function passwordInputs(html) {
  return (html.match(/<input[^>]*type="password"[^>]*>/g) || []);
}

/** Every show/hide toggle in `html`. */
function toggles(html) {
  return (html.match(/<button[^>]*aria-label="Show password"[^>]*>/g) || []);
}

// ── The primitive ────────────────────────────────────────────────────

test('a password field ships masked, with a toggle that cannot submit the form', () => {
  const html = renderField({
    id: 'login-password',
    placeholder: 'password',
    autoComplete: 'current-password',
  });

  assert.match(html, /^<div class="relative">/);
  assert.match(html, /<input id="login-password"[^>]*type="password"/,
    'the field is masked until the viewer asks otherwise');
  assert.match(html, /placeholder="password"/);
  assert.match(html, /autoComplete="current-password"/i,
    'the browser and its password manager still recognise the field');

  const button = /<button[^>]*>/.exec(html)[0];
  // Four of these fields sit inside a <form> whose submit IS the sign-in; a
  // bare <button> would submit it on the first reveal.
  assert.match(button, /type="button"/);
  assert.match(button, /aria-label="Show password"/);
  assert.match(button, /aria-pressed="false"/);
});

test('the field keeps its box, its variants and the room the glyph needs', () => {
  const html = renderField({
    id: 'cp-new',
    box: 'auth',
    hint: 'dim',
    ring: 'seamless',
  });
  const input = /<input[^>]*>/.exec(html)[0];
  // The auth screens' field box, unchanged — the toggle is not a restyle.
  assert.match(input, /bg-zinc-100 dark:bg-zinc-900 border border-zinc-300/);
  assert.match(input, /placeholder-zinc-500/);
  assert.match(input, /focus:border-transparent/);
  // …and the padding that keeps a typed password clear of the glyph.
  assert.match(input, /pr-11/);
});

test('the state lives in the primitive, so no section becomes stateful', () => {
  // The settings sections are not React-owned all the way down: settings.js
  // clears #cp-current/#cp-new/#cp-confirm by id, toggles .hidden on
  // #cp-current-row and writes #cp-status by hand. Holding the toggle state in
  // a section would put React's reconciler over those nodes.
  const src = read(PRIMITIVE);
  assert.match(src, /React\.useState\(false\)/);
  for (const rel of Object.keys(SHELL_FIELDS)) {
    if (!rel.includes('/sections/')) continue;
    assert.ok(!/useState/.test(read(rel)),
      `${rel} must stay a static render`);
  }
  // And the field stays uncontrolled, so `el.value = ''` from settings.js and
  // `ref.current.value` from the auth screens keep working.
  assert.ok(!/\bvalue=\{/.test(src), 'the primitive never sets value');
});

// ── Every field on the platform shell ────────────────────────────────

test('no password field is spelled by hand any more', () => {
  for (const [rel, count] of Object.entries(SHELL_FIELDS)) {
    const src = read(rel);
    assert.equal((src.match(/<PasswordInput\b/g) || []).length, count, rel);
    assert.ok(!/<Input[^>]*\n?[^>]*type="password"/.test(src),
      `${rel} still hand-writes a masked Input`);
  }
});

test('every rendered password field carries a toggle', () => {
  for (const id of ['auth-login-screen', 'auth-register-screen', 'settings-screen']) {
    const html = interiorHtmlFor(id);
    const fields = passwordInputs(html);
    assert.ok(fields.length > 0, `${id} renders no password field at all`);
    assert.equal(toggles(html).length, fields.length,
      `${id}: one toggle per password field`);
  }
});

test('the login screen\'s fields are all masked on arrival', () => {
  // Five of the seven render on mount; #reset-password-view's two are built
  // only when the emailed link is being redeemed.
  const html = interiorHtmlFor('auth-login-screen');
  assert.equal(passwordInputs(html).length, 5);
  for (const id of ['login-password', 'otp-new-password', 'otp-confirm-password',
    'recovery-new-password', 'recovery-confirm-password']) {
    assert.match(html, new RegExp(`<input id="${id}"[^>]*type="password"`), id);
  }
});

test('#cu-password is still masked on arrival — a dapp.json check selects on it', () => {
  // dapp.json: "Changing a username asks for the current password" expects
  // `#change-username-section #cu-password[type="password"]` on a fresh load.
  const html = interiorHtmlFor('settings-screen');
  assert.match(html, /<input id="cu-password"[^>]*type="password"/);
});

// ── The admin console's own field ────────────────────────────────────

test('the console gets the same affordance without crossing the surface', () => {
  assert.ok(!/@\/components\/ui\//.test(ADMIN_DB_EXPORT),
    'an admin section never imports a shell primitive');
  // Its own toggle, from its own class vocabulary, reset with the panel so a
  // reopened confirm never starts revealed.
  assert.match(ADMIN_DB_EXPORT, /id="admin-db-export-password-toggle"/);
  assert.match(ADMIN_DB_EXPORT, /type=\{showPassword \? 'text' : 'password'\}/);
  assert.match(ADMIN_DB_EXPORT, /setShowPassword\(false\);/);
  assert.match(ADMIN_DB_EXPORT, /aria-label=\{showPassword \? 'Hide password' : 'Show password'\}/);
});
