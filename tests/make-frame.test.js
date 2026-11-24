// Make and Import in the one frame (version 2 of the tour's s42 and s43).
// Opened from Create, under a look, "What do you want to make?"
// (features/first-session/make.tsx) and the import form after its link are
// pages of the kit (./frame/make-frame.tsx): the title in the head with the
// primary button, the other way to start and the close control, the ideas as
// four cards, the two answers as fields in one card, and who can change it
// in the side column. The form's state, ids and handlers are the standard
// screen's; the standard screen is not changed at all. This overturns the
// first programme's ruling that Make keeps its form under a look.
//
// Run with: node --test tests/make-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const css = read('public/css/app.css');
const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
const FRAME = 'frontend/src/features/first-session/frame/make-frame.tsx';
const RULE = 'frontend/src/features/who-decides/make-rule.tsx';
const ref = { current: null };
const no = () => {};

const idea = (attr, label, more = {}) => ({ attr, on: false, lead: '🎮', label, onPick: no, ...more });
const plain = { kind: 'plain', boxRef: ref, value: '', max: 4000, placeholder: 'A map of our favorite swimming spots…', onChange: no, onScroll: no, fade: '', kept: null };
const make = (over = {}) => renderComponent(FRAME, 'MakeFrame', {
  motion: 'translate-y-0', title: 'What do you want to make?', onSubmit: no, onImport: no, onClose: no, busy: false, off: false,
  ideas: [idea('tier', 'Tier list'), idea('game', 'A game'), idea('organizer', 'Organizer'), idea('more', 'Something else…', { popup: true })],
  brief: plain, onToName: no, mic: null, briefNeeded: null,
  name: { boxRef: ref, value: '', placeholder: 'For example, My New App', onChange: no, needed: null },
  speed: null, rule: null, allowance: null, error: null, ...over,
}, { cache: false });
const imports = (over = {}) => renderComponent(FRAME, 'ImportFrame', {
  motion: 'translate-y-0', title: 'Import a GitHub repo', line: 'Bring an app that already exists. Your group builds on it from here.',
  onSubmit: no, onDescribe: no, onClose: no, busy: false, off: false,
  url: { boxRef: ref, value: '', onChange: no, onBlur: no, onKeyDown: no },
  check: { label: 'Check', off: false, onPress: no },
  status: { state: 'idle', tone: undefined, text: 'Invite usernode-bot to the repo first (Write access on an organization repo).', spinner: null },
  name: { boxRef: ref, value: '', onChange: no, needed: null },
  note: null, allowance: null, error: null, ...over,
}, { cache: false });

test('from Create, Make and the made screen sit in the frame\'s page area, not over its sidebar and bar', () => {
  const rule = hand.match(/html\[data-skin\]\[data-frame-chrome\] :is\(\.platform-kb-surface, \[data-first-session-made\]\)\.platform-under-header \{([^}]*)\}/);
  assert.ok(rule, 'only while the frame\'s chrome is up');
  assert.match(rule[1], /top: var\(--fr-shell-top, 0px\);/);
  assert.match(rule[1], /bottom: 0;\s+padding-bottom: var\(--fr-shell-bottom, 0px\);/, 'to the foot, the tab bar\'s height kept clear inside: the bar is see-through');
  assert.match(rule[1], /inset-inline-start: var\(--fr-shell-left, 0px\);/);
  assert.match(rule[1], /background: var\(--fr-page, var\(--home-wallpaper, var\(--fr-ground\)\)\) !important;/,
    'the page\'s own ground again: the look\'s flat page where it has one, else the wallpaper the body draws, never a flat colour over a wash');
  // None of the five looks has a page of its own today (Brand kit, retired, had): every one reads the wallpaper.
  assert.doesNotMatch(css.slice(css.indexOf('/* looks:begin'), css.indexOf('/* looks:end */')), /--fr-page:/);
  // The roots the rule reads are the product's, as written.
  const src = read('frontend/src/features/first-session/make.tsx');
  assert.match(src, /export const MAKE_ROOT_UNDER_HEADER = 'platform-kb-surface platform-under-header fixed inset-x-0 bottom-0 /);
  assert.match(src, /export const MAKE_ROOT = 'platform-kb-surface fixed inset-0 /, 'the first session\'s Make keeps the whole screen');
});

