// OpenMoji lookup for the subtle-y2k theme's illustrated app icons.
//
// The platform vendors a CURATED slice of the OpenMoji color set under
// /vendor/openmoji/ (CC BY-SA 4.0 — provenance and attribution in
// public/vendor/README.md). openmoji-manifest.json beside this file is
// written by `npm run vendor:assets` and lists every vendored
// codepoint-sequence, so membership here is exactly "the file exists" —
// anything not listed keeps the platform's plain text-emoji rendering.
// A miss is a soft degrade by design: app icon emojis are user data, and
// no curated slice can cover all of Unicode.
//
// OpenMoji names files by UPPERCASE hex codepoints joined with '-'. Single
// glyphs drop the FE0F variation selector ('2764.svg' for ❤️) while keycap
// and ZWJ sequences keep it, so the lookup tries the full sequence first,
// then the FE0F-stripped one — mirroring scripts/vendor-assets.js, which
// resolves the same way against the real package at vendor time.
//
// A .js module (not .ts) on purpose: features/apps/app-card.js consumes it,
// and the vm test harness (tests/helpers/app-card.js) evaluates that file as
// classic script text with its import lines stripped, binding each imported
// name by evaluating ITS source into the same context first — which only
// works for sources a vm can parse.

import manifest from './openmoji-manifest.json';

const OPENMOJI_ICONS = new Set(manifest.icons);

function openmojiCandidates(emoji) {
  const cps = [...emoji].map((ch) =>
    ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
  const full = cps.join('-');
  const stripped = cps.filter((cp) => cp !== 'FE0F').join('-');
  return full === stripped ? [full] : [full, stripped];
}

/**
 * The same-origin URL of the vendored OpenMoji SVG for `emoji`, or null when
 * the curated slice doesn't cover it (render the text emoji instead).
 * @param {string} emoji
 * @returns {string | null}
 */
export function openmojiSrcFor(emoji) {
  if (!emoji || typeof emoji !== 'string') return null;
  const name = openmojiCandidates(emoji.trim()).find((n) => OPENMOJI_ICONS.has(n));
  return name ? `/vendor/openmoji/${name}.svg` : null;
}
