'use strict';

// The Needs-you card's diagram: what a change WITHOUT before & after shots
// draws in the space the empty spacer left. Renames as crossed-out and
// tinted words, otherwise its declared changes as numbered tiles, otherwise
// the one line that says nothing on screen changes.
//
// Run with: node --test tests/workshop-needs-diagram.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const AppView = require('../public/js/app-view.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const APP_VIEW = read('public/js/app-view.js');
const CSS = read('public/css/app.css');
const OVERVIEW = require('../src/routes/workshop-overview');
const REEL = read('frontend/src/features/workshop/needs-reel.tsx');

const { renamePairs, diagramFor } = loadTsx('frontend/src/features/dev-board/workshop/change-diagram.ts');

// ── renamePairs ────────────────────────────────────────────────────────

test('renamePairs reads the screenshot\'s title as spec to plan', () => {
  assert.deepEqual(renamePairs(['Rename user-facing "spec" to "plan" and fix shell build test failures']),
    [{ from: 'spec', to: 'plan' }]);
});

test('renamePairs reads curly quotes, arrows, => and instead-of', () => {
  assert.deepEqual(renamePairs(['“spec” to “plan”']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['"spec" → "plan"']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['"spec" -> "plan"']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['"spec" => "plan"']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['"spec" into "plan"']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['"spec" becomes "plan"']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['replace "spec" with "plan"']), [{ from: 'spec', to: 'plan' }]);
  // The NEW word comes first in an instead-of, so the arrow points the way
  // the rename went.
  assert.deepEqual(renamePairs(['use "plan" instead of "spec"']), [{ from: 'spec', to: 'plan' }]);
});

test('renamePairs reads two bare words joined by an arrow, never by "to"', () => {
  assert.deepEqual(renamePairs(['spec -> plan']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['spec → plan']), [{ from: 'spec', to: 'plan' }]);
  assert.deepEqual(renamePairs(['Rename Workshop to Studio']), [], 'unquoted "to" is too easy to misread');
});

test('renamePairs is not mangled by an apostrophe before a quote', () => {
  assert.deepEqual(renamePairs(["it keeps the user's \"spec\" intact"]), []);
});

test('renamePairs drops same-word pairs and duplicates, and caps at three', () => {
  assert.deepEqual(renamePairs(['"spec" to "spec"']), []);
  assert.deepEqual(renamePairs(['"SPEC" to "plan"', '"spec" to "PLAN"']), [{ from: 'SPEC', to: 'plan' }]);
  assert.deepEqual(renamePairs(['"a" to "b"', '"c" to "d"', '"e" to "f"', '"g" to "h"']),
    [{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }, { from: 'e', to: 'f' }]);
});

test('renamePairs ignores a term of more than forty characters', () => {
  const long = 'x'.repeat(41);
  assert.deepEqual(renamePairs([`"${long}" to "plan"`]), []);
  assert.deepEqual(renamePairs([`"${'x'.repeat(40)}" to "plan"`]), [{ from: 'x'.repeat(40), to: 'plan' }]);
});

// ── diagramFor ─────────────────────────────────────────────────────────

test('diagramFor prefers renames, then tiles, then the nothing-to-see tile', () => {
  // Renames win even when the change also declares changes.
  assert.deepEqual(diagramFor({
    card: { title: { text: 'Rename "a" to "b"' } },
    summary: null,
    changes: [{ n: 1, text: 'declared' }],
    impact: null,
  }), { kind: 'renames', pairs: [{ from: 'a', to: 'b' }] });
  // Otherwise the declared changes, capped at three, keeping their numbers.
  assert.deepEqual(diagramFor({
    card: { title: { text: 'A plain title' } },
    summary: 'A summary.',
    changes: [{ n: 1, text: 'one' }, { n: 2, text: 'two' }, { n: 3, text: 'three' }, { n: 4, text: 'four' }],
    impact: 'ui',
  }), { kind: 'changes', tiles: [{ n: 1, text: 'one' }, { n: 2, text: 'two' }, { n: 3, text: 'three' }] });
  // Nothing declared: the change that says nothing on screen changes.
  assert.deepEqual(diagramFor({
    card: { title: { text: 'A plain title' } },
    summary: null,
    changes: [],
    impact: 'none',
  }), { kind: 'unseen' });
  // Nothing true to draw: null, and the card keeps its empty space.
  assert.equal(diagramFor({
    card: { title: { text: 'A plain title' } },
    summary: null,
    changes: [],
    impact: 'ui',
  }), null);
});

