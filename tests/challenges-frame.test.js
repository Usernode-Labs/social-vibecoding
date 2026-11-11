// Challenges in the one frame, version 2 (frontend/src/features/leaderboard/
// frame/challenges-frame.tsx; the tour's s53, s54): the first tour's layout
// holding today's pane. The title with the sentence saying where your place
// comes from, the two tabs, the points and "10 of 11 done" over one bar, the
// challenges under today's headings as rows, and Your standing in the side
// column. It is the pane's own view (challenges-pane.tsx, my-standing.js)
// with another face; a challenge's own page is still the pane's.
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
const card = (idx, goal, over) => ({ key: `c${idx}`, idx, featured: false, done: false, label: 'WEEKLY', goal, reward: '1,000 pts', state: 'progress', stateLabel: 'Started', fill: null, counted: false, earned: null, illustration: null, illustrationTone: null, ...over });
const base = {
  tabs: [{ key: 'challenges', label: 'Challenges' }, { key: 'topochain', label: 'Standings' }], onTab() {},
  state: 'cards',
  progress: { done: 10, total: 11, points: '15,128 pts' },
  groups: [
    { key: 'next', heading: 'Next challenges', cards: [card(0, 'Build for your community'), card(1, 'Send useful feedback', { stateLabel: '0/4 counted this week', reward: 'Up to 1,000 pts' })] },
    { key: 'done', heading: 'Done', cards: [card(2, 'Join a community', { done: true, state: 'done', reward: '500 pts', earned: '500 pts' })] },
  ],
  notice: null, onOpen() {},
  standing: { rank: '#16', of: 'of 149 ranked', pending: null, token: null },
};
const render = (over) => renderComponent(FRAME, 'ChallengesFrame', { ...base, ...over }, { cache: false });
const columns = (html) => {
  const at = html.indexOf('<div class="fr-cols">');
  const side = html.lastIndexOf('<div class="fr-stack fr-first">');
  return { main: html.slice(at, side), side: html.slice(side) };
};

test('Challenges is a page of the frame: its title, the fixed sentence, the two tabs', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-challenges-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Challenges<\/h1><p class="fr-purpose">Your place comes from the points you earn in challenges\.<\/p><\/div><\/div><nav class="fr-tabs"><button type="button" class="fr-tab fr-on" aria-pressed="true">Challenges<\/button><button type="button" class="fr-tab" aria-pressed="false">Standings<\/button><\/nav>/);
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
  assert.doesNotMatch(html, /fr-purpose">#16/, 'the standing is not the head\'s sentence any more');
});

test('first in the column: the points and how many are done, over one bar', () => {
  const { main } = columns(render());
  assert.match(main, /^<div class="fr-cols"><div class="fr-stack"><div class="fr-card fr-pad fr-progress"><div class="fr-sub15 fr-mut"><b>15,128 pts<\/b> · 10 of 11 done<\/div><div class="fr-prog" role="meter" aria-valuemin="0" aria-valuemax="11" aria-valuenow="10" aria-label="10 of 11 done"><i style="width:91%"><\/i><\/div><\/div>/);
  assert.match(columns(render({ progress: { done: 11, total: 11, points: null } })).main, /<div class="fr-sub15 fr-mut">11 of 11 done<\/div><div class="fr-prog fr-done" role="meter"/, 'no points known: the count alone; all done: green');
  assert.doesNotMatch(render({ progress: null }), /fr-progress/);
  assert.doesNotMatch(main.slice(0, main.indexOf('<section')), /role="progressbar"/, 'a meter, as the standard bar is (an open challenge\'s rail is the progressbar, as the standard card\'s)');
});

