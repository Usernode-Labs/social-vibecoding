// The Workshop's three model stages (services/llm.js) each carry a prompt
// version, WORKSHOP_*_VERSION, that services/workshop-themes.js records on
// the row and re-runs the stage for when it moves. The version only helps if
// it is bumped when the prompt changes, and nothing about a template string
// reminds you. So this test pins a hash of each builder's SOURCE to its
// version: edit the prompt without touching the constant and it fails here,
// naming the constant to raise.
//
// Two ways to make it pass, and both are decisions this test exists to force:
//   * the prompt's meaning changed → bump the constant in llm.js and record
//     the new version with its hash below (keep the old pair: it is the
//     changelog). Know the cost — a discovery bump re-drafts every recently
//     viewed app's categories under its members, a placement bump re-places
//     every card in batches, a digest bump is one short call per app;
//   * the edit was cosmetic (a comment, a typo, a rename) → re-pin the hash
//     on the current version and bump nothing.
//
// The hash covers the whole builder, its call parameters included: a
// max_tokens or effort change alters the output too, and deserves the same
// decision. A comment inside the builder trips it as well; that is a small
// price for never shipping a prompt the rows do not know about.
//
// Run with: node --test tests/workshop-prompt-versions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const llm = require('../src/services/llm');

const STAGES = {
  discovery: {
    constant: 'WORKSHOP_DISCOVERY_VERSION',
    builder: llm.generateWorkshopThemeDefinitions,
    // version → hash of the builder's source at that version
    pinned: { 1: '9561f5061d176cc6' },
  },
  placement: {
    constant: 'WORKSHOP_PLACEMENT_VERSION',
    builder: llm.placeWorkshopItems,
    pinned: { 1: 'd82abd8a00088937' },
  },
  digest: {
    constant: 'WORKSHOP_DIGEST_VERSION',
    builder: llm.generateWorkshopDigest,
    // 1 was the two-sentence prompt the columns grandfather; 2 is the
    // rewrite around what a user notices (#1820), and the first bump.
    pinned: { 2: '14c1ca1864a4fb96' },
  },
};

function hashOf(fn) {
  return crypto.createHash('sha256').update(fn.toString()).digest('hex').slice(0, 16);
}

for (const [stage, spec] of Object.entries(STAGES)) {
  test(`the ${stage} prompt's version matches its source`, () => {
    const version = llm[spec.constant];
    assert.ok(Number.isInteger(version) && version >= 1, `${spec.constant} must be a positive integer`);
    const actual = hashOf(spec.builder);
    const expected = spec.pinned[version];
    assert.ok(expected,
      `${spec.constant} is ${version} but no hash is pinned for it in tests/workshop-prompt-versions.test.js: `
      + `add \`${version}: '${actual}'\` to the ${stage} entry.`);
    assert.equal(actual, expected,
      `The ${stage} builder in src/services/llm.js changed but ${spec.constant} is still ${version}. `
      + `If the prompt's meaning changed, bump ${spec.constant} to ${version + 1} and pin \`${version + 1}: '${actual}'\` `
      + `for ${stage} (every app re-runs that stage on its next pass). If the edit was cosmetic, re-pin `
      + `\`${version}: '${actual}'\` and leave the constant alone.`);
  });
}

test('the versions the row is compared against are the ones the builders export', () => {
  // services/workshop-themes.js reads llm.WORKSHOP_*_VERSION; a rename in one
  // place and not the other would make every row read as current forever.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/workshop-themes.js'), 'utf8');
  for (const spec of Object.values(STAGES)) {
    assert.match(src, new RegExp(`llm\\.${spec.constant}\\b`), `${spec.constant} is read by the service`);
  }
  // And each is stamped by the row write, so the version on the row can only
  // ever be one the code has had.
  assert.match(src, /discovery_version = CASE WHEN \$7::boolean THEN \$15::integer/);
  assert.match(src, /placement_version = CASE WHEN \$16::boolean THEN \$17::integer/);
  assert.match(src, /digest_version = CASE WHEN \$13::boolean THEN \$18::integer/);
  const schema = require('node:fs').readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  for (const col of ['discovery_version', 'placement_version', 'digest_version']) {
    assert.match(schema, new RegExp(`ADD COLUMN IF NOT EXISTS ${col} INTEGER NOT NULL DEFAULT 1;`),
      `${col} defaults to 1 so the rows from before it existed are grandfathered`);
  }
});