test('diagramFor reads the title the row carries, either field', () => {
  assert.deepEqual(diagramFor({ card: { title: { title: 'Rename "x" to "y"' } } }),
    { kind: 'renames', pairs: [{ from: 'x', to: 'y' }] });
});

// ── The project feed's rows ────────────────────────────────────────────

test('AppView._workshopChanges numbers the declared claims from one, capped at three', () => {
  assert.deepEqual(AppView._workshopChanges({
    claims: [
      { id: 'a', claim: ' One thing shows. ' },
      { id: 'b', claim: 'Another shows.' },
      { id: 'c', claim: 'A third shows.' },
      { id: 'd', claim: 'A fourth, cut.' },
    ],
  }), [
    { n: 1, text: 'One thing shows.' },
    { n: 2, text: 'Another shows.' },
    { n: 3, text: 'A third shows.' },
  ]);
  // An EMPTY claim is dropped without renumbering the ones after it: the
  // numbers name the proposal's own declared changes, as the shots number
  // them, so they must not shift.
  assert.deepEqual(AppView._workshopChanges({
    claims: [{ id: 'a', claim: 'First' }, { id: 'b', claim: '' }, { id: 'c', claim: 'Third' }],
  }), [{ n: 1, text: 'First' }, { n: 3, text: 'Third' }]);
  assert.deepEqual(AppView._workshopChanges(null), []);
  assert.deepEqual(AppView._workshopChanges({}), []);
});

test('voteRow carries the declared changes and the impact for the diagram', () => {
  assert.match(APP_VIEW, /_workshopChanges\(shots\)/);
  assert.match(APP_VIEW, /changes: AppView\._workshopChanges\(item && item\.shots\)/);
  assert.match(APP_VIEW, /impact: item && item\.shots && typeof item\.shots === 'object' \? item\.shots\.impact \|\| null : null/);
});

// ── The communities feed ───────────────────────────────────────────────

test('the needs feed selects the declared claims and their impact', () => {
  const sql = OVERVIEW.NEEDS_FEED_SQL;
  assert.match(sql, /cs\.shots_detail->'claims' AS claims/);
  assert.match(sql, /cs\.shots_detail->>'impact' AS impact/);
  // The governance half of the UNION carries the columns as NULL.
  assert.match(sql, /NULL::jsonb, NULL::text/);
  assert.match(sql, /o\.claims, o\.impact/);
});

test('shapeNeedsFeed adds changes and impact only when there is something to draw', () => {
  const base = {
    kind: 'proposal', id: 7, title: 'A change', summary: 'S', author: 'a',
    number: null, epoch: 0, at: new Date('2026-10-01T00:00:00Z'), yes: 0, no: 0,
    slug: 'demo', name: 'Demo', icon_image_id: null, icon_emoji: null,
  };
  // Nothing declared: the keys are absent, so the shape rows already had.
  const plain = OVERVIEW.shapeNeedsFeed([{ ...base }])[0];
  assert.ok(!('changes' in plain), 'no changes key on a row with none');
  assert.ok(!('impact' in plain), 'no impact key on a row with none');
  const declared = OVERVIEW.shapeNeedsFeed([{
    ...base,
    claims: [
      { id: 'a', claim: ' One shows. ' },
      { id: 'b', claim: '' },
      { id: 'c', claim: 'Two shows.' },
      { id: 'd', claim: 'Three shows.' },
      { id: 'e', claim: 'Four, cut.' },
    ],
    impact: 'none',
  }])[0];
  assert.deepEqual(declared.changes, ['One shows.', 'Two shows.', 'Three shows.']);
  assert.equal(declared.impact, 'none');
  // A 'ui' impact is not 'none': no key, because only the nothing-to-see
  // value means anything to the diagram.
  const ui = OVERVIEW.shapeNeedsFeed([{ ...base, impact: 'ui' }])[0];
  assert.ok(!('impact' in ui));
  assert.ok(!('changes' in ui));
});

