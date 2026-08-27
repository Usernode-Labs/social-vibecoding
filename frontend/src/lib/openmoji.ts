/**
 * OpenMoji — the product's ILLUSTRATED icon tier.
 *
 * BRAND KIT 2026 draws its icons as chunky outlined marks, not line glyphs
 * (its Icons board, and the landing page's feature cards). This module is the
 * two-tier icon system that follows from that:
 *
 *   Lucide    16–20px system glyphs — chevrons, close, search, inline marks.
 *             An illustrated icon at 16px is mud, so this tier never changes.
 *   OpenMoji  32px+ marks with room to speak — app tiles, card type marks,
 *             empty states.
 *
 * ── Why this is a CORRECTNESS fix, not only a styling one ──────────────
 *
 * App icons are emoji CHARACTERS (`apps.icon_emoji`), and the shell rendered
 * them as text. Text emoji are painted by the platform's own font, so the
 * launcher — the most-looked-at surface in the product — rendered as Apple
 * emoji on macOS, Segoe on Windows and Noto on Android, matching the brand on
 * none of them. Serving the glyph as an <img> makes the launcher identical
 * everywhere AND on-brand.
 *
 * ── The subset, and the fallback that makes a subset safe ──────────────
 *
 * The package ships 11,458 SVGs; vendoring all of them would put ~12 MB of
 * artwork in the image for a handful of glyphs. An app author can pick ANY
 * emoji, so a subset can never be complete — which is exactly why the
 * fallback is the load-bearing part rather than an afterthought: an
 * unvendored pick renders the plain text emoji, i.e. precisely today's
 * behaviour. The feature degrades to the status quo, never to a broken image.
 *
 * Licensed CC BY-SA 4.0 — see public/vendor/README.md. Attribution is
 * required, and any icon we MODIFY must itself ship CC BY-SA. We ship them
 * unmodified.
 */

/**
 * Emoji character → OpenMoji filename stem.
 *
 * OpenMoji names a file by its codepoints, uppercase hex, hyphen-joined:
 * 🚀 = `1F680`, 🏗️ = `1F3D7`, 👩‍💻 = `1F469-200D-1F4BB`.
 *
 * VARIATION SELECTOR handling is the subtle part, and it is the opposite of
 * the obvious guess. U+FE0F asks for the emoji presentation of a codepoint
 * that also has a text form; OpenMoji DROPS it from the filename — 🏗️ is
 * U+1F3D7 U+FE0F and its file is `1F3D7.svg`, not `1F3D7-FE0F.svg`. ZWJ
 * (U+200D) is KEPT, so 👩‍💻 is `1F469-200D-1F4BB.svg`.
 *
 * Both halves verified against the pinned CDN rather than inferred; the
 * vendor step fails loudly on a stem with no artwork, which is how the first
 * version of this function (which kept FE0F) was caught.
 */
export function openmojiStem(emoji: string): string | null {
  if (!emoji) return null;
  const points: string[] = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) return null;
    if (cp === 0xfe0f) continue; // see the note above
    points.push(cp.toString(16).toUpperCase().padStart(4, '0'));
  }
  return points.length ? points.join('-') : null;
}

/**
 * The vendored set, as filename stems. Kept in step BY HAND with
 * OPENMOJI_STEMS in scripts/vendor-assets.js, and held there by
 * tests/openmoji-subset.test.js — the renderer and the fetcher disagreeing is
 * the one failure this feature has that the text fallback cannot absorb,
 * because a stem listed here but never fetched renders a broken image rather
 * than a character.
 *
 * Deliberately NOT a wildcard or a fetch-and-see: a missing file would 404 on
 * every render of that tile, and the whole point of the fallback is that a
 * miss is silent and cheap.
 */
export const VENDORED: ReadonlySet<string> = new Set([
  // In use by apps on the platform today.
  '1F9EA', '1FA90', '1F3D7', '1F524', '1F319', '1F9FE', '1F4CD',
  // The dev board's card-type marks (see DEV_CARD_ICONS in public/js/app-view.js).
  '1F44D', '1F511', '2705', '1F4C4',
  // A small buffer of the picks an app author reaches for first.
  '1F680', '2728', '1F4A1', '1F4CA', '1F4C8', '1F4DD', '1F4C5', '1F4CB',
  '1F3AF', '1F3AE', '1F3B2', '1F3B5', '1F3A8', '1F4F7', '1F4F1', '1F4BB',
  '1F5A5', '2699', '1F527', '1F528', '1F9F0', '1F50D', '1F513',
  '1F512', '1F4E6', '1F6D2', '1F4B0', '1F4B3', '1F3E0', '1F3E2', '1F5FA',
  '1F30D', '1F326', '2600', '1F331', '1F333', '1F340', '1F41B',
  '1F436', '1F431', '1F418', '1F984', '1F995', '2764', '2B50', '1F31F',
  '26A1', '1F525', '1F3C6', '1F947', '1F393', '1F4DA', '1F4D6', '270F',
  '1F58A', '1F4CE', '1F517', '1F5D3', '23F0', '231A', '1F553',
  '1F4AC', '1F4E3', '1F514', '1F4EC', '2709', '1F310', '1F6F0',
  '1F52C', '1F52D', '1F9EC', '1F9E0', '1F916', '1F47E', '1F3AA', '1F3AD',
  '1F3B8', '1F3BA', '1F374', '2615', '1F355', '1F34E', '1F95A', '1F9C1',
  '1F6B2', '2708', '1F697', '1F686', '26F5', '1F3D5', '1F3D6',
  '26F0', '1F30A', '1F3C3', '1F9D8', '1F3CB', '26BD', '1F3C0',
]);

/** Where `npm run vendor:assets` writes them, and the shape the served path takes. */
export const OPENMOJI_BASE = '/vendor/openmoji';

/**
 * The served URL for an emoji, or null when it is not in the vendored set.
 * A null here is the caller's cue to render the plain character — see the
 * fallback note in the header.
 */
export function openmojiUrl(emoji: string): string | null {
  const stem = openmojiStem(emoji);
  if (!stem || !VENDORED.has(stem)) return null;
  return `${OPENMOJI_BASE}/${stem}.svg`;
}