test('what can still be earned is rows that open the challenge, each ending in its points as a pill', () => {
  const html = render();
  // Version 2, today's content: the row holds what the standard card holds, the name over the rail that says where it stands.
  assert.match(html, /<h2 class="fr-cap">Next challenges<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row fr-wrap" data-challenge-open=""><span class="fr-lead fr-acc" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Build for your community<\/span><span class="fr-rail" data-state="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Started" aria-label="Build for your community: Started"><span>Started<\/span><\/span><\/span><span class="fr-pill" data-kind="none">1,000 pts<\/span><svg/s);
  assert.match(html, /<span class="fr-t">Send useful feedback<\/span><span class="fr-rail" data-state="progress"[^>]*><span>0\/4 counted this week<\/span><\/span><\/span><span class="fr-pill" data-kind="none">Up to 1,000 pts<\/span>/, 'its name, then where it stands, never its kind in capitals');
  assert.doesNotMatch(html, /WEEKLY/);
  // The wrapping row: beside the points pill a phone cut the name to "Use apps for 10 min…".
  assert.doesNotMatch(html, /<button type="button" class="fr-row"><span class="fr-lead fr-acc"/, 'no open challenge is a one-line row');
});

test('an open challenge keeps today\'s picture and rail: the art on its tone, a bar when the challenge is counted', () => {
  const html = render({ groups: [{ key: 'next', heading: 'Next challenges', cards: [
    card(0, 'Try three apps', { illustration: 'try-three-apps', state: 'progress', stateLabel: '1/3 apps', fill: 1 / 3, counted: true }),
    card(1, 'Send feedback', { illustration: 'try-three-apps', state: 'new', stateLabel: '0/4 counted this week', fill: 0, counted: true }),
    card(2, 'Use apps for 10 minutes', { illustration: 'no such art', state: 'progress', stateLabel: 'Started', fill: 0.5, counted: false }),
  ] }] });
  assert.match(html, /<span class="fr-cart" style="background:#e2f2e8" aria-hidden="true"><img src="\/illustrations\/challenges\/try-three-apps\.svg" alt="" draggable="false" loading="lazy"\/><\/span><span class="fr-tx"><span class="fr-t">Try three apps<\/span>/, 'the registry\'s picture on its tone leads the row');
  assert.match(html, /aria-valuenow="33" aria-valuetext="1\/3 apps" aria-label="Try three apps: 1\/3 apps"><i style="width:33%"><\/i><span>1\/3 apps<\/span>/, 'a counted challenge draws its bar');
  assert.match(html, /<span class="fr-rail" data-state="new"[^>]*aria-valuenow="0"[^>]*><i style="width:6%"><\/i><span>0\/4 counted this week<\/span>/, 'from zero the bar is its stub');
  assert.match(html, /<span class="fr-lead fr-acc" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Use apps for 10 minutes<\/span><span class="fr-rail" data-state="progress"[^>]*aria-valuenow="50"[^>]*><span>Started<\/span>/s, 'no picture: the trophy; not counted: words alone, no bar');
  const src = read(FRAME);
  assert.match(src, /import \{ TONE_FILL, resolveIllustration \} from '\.\.\/\.\.\/\.\.\/lib\/challenge-illustrations';/, 'the standard card\'s own registry');
  const css = read('public/css/app.css');
  assert.ok(css.includes('html[data-skin] [data-challenges-frame] .fr-row[data-challenge-open] > .fr-cart { width: 56px; height: 56px; border-radius: 14px; }'));
  assert.ok(css.includes('html[data-skin] [data-challenges-frame] .fr-row[data-challenge-open] .fr-rail { grid-column: 2 / span 2; grid-row: 2; margin-top: 0; }'), 'on a phone the rail has the second line whole');
});

test('what is done is short rows with a green check and the points earned in green', () => {
  const html = render();
  assert.match(html, /<h2 class="fr-cap">Done<\/h2><\/div><div class="fr-card"><button type="button" class="fr-row fr-sm"><span class="fr-lead fr-ok" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Join a community<\/span><\/span><span class="fr-meta fr-ok">500 pts<\/span>/s);
});

test('Your standing is one card in the side column, above the list on a phone: the rank, its two sentences', () => {
  const { side } = columns(render());
  assert.match(side, /^<div class="fr-stack fr-first"><section class="fr-sec" data-frame-standing=""><div class="fr-sechead"><h2 class="fr-cap">Your standing<\/h2><\/div><div class="fr-card fr-text"><div class="fr-sub22">#16 <span class="fr-sub15 fr-mut">of 149 ranked<\/span><\/div><div class="fr-txt">Your place comes from the points you earn in challenges\.<\/div><div class="fr-txt">Your place updates within about 10 minutes whenever anyone earns points, so it can move even when you did nothing\.<\/div><\/div><\/section>/);
  assert.doesNotMatch(side, /fr-facts|fr-note/, 'no strip of figures and no separate note');
  assert.match(columns(render({ standing: { rank: null, of: null, pending: '1,000 pts earned, not in the standings yet', token: null } })).side, /<div class="fr-sub17">Your standing<\/div><div class="fr-sub15">1,000 pts earned, not in the standings yet<\/div>/, 'before the standings have you: the card says so, with what is pending');
  assert.doesNotMatch(render({ standing: null }), /Your standing/);
});

test('the token allocation keeps its two states, in the same group', () => {
  const gated = render({ standing: { ...base.standing, token: { gated: true, onReview() {} } } });
  assert.match(gated, /<span class="fr-t">Token allocation withheld<\/span><span class="fr-s">Review and accept the terms to see your token allocation\.<\/span><\/span><button type="button" class="fr-btn fr-quiet fr-sm">Review terms<\/button>/);
  const hidden = render({ standing: { ...base.standing, token: { gated: false, amount: '1,250', revealed: false, onReveal() {} } } });
  assert.match(hidden, /<span class="fr-t">Token allocation<\/span>.*?<button type="button" class="fr-btn fr-quiet fr-sm">Reveal<\/button>/s);
  assert.doesNotMatch(hidden, /1,250/, 'not shown until it is revealed');
  assert.match(render({ standing: { ...base.standing, token: { gated: false, amount: '1,250', revealed: true, onReveal() {} } } }), /<span class="fr-meta">1,250<\/span>/);
});

test('today\'s other parts: the way to the first challenges, what Getting started hides, and the states before the cards', () => {
  assert.match(render({ onFirst() {} }), /<div><button type="button" class="fr-link">Go to First challenges<\/button><\/div>/);
  assert.doesNotMatch(render(), /Go to First challenges/);
  const locked = render({ locked: { title: '3 challenges unlock after Getting started', hint: 'A, B and C' }, notice: 'Finish Getting started to unlock the rest of the season.' });
  assert.match(locked, /<span class="fr-lead fr-dash" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">3 challenges unlock after Getting started<\/span><span class="fr-s">A, B and C<\/span>/s);
  assert.doesNotMatch(locked, /Finish Getting started to unlock/, 'the placeholder says it: the note is drawn only without it, as on the standard page');
  assert.match(render({ notice: 'Finish Getting started to unlock the rest of the season.' }), /<div role="status"><div class="fr-note">/);
  const loading = render({ state: 'loading', groups: [], progress: null });
  assert.match(loading, /<div class="fr-card fr-pad">Loading challenges<\/div>/);
  assert.match(loading, /<nav class="fr-tabs">/, 'the head and tabs stay');
  assert.match(render({ state: 'error', error: 'Failed to load challenges.', groups: [], progress: null }), /<div role="alert"><div class="fr-note fr-bad">.*?Failed to load challenges\./s);
  assert.match(render({ state: 'empty', groups: [], progress: null }), /<span class="fr-t">No challenges right now<\/span><span class="fr-s">New ones will show up here\.<\/span>/);
});

test('the pane draws the kit\'s page under a look in every state, ahead of its own parts', () => {
  const src = read('frontend/src/features/leaderboard/challenges-pane.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /\{frame \? <ChallengesInFrame grid=\{state\.grid\} up=\{!state\.detail\} \/> : null\}/, 'loading, the error and "no challenges" keep the head and tabs too');
  assert.match(src, /state=\{!grid \|\| grid\.kind === 'loading' \? 'loading' : grid\.kind\}/);
  assert.match(src, /points: points == null \? null : t\('leaderboard:challenges\.points', \{ count: points, points: points\.toLocaleString\('en-US'\) \}\),/, 'the points as the standard line says them');
  assert.match(src, /locked=\{cards && lockedCount >= 1 \? \{ title: lockedTitle\(lockedCount\), hint: lockedHint\(lockedCount, cards\.lockedNames\) \} : null\}/);
  assert.match(src, /up=\{up && section === 'challenges'\}/, 'the page on show only while its own section is, and no challenge\'s page is over it');
  assert.match(read('frontend/src/features/frame/frame-flag.ts'), /if \(!on\) return undefined;/);
  assert.match(src, /<YourStanding \/>\s*<Grid view=\{state\.grid\} \/>/, 'its own parts stay as written');
  assert.doesNotMatch(src, /leaderboard:frame\./, 'the joined sentence and its words are gone');
  const catalog = JSON.parse(read('frontend/locales/en/leaderboard.json'));
  for (const id of ['frame.pair', 'frame.pts', 'frame.points', 'standings.frame.season', 'standings.frame.event']) assert.equal(catalog[id], undefined, `${id} is removed`);
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]\[data-challenges-frame\] #tc-se-grid > :not\(\.fr\) \{ display: none; \}/);
  assert.match(hand, /html\[data-skin\]\[data-challenges-frame\] #leaderboard-screen \{ padding-inline-start: var\(--platform-rail-w, 0px\) !important; padding-inline-end: 0 !important; \}/);
  assert.match(hand, /html\[data-skin\]\[data-challenges-frame\] #standings-tabs \{ display: none; \}/, 'the tabs are the kit\'s');
});

test('Standings wears the same head and tabs', () => {
  const html = renderComponent(FRAME, 'StandingsFrameHead', { tabs: base.tabs, onTab() {} }, { cache: false });
  assert.match(html, /^<div class="fr" data-standings-frame=""><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Challenges<\/h1><p class="fr-purpose">Your place comes from the points you earn in challenges\.<\/p><\/div><\/div><nav class="fr-tabs"><button type="button" class="fr-tab" aria-pressed="false">Challenges<\/button><button type="button" class="fr-tab fr-on" aria-pressed="true">Standings<\/button><\/nav><\/div><\/div>$/);
  const src = read('frontend/src/features/leaderboard/topochain-standings.tsx');
  assert.match(src, /<StandingsInFrameHead \/>\s*<StandingsFrameCols event=\{event\}>\s*<div id="tc-lb-body">/);
  assert.doesNotMatch(src, /MyStanding/, 'the head no longer reads your rank');
  assert.match(src, /up=\{section === 'topochain'\}/);
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-standings-frame\] #standings-tabs \{ display: none; \}/);
});
