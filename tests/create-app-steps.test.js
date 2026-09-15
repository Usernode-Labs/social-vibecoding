// #1911: the create-app dialog is three steps, not one page of every choice.
//
//   start    from scratch, or from a GitHub repo (the old mode pills, as rows)
//   details  the name; for an import, the repo URL and its check first
//   access   who can build it, who can see it, then Create / Import
//
// Every section ships on every step and app.css shows the current one off
// #create-card[data-step]; the ids the declared checks and public/js select
// on are unchanged. This pins the component's wiring, the CSS, the shot
// links and the checks at source level, and renders the dialog to prove
// the prerendered document starts on the start step with every id present.
//
// Run with: node --test tests/create-app-steps.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = read('frontend/src/features/dialogs/create-app.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));
const { shellMarkup } = require('./lib/shell-markup');

test('the dialog has three steps and starts on the first', () => {
  assert.match(SRC, /type Step = 'start' \| 'details' \| 'access';/);
  assert.match(SRC, /const STEPS: readonly Step\[\] = \['start', 'details', 'access'\];/);
  assert.match(SRC, /useState<Step>\('start'\)/, 'the initial state is the prerendered one');
  // Both the root and the card carry the step, like data-mode: the kit lifts
  // the card out of the root while presented.
  assert.equal((SRC.match(/data-step=\{step\}/g) || []).length, 2, 'data-step on the root and on the card');
  // Close puts the next open back on the start step.
  assert.match(SRC, /formRef\.current\?\.reset\(\);[\s\S]*?setStep\('start'\);/);
});

