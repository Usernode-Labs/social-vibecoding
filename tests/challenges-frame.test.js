// Challenges in the one frame (frontend/src/features/leaderboard/frame/
// challenges-frame.tsx), as the 2026-11-06 screen tour draws it (s53, s54):
// the frame with Challenges and Standings as its tabs, your standing as the
// one sentence, what you can still earn and what is done as groups of the
// standard row, and your season in the context column. It is the pane's own
// view (challenges-pane.tsx, my-standing.js) with another face; a
// challenge's own page, and Standings, are still the pane's.
//
// Run with: node --test tests/challenges-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/leaderboard/frame/challenges-frame.tsx';

// A card as the pane has it: `goal` is the challenge's name, `label` its kind.
const card = (idx, goal, over) => ({ key: `c${idx}`, idx, featured: false, done: false, label: 'WEEKLY', goal, reward: '1,000 pts', state: 'started', stateLabel: 'Started', fill: null, counted: false, earned: null, illustration: null, illustrationTone: null, ...over });
const base = {
  tabs: [{ key: 'challenges', label: 'Challenges' }, { key: 'topochain', label: 'Standings' }], onTab() {},
  purpose: '#16 of 151 ranked · 16,128 pts · 8 of 11 done',
  groups: [
    { key: 'next', heading: 'Next challenges', cards: [card(0, 'Build for your community'), card(1, 'Send useful feedback', { stateLabel: '0/4 counted this week', reward: 'Up to 1,000 pts' })] },
    { key: 'done', heading: 'Done', cards: [card(2, 'Join a community', { done: true, state: 'done', reward: '500 pts', earned: '500 pts' })] },
  ],
  notice: null, onOpen() {},
  season: { rank: '#16', of: 'of 151', points: '16,128', pointsLabel: 'points' },
  note: 'Your place updates within about 10 minutes.',
  token: null,
};
const render = (over) => renderComponent(FRAME, 'ChallengesFrame', { ...base, ...over }, { cache: false });

test('Challenges is a page of the frame: its title, your standing as the one sentence, the two tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-challenges-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Challenges<\/h1><p class="fr-purpose">#16 of 151 ranked · 16,128 pts · 8 of 11 done<\/p><\/div><\/div><nav class="fr-tabs"><button type="button" class="fr-tab fr-on" aria-pressed="true">Challenges<\/button><button type="button" class="fr-tab" aria-pressed="false">Standings<\/button><\/nav>/);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
});

test('what can still be earned is rows in blue that open the challenge, each ending in its points', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Next challenges<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row"><span class="fr-lead fr-acc" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Build for your community<\/span><span class="fr-s">Started<\/span><\/span><span class="fr-meta">1,000 pts<\/span><svg/s);
  assert.match(html, /<span class="fr-t">Send useful feedback<\/span><span class="fr-s">0\/4 counted this week<\/span><\/span><span class="fr-meta">Up to 1,000 pts<\/span>/, 'its name, then where it stands, never its kind in capitals');
  assert.doesNotMatch(html, /WEEKLY/);
});

test('what is done is short rows with a green check and the points earned', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Done<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row fr-sm"><span class="fr-lead fr-ok" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Join a community<\/span><\/span><span class="fr-meta">500 pts<\/span>/s);
});

test('your season is two figures and one note in the context column; the token allocation keeps its two states', () => {
  const html = render();
  const side = html.slice(html.lastIndexOf('<div class="fr-stack">'));
  assert.match(side, /<h2 class="fr-cap">Your standing<\/h2><\/div><div class="fr-card"><div class="fr-facts fr-f2"><div class="fr-fact"><div class="fr-v">#16<\/div><div class="fr-l">of 151<\/div><\/div><div class="fr-fact"><div class="fr-v">16,128<\/div><div class="fr-l">points<\/div><\/div>/);
  assert.match(side, /<div class="fr-note"><svg[^>]*>.*?<\/svg><div>Your place updates within about 10 minutes\.<\/div><\/div>/s);
  const gated = render({ token: { gated: true, onReview() {} } });
  assert.match(gated, /<span class="fr-t">Token allocation withheld<\/span><span class="fr-s">Review and accept the terms to see your token allocation\.<\/span><\/span><button type="button" class="fr-btn fr-quiet fr-sm">Review terms<\/button>/);
  const hidden = render({ token: { gated: false, amount: '1,250', revealed: false, onReveal() {} } });
  assert.match(hidden, /<span class="fr-t">Token allocation<\/span>.*?<button type="button" class="fr-btn fr-quiet fr-sm">Reveal<\/button>/s);
  assert.doesNotMatch(hidden, /1,250/, 'not shown until it is revealed');
  assert.match(render({ token: { gated: false, amount: '1,250', revealed: true, onReveal() {} } }), /<span class="fr-meta">1,250<\/span>/);
  assert.doesNotMatch(render({ season: null }), /Your standing/);
});

test('the pane draws the kit\'s page under a look, ahead of its own parts, and the screen gives it the page area', () => {
  const src = read('frontend/src/features/leaderboard/challenges-pane.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /\{frame && \(!state\.grid \|\| state\.grid\.kind === 'loading' \|\| state\.grid\.kind === 'cards'\) \? \(\s*<ChallengesInFrame grid=\{state\.grid && state\.grid\.kind === 'cards' \? state\.grid : null\} up=\{!state\.detail\} \/>/,
    'while the cards load the page is the kit\'s too, so the standard card and skeleton do not show under the kit\'s tabs');
  assert.match(src, /notice=\{grid \? grid\.notice : t\('leaderboard:challenges\.loading'\)\}/);
  assert.match(src, /groups=\{grid \? grid\.groups : \[\]\}/);
  assert.match(src, /up=\{up && section === 'challenges'\}/, 'the page on show only while its own section is, and no challenge\'s page is over it');
  assert.match(read('frontend/src/features/frame/frame-flag.ts'), /if \(!on\) return undefined;/);
  assert.match(src, /<YourStanding \/>\s*<Grid view=\{state\.grid\} \/>/, 'its own parts stay as written');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]\[data-challenges-frame\] #tc-se-grid > :not\(\.fr\) \{ display: none; \}/);
  assert.match(hand, /html\[data-skin\]\[data-challenges-frame\] #leaderboard-screen \{ padding-inline-start: var\(--platform-rail-w, 0px\) !important; padding-inline-end: 0 !important; \}/);
  assert.match(hand, /html\[data-skin\]\[data-challenges-frame\] #standings-tabs \{ display: none; \}/, 'the tabs are the kit\'s');
});

test('Standings wears the same head and tabs over its own table', () => {
  const html = renderComponent(FRAME, 'StandingsFrameHead', { tabs: base.tabs, onTab() {}, purpose: '#16 of 151 ranked' }, { cache: false });
  assert.match(html, /^<div class="fr" data-standings-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Challenges<\/h1><p class="fr-purpose">#16 of 151 ranked<\/p><\/div><\/div><nav class="fr-tabs"><button type="button" class="fr-tab" aria-pressed="false">Challenges<\/button><button type="button" class="fr-tab fr-on" aria-pressed="true">Standings<\/button><\/nav><\/div><\/div>$/);
  const src = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(src, /\{frame \? <StandingsInFrameHead \/> : null\}\s*<div id="tc-lb-body">/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #standings-tabs \{ display: none; \}/);
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #topochain-leaderboard-root \{ display: contents; \}/, 'the head comes before the season picker, which is written ahead of the panes');
  assert.match(src, /up=\{section === 'topochain'\}/);
});
