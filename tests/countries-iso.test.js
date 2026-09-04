// src/services/countries.js — the country table itself, as a contract.
//
// WHY THIS FILE EXISTS. The waitlist picker's countries used to be ~50 codes
// in six region buckets. #1527 (and feedback triage item #18) replaced them
// with the complete ISO 3166-1 list, and three properties of the new table
// are the kind that decay silently rather than breaking a page:
//
//   1. COMPLETENESS. The bug was "Uruguay is not in the list". A table that
//      quietly loses a row reintroduces exactly that report, and no rendered
//      screen looks wrong when it happens.
//   2. ORDER. The entries are authored already sorted by English name, so
//      insertion order IS display order and nothing sorts at runtime. Hand
//      editing is what maintains that, and a name inserted in the wrong place
//      renders fine.
//   3. THE PSEUDO-CODE SPLIT, which is the subtle part of the whole change:
//      of the five retired region catch-alls, `LA`, `AF` and `ME` are real
//      ISO codes (Laos, Afghanistan, Montenegro) and are now ACCEPTED as
//      those countries, while `EU` and `AP` are not ISO codes at all and are
//      rejected. That asymmetry is why the stored legacy answers had to be
//      namespaced to `X-*` by a migration.
//
// It also pins the server's countryLabel() against the admin bundle's copy —
// the one piece of logic that is written twice (see countries.ts's header for
// why the data is not).
//
// Run with: node --test tests/countries-iso.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ISO_COUNTRIES, LEGACY_REGION_LABELS, countryLabel } = require('../src/services/countries');
const q = require('../src/services/waitlist-questions');

// ─── 1. Completeness ──────────────────────────────────────────────────

test('the table is the complete officially assigned ISO 3166-1 alpha-2 set', () => {
  const codes = Object.keys(ISO_COUNTRIES);
  assert.equal(codes.length, 249, 'ISO 3166-1 currently assigns 249 alpha-2 codes');
  for (const code of codes) {
    assert.match(code, /^[A-Z]{2}$/, `${code} is an upper-case alpha-2 code`);
    assert.equal(typeof ISO_COUNTRIES[code], 'string');
    assert.ok(ISO_COUNTRIES[code].length > 0, `${code} has a name`);
  }
  assert.equal(new Set(codes).size, codes.length, 'no code appears twice');
});

// The named casualties of the old curated list. Uruguay is the one the
// report was filed about; the rest are places whose absence or misfiling was
// cited alongside it, plus the two the old Europe bucket buried.
test('the countries the region buckets left out are all selectable now', () => {
  const expected = {
    UY: 'Uruguay',
    CH: 'Switzerland',
    LI: 'Liechtenstein',
    BD: 'Bangladesh',
    NP: 'Nepal',
    ET: 'Ethiopia',
    UZ: 'Uzbekistan',
  };
  for (const [code, name] of Object.entries(expected)) {
    assert.equal(ISO_COUNTRIES[code], name, `${code} is present as "${name}"`);
  }
});

test('no two entries share a name, so every option is distinguishable', () => {
  const names = Object.values(ISO_COUNTRIES);
  const seen = new Map();
  for (const [code, name] of Object.entries(ISO_COUNTRIES)) {
    assert.ok(!seen.has(name), `"${name}" is used by both ${seen.get(name)} and ${code}`);
    seen.set(name, code);
  }
  assert.equal(seen.size, names.length);
});

// ─── 2. Order ─────────────────────────────────────────────────────────

// Insertion order is what the <select> renders, so the file has to BE sorted.
// The comparison uses localeCompare only to check the authored order — the
// module itself never sorts, deliberately, so the picker's order changes in a
// reviewed diff rather than on a Node/ICU bump.
test('entries are authored in English-name order, which is display order', () => {
  const codes = Object.keys(ISO_COUNTRIES);
  const sorted = [...codes].sort((a, b) =>
    ISO_COUNTRIES[a].localeCompare(ISO_COUNTRIES[b], 'en'));
  assert.deepEqual(codes, sorted, 'the JSON is out of order somewhere');

  // Spot-check the four places where the collation is not obvious from the
  // bytes: a leading Å, a dotted Ü, a circumflex, and a plain adjacency.
  const at = (name) => codes.indexOf(Object.keys(ISO_COUNTRIES)
    .find((c) => ISO_COUNTRIES[c] === name));
  assert.ok(at('Afghanistan') < at('Åland Islands'), 'Å sorts as A');
  assert.ok(at('Åland Islands') < at('Albania'));
  assert.ok(at('Tunisia') < at('Türkiye'), 'Ü sorts as U');
  assert.ok(at('Türkiye') < at('Turkmenistan'));
  assert.ok(at('Costa Rica') < at("Côte d'Ivoire"));
  assert.ok(at("Côte d'Ivoire") < at('Croatia'));
  assert.ok(at('United States Virgin Islands') < at('Uruguay'));
});

