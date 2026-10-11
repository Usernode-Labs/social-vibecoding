// #2442: the App settings dialog joins the dialog language it sits in.
//
// Three slots were off, all of them in frontend/src/features/dialogs/app-settings.tsx:
//
//   - Close rendered as the default Button — the filled violet primary. Close
//     is a DISMISSAL, and the widget language draws a secondary action as a
//     filled NEUTRAL pill (variant="neutral" ink="neutral"), which is what
//     #app-notifications-done passes and what #members-close hand-writes.
//     A violet Close reads as the thing the dialog wants you to press, beside
//     an actual destructive primary in the same card.
//   - The title sat at `mb-2` where every other dialog title writes `mb-1`.
//   - The loading line was bare unstyled text, so it rendered at the card's
//     full ink while every other dialog's is muted.
//
// Anchored to those three slots rather than scanned over the file: the dialog
// has other buttons (Retry, Propose access change, Delete app for everyone)
// whose variants are deliberately NOT neutral.
//
// Run with: node --test tests/app-settings-dialog-language.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const REL = 'frontend/src/features/dialogs/app-settings.tsx';
const src = fs.readFileSync(path.join(root, REL), 'utf8');

// The element that carries `anchor`, from the '<' that opens it to the '>'
// that ends its opening tag. Anchoring on the element rather than on a byte
// window keeps a sibling's classes out of the assertion.
function element(anchor) {
  const at = src.indexOf(anchor);
  assert.notEqual(at, -1, `${REL}: ${anchor} — anchor moved, update this test`);
  const open = src.lastIndexOf('<', at);
  assert.notEqual(open, -1, `${REL}: ${anchor} — no opening tag before it`);
  const close = src.indexOf('>', at + anchor.length);
  assert.notEqual(close, -1, `${REL}: ${anchor} — unterminated opening tag`);
  return src.slice(open, close + 1);
}

test('the App settings dialog closes with the neutral pill, not the violet primary', () => {
  const button = element('onClick={() => dialog.close()}');
  assert.match(button, /^<Button\b/, `the Close control is the shell's Button primitive:\n${button}`);
  assert.match(button, /variant="neutral"/, `Close is a dismissal, so it takes the neutral fill:\n${button}`);
  assert.match(button, /ink="neutral"/, `variant="neutral" carries no ink of its own:\n${button}`);
});

test('the App settings title carries the dialog language\'s mb-1', () => {
  assert.equal(message('dialogs:appSettings.title'), 'App settings');
  const title = element(">{t('dialogs:appSettings.title')}<");
  assert.match(title, /\bmb-1\b/, `dialog titles write mb-1:\n${title}`);
  assert.doesNotMatch(title, /\bmb-2\b/, `dialog titles write mb-1, not mb-2:\n${title}`);
});

test('the App settings loading line is muted like the other dialogs\'', () => {
  assert.equal(message('dialogs:appSettings.loading'), 'Loading app settings…');
  const line = element(">{t('dialogs:appSettings.loading')}<");
  assert.match(
    line,
    /text-zinc-500 dark:text-zinc-400/,
    `a dialog's loading line is muted ink, not the card's full ink:\n${line}`,
  );
  // The line still announces itself: it replaces the settings body while the
  // fetch is out, and that is a live-region update, not decoration.
  assert.match(line, /role="status"/, `the loading line stays a status region:\n${line}`);
});

// Private decides who can OPEN the app. Every repository is public on GitHub
// (services/github.js createRepo makes them public, and an import must be
// public already), so the Access section says so once, under the line that
// says who can see it today, in the same muted ink.
test('the Access section says the code is public on GitHub either way', () => {
  assert.equal(message('dialogs:appSettings.access.codePublic'), 'The code is public on GitHub either way.');
  const said = "{t('dialogs:appSettings.access.codePublic')}";
  const line = element(said);
  assert.match(line, /^<p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">/,
    `the line is the description's muted ink:\n${line}`);
  const now = src.indexOf("t('dialogs:appSettings.access.now'");
  const open = src.indexOf('id="app-access-open"');
  assert.ok(now > 0 && now < src.indexOf(said) && src.indexOf(said) < open,
    'under the line that says who can see it, before the button that opens the sheet');
});

// #4666: who can see it and how changes are approved are one sheet and one
// proposal; the section opens it rather than proposing on its own.
test('the Access section opens Who can see & change it', () => {
  assert.equal(message('dialogs:appSettings.access.open'), 'Who can see & change it');
  const at = src.indexOf('id="app-access-open"');
  assert.notEqual(at, -1, 'the button is there');
  const button = src.slice(at, src.indexOf('</Button>', at));
  assert.match(button, /whoDecides\?\.open/, `the button opens the sheet:\n${button}`);
  assert.ok(!/—|–/.test(message('dialogs:appSettings.access.now', { access: 'Private community' })), 'no dashes in user-facing copy');
});
