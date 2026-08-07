// The React chassis migration's centrepiece test.
//
// Step 1 of the React + shadcn migration is a SCAFFOLDING-ONLY chassis swap:
// public/index.html stopped being hand-written and became a build artifact
// generated from frontend/src/Shell.tsx, with the explicit contract that the
// markup is carried over AS-IS and there is ZERO visual change.
//
// "Carried over as-is" is worth nothing as prose, so this test makes it a
// machine-checked claim: the generated document is compared, element by
// element, against tests/fixtures/pre-migration-index.html — a byte copy of
// the last hand-written public/index.html (commit 1d169130).
//
// What is compared: the ordered sequence of elements, their tag names, and
// every attribute and its value, plus the non-whitespace text between them.
// What is deliberately ignored: HTML comments (JSX drops them), indentation
// and whitespace-only text nodes (JSX re-indents everything), the order of
// tokens inside `class`/`rel` (a set, not a sequence, to the browser), and
// the spacing inside a `style` declaration block. None of those can change a
// pixel; all of them change when markup moves through JSX.
//
// LIFETIME: this test is maximally valuable for exactly one commit and turns
// into an obstacle the moment step 2 starts converting real screens. Delete
// it — and the fixture — in the first step-2 slice. tests/shell-id-inventory
// and tests/shell-script-order stay useful much longer and should outlive it.
//
// Run with: node --test tests/shell-markup-parity.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { structure, describe } = require('./helpers/html-tokens');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'pre-migration-index.html');

const before = fs.readFileSync(FIXTURE, 'utf8');
const after = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// The one deliberate ADDITION: the React entry, last in <head>. Everything
// else in the document must match the fixture, so it is removed here rather
// than special-cased inside the walk — and asserted separately below, so
// dropping it can't pass by accident.
const ENTRY_TAG = '<script type="module" src="/shell/assets/shell.js"></script>';
const afterWithoutEntry = after.replace(ENTRY_TAG, '');

// ── The one deliberate, reviewed markup difference in step 1 ───────────
//
// #platform-updating-reload carried `onclick="location.reload()"`, the only
// inline handler in the whole document. React rejects inline `onclick`
// attributes (it warns, and a warning is a console.error, and a console.error
// on any route fails the platform's proposal checks), so the binding moved
// into the module that already owns that button — PlatformUpdating.show() in
// public/js/app.js, which was already doing getElementById on it.
//
// Behaviour is identical; the attribute is gone from the served HTML. It is
// listed here rather than tolerated silently so that any OTHER attribute
// disappearing still fails.
const ALLOWED_ATTR_REMOVALS = [
  { id: 'platform-updating-reload', attr: 'onclick' },
];

function isAllowedRemoval(token, attr) {
  return ALLOWED_ATTR_REMOVALS.some((a) => a.id === token.attrs.id && a.attr === attr);
}

test('the generated shell matches the pre-migration markup element for element', () => {
  const a = structure(before);
  const b = structure(afterWithoutEntry);

  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    const x = a[i];
    const y = b[i];

    // Fail on the FIRST divergence with both sides quoted plus a little
    // context. A structural diff of a 2,600-line document is unreadable
    // otherwise, and the first divergence is nearly always the real cause.
    const context = () => {
      const from = Math.max(0, i - 4);
      return a.slice(from, i).map((t, n) => `      ${from + n}: ${describe(t)}`).join('\n');
    };

    assert.ok(
      x && y,
      `public/index.html has ${b.length} structural tokens, the pre-migration fixture has ${a.length}.\n`
      + `  First extra/missing at index ${i}:\n`
      + `    fixture:   ${describe(x)}\n`
      + `    generated: ${describe(y)}\n`
      + `  preceding context:\n${context()}`,
    );

    assert.equal(
      y.kind, x.kind,
      `token ${i}: expected ${x.kind} ${describe(x)}, got ${y.kind} ${describe(y)}\n`
      + `  preceding context:\n${context()}`,
    );

    if (x.kind === 'text') {
      assert.equal(
        y.text, x.text,
        `token ${i}: text differs\n  fixture:   ${JSON.stringify(x.text)}\n`
        + `  generated: ${JSON.stringify(y.text)}\n  preceding context:\n${context()}`,
      );
      continue;
    }
    if (x.kind === 'close') {
      assert.equal(y.tag, x.tag, `token ${i}: expected </${x.tag}>, got </${y.tag}>`);
      continue;
    }
    if (x.kind !== 'open') continue;

    assert.equal(
      y.tag, x.tag,
      `token ${i}: expected <${x.tag}>, got <${y.tag}>\n  preceding context:\n${context()}`,
    );

    const where = `${describe(x)} (token ${i})`;

    for (const [name, value] of Object.entries(x.attrs)) {
      if (isAllowedRemoval(x, name)) continue;
      assert.ok(
        name in y.attrs,
        `${where}: attribute \`${name}\` was dropped by the JSX conversion (was ${JSON.stringify(value)}).`,
      );
      assert.equal(
        y.attrs[name], value,
        `${where}: attribute \`${name}\` changed.\n`
        + `    fixture:   ${JSON.stringify(value)}\n    generated: ${JSON.stringify(y.attrs[name])}`,
      );
    }

    for (const name of Object.keys(y.attrs)) {
      assert.ok(
        name in x.attrs,
        `${where}: the generated markup added attribute \`${name}\`=${JSON.stringify(y.attrs[name])}, `
        + 'which the pre-migration markup did not have.',
      );
    }
  }
});

test('the deliberate markup differences are exactly the ones listed here', () => {
  // Guards the allow-list itself: if someone retires the inline handler
  // exception without removing the entry, or the element disappears, this
  // fails rather than quietly widening the tolerance.
  const a = structure(before);
  for (const allowed of ALLOWED_ATTR_REMOVALS) {
    const token = a.find((t) => t.kind === 'open' && t.attrs.id === allowed.id);
    assert.ok(token, `the fixture has no #${allowed.id} — remove its entry from ALLOWED_ATTR_REMOVALS`);
    assert.ok(
      allowed.attr in token.attrs,
      `#${allowed.id} in the fixture has no \`${allowed.attr}\` attribute — the exception is obsolete`,
    );
  }
  assert.equal(
    ALLOWED_ATTR_REMOVALS.length, 1,
    'step 1 permits exactly ONE markup difference. Adding another means the chassis swap stopped '
    + 'being scaffolding-only — justify it in review rather than extending this list.',
  );
});

test('the generated document keeps the shell boilerplate the head depends on', () => {
  assert.match(after, /^<!DOCTYPE html>\n<html lang="en" class="dark">\n/,
    'the doctype / <html lang="en" class="dark"> preamble must be preserved verbatim');
  assert.match(after, /<body class="[^"]*flex flex-col" style="height:100dvh">/,
    'the <body> element keeps its own class/style: it is the flex column every screen\'s height '
    + 'depends on, so React hydrates its CHILDREN rather than a wrapper div');
  assert.ok(after.includes(ENTRY_TAG),
    'the React entry must be referenced from the generated document');
});