test('the client renders the map as-is, so the served options keep that order', () => {
  assert.deepEqual(Object.keys(q.publicOptions().countries), Object.keys(ISO_COUNTRIES));
  assert.deepEqual(q.countryCodes(), Object.keys(ISO_COUNTRIES));
});

// ─── 3. The retired pseudo-codes ──────────────────────────────────────

test('the five retired region catch-alls are labelled but never offered', () => {
  assert.deepEqual(Object.keys(LEGACY_REGION_LABELS), ['X-EU', 'X-LA', 'X-AF', 'X-ME', 'X-AP']);
  for (const key of Object.keys(LEGACY_REGION_LABELS)) {
    assert.equal(key in ISO_COUNTRIES, false, `${key} is not a selectable country`);
    assert.equal(q.countryCodes().includes(key), false, `${key} is not offered by the form`);
  }
});

// THE SUBTLE PART. Three of the five old pseudo-codes are real ISO codes and
// now mean the country, not the region — which is the whole reason the stored
// answers had to be namespaced rather than left alone.
test('LA, AF and ME are countries now; EU and AP were never ISO codes', () => {
  assert.equal(ISO_COUNTRIES.LA, 'Laos');
  assert.equal(ISO_COUNTRIES.AF, 'Afghanistan');
  assert.equal(ISO_COUNTRIES.ME, 'Montenegro');
  for (const code of ['LA', 'AF', 'ME']) {
    const r = q.validateStage1({ country: code });
    assert.equal(r.ok, true, `${code} is accepted`);
    assert.equal(r.value.country, code);
  }

  assert.equal('EU' in ISO_COUNTRIES, false);
  assert.equal('AP' in ISO_COUNTRIES, false);
  for (const code of ['EU', 'AP', 'ZZ']) {
    const r = q.validateStage1({ country: code });
    assert.equal(r.ok, false, `${code} is rejected`);
    assert.equal(r.error, 'Unknown country.');
  }
});

test('a submitted code is normalized to upper case and validated against the table', () => {
  const r = q.validateStage1({ country: 'uy' });
  assert.equal(r.ok, true);
  assert.equal(r.value.country, 'UY');
});

// ─── 4. countryLabel ──────────────────────────────────────────────────

// It renders untrusted stored values on the admin screen, so "never throws"
// is a property and not a nicety: a legacy row can hold anything.
const LABEL_CASES = [
  ['DE', 'Germany'],
  ['UY', 'Uruguay'],
  ['LA', 'Laos'],
  ['X-LA', 'Elsewhere in Latin America (region)'],
  ['X-EU', 'Elsewhere in Europe (region)'],
  ['X-AF', 'Elsewhere in Africa (region)'],
  ['X-ME', 'Elsewhere in the Middle East (region)'],
  ['X-AP', 'Elsewhere in Asia-Pacific (region)'],
  ['Elsewhere', 'Elsewhere'],
  ['de', 'de'],
  ['', ''],
  [null, ''],
  [undefined, ''],
  ['constructor', 'constructor'],
  ['toString', 'toString'],
  [42, '42'],
];

test('countryLabel maps codes, marks retired regions, and echoes anything else', () => {
  for (const [input, expected] of LABEL_CASES) {
    assert.equal(countryLabel(input), expected, `countryLabel(${JSON.stringify(input)})`);
  }
});

// The data is shared (one countries.json), but this function is written twice
// — once for CommonJS on the server, once for the admin bundle. Run both.
test('the admin bundle copy of countryLabel agrees with the server copy', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const client = loadTsx('frontend/src/features/admin/topochain/countries.ts');

  assert.deepEqual(client.ISO_COUNTRIES, ISO_COUNTRIES, 'both read the same table');
  assert.deepEqual(client.LEGACY_REGION_LABELS, LEGACY_REGION_LABELS);
  for (const [input] of LABEL_CASES) {
    assert.equal(client.countryLabel(input), countryLabel(input),
      `the two copies disagree on ${JSON.stringify(input)}`);
  }
});
