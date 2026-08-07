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

// React turns an inline `on…="…"` attribute into a console.error, which fails
// the platform's proposal checks on every route that renders it. Fail the
// conversion loudly rather than emit a Shell.tsx that only breaks at runtime.
function assertNoInlineHandlers() {
  const found = [...source.matchAll(/\son(click|change|input|submit|load|error|focus|blur|keyup|keydown)="/g)];
  if (found.length) {
    console.error(
      `[apply-step1-edits] ${found.length} inline event handler(s) in the converted markup: `
      + `${[...new Set(found.map((m) => `on${m[1]}`))].join(', ')}. React rejects these. Bind them `
      + 'from the owning public/js/** module instead, and strip the attribute with an edit here.',
    );
    process.exit(1);
  }
  console.log('[apply-step1-edits] no inline event handlers (nothing to strip)');
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

// The shell's markup carries NO inline event handlers. React rejects them
// (it warns, a warning is a console.error, and a console.error on any route
// fails the platform's proposal checks), so if one ever reappears it needs an
// edit here — or better, a binding in the module that owns the element.
//
// There was exactly one when this migration started:
// `onclick="location.reload()"` on #platform-updating-reload. It is gone —
// main removed the whole platform-updating banner in #1015/#1018 — so the
// edit that stripped it is gone too, and so is the parity-test exception it
// needed. Nothing to do.
assertNoInlineHandlers();

// ── 2 & 3. Uncontrolled form fields ────────────────────────────────────
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
