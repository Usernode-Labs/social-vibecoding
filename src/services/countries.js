// src/services/countries.js — the country list the waitlist picker renders
// from and validates against.
//
// ── Why this module exists ──────────────────────────────────────────────
//
// The waitlist's Country dropdown used to be ~50 hand-curated countries in
// six region buckets, with an "Elsewhere in <region>" catch-all at the foot
// of five of them. Two reports killed that shape (GitHub issue #1527 plus
// feedback triage item #18): Uruguay — and roughly two hundred other
// countries and territories — could not be selected at all, and finding the
// ones that WERE there meant knowing which region bucket somebody had filed
// them under (Switzerland sits tenth down under Europe, not where an
// alphabetical scan looks).
//
// So the list is now the complete ISO 3166-1 set, flat and alphabetical, and
// it lives here rather than in waitlist-questions.js so a 249-entry table
// does not swamp the survey definitions.
//
// ── The data ────────────────────────────────────────────────────────────
//
// countries.json holds the table itself, in ONE file both the server (CommonJS
// `require`) and the admin console's React bundle (a JSON import — Vite's
// commonjs transform does not reach source .js files outside node_modules,
// so a shared CJS module would not have loaded there) can read. One copy of
// 249 names, no mirror to keep in sync.
//
// Three properties the data is authored for, each pinned by
// tests/countries-iso.test.js:
//
//   1. KEY ORDER IS DISPLAY ORDER. The entries are authored already sorted by
//      English name, and every key is non-numeric, so both V8 object literals
//      and JSON.parse preserve insertion order. The client renders
//      Object.entries() straight into <option>s.
//   2. THE ORDER IS BAKED IN, not computed. Sorting at runtime would tie the
//      picker's order to whatever ICU data the Node image happens to ship;
//      the order should change in a reviewed diff, never on a Node bump.
//   3. THE NAMES ARE COMMON ENGLISH SHORT FORMS — `United States`,
//      `South Korea`, `Vietnam`, `Türkiye`, `Czechia` — the ones the curated
//      list already used, not ISO's inverted formal forms ("Korea, Republic
//      of"), which sort where nobody looks. They are NOT generated from
//      Intl.DisplayNames either: CLDR renames territories between releases
//      (that is how "Turkey" became "Türkiye") and this picker's labels
//      should only ever move in a reviewed diff.
//
// ── The retired pseudo-codes ────────────────────────────────────────────
//
// The five region catch-alls stored `EU`, `LA`, `AF`, `ME`, `AP`. Three of
// those collide with real ISO codes — LA is Laos, AF is Afghanistan, ME is
// Montenegro — so leaving them as-is would make a past "somewhere in Latin
// America" answer indistinguishable from a future Laos signup. A one-time
// migration (migrateWaitlistCountryCodes in src/db/migrate.js) namespaces the
// stored values to `X-EU` … `X-AP`, and LEGACY_REGION_LABELS below is how
// they are still shown to admins. They are display-only: never offered in the
// picker, never accepted as input — and structurally unsubmittable anyway,
// because validateStage1 caps the field at two characters.
'use strict';

const data = require('./countries.json');

/**
 * All 249 officially assigned ISO 3166-1 alpha-2 codes → English name,
 * in display (alphabetical-by-name) order.
 */
const ISO_COUNTRIES = Object.freeze({ ...data.iso });

/**
 * The five retired region catch-alls, namespaced so they cannot collide with
 * a real ISO code. Display-only.
 */
const LEGACY_REGION_LABELS = Object.freeze({ ...data.legacy_regions });

/**
 * Resolve a STORED answer for display: a real country name, a retired region
 * (suffixed so it is never mistaken for a specific country), or the raw value
 * unchanged when it is neither.
 *
 * Never throws and never assumes two characters — legacy topochain rows can
 * hold arbitrary free text in this field.
 */
function countryLabel(stored) {
  if (stored == null) return '';
  const key = String(stored);
  if (Object.prototype.hasOwnProperty.call(ISO_COUNTRIES, key)) return ISO_COUNTRIES[key];
  if (Object.prototype.hasOwnProperty.call(LEGACY_REGION_LABELS, key)) {
    return `${LEGACY_REGION_LABELS[key]} (region)`;
  }
  return key;
}

module.exports = { ISO_COUNTRIES, LEGACY_REGION_LABELS, countryLabel };
