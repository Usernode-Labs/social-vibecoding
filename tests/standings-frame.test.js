// Standings in the one frame, version 2 (frontend/src/features/leaderboard/
// frame/challenges-frame.tsx; the tour's s55): the line to the challenges
// with the non-podium chip, your own line lit, the board as one card of rows
// under the table's own headings (the rank as a plain figure, the name, the
// points), and the event's card in the side column. The picker is the
// screen's own <select>, wearing the kit's field between the tabs and the
// columns.
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
  headers: { rank: 'Rank', user: 'User', points: 'Season points' },
  rows: [row(0, 1, 'maragung', '24,310'), row(1, 2, 'evan', '22,945'), row(2, 3, 'snait', '21,060', { viewer: true }), row(3, '—', 'bruno', '19,000', { nonPodium: true })],
  you: { rank: '3', points: '21,060', count: 21060 },
  openIndex: null,
  details: null,
  onOpen() {},
};
const render = (over) => renderComponent(FRAME, 'StandingsFrameRows', { ...base, ...over }, { cache: false });

test('the board is one card: the table\'s headings as its first row, then rank, name and points', () => {
  const html = render();
  assert.match(html, /^<div data-standings-rows=""><div class="fr-card"><div class="fr-row fr-sm fr-th"><span class="fr-num">Rank<\/span><span class="fr-tx"><span class="fr-t">User<\/span><\/span><span class="fr-meta">Season points<\/span><\/div>/);
  assert.match(html, /<button type="button" class="fr-row fr-sm fr-rk" data-row-index="0" aria-label="Open maragung&#x27;s details" aria-pressed="false"><span class="fr-num">1<\/span><span class="fr-tx"><span class="fr-t">maragung<\/span><\/span><span class="fr-meta fr-ink">24,310<\/span><\/button>/);
  assert.deepEqual([...html.matchAll(/<button[^>]*><span class="fr-num">[^<]*<\/span><span class="fr-tx"><span class="fr-t">([^<]+)<\/span>/g)].map((m) => m[1]), ['maragung', 'evan', 'snait', 'bruno'], 'the board\'s order, nothing added');
  assert.doesNotMatch(html, /fr-lead|fr-cap/, 'no rank in a circle, no group label');
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('your own row is lit; a non-podium row says so in its line', () => {
  const html = render();
  assert.match(html, /<button type="button" class="fr-row fr-sm fr-rk fr-on" data-row-index="2" aria-label="Open snait&#x27;s details" aria-pressed="false"><span class="fr-num">3<\/span>/);
  assert.match(html, /<button type="button" class="fr-row fr-rk" data-row-index="3" aria-label="Open bruno&#x27;s details" aria-pressed="false"><span class="fr-num">—<\/span><span class="fr-tx"><span class="fr-t">bruno<\/span><span class="fr-s">Excluded from podium ranking<\/span><\/span><span class="fr-meta">19,000<\/span>/);
  assert.doesNotMatch(render({ you: null }), /fr-on/, 'nobody is you until the board says so');
});

test('a row\'s details open under it, inside the card, and the open row says it is open', () => {
  const html = render({ openIndex: 1, details: 'DETAILS' });
  assert.match(html, /aria-label="Open evan&#x27;s details" aria-pressed="true">.*?<\/button><div class="fr-pad">DETAILS<\/div><button type="button" class="fr-row fr-sm fr-rk fr-on"/s);
  assert.doesNotMatch(render(), /fr-pad/);
});

test('over the board: the line to the challenges with the chip, and your own line lit', () => {
  const line = renderComponent(FRAME, 'StandingsFrameLine', { line: { done: '10', total: '11' }, toggle: { count: 21, on: false }, onChallenges() {}, onToggle() {} }, { cache: false });
  assert.match(line, /^<div class="fr-btnrow fr-line13" data-standings-line=""><span id="tc-lb-challenge-link">10 of 11 challenges done <span>· <\/span><button type="button" id="tc-lb-to-challenges" class="fr-link">View challenges →<\/button><\/span><button type="button" class="fr-btn fr-quiet fr-sm" id="tc-lb-non-podium-toggle" aria-pressed="false">Show non-podium users \(21\)<\/button><\/div>$/);
  assert.match(renderComponent(FRAME, 'StandingsFrameLine', { line: null, toggle: { count: null, on: true }, onChallenges() {}, onToggle() {} }, { cache: false }), /<button type="button" class="fr-btn fr-sm" id="tc-lb-non-podium-toggle" aria-pressed="true">Show non-podium users<\/button>/);
  assert.equal(renderComponent(FRAME, 'StandingsFrameLine', { line: null, toggle: null, onChallenges() {}, onToggle() {} }, { cache: false }), '');
  const you = renderComponent(FRAME, 'StandingsFrameYou', { you: base.you, onOpen() {} }, { cache: false });
  assert.equal(you, '<div class="fr-card"><button type="button" id="tc-lb-you" class="fr-row fr-sm fr-on fr-you"><span class="fr-tx"><span class="fr-t">You · #3 · 21,060 points</span></span></button></div>');
  assert.equal(renderComponent(FRAME, 'StandingsFrameYou', { you: null, onOpen() {} }, { cache: false }), '');
});

test('the side column is the event\'s card, from the event bar\'s own hero; nobody without history has one', () => {
  const event = { kind: 'event', name: 'Season 2', statusLabel: 'season', statusClass: 'x', description: 'Season-wide standings.', dates: 'Sep 23, 2026 – Dec 31, 2026 · 159 taking part', seasonNote: true, fallbackNote: false };
  const html = renderComponent(FRAME, 'StandingsFrameCols', { event, children: 'BOARD' }, { cache: false });
  assert.match(html, /^<div class="fr" data-standings-cols=""><div class="fr-inner"><div class="fr-cols"><div class="fr-stack">BOARD<\/div><div class="fr-stack fr-first"><section class="fr-sec" data-frame-event=""><div class="fr-sechead"><h2 class="fr-cap">Event<\/h2><\/div><div class="fr-card fr-text"><div class="fr-btnrow"><h2 class="fr-sub22">Season 2<\/h2><span class="fr-pill" data-kind="none">season<\/span><\/div><div class="fr-sub15">Season-wide standings\.<\/div><div class="fr-txt">Sep 23, 2026 – Dec 31, 2026 · 159 taking part<\/div><div class="fr-txt">Whole-season standings: every public event in this season, combined\. Pick a single event above to see just its results\.<\/div><\/div><\/section><\/div><\/div><\/div><\/div>$/);
  assert.match(renderComponent(FRAME, 'StandingsFrameCols', { event: { ...event, seasonNote: false, fallbackNote: true }, children: 'B' }, { cache: false }), /Nothing is running right now, so this shows the most recent event\./);
  assert.match(renderComponent(FRAME, 'StandingsFrameCols', { event: { kind: 'error', message: 'Failed to load this event.' }, children: 'B' }, { cache: false }), /<div role="alert"><div class="fr-note fr-bad">.*?Failed to load this event\./s);
  assert.match(renderComponent(FRAME, 'StandingsFrameCols', { event: { kind: 'empty' }, children: 'B' }, { cache: false }), /<div class="fr-card fr-pad">No event selected\.<\/div>/);
  assert.match(renderComponent(FRAME, 'StandingsFrameCols', { event: null, children: 'B' }, { cache: false }), /<div class="fr-cols fr-one"><div class="fr-stack">B<\/div><\/div>/, 'one column');
});

test('under a look the pane draws these, from its own view and the event bar\'s store', () => {
  const src = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(src, /function Body\(\{ view, drill, frame \}/);
  assert.match(src, /<Lines frame line=\{view\.challengeLine\} disclaimer=\{view\.disclaimer\} toggle=\{view\.nonPodiumToggle\} \/>\s*<StandingsFrameYou you=\{view\.you\} onOpen=\{\(\) => controller\(\)\?\._openViewerRow\(\)\} \/>\s*<StandingsFrameRows\s+headers=\{view\.headers\}\s+rows=\{view\.rows\}\s+you=\{view\.you \|\| null\}\s+openIndex=\{drill && drill\.index != null \? drill\.index : null\}\s+details=\{drill \? <DrillPanel view=\{drill\} \/> : null\}\s+onOpen=\{\(index\) => controller\(\)\?\._openRowAt\(index\)\}/);
  assert.match(src, /onChallenges=\{\(\) => controller\(\)\?\._goToChallenges\(\)\} onToggle=\{\(\) => controller\(\)\?\._toggleNonPodium\(\)\}/);
  assert.match(src, /<YouLine you=\{view\.you\} \/>\s*<NonPodiumChip toggle=\{view\.nonPodiumToggle\} \/>\s*<StandingsTable view=\{view\} drill=\{drill\} \/>/, 'the standard look\'s table and lines stay as written');
  assert.match(src, /return bar\.mounted && bar\.history \? bar\.hero : null;/);
  assert.match(src, /viewer\?: boolean;/, 'the row view says which row is the viewer\'s');
  assert.match(read('frontend/src/features/leaderboard/topochain-leaderboard.js'), /viewer: !!r\.is_viewer,/);
  assert.doesNotMatch(src, /standings\.frame\.(season|event)/, 'the group label is gone');
});

test('app.css orders the head, the picker and the columns, and the picker wears the kit\'s field', () => {
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #topochain-leaderboard-root \{ display: contents; \}/);
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #topochain-leaderboard-root > \[data-standings-frame\] \{ order: 0; \}/);
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #leaderboard-screen > div > div:first-child \{ order: 1; \}/);
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #topochain-leaderboard-root > \[data-standings-cols\] \{ order: 2; \}/);
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #tc-ev-hero \{ display: none; \}/, 'the kit\'s Event card says it');
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #tc-ev-select \{[^}]*background: var\(--fr-surface\);/);
  assert.doesNotMatch(css, /#tc-lb-body > \* \{ max-width: 720px; \}/, 'the 720px column is the kit\'s own now');
  assert.match(css, /html\[data-skin\] \[data-standings-rows\] > \.fr-card > \.fr-pad \{ padding: 0 16px 16px; \}/);
});
