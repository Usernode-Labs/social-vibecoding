'use strict';

// The admin Journey section (#3369, slice 2): frontend/src/features/admin/
// admin-journey.tsx, the page over the endpoints slice 1 shipped under
// /api/admin/journey/*.
//
// Text-pinning, in the style of the other admin section tests: the section is
// a React module behind the console's lazily imported barrel, and the
// properties that matter are visible in its source. The payload shapes are
// pinned on the server side by tests/journey-routes.test.js and
// tests/journey-routes-demo.test.js.
//
// What is pinned:
//  - the section is registered everywhere the console looks for one;
//  - it reads only the Journey routes (plus Support's search, to pick a
//    person for the left-out list) and writes only the left-out list;
//  - a reading the platform does not record reads "not recorded yet", and
//    Hear back reads "coming", never a number;
//  - counts and names: no percentages, no charts;
//  - nothing from the API becomes a link;
//  - the demo payloads ride on ?demo=1, and the demo list cannot be edited;
//  - details open in dialogs, so nothing expands inside the page;
//  - one declared check opens it in a staging preview.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const src = read('frontend/src/features/admin/admin-journey.tsx');
const consoleJs = read('frontend/src/features/admin/admin-console.js');
const sections = read('frontend/src/features/admin/sections.ts');
const audit = read('scripts/audit-react-ownership.mjs');
const manifest = JSON.parse(read('dapp.json'));

test('Journey is registered wherever the console looks for a section', () => {
  assert.match(consoleJs, /\{ key: 'journey', label: 'Journey', group: 'Insights' \}/,
    'a menu entry under Insights');
  assert.match(consoleJs, /journey: 'AdminJourney',/, 'SECTION_MODULES dispatches to the module');
  assert.match(consoleJs, /'journey': '<svg /, 'the menu entry has an icon');
  assert.match(sections, /import '\.\/admin-journey\.tsx';/, 'the lazily imported barrel loads it');
  assert.match(src, /\(window as any\)\.AdminJourney = AdminJourney;/, 'it publishes itself for _renderModule');
  assert.match(src, /mountLegacyPortal\(el, <JourneySection \/>\)/, 'render(host) mounts the React section');
  assert.match(src, /unmountLegacyPortal\(host\)/, 'destroy() unmounts it');
  assert.match(audit, /\{ sel: '#admin-section-content', when: '#admin\/journey' \}/,
    'the ownership audit scopes the shared host to this route');
  assert.match(audit, /'#admin\/journey'/, 'and visits the route');
});

test('it reads the Journey routes and writes only the left-out list', () => {
  const reads = [...src.matchAll(/'(\/api\/[^'`$?]+)/g)].map((m) => m[1]);
  const templated = [...src.matchAll(/`(\/api\/[^`$?]+)/g)].map((m) => m[1]);
  for (const p of [...reads, ...templated]) {
    assert.ok(p.startsWith('/api/admin/journey/') || p === '/api/admin/support/search',
      `${p} is a Journey route or Support's search`);
  }
  for (const route of ['summary', 'cohorts', 'first-mile', 'stages', 'loops', 'next-steps', 'people/', 'left-out']) {
    assert.ok(src.includes(`/api/admin/journey/${route}`), `the page reads ${route}`);
  }
  const writes = [...src.matchAll(/method: '(POST|DELETE|PUT|PATCH)'/g)].map((m) => m[1]);
  assert.deepEqual(writes.sort(), ['DELETE', 'POST'], 'one add and one remove');
  assert.equal((src.match(/fetch\('\/api\/admin\/journey\/left-out', \{/g) || []).length, 1);
  assert.match(src, /fetch\(`\/api\/admin\/journey\/left-out\/\$\{entry\.userId\}`, \{ method: 'DELETE' \}\)/);
});

test('a missing record reads "not recorded yet", and Hear back reads "coming"', () => {
  assert.match(src, /function Num\(\{ v \}: \{ v: Count \}\) \{\n  if \(isNotRecorded\(v\)\) return <span className=\{JUI\.fine\} title=\{v\.reason\}>not recorded yet<\/span>;/,
    'a stage count that is not recorded never renders as a number');
  assert.match(src, /\{isComing\(v\) \? 'coming' : v\}/, 'a loop step that is coming says so');
  assert.match(src, /\(v as Coming\)\.status === 'coming'/);
  assert.match(src, /<Num v=\{data\.counts\[key\]\} \/>/, 'the stage strip goes through Num');
});

test('counts and names only: no percentages, no charts, no links from data', () => {
  assert.ok(!src.includes('%'), 'no percentage is drawn');
  assert.ok(!/<svg|<canvas|from '[^']*chart/i.test(src), 'no chart');
  assert.ok(!/<a[\s>]|href=/.test(src), 'nothing is rendered as an anchor');
  assert.match(src, /location\.hash = `#admin\/support\/\$\{p\.userId\}`/,
    'the one jump is to Support, by a numeric id, through the hash');
  assert.ok(!/\bapp\b/.test(src.match(/>[^<{]*</g).join(' ')), 'on screen it says project, not app');
});

test('the demo rides on ?demo=1 and cannot be edited', () => {
  assert.match(src, /new URLSearchParams\(location\.search\)\.get\('demo'\) === '1'/);
  assert.match(src, /`\$\{path\}\$\{path\.includes\('\?'\) \? '&' : '\?'\}demo=1`/);
  assert.match(src, /const canWrite = !DEMO && !!consoleApi\(\)\?\.canWrite\?\.\(\);/,
    'the left-out controls need a full admin and real data');
  assert.match(src, /Demo: invented people/);
});

test('details open in dialogs, one at a time on top', () => {
  for (const id of ['mile', 'stages', 'loops', 'next', 'leftout', 'checks', 'person']) {
    assert.ok(src.includes(`id="admin-journey-${id}-dialog"`), `${id} is a dialog`);
  }
  assert.match(src, /if \(open\[open\.length - 1\] === panel\.current\) onClose\(\);/,
    'Escape closes only the topmost dialog');
  assert.ok(!src.includes('_confirm('), 'confirmations stay inside the dialog');
});

test('one declared check opens the demo page', () => {
  const checks = manifest.tests.filter((t) => t.path === '/?demo=1#admin/journey');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].expectSelector, '#admin-journey-north-star');
});
