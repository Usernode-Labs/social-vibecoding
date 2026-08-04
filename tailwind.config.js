// Tailwind config for the platform shell's COMPILED stylesheet.
//
// This is a verbatim port of the inline `tailwind.config` that used to sit
// next to the `https://cdn.tailwindcss.com` script tag in
// public/index.html. The Play CDN compiled utilities in the browser on
// every page load; we now compile them once at build time into
// public/css/tailwind.css (see scripts/build-tailwind.js) and commit that
// artifact, so the shell has no cross-origin asset requests at all.
//
// Pinned to tailwindcss 3.4.17 — the exact version the Play CDN resolved
// to (cdn.tailwindcss.com 302s to /3.4.17), so the compiled output matches
// what the browser was generating utility-for-utility. Do NOT jump to v4
// here: it changes utility semantics (default border colour, ring width,
// opacity utilities, `space-*` selector) and would silently restyle the
// whole shell. The React shell migration adopts v4 in its own frontend/
// tree instead.
//
// AFTER EDITING THIS FILE (or any scanned markup) RUN `npm run build:css`.
// tests/tailwind-build.test.js stamps the output with a hash of every
// input and fails the suite when the committed CSS is stale.
module.exports = {
  // Every surface that gets its utilities from the compiled stylesheet.
  // index.html + the shell's JS (which builds markup as template strings)
  // + the usernode-native kit's demo page, which also loads
  // /css/tailwind.css now.
  content: [
    './public/index.html',
    './public/js/**/*.js',
    './public/usernode-native/v1/demo.html',
  ],

  // Every class name in the shell is a COMPLETE literal in source — the
  // conditional ones are whole strings picked out of maps/ternaries (see
  // the CHIP/BADGES tables in admin-gallery.js, admin-merges.js,
  // app-secrets.js, …), never assembled from fragments like `bg-${tone}-500`.
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
