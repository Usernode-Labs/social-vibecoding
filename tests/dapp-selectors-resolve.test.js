// A pure-Node pre-flight for dapp.json's declared UI tests.
//
// dapp.json declares 227 tests across ~100 routes, and a proposal whose
// checks aren't passing is BLOCKED from merging. Each test's `expectSelector`
// is a deep structural chain against the shell's real ids and visibility
// classes, e.g.
//
//   #leaderboard-screen:not(.hidden) #challenges-root:not(.hidden)
//     #tc-se-grid #tc-se-challenge-summary
//
// That suite is the most precise specification the shell has: it pins ids,
// ancestor nesting, `.hidden` semantics and data-* attributes far harder than
// any prose. But finding out you broke one costs a full staging build plus a
// headless capture run — minutes, and far from the edit that caused it.
//
// So this test resolves the STATIC half of every selector against the
// generated public/index.html in a few milliseconds: each `#id` a selector
// mentions must either exist in the shipped markup, or be one that
// public/js/** injects at runtime (an app card, a session row, a rendered
// leaderboard). The runtime-injected ones are listed explicitly, so a
// genuinely lost id can't hide behind "oh, JS probably adds that".
//
// It cannot prove a selector MATCHES (that needs a browser with data loaded);
// it proves the selector's static anchors still exist, which is the failure
// the React chassis swap could plausibly cause.
//
// Run with: node --test tests/dapp-selectors-resolve.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { idsOf, tokenize } = require('./helpers/html-tokens');

// The set of data-* attribute NAMES actually used on elements. Deliberately
// not a raw text search: `data-panel-slot`, for one, appears only inside an
// explanatory HTML comment in the hand-written shell — home.js plants those
// hosts at runtime — and a text search would call it present in a document
// that never had it.
function dataAttrsUsed(html) {
  const names = new Set();
  for (const t of tokenize(html)) {
    if (t.kind !== 'open') continue;
    for (const a of t.attrs) {
      const n = a.name.toLowerCase();
      if (n.startsWith('data-')) names.add(n);
    }
  }
  return names;
}

const ROOT = path.join(__dirname, '..');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'pre-migration-index.html'), 'utf8');

const shipped = new Set(idsOf(html));
const shippedBefore = new Set(idsOf(fixture));

// Every `#id` mentioned anywhere in a selector, including inside :not(…) and
// :has(…), which the shell's selectors use heavily.
function idsInSelector(selector) {
  return [...String(selector).matchAll(/#([A-Za-z_][-\w]*)/g)].map((m) => m[1]);
}

// Every `[data-…]` attribute name a selector mentions.
function dataAttrsInSelector(selector) {
  return [...String(selector).matchAll(/\[(data-[-\w]+)/g)].map((m) => m[1]);
}

const declared = Array.isArray(manifest.tests) ? manifest.tests : [];

test('dapp.json still declares its full test suite', () => {
  assert.ok(
    declared.length >= 227,
    `dapp.json declares ${declared.length} tests; it had 227 before the React chassis swap. `
    + 'Step 1 must not remove any: they accumulate across proposals and are the migration\'s '
    + 'real acceptance criteria.',
  );
  for (const t of declared) {
    assert.ok(t.path && t.path.startsWith('/'), `test "${t.name}" has no relative path`);
  }
});

test('every id a dapp.json selector anchors on is still in the shipped markup', () => {
  // Ids that legitimately do not exist in the static document because
  // public/js/** creates them at runtime. Derived, not hand-listed: an id the
  // PRE-MIGRATION document also lacked was always runtime-injected, so it is
  // not something this migration could have dropped. That keeps the exemption
  // honest — it can only ever excuse ids that were never in the markup.
  const failures = [];

  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const id of idsInSelector(t.expectSelector)) {
      if (shipped.has(id)) continue;
      if (!shippedBefore.has(id)) continue; // runtime-injected before and after
      failures.push(`#${id} — required by "${t.name}" (${t.path})`);
    }
  }

  assert.deepEqual(
    [...new Set(failures)], [],
    'dapp.json selectors reference element ids that were in the hand-written shell but are '
    + 'missing from the generated one. Each is a check that will fail on staging and block the '
    + 'merge:\n  ' + [...new Set(failures)].join('\n  '),
  );
});

test('every data-* attribute a dapp.json selector anchors on is still present', () => {
  const shippedAttrs = dataAttrsUsed(html);
  const shippedAttrsBefore = dataAttrsUsed(fixture);

  const failures = [];
  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const attr of dataAttrsInSelector(t.expectSelector)) {
      if (shippedAttrs.has(attr)) continue;
      if (!shippedAttrsBefore.has(attr)) continue; // runtime-injected before and after
      failures.push(`${attr} — required by "${t.name}" (${t.path})`);
    }
  }
  assert.deepEqual(
    [...new Set(failures)], [],
    'dapp.json selectors reference data-* attributes the generated markup no longer has:\n  '
    + [...new Set(failures)].join('\n  '),
  );
});

test('the static-anchor coverage is meaningful, not vacuously empty', () => {
  // Without this, a bug that made idsInSelector() return nothing would turn
  // both tests above into no-ops that pass forever.
  const anchored = new Set();
  for (const t of declared) {
    if (!t.expectSelector) continue;
    for (const id of idsInSelector(t.expectSelector)) if (shippedBefore.has(id)) anchored.add(id);
  }
  assert.ok(
    anchored.size > 50,
    `only ${anchored.size} dapp.json selector ids resolve to static shell markup — expected well `
    + 'over 50. Either the selector parsing broke or the shell lost a great many ids.',
  );
});

test('the self-app hash routes dapp.json targets are the ones visuals.js normalises', () => {
  // src/services/visuals.js rewrites a self-app testing path whose FIRST
  // segment is in SELF_APP_HASH_ROUTES into the URL fragment, because a
  // pathname would just load index.html with an empty hash and photograph the
  // home feed for both sides of a before/after pair. Nothing in step 1 changes
  // routing — App.restoreFromHash() in public/js/app.js is still the only
  // router — so every declared path must still start with a segment that set
  // knows about, or be a genuinely standalone server page.
  const HASH_ROUTES = new Set([
    'app', 'apps', 'leaderboard', 'group-chat', 'individual-chat', 'create', 'admin',
  ]);
  // Real server-rendered pages and static assets, which pass through untouched.
  const STANDALONE = ['/cli/authorize', '/usernode-native/', '/dashboard', '/admin-features',
    '/status', '/node-status', '/debug', '/gallery'];

  const unroutable = [];
  for (const t of declared) {
    const p = t.path;
    if (p === '/' || p.startsWith('/?') || p.startsWith('/#')) continue;
    if (STANDALONE.some((s) => p.startsWith(s))) continue;
    const first = p.slice(1).split(/[/?#]/)[0];
    if (HASH_ROUTES.has(first)) continue;
    unroutable.push(`${p} — "${t.name}"`);
  }

  assert.deepEqual(
    unroutable, [],
    'dapp.json declares test paths whose first segment is neither a self-app hash route nor a '
    + 'standalone server page. src/services/visuals.js will leave them as pathnames, index.html '
    + 'will boot to the home feed, and the check will photograph a screen the change never '
    + 'touched:\n  ' + unroutable.join('\n  '),
  );
});
