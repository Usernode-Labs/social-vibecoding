// Country labels for the admin Waitlist screen.
//
// `waitlist_signups.answers.country` stores a code, not a name, so the
// "Survey answers" disclosure used to render a bare `DE` or `LA`. This turns
// a stored value into something an admin can read.
//
// ── Why the data is imported rather than mirrored ───────────────────────
//
// The table itself is src/services/countries.json — the SAME file the server
// reads. It is JSON, not the CommonJS src/services/countries.js beside it,
// precisely so this import works: Vite's commonjs transform only covers
// node_modules, so a source .js module using `module.exports` would resolve
// to nothing here, whereas a .json import is native to both bundlers and to
// node's `require`. One copy of 249 names, no mirror to drift.
//
// countryLabel() below is the one thing that IS written twice (the server's
// copy lives in src/services/countries.js). tests/countries-iso.test.js runs
// both against the same inputs so the two cannot disagree.

import data from '../../../../../src/services/countries.json';

/** All 249 ISO 3166-1 alpha-2 codes, in display order. */
export const ISO_COUNTRIES: Record<string, string> = data.iso;

/** The five retired region catch-alls, namespaced. Display-only. */
export const LEGACY_REGION_LABELS: Record<string, string> = data.legacy_regions;

/**
 * A stored answer as text: the country's name, a retired region (suffixed so
 * it is never read as a specific country), or the raw value when it is
 * neither — legacy rows can hold arbitrary free text here, and an
 * unrecognised value is shown exactly as stored rather than hidden.
 */
export function countryLabel(stored: unknown): string {
  if (stored == null) return '';
  const key = String(stored);
  if (Object.prototype.hasOwnProperty.call(ISO_COUNTRIES, key)) return ISO_COUNTRIES[key];
  if (Object.prototype.hasOwnProperty.call(LEGACY_REGION_LABELS, key)) {
    return `${LEGACY_REGION_LABELS[key]} (region)`;
  }
  return key;
}