test('the start step\'s choices are the mode pills, and a choice advances', () => {
  const start = SRC.slice(SRC.indexOf('data-create-step="start"'), SRC.indexOf('data-create-step="details"'));
  assert.match(start, /data-mode-pill="new"/);
  assert.match(start, /data-mode-pill="import"/);
  assert.equal((start.match(/className=\{CHOICE\}/g) || []).length, 2);
  assert.match(SRC, /const CHOICE = 'create-mode-pill w-full text-left ' \+ CARD/, 'the same class the mode pills carried');
  assert.match(start, /onClick=\{\(\) => choose\('new'\)\}/);
  assert.match(start, /onClick=\{\(\) => choose\('import'\)\}/);
  assert.match(SRC, /function choose\(next: Mode\) \{\s*applyMode\(next\);\s*setStep\('details'\);/);
  assert.doesNotMatch(start, /id="create-next"/, 'no Next on the start step: the choice is the way forward');
  assert.match(start, /Start from scratch/);
  assert.match(start, /Import a GitHub repo/);
});

test('the details step keeps the import block and the name card, in that order', () => {
  const details = SRC.slice(SRC.indexOf('data-create-step="details"'), SRC.indexOf('data-create-step="access"'));
  assert.ok(details.indexOf('id="create-import-block"') < details.indexOf('id="create-name-block"'));
  assert.match(details, /id="import-url"/);
  assert.match(details, /id="import-check"/);
  assert.match(details, /id="app-name"/);
});

test('Next runs the old submit guards one step early, and Enter on the details step advances', () => {
  const next = SRC.slice(SRC.indexOf('function next() {'), SRC.indexOf('function back() {'));
  assert.match(next, /Paste a GitHub repo URL first\./);
  assert.match(next, /Click "Check" to verify bot access first\./);
  assert.match(next, /Give your app a name\./);
  assert.match(next, /setStep\('access'\)/);
  assert.match(SRC, /if \(step !== 'access'\) \{\s*if \(step === 'details'\) next\(\);\s*return;\s*\}/,
    'submit on any step but the last never POSTs');
  assert.match(SRC, /function back\(\) \{[\s\S]*?setStep\(step === 'access' \? 'details' : 'start'\)/);
});

test('the access step holds the visibility rails, and the footer carries every button', () => {
  const access = SRC.slice(SRC.indexOf('data-create-step="access"'), SRC.indexOf('id="create-error"'));
  assert.match(access, /id="create-visibility-block"/);
  assert.match(access, /data-collab-vis="public"/);
  assert.match(access, /data-view-vis="private"/);
  assert.match(access, /id="create-vis-hint"/);
  for (const id of ['create-cancel', 'create-back', 'create-next', 'create-submit']) {
    assert.match(SRC, new RegExp(`id="${id}"`), `${id} ships`);
  }
});

test('app.css shows one step at a time and shapes the footer per step', () => {
  assert.match(CSS, /#create-card \[data-create-step\] \{ display: none; \}/);
  for (const step of ['start', 'details', 'access']) {
    assert.match(CSS, new RegExp(`#create-card\\[data-step="${step}"\\]\\s+\\[data-create-step="${step}"\\]`), step);
  }
  assert.match(CSS, /#create-card:not\(\[data-step="start"\]\) #create-cancel \{ display: none; \}/);
  assert.match(CSS, /#create-card\[data-step="start"\] #create-back,\n#create-card\[data-step="start"\] #create-next,\n#create-card\[data-step="start"\] #create-submit,\n#create-card\[data-step="details"\] #create-submit,\n#create-card\[data-step="access"\] #create-next \{\n  display: none;\n\}/);
  // The old import-mode rule on the submit button went: the step gates it now.
  assert.doesNotMatch(CSS, /#create-card\[data-mode="import"\] #create-submit/);
  // The name card's import gating stays.
  assert.match(CSS, /#create-card\[data-mode="import"\]\[data-import-state="ok"\] #create-name-block \{ display: block; \}/);
});

test('the shot links land on the step they name', () => {
  assert.match(SRC, /if \(shot === 'create-import' \|\| shot === 'create-details'\) return 'details';/);
  assert.match(SRC, /if \(shot === 'create-access'\) return 'access';/);
  assert.match(SRC, /const initial = shotStep\(\);\s*setStep\(initial\);/);
  const byPath = new Map(DAPP.tests.map((t) => [t.path, t]));
  const start = DAPP.tests.find((t) => t.path === '/#create' && /Step 1 of 3/.test(t.expectText || ''));
  assert.ok(start, 'a check reads the step count on a cold open');
  assert.match(start.expectSelector, /\[data-step="start"\]/);
  const details = byPath.get('/?shot=create-details#create');
  assert.ok(details, 'the name card is checked on the details step');
  assert.match(details.expectSelector, /\[data-step="details"\] #create-name-block/);
  const access = byPath.get('/?shot=create-access#create');
  assert.ok(access, 'the access step has its own check');
  assert.match(access.expectSelector, /\[data-step="access"\][\s\S]*#create-visibility-block/);
  assert.equal(access.expectText, 'Who can build it');
  const imp = byPath.get('/?shot=create-import#create');
  assert.ok(imp && /data-mode="import"/.test(imp.expectSelector), 'the import shot still lands on the import view');
  // Nothing on /#create expects text that only a later step shows.
  for (const t of DAPP.tests.filter((t) => t.path === '/#create')) {
    assert.doesNotMatch(t.expectText || '', /Who can build it|App name/, t.name);
  }
});

test('the prerendered document starts on the start step with every id in place', () => {
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  assert.match(card, /data-step="start"/);
  assert.match(card, /data-create-step="start"/);
  assert.match(card, /data-create-step="details"/);
  assert.match(card, /data-create-step="access"/);
  assert.match(card, /Step 1 of 3/);
  for (const id of ['create-step-indicator', 'create-import-block', 'create-name-block', 'create-visibility-block',
    'create-cancel', 'create-back', 'create-next', 'create-submit', 'import-url', 'app-name']) {
    assert.match(card, new RegExp(`id="${id}"`), id);
  }
  assert.match(card, /Create a new app/);
});