test('changesFromClaims trims, drops empties and caps the claim texts', () => {
  assert.deepEqual(OVERVIEW.changesFromClaims([
    { id: 'a', claim: ' One ' }, { id: 'b', claim: '' }, null,
    { id: 'c', claim: 'Two' }, { id: 'd', claim: 'Three' }, { id: 'e', claim: 'Four' },
  ]), ['One', 'Two', 'Three']);
  assert.deepEqual(OVERVIEW.changesFromClaims(null), []);
  assert.deepEqual(OVERVIEW.changesFromClaims('not an array'), []);
  assert.deepEqual(OVERVIEW.changesFromClaims([{ id: 'a', claim: 'x'.repeat(1001) }]), ['x'.repeat(1000)]);
});

test('the reel maps the feed\'s changes and impact onto its rows', () => {
  assert.match(REEL, /changes: \(item\.changes \|\| \[\]\)\.map\(\(text, k\) => \(\{ n: k \+ 1, text \}\)\)/);
  assert.match(REEL, /impact: item\.impact \|\| null/);
});

// ── The drawing half ───────────────────────────────────────────────────

test('the feed draws the diagram only for a vote row without its visuals', () => {
  assert.match(WORKSHOP,
    /const diagram = useMemo\(\s*\n\s*\(\) => \(row\.kind === 'vote' && !row\.visuals \? diagramFor\(row\) : null\),\s*\n\s*\[row\]\s*\n\s*\);/);
  // The spacer stays the last resort: the diagram goes between the pictures
  // and it.
  const item = WORKSHOP.slice(WORKSHOP.indexOf('{shots && row.visuals ? <ShotsPicture'), WORKSHOP.indexOf('dev-ws-item-caption'));
  assert.match(item, /: diagram \? <ChangeDiagram d=\{diagram\} \/>/);
  assert.match(item, /: <div className="dev-ws-item-spacer" aria-hidden="true" \/>/);
});

test('the diagram names its three panels the words people read', () => {
  assert.match(WORKSHOP, />Renames<\/figcaption>/);
  assert.match(WORKSHOP, />What changes<\/figcaption>/);
  assert.match(WORKSHOP, />Nothing on screen changes<\/span>/);
});

test('the diagram is drawn like the app’s grouped cards, from existing variables', () => {
  const rule = (sel) => {
    const m = new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, `rule ${sel}`);
    return m[1];
  };
  assert.match(rule('.dev-ws-diagram-panel'), /border-radius: 20px;/);
  assert.match(rule('.dev-ws-diagram-panel'), /box-shadow: inset 0 0 0 1px var\(--app-sheet-line\);/);
  assert.match(rule('.dev-ws-diagram-panel'), /background: var\(--dc-sheet-solid, #fff\);/);
  assert.match(rule('.dev-ws-diagram-head'), /text-transform: uppercase;/);
  // The old word crossed out and grey, the new one in the info chip's pair.
  assert.match(rule('.dev-ws-term-before'), /text-decoration: line-through;/);
  assert.match(rule('.dev-ws-term-after'), /background: var\(--accent-tint\);/);
  assert.match(rule('.dev-ws-term-after'), /color: var\(--accent-wash-ink\);/);
  assert.doesNotMatch(CSS.slice(CSS.indexOf('The change diagram'), CSS.indexOf('The rail')), /gray-|indigo-/);
});
