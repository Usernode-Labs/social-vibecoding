// Standings in the one frame (frontend/src/features/leaderboard/frame/
// challenges-frame.tsx, StandingsFrameRows), as the 2026-11-06 screen tour
// draws it (s55): the same row as everywhere, rank in the lead, the name,
// the points at the right, your own row lit. The pane's own table
// (topochain-standings.tsx) still draws the standard look; under a look the
// table state is these rows, and a row's details open under it as before.
//
// Run with: node --test tests/standings-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/leaderboard/frame/challenges-frame.tsx';

const row = (index, rank, user, points, over) => ({ index, rank: String(rank), nonPodium: false, user, points, ...over });
const base = {
  label: 'Season 2',
  rows: [row(0, 1, 'maragung', '24,310'), row(1, 2, 'evan', '22,945'), row(2, 3, 'snait', '21,060', { viewer: true }), row(3, '—', 'bruno', '19,000', { nonPodium: true })],
  you: { rank: '3', points: '21,060', count: 21060 },
  openIndex: null,
  details: null,
  onOpen() {},
};
const render = (over) => renderComponent(FRAME, 'StandingsFrameRows', { ...base, ...over }, { cache: false });

test('standings are one group of the standard row: rank in the lead, the name, the points', () => {
  const html = render();
  assert.match(html, /^<section class="fr-sec" data-standings-rows=""><div class="fr-sechead"><h2 class="fr-cap">Season 2<\/h2><\/div><div class="fr-card">/);
  assert.match(html, /<button type="button" class="fr-row fr-sm" aria-label="Open maragung&#x27;s details" aria-pressed="false"><span class="fr-lead">1<\/span><span class="fr-tx"><span class="fr-t">maragung<\/span><\/span><span class="fr-meta">24,310<\/span><\/button>/);
  assert.deepEqual([...html.matchAll(/<span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['maragung', 'evan', 'snait', 'bruno'], 'the board\'s order, nothing added');
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('your own row is lit; a non-podium row says so in its line and has no rank', () => {
  const html = render();
  assert.match(html, /<button type="button" class="fr-row fr-sm fr-on" aria-label="Open snait&#x27;s details" aria-pressed="false"><span class="fr-lead">3<\/span>/);
  assert.match(html, /<button type="button" class="fr-row" aria-label="Open bruno&#x27;s details" aria-pressed="false"><span class="fr-lead">—<\/span><span class="fr-tx"><span class="fr-t">bruno<\/span><span class="fr-s">Excluded from podium ranking<\/span><\/span>/);
  assert.doesNotMatch(render({ you: null }), /fr-on/, 'nobody is you until the board says so');
});

test('a row\'s details open under it, inside the card, and the open row says it is open', () => {
  const html = render({ openIndex: 1, details: 'DETAILS' });
  assert.match(html, /aria-label="Open evan&#x27;s details" aria-pressed="true">.*?<\/button><div class="fr-pad">DETAILS<\/div><button type="button" class="fr-row fr-sm fr-on"/s);
  assert.doesNotMatch(render(), /fr-pad/);
});

test('under a look the pane draws the table state as these rows, keeping its own hints and chip above them', () => {
  const src = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(src, /function Body\(\{ view, drill, frame \}/);
  assert.match(src, /<NonPodiumChip toggle=\{view\.nonPodiumToggle\} \/>\s*\{frame \? \(\s*<StandingsFrameRows/);
  assert.match(src, /label=\{t\(view\.isSeason \? 'leaderboard:standings\.frame\.season' : 'leaderboard:standings\.frame\.event'\)\}\s+rows=\{view\.rows\}\s+you=\{view\.you \|\| null\}\s+openIndex=\{drill && drill\.index != null \? drill\.index : null\}\s+details=\{drill \? <DrillPanel view=\{drill\} \/> : null\}\s+onOpen=\{\(index\) => controller\(\)\?\._openRowAt\(index\)\}/);
  assert.match(src, /\) : <StandingsTable view=\{view\} drill=\{drill\} \/>\}/);
  assert.match(src, /viewer\?: boolean;/, 'the row view says which row is the viewer\'s');
  assert.match(read('frontend/src/features/leaderboard/topochain-leaderboard.js'), /viewer: !!r\.is_viewer,/);
  assert.match(src, /\{frame \? null : <YouLine you=\{view\.you\} \/>\}/, 'the pinned "You" line is the standard look\'s: under a look your row is lit');
});

test('app.css keeps the rows at the content column\'s width and pads the open details', () => {
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #tc-lb-body > \* \{ max-width: 720px; \}/);
  assert.match(css, /html\[data-skin\] \[data-standings-rows\] > \.fr-card > \.fr-pad \{ padding: 0 16px 16px; \}/);
});
