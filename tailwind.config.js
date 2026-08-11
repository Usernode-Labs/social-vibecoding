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
  theme: { extend: { colors: {
    zinc: { 50:'#f6f6fb',100:'#eeeef6',200:'#d4d4e4',300:'#b0b0c8',400:'#9898b0',500:'#6e6e8a',600:'#4e4e6a',700:'#484870',800:'#2e2e50',900:'#1a1a30',950:'#08080f' },
    violet: { 400:'#a78bfa',500:'#8b5cf6',600:'#7c3aed',700:'#6d28d9' },
  } } },
};
