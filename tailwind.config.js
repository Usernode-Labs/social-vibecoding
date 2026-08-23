// Tailwind config for the platform shell's COMPILED stylesheet.
//
// This is a verbatim port of the inline `tailwind.config` that used to sit
// next to the `https://cdn.tailwindcss.com` script tag in
// public/index.html. The Play CDN compiled utilities in the browser on
// every page load; we now compile them once per image build into
// public/css/tailwind.css (see Dockerfile and scripts/build-tailwind.js), so
// the shell has no cross-origin asset requests and the generated file never
// needs to be committed.
//
// Pinned to tailwindcss 3.4.17 — the exact version the Play CDN resolved
// to (cdn.tailwindcss.com 302s to /3.4.17), so the compiled output matches
// what the browser was generating utility-for-utility. Do NOT jump to v4
// here: it changes utility semantics (default border colour, ring width,
// opacity utilities, `space-*` selector) and would silently restyle the
// whole shell. The React shell migration adopts v4 in its own frontend/
// tree instead.
//
// Docker compiles after copying every scanned source. For local browser work,
// run `npm run build:css`; tests/tailwind-build.test.js also performs a fresh
// compile into a temporary directory and validates the result.
module.exports = {
  // Every surface that gets its utilities from the compiled stylesheet.
  // index.html + the shell's JS (which builds markup as template strings)
  // + the usernode-native kit's demo page, which also loads
  // /css/tailwind.css now.
  content: [
    './public/index.html',
    './public/js/**/*.js',
    './public/usernode-native/v1/demo.html',
    // The React chassis. public/index.html is generated FROM these sources
    // now, so scanning it alone would still find every class in the shell —
    // but shadcn primitives under frontend/@/components/ui hold classes in
    // `cva` variant tables that only some call sites use, and a step-2
    // component will hold classes that appear in no static markup at all.
    // Scan the source, not just the artifact.
    './frontend/src/**/*.{ts,tsx}',
    './frontend/@/**/*.{ts,tsx}',
    // The legacy modules step 2 has MOVED into that tree (features/settings/
    // settings.js, features/admin/admin-*.js, …). They are the same
    // template-string DOM builders they were under public/js/**, so they hold
    // the same class literals, and this glob is the only thing that keeps them
    // in the scan after the move — the admin console alone is ~12k lines of
    // them, and losing it would strip the whole console's styling with no
    // error anywhere.
    './frontend/src/**/*.js',
  ],

  // Every class name in the shell is a COMPLETE literal in source — the
  // conditional ones are whole strings picked out of maps/ternaries (see
  // the CHIP/BADGES tables in features/admin/admin-gallery.js,
  // features/admin/admin-merges.js, app-secrets.js, …), never assembled from
  // fragments like `bg-${tone}-500`.
  // That's what makes a compiled stylesheet safe here: Tailwind's extractor
  // is a regex over source text and finds all of them.
  //
  // If a future change ever does build a class name dynamically, add the
  // resulting classes here rather than reaching back for the CDN. Note that
  // classes arriving from *content* (sanitized markdown allows `class`, see
  // renderMarkdown in public/js/dev-chat.js) are deliberately NOT
  // safelisted — message content should not be able to restyle the shell.
  safelist: [],

  darkMode: 'class',
  future: { hoverOnlyWhenSupported: true },
  // ── The widget-language palette (step 1 of the reskin) ──────────────
  //
  // THE SCALE NAMES ARE DELIBERATELY UNCHANGED; ONLY THE VALUES MOVED.
  // `zinc-*` is no longer a violet-tinted grey and `violet-*` is no longer
  // violet — they are the new language's neutral ramp and its blue accent.
  // That reads wrong at first glance and is still the right call:
  //
  //   * ~80k lines across frontend/src/**, frontend/@/** and public/js/**
  //     spell these scales as complete class literals (`bg-zinc-900`,
  //     `text-violet-400`). Re-keying them to `neutral-*`/`blue-*` would be a
  //     rename touching every one of those literals — an enormous diff whose
  //     rendered output is identical to this four-line one.
  //   * tests/admin-ui-registry.test.js keeps the two design systems apart BY
  //     PALETTE NAME: the shell must read `zinc-`/`violet-` and the admin
  //     console `gray-`/`indigo-`. Re-keying the shell's scales would erase
  //     the boundary that test exists to defend.
  //
  // So the scale name is now an IDENTITY ("the shell's neutral", "the shell's
  // accent"), not a hue. Read the hex, not the key. The admin console is
  // untouched and stays gray/indigo — see the "Two design systems" rule in
  // AGENTS.md.
  //
  // Values are eyedropped from the design screenshots and are EXPECTED TO BE
  // CORRECTED against the real source tokens; they are anchored deliberately
  // at three points and interpolated between:
  //   zinc-100  the page background the cards float on
  //   zinc-400  secondary label text ("Private, 3m ago agent finished")
  //   violet-600  the outgoing message bubble — CORRECTED from the eyedropped
//               #0a7cff to #0a6ee0, because white on the original is 3.93:1
//               and so is the original as ink on white. See the note beside
//               --accent in public/css/app.css.
  theme: { extend: {
    colors: {
      zinc: { 50:'#f5f5f7',100:'#eaeaea',200:'#e3e3e6',300:'#c7c7cc',400:'#8e8e93',500:'#6c6c70',600:'#48484a',700:'#3a3a3c',800:'#2c2c2e',900:'#1c1c1e',950:'#0b0b0c' },
      // The FULL ramp, deliberately. The pre-reskin config pinned only
      // 400/500/600/700, so 280 call sites using violet-50 (191 of them),
      // -100, -200, -300, -800, -900 and -950 were quietly rendering STOCK
      // Tailwind violet all along. That was invisible while the pinned shades
      // were violet too; against a blue accent every one of them would have
      // read as a stray purple tint. Closing the ramp is what makes the
      // remap total rather than partial.
      violet: {
        50:'#eaf4ff',100:'#d6e9ff',200:'#b3d6ff',300:'#85bcff',400:'#5aa9ff',
        500:'#1f86ff',600:'#0a6ee0',700:'#0062cc',800:'#004fa3',900:'#003b7a',950:'#00264d',
      },
    },
    // The language is markedly rounder than the shell was. Remapping the
    // scale rather than editing call sites rounds every existing
    // `rounded-lg`/`rounded-xl` up one step at once, with no class churn.
    // `rounded-full` is untouched (pills stay pills).
    borderRadius: { lg: '0.75rem', xl: '1rem', '2xl': '1.25rem', '3xl': '1.5rem' },
  } },
};
