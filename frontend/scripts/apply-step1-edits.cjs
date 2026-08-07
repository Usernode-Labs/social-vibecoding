#!/usr/bin/env node
// ONE-TIME migration tool, run after frontend/scripts/html-to-jsx.cjs.
//
//   node frontend/scripts/html-to-jsx.cjs
//   node frontend/scripts/apply-step1-edits.cjs
//     → frontend/src/Shell.tsx
//
// The mechanical HTML→JSX conversion is faithful but produces four things
// React will not accept as-is. This script applies exactly those four edits,
// so the whole conversion stays reproducible from the committed fixture
// rather than being a pile of hand edits nobody can re-derive. Each edit is
// documented at its site below AND in the emitted source.
//
// Like the converter, this is NOT part of the build. Shell.tsx is
// hand-maintained source from here on.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GENERATED = path.join(ROOT, 'frontend', 'src', 'Shell.generated.tsx');
const TARGET = path.join(ROOT, 'frontend', 'src', 'Shell.tsx');

let source = fs.readFileSync(GENERATED, 'utf8');

function edit(name, from, to) {
  if (!source.includes(from)) {
    console.error(`[apply-step1-edits] anchor for "${name}" not found — the converter output moved.`);
    process.exit(1);
  }
  source = source.replace(from, to);
  console.log(`[apply-step1-edits] ${name}`);
}

// ── 1. The one live shadcn conversion ──────────────────────────────────
edit(
  '#settings-save → <Button> (the shadcn proof)',
  `                    <button
                      id="settings-save"
                      className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm font-medium text-white transition-colors"
                    >
                      Save
                    </button>`,
  `                    {/*
                        THE ONE LIVE shadcn CONVERSION IN STEP 1.

                        <Button>'s default variant + default size emit
                        \`rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2
                        text-sm font-medium text-white transition-colors\`, so with
                        \`shrink-0\` passed through className this renders the exact
                        DOM node the hand-written button did — same tag, same id,
                        same class set. settings.js still finds it by
                        getElementById and binds its click.

                        It is here so that "shadcn is wired up and produces
                        byte-identical output against the platform's own palette"
                        is something the screenshot-parity gate actually TESTS,
                        rather than something this migration merely claims.
                        Every other control in this file is still raw JSX; they
                        convert one screen at a time in step 2.
                    */}
                    <Button id="settings-save" className="shrink-0">
                      Save
                    </Button>`,
);

// ── 2. The document's only inline event handler ────────────────────────
// React rejects an inline `onclick` attribute: it warns, a warning is a
// console.error, and a console.error on any route fails the platform's
// proposal checks. The binding moved into the module that already owns this
// button — PlatformUpdating.show() in public/js/app.js, which was already
// doing getElementById on it. Behaviour is identical.
edit(
  '#platform-updating-reload: inline onclick → bound in public/js/app.js',
  `          className="hidden ml-2 px-2 py-0.5 rounded border border-current text-xs font-semibold hover:bg-black/10 dark:hover:bg-white/10"
          onclick="location.reload()"
        >`,
  `          className="hidden ml-2 px-2 py-0.5 rounded border border-current text-xs font-semibold hover:bg-black/10 dark:hover:bg-white/10"
        >`,
);

// ── 3 & 4. Uncontrolled form fields ────────────────────────────────────
// `value` / `checked` without an onChange make React warn about a controlled
// field with no handler — again a console.error. `defaultValue` /
// `defaultChecked` are the uncontrolled spelling and render the IDENTICAL
// HTML attribute, so the served markup is unchanged and the legacy modules
// that read/write `.value` and `.checked` are unaffected.
edit(
  '#members-approvals-n: value → defaultValue',
  `                    max="50"
                    value="1"`,
  `                    max="50"
                    defaultValue="1"`,
);

edit(
  '#feedback-state-checkbox: checked → defaultChecked',
  `                  type="checkbox"
                  checked={true}`,
  `                  type="checkbox"
                  defaultChecked={true}`,
);

fs.writeFileSync(TARGET, source);
fs.unlinkSync(GENERATED);
console.log(`[apply-step1-edits] wrote ${path.relative(ROOT, TARGET)}`);
