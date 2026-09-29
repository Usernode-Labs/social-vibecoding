// The waitlist fields keep a visible outline when they are focused (#1529).
//
// Both screens used `focus:outline-none`, a box-shadow ring, and a focused
// border set to transparent: the resting border is removed on focus and the
// ring is drawn in its place. iOS Safari does not paint box-shadow on a
// natively-styled control, so on a phone the border vanished on tap and
// nothing replaced it — a field that looks LESS defined the moment you are
// typing in it.
//
// The fix is not to drop the ring (it is the better indicator wherever it
// draws) but to stop removing the border: a focused field colours its border
// instead. That leaves a visible outline on every engine.
//
// ── Why this reads the RENDERED markup now ─────────────────────────────
//
// It used to scan the two screens' `className="…"` literals, because that is
// where the field boxes were written — sixteen hand-authored copies of one
// recipe, and the rule's job was to stop one of them drifting.
//
// #2437 routed all sixteen through <Input>/<Textarea>/<Select>, so the pair
// this file is about lives in `inputVariants`' `bordered` ring and in
// `selectVariants`' `authWhite` variant, and a source scan of the screens
// would now find almost nothing to check — it would pass by being empty,
// which is the worst way for a rule to pass.
//
// So the assertions moved one layer out, to the markup the browser actually
// gets (tests/lib/lazy-interiors.js renders both interiors the way their
// reveal does). That is strictly stronger: it covers the fields whatever they
// are spelled as, it still covers the two that are NOT routed through the
// primitive (#more-invite-url's read-only box, and any field a later slice
// adds by hand), and it cannot be satisfied by a variant nobody uses.
//
// Run with: node --test tests/waitlist-focus-outline.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const SCREENS = ['auth-waitlist-screen', 'auth-more-screen'];

/** Every field element in a screen's interior, as `{ id, tag, classes }`. */
function fieldsOf(screenId) {
  const html = interiorHtmlFor(screenId);
  const out = [];
  for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    out.push({
      tag: m[1],
      id: /\bid="([^"]*)"/.exec(m[2])?.[1] || '(no id)',
      classes: /\bclass="([^"]*)"/.exec(m[2])?.[1] || '',
    });
  }
  return out;
}

test('no waitlist field hides its border on focus', () => {
  for (const screen of SCREENS) {
    for (const field of fieldsOf(screen)) {
      assert.ok(
        !field.classes.includes('focus:border-transparent'),
        `${screen} #${field.id}: a transparent focused border is invisible wherever the ring is`,
      );
    }
  }
});

test('every focus ring is paired with a focused border colour', () => {
  // The two always travel together: the ring for engines that paint it, the
  // border for the ones that do not.
  let checked = 0;
  for (const screen of SCREENS) {
    for (const field of fieldsOf(screen)) {
      if (!field.classes.includes('focus:ring-2')) continue;
      checked += 1;
      assert.ok(
        field.classes.includes('focus:border-violet-500'),
        `${screen} #${field.id}: a focus ring without a focused border reads as `
          + 'no outline on iOS Safari',
      );
    }
  }
  assert.ok(checked >= 17, `expected the whole waitlist form, saw ${checked} fields`);
});

test('the country select — the control the report named — is covered', () => {
  const select = fieldsOf('auth-waitlist-screen').find((f) => f.id === 'waitlist-country');
  assert.ok(select, '#waitlist-country is rendered');
  assert.equal(select.tag, 'select', 'and it is still a real <select>');
  assert.match(select.classes, /border border-zinc-300/, 'still bordered at rest');
  assert.match(select.classes, /focus:border-violet-500/, 'and bordered when focused');
});

test('the pair is spelled ONCE, in the primitives the screens now use', () => {
  // The rule above is about rendered output; this is about there being one
  // place to change it. Both values carry the ring and the border together,
  // so neither can be taken without the other.
  const input = fs.readFileSync(path.join(ROOT, 'frontend/@/components/ui/input.tsx'), 'utf8');
  const select = fs.readFileSync(path.join(ROOT, 'frontend/@/components/ui/select.tsx'), 'utf8');
  const bordered = /bordered:\s*\n?\s*'([^']*)'/.exec(input)?.[1];
  assert.ok(bordered, "inputVariants still has a `bordered` ring");
  assert.match(bordered, /focus:ring-2 focus:ring-violet-500 focus:border-violet-500/);
  const authWhite = /authWhite:\s*\n?\s*'([^']*)'/.exec(select)?.[1];
  assert.ok(authWhite, "selectVariants still has an `authWhite` variant");
  assert.match(authWhite, /focus:ring-2 focus:ring-violet-500 focus:border-violet-500/);
});
