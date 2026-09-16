'use strict';

// #1873: the platform is called Homeroom. "Usernode" survives in three
// legitimate roles and must NOT be swept up with the brand:
//
//   1. THE NODE. A usernode is the block-producing node a member runs. The
//      Settings section, `UsernodeSectionState`, `_retryUsernodeConnection`
//      and the whole wallet/chain vocabulary mean that, not the platform.
//   2. IDENTIFIERS. `usernode-bridge`, `usernode-native`, `usernode-tailwind`,
//      `UsernodeReact`, `window.usernode`, `USERNODE_*` env vars. These are
//      wire format and URL space; renaming them breaks every deployed app.
//   3. THE GITHUB ORG. `Usernode-Labs/...` is where the code actually lives.
//
// What is left — natural-language copy a PERSON READS that names the product
// — is the brand, and it should say Homeroom. This test pins the strings the
// rename touched so they cannot drift back, and asserts the three categories
// above are untouched so a future sweep cannot "fix" them.
//
// Run with: node --test tests/platform-brand-strings.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// The bridge ships as two identical committed copies: the versioned URL every
// app loads, and the legacy flat path. A change to one that misses the other
// would serve two different texts from one origin.
const BRIDGE_COPIES = ['public/usernode-bridge/v1/bridge.js', 'public/usernode-bridge.js'];

test('the chromeless "Open in" pill names the platform', () => {
  for (const p of BRIDGE_COPIES) {
    const src = read(p);
    assert.match(src, /label\.textContent = "Open in Homeroom";/, `${p}: visible label`);
    assert.match(src, /"aria-label", "Open this app on Homeroom"/, `${p}: accessible name`);
    assert.doesNotMatch(src, /Open in Usernode|Open this app on Usernode/, `${p}: no stale brand`);
  }
});

test('the two committed bridge copies stay byte-identical', () => {
  const [a, b] = BRIDGE_COPIES.map(read);
  assert.equal(a, b, 'edit both copies or neither');
});

test('the headless-run copy names the platform', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /Uses your available Homeroom credits\./);
  assert.match(src, /Homeroom will inspect the issue and repository/);
  assert.doesNotMatch(src, /available Usernode credits|Usernode will inspect/);
});

test('the node, the identifiers and the org are NOT renamed', () => {
  // The node concept — Settings' own section is about the member's node.
  const settings = read('frontend/src/features/settings/sections/usernode.tsx');
  assert.match(settings, /UsernodeSectionState/, 'the node section keeps its name');

  // Identifiers: the URL space every deployed app already loads.
  const bridge = read(BRIDGE_COPIES[0]);
  assert.match(bridge, /__un-platform-link/, 'kit class names are wire format');

  // The GitHub org is where the code is, not what the product is called.
  assert.match(read('public/js/app.js'), /github\.com\/Usernode-Labs\/social-vibecoding/);

  // The connector allow-rule blocks deliberately cover the PRE-RENAME
  // spellings so an older tool name keeps working; that is compatibility,
  // not a miss.
  assert.match(read('frontend/src/features/settings/sections/connectors.tsx'),
    /pre-rename `usernode` and `Usernode`/);
});