test('the standard title still wears the kit\'s title where the standard form is drawn under a look', () => {
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.title.to, /#first-session-make-title/);
  assert.match(read('frontend/src/features/first-session/make.tsx'), /id="first-session-make-title"/);
});

test('the screen draws the kit\'s page only from Create, under a look, below the frame\'s bar; the standard render is untouched', () => {
  const src = read('frontend/src/features/first-session/make.tsx');
  assert.match(src, /const look = useLiveSkin\(\);/, 'read with the other hooks, never behind a condition');
  assert.match(src, /const kit = isFrameSkin\(look\) && fromCreate && underHeader;/, 'the first session\'s Make keeps its own screen and form');
  assert.match(src, /useFramePage\(kit \? \[t\('core:tabs\.home'\), t\('home:create\.label'\)\] : null, kit && onClose \? leave : null\);/, 'the bar says Home › New project, and its arrow leaves the way ✕ does');
  const hooks = src.slice(src.indexOf('export function MakeScreen('), src.lastIndexOf('const template = picked && picked !== OWN_IDEA ? picked : null;'));
  assert.ok(hooks.includes('useFramePage('), 'before anything that could return');
  const branch = src.slice(src.indexOf('  if (kit) {'), src.indexOf('\n  return (\n    <div\n      ref={rootRef}'));
  assert.ok(branch.length > 1000, 'one branch, before the standard render');
  assert.match(branch, /<MakeFrameShell rootRef=\{rootRef\} scrollerRef=\{scrollerRef\} rootClass=\{MAKE_ROOT_UNDER_HEADER\} entry=\{entry\} mode=\{mode\}>/, 'the same root and scroller: the page lock, the keyboard surface and the leaving fade are the standard screen\'s');
  assert.match(branch, /onSubmit=\{\(\) => \{ void make\(\); \}\}/);
  assert.match(branch, /onImport=\{\(\) => setMode\('import'\)\}/);
  assert.match(branch, /onClose=\{onClose \? leave : null\}/, 'the close control is kept');
  assert.match(branch, /off=\{dictating \|\| busy \|\| quotaBlocks\}/, 'Make it is off exactly when the standard button is');
  assert.match(branch, /<SpeakButton\s+scope=\{`make:\$\{mode\}:\$\{template\?\.key \|\| 'idea'\}:\$\{written === null \? choice : 'written'\}`\}/, 'the microphone, with the standard scope');
  assert.match(branch, /rule=\{<MakeRuleRows preset=\{rule\} onPick=\{setRule\} who=\{who\} \/>\}/);
  assert.match(branch, /kind: 'sentence',[\s\S]*onWords: changeWords,[\s\S]*onWriteOut: template\.finish \? null : writeOut,/, 'a picked idea keeps its sentence, its blank and its choices');
  assert.match(branch, /<MoreSheet\b/, 'Something else… opens the same sheet');
  assert.match(branch, /frame=\{\{ motion, title: t\(IMPORT_TITLE\), line: t\(IMPORT_LINE\), onClose: onClose \? leave : null \}\}/, 'the import form draws its own kit page, from its own state');
  // The standard render after it is as it was: its pinned lines stand once, after the branch.
  const standard = src.slice(src.indexOf('\n  return (\n    <div\n      ref={rootRef}'));
  for (const line of ['<MakeRuleLine preset={rule} onPick={setRule} who={who} />', 'data-make-submit=""', 'data-make-close=""', 'data-make-import-link=""', 'id="first-session-brief"', 'id="first-session-name"']) {
    assert.equal(src.split(line).length - 1, 1, `${line} is written once`);
    assert.ok(standard.includes(line), `${line} is the standard render's`);
  }
  assert.doesNotMatch(standard, /\bkit\b|MakeFrame|isFrameSkin/, 'nothing in the standard render asks about the look');
});

test('s42: the head, four idea cards, the two fields in one card, and who can change it beside them', () => {
  const html = make({ rule: 'RULE' });
  assert.match(html, /^<form data-make-kit-form="make" class="mk-form translate-y-0"><div class="fr" data-make-frame="make"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 id="first-session-make-title" class="fr-title">What do you want to make\?<\/h1><\/div><div class="fr-acts">/);
  assert.doesNotMatch(html.slice(0, html.indexOf('fr-acts')), /fr-purpose/, 'no sentence under the title: today\'s screen has none from Create');
  const acts = html.slice(html.indexOf('<div class="fr-acts">'), html.indexOf('<div class="fr-cols">'));
  assert.match(acts, /^<div class="fr-acts"><button type="button" class="fr-btn fr-line fr-d" data-make-import-link="">Import from a GitHub repo<\/button><button type="submit" class="fr-btn" data-make-submit="">Make it<\/button><button type="button" class="fr-ib" data-make-close="" aria-label="Close"><svg/, 'the other way to start (a desktop\'s), the primary button, the close control');
  const main = html.slice(html.indexOf('<div class="fr-cols">'), html.lastIndexOf('<div class="fr-stack">'));
  assert.match(main, /<h2 class="fr-cap">Start from an idea<\/h2>.*?<div class="fr-grid fr-g2" role="group" aria-label="Ideas">/s);
  assert.deepEqual([...main.matchAll(/<button type="button" class="fr-card fr-press" aria-pressed="false"(?: aria-haspopup="dialog")? data-first-session-example="([a-z]+)"><span class="fr-row fr-wrap"><span class="fr-lead" aria-hidden="true">[^<]*<\/span><span class="fr-tx"><span class="fr-t">([^<]+)<\/span><\/span><\/span><\/button>/g)].map((m) => [m[1], m[2]]),
    [['tier', 'Tier list'], ['game', 'A game'], ['organizer', 'Organizer'], ['more', 'Something else…']]);
  assert.match(main, /data-first-session-example="more"/);
  assert.match(main, /aria-haspopup="dialog" data-first-session-example="more"/, 'the fourth opens the sheet');
  assert.match(main, /<h2 class="fr-cap">Your idea<\/h2>.*?<div class="fr-card" data-make-brief=""><div class="fr-fields"><div class="fr-field"><label for="first-session-brief">What should it do\?<\/label><div class="fr-inp fr-area"><textarea id="first-session-brief" class="fr-v" rows="3" maxLength="4000" enterKeyHint="next" placeholder="A map of our favorite swimming spots…"><\/textarea><span class="mk-mic"><\/span><\/div><\/div><div class="fr-field"><label for="first-session-name">What should we call it\?<\/label><div class="fr-inp"><input id="first-session-name" class="fr-v" type="text" autoComplete="off" enterKeyHint="go" placeholder="For example, My New App" value=""\/><\/div><\/div><\/div><\/div>/s);
  assert.match(main, /<div class="fr-foot fr-p"><button type="button" class="fr-link" data-make-import-link="">Import from a GitHub repo<\/button><\/div>/, 'on a phone the link under the form, where today\'s form has it');
  assert.match(html, /<div class="fr-stack"><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">Who can change it<\/h2><\/div>RULE<\/section><\/div><\/div><\/div><\/div><\/form>$/, 'the side column holds the rule alone');
  assert.doesNotMatch(html, /Suggested from your description|What we found|fr-track|data-make-hold|mk-after/, 'nothing the first tour invented, and no empty parts');
});

test('s42: a picked idea, its states and what a press found missing are today\'s', () => {
  const on = make({ ideas: [idea('tier', 'Tier list', { on: true }), idea('idea', 'Your own idea', { on: true, popup: true, chevron: true })] });
  assert.match(on, /<button type="button" class="fr-card fr-press fr-on" aria-pressed="true" data-first-session-example="tier">/, 'the picked card has the accent\'s ring');
  assert.match(on, /data-first-session-example="idea">.*?<span class="fr-t">Your own idea<\/span><\/span><svg class="fr-ic fr-go"/s, 'a pick from the sheet takes the fourth card over, chevron and all');
  const said = make({
    brief: {
      kind: 'sentence', template: 'tier', head: 'A tier list for ', tail: '. Anyone can add items.', fill: 'our favorite restaurants', finish: false, own: false,
      words: '', onWords: no, fieldRef: ref, areaRef: ref, fieldPlaceholder: 'for example, pizza toppings', areaPlaceholder: '', areaMax: 3800,
      chips: [{ key: 'restaurants', label: 'Restaurants', on: true, onPick: no }, { key: 'own', label: 'Your own…', on: false, onPick: no }], onWriteOut: no,
    },
    mic: 'MIC', speed: { key: 'instant', id: 'onboarding:firstSession.make.speed.instant' },
  });
  assert.match(said, /<div class="mk-lab"><span>What should it do\?<\/span><button type="button" class="fr-link" data-make-write-out="">Write it yourself<\/button><\/div><p data-make-sentence="tier" class="mk-say">A tier list for <span class="mk-blank">our favorite restaurants<\/span>\. Anyone can add items\.<\/p>/);
  assert.match(said, /<div class="fr-btnrow fr-chips" role="group" aria-label="[^"]+"><button type="button" class="fr-btn fr-sm fr-chip" aria-pressed="true" data-make-choice="restaurants">Restaurants<\/button><button type="button" class="fr-btn fr-quiet fr-sm fr-chip" aria-pressed="false" data-make-choice="own">Your own…<\/button><span class="mk-mic mk-mic-row">MIC<\/span><\/div>/, 'the choices are the kit\'s small buttons, the chosen one filled; the microphone ends their row');
  assert.match(said, /<p data-make-speed="instant" class="mk-speed"><svg[^>]*>.*?<\/svg><span>.*?<b>/s, 'the line about speed, under the card');
  const own = make({ brief: { kind: 'sentence', template: 'tier', head: 'A tier list for ', tail: '.', fill: '', finish: false, own: true, words: 'board games', onWords: no, fieldRef: ref, areaRef: ref, fieldPlaceholder: 'x', areaPlaceholder: '', areaMax: 3800, chips: [], onWriteOut: no } });
  assert.match(own, /<input id="make-words" type="text" autoComplete="off" enterKeyHint="next" maxLength="60" aria-label="[^"]+" placeholder="x" class="mk-blank mk-blank-field" value="board games"\/>/, 'Your own…: the blank is the field, with its id');
  const game = make({ brief: { kind: 'sentence', template: 'game', head: 'A new game we build together. ', tail: '', fill: '', finish: true, own: true, words: '', onWords: no, fieldRef: ref, areaRef: ref, fieldPlaceholder: '', areaPlaceholder: 'For example, a drawing game', areaMax: 3800, chips: [], onWriteOut: null }, mic: 'MIC' });
  assert.match(game, /<label for="make-words" class="mk-finish"><svg[^>]*>.*?<\/svg>[^<]+<\/label><div class="fr-inp fr-area"><textarea id="make-words" class="fr-v" rows="2" maxLength="3800" enterKeyHint="next" placeholder="For example, a drawing game"><\/textarea><span class="mk-mic">MIC<\/span><\/div>/s, 'a game: the rest of the sentence in a box, the microphone inside it');
  assert.doesNotMatch(game, /data-make-write-out/, 'and no Write it yourself');
  const kept = make({ brief: { ...plain, value: 'A map', kept: { attr: 'data-make-waitlist-idea', text: 'From your waitlist answer.' } }, mic: 'MIC' });
  assert.match(kept, /<div class="fr-inp fr-area fr-val"><textarea id="first-session-brief"[^>]*>A map<\/textarea><span class="mk-mic">MIC<\/span><\/div><span class="fr-hint" data-make-waitlist-idea="">From your waitlist answer\.<\/span>/);
  const gaps = make({ briefNeeded: 'Say what it should do first.', name: { boxRef: ref, value: '', placeholder: '', onChange: no, needed: 'Give it a name.' }, error: 'Could not make it.', busy: true, off: true, allowance: 'ALLOWANCE' });
  assert.match(gaps, /aria-describedby="first-session-brief-needed"/);
  assert.match(gaps, /<span id="first-session-brief-needed" role="alert" class="fr-hint fr-bad">Say what it should do first\.<\/span>/);
  assert.match(gaps, /aria-describedby="first-session-name-hint"[^>]*\/><\/div><span id="first-session-name-hint" role="alert" class="fr-hint fr-bad">Give it a name\.<\/span>/);
  assert.match(gaps, /<p role="alert" class="mk-error">Could not make it\.<\/p>/);
  assert.match(gaps, /<button type="submit" class="fr-btn fr-off" data-make-submit="" disabled="">Making it…<\/button>/);
  assert.match(gaps, /<\/div><div class="mk-after">ALLOWANCE<\/div><div aria-hidden="true" data-make-hold="" class="h-\[60vh\] shrink-0"><\/div><\/form>$/, 'the product\'s allowance block stands outside the frame root, and the form is held while it makes');
  assert.doesNotMatch(make({ onClose: null }), /data-make-close/);
});

test('who can change it is two rows of one card: the rule with Change, and What happens next, which opens the note in place', () => {
  const html = renderComponent(RULE, 'MakeRuleRows', { preset: 'you_or_the_group', onPick: no, who: 'snait' }, { cache: false });
  assert.match(html, /^<div class="fr-card" data-make-rule="you_or_the_group"><div class="fr-row"><span class="fr-lead" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><span class="fr-tx"><span class="fr-t">You or the group<\/span><\/span><button type="button" class="fr-btn fr-quiet fr-sm" data-make-rule-change="">Change<\/button><\/div><button type="button" class="fr-row" data-make-rule-info="" aria-expanded="false" aria-controls="make-rule-tip"><span class="fr-lead" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><span class="fr-tx"><span class="fr-t">What happens next<\/span><\/span><svg class="fr-ic fr-go"[^>]*>.*?<\/svg><\/button><\/div>$/s, 'closed on the first render, as the tip is');
  const src = read(RULE);
  const rows = src.slice(src.indexOf('export function MakeRuleRows('));
  assert.match(rows, /<PresetsSheet now=\{preset\} viewer=\{viewer\} onPick=\{onPick\} onGone=\{\(\) => setOpen\(false\)\} \/>/, 'Change opens the line\'s own sheet');
  for (const id of ['readyMade', 'custom', 'invite', 'rule']) assert.ok(rows.includes(`id="onboarding:firstSession.make.next.${id}"`), `the note's line: ${id}`);
  assert.match(rows, /<ul id="make-rule-tip" role="note" data-make-rule-tip="" className=\{k\('bullets'\)\}>/);
  assert.ok(src.indexOf('export function MakeRuleLine(') < src.indexOf('export function MakeRuleRows('), 'added after the line, which is as it was');
});

test('s43: the import form is one narrow page: the head with Import it, one card of the two fields, Check beside the address', () => {
  const html = imports();
  assert.match(html, /^<form data-make-import="" data-make-kit-form="import" class="mk-form translate-y-0"><div class="fr" data-make-frame="import"><div class="fr-inner fr-narrow"><div class="fr-head"><div class="fr-tx"><h1 id="first-session-make-title" class="fr-title">Import a GitHub repo<\/h1><p class="fr-purpose">Bring an app that already exists\. Your group builds on it from here\.<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn fr-line fr-d" data-make-describe="">Describe a new project instead<\/button><button type="submit" class="fr-btn" data-make-import-submit="">Import it<\/button><button type="button" class="fr-ib" data-make-close="" aria-label="Close">/);
  assert.match(html, /<h2 class="fr-cap">Repository<\/h2><\/div><div class="fr-card"><div class="fr-fields"><div class="fr-field"><label for="make-import-url">GitHub repo URL<\/label><div class="fr-fieldrow"><div class="fr-inp fr-code"><svg[^>]*>.*?<\/svg><input id="make-import-url" class="fr-v" type="text" inputMode="url" autoComplete="off" spellCheck="false" enterKeyHint="go" aria-describedby="make-import-status" placeholder="[^"]+" value=""\/><\/div><button type="button" class="fr-btn fr-quiet fr-sm" data-make-import-check="">Check<\/button><\/div><span id="make-import-status" role="status" data-import-state="idle" class="fr-hint mk-status">Invite usernode-bot to the repo first \(Write access on an organization repo\)\.<\/span><\/div><div class="fr-field"><label for="make-import-name">What should we call it\?<\/label><div class="fr-inp"><input id="make-import-name" class="fr-v" type="text" autoComplete="off" enterKeyHint="go" placeholder="[^"]+" value=""\/><\/div><\/div><\/div><\/div>/s);
  assert.match(html, /<div class="fr-foot fr-p"><button type="button" class="fr-link" data-make-describe="">Describe a new project instead<\/button><\/div><\/div><\/div><\/div><\/form>$/);
  assert.doesNotMatch(html, /What we found|dapp\.json|fr-cols/, 'one column, and nothing the first tour invented');
  const ok = imports({
    url: { boxRef: ref, value: 'https://github.com/lingash25/brew-log', onChange: no, onBlur: no, onKeyDown: no },
    check: { label: 'Re-check', off: false, onPress: no },
    status: { state: 'ok', tone: 'ok', text: 'usernode-bot has Write access to lingash25/brew-log.', spinner: null },
    name: { boxRef: ref, value: 'Brew Log', onChange: no, needed: null },
    note: 'The repo is private, so only people you invite see the project.', error: 'Could not import it.', busy: true, off: true, allowance: 'ALLOWANCE',
  });
  assert.match(ok, /data-make-import-check="">Re-check<\/button>/);
  assert.match(ok, /<span id="make-import-status" role="status" data-import-state="ok" class="fr-hint fr-ok mk-status">usernode-bot has Write access to lingash25\/brew-log\.<\/span>/);
  assert.match(ok, /<p data-make-import-note="" class="fr-secnote">The repo is private, so only people you invite see the project\.<\/p><p role="alert" class="mk-error">Could not import it\.<\/p>/, 'the note about the repo and the error are kept');
  assert.match(ok, /<button type="submit" class="fr-btn fr-off" data-make-import-submit="" disabled="">Importing…<\/button>/);
  assert.match(ok, /<div class="mk-after mk-after-narrow">ALLOWANCE<\/div><\/form>$/);
  const bad = imports({ status: { state: 'error', tone: 'bad', text: 'No such repo.', spinner: 'SPIN' }, check: { label: 'Check', off: true, onPress: no }, name: { boxRef: ref, value: '', onChange: no, needed: 'Give it a name.' } });
  assert.match(bad, /data-import-state="error" class="fr-hint fr-bad mk-status">SPINNo such repo\.<\/span>/);
  assert.match(bad, /class="fr-btn fr-quiet fr-sm fr-off" data-make-import-check="" disabled="">Check<\/button>/);
  assert.match(bad, /<span id="make-import-name-hint" role="alert" class="fr-hint fr-bad">Give it a name\.<\/span>/);
});

test('the import form draws the kit page from its own state, with the standard fields\' own handlers', () => {
  const src = read('frontend/src/features/first-session/import-repo.tsx');
  const branch = src.slice(src.indexOf('  if (frame) {'), src.indexOf('  return (\n    <form data-make-import="" className={className}'));
  assert.ok(branch.length > 500);
  assert.match(branch, /onSubmit=\{\(\) => \{ void go\(\); \}\}/);
  assert.match(branch, /off=\{busy \|\| blocked\}/);
  assert.match(branch, /onBlur: \(\) => setUrl\(\(typed\) => normalizeRepositoryUrl\(typed\)\),/, 'leaving the field still canonicalises it');
  assert.match(branch, /if \(state === 'ok'\) nameRef\.current\?\.focus\(\{ preventScroll: true \}\);\s+else void check\(\);/, 'Return checks, or moves on to the name');
  assert.match(branch, /setState\('idle'\); setStatus\(''\); setManifest\(null\); setUnread\(false\);/, 'a new address is an unchecked one');
  assert.match(branch, /tone: state === 'error' \|\| missing === 'repo' \? 'bad' : state === 'ok' \? 'ok' : undefined,/);
  assert.equal(src.split('id="make-import-url"').length - 1, 1, 'the standard form\'s markup is written once, after the branch');
});

test('the page\'s own small parts are dressed by hand in the kit\'s tokens, under a look only', () => {
  const block = hand.slice(hand.indexOf('/* MAKE AND IMPORT IN THE KIT'), hand.indexOf('/* CHALLENGES (features/leaderboard/frame/challenges-frame.tsx)'));
  assert.ok(block.length > 800);
  for (const rule of block.split('\n').filter((line) => /\{/.test(line) && !/^@media|^\s*\/?\*|^   /.test(line))) assert.match(rule.trim(), /^html\[data-skin\] \[data-make-(kit|frame="import")\]/, rule);
  for (const name of ['mk-form', 'mk-four', 'mk-lab', 'mk-say', 'mk-blank', 'mk-blank-field', 'mk-finish', 'mk-mic', 'mk-speed', 'mk-error', 'mk-status', 'mk-after']) assert.ok(block.includes(`.${name}`), name);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no literal colour');
  assert.doesNotMatch(block, /(margin|padding|border)-(left|right)|[^-](left|right)\s*:/, 'logical sides only');
  const catalog = JSON.parse(read('frontend/locales/en/onboarding.json'));
  assert.equal(catalog['firstSession.make.frame.yourIdea'].text, 'Your idea');
  assert.equal(catalog['firstSession.make.frame.whoCanChange'].text, 'Who can change it');
  assert.equal(catalog['firstSession.import.frame.repository'].text, 'Repository');
});
