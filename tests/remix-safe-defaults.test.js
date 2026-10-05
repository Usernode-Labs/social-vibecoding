'use strict';
const { englishUiSource } = require("./lib/english-ui-source");

// Remix: safe defaults. People see a fork as a "Remix" (their own copy); the
// code, the route (POST /api/apps/:slug/fork) and every id keep "fork".
//
// What is pinned here is what a person reads before they make a copy, because
// it has to match what the worker does (src/services/app-forker.js, pinned in
// tests/app-forker-reliability.test.js and tests/app-forker-no-shell.test.js):
//
//   - the dialog (frontend/src/features/dialogs/fork-app.tsx), as the
//     prerendered shell ships it: its title, lead, field, the box saying what
//     is copied, what starts fresh and what is not, and its button. Two old
//     bugs are pinned closed: JSX dropped the spaces around the inline app
//     name ("ForkingBook Clubstands up…"), and the name was near-white
//     (`text-zinc-300`) on a light card.
//   - the four doors to it say "Remix", and the lineage says "Remixed from".
//
// Run with: node --test tests/remix-safe-defaults.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => englishUiSource(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const DIALOG_SRC = englishUiSource(read('frontend/src/features/dialogs/fork-app.tsx'));

/** The #fork-modal subtree of the prerendered shell, as markup. */
function forkModalHtml() {
  const html = read('public/index.html');
  const start = html.indexOf('<div id="fork-modal"');
  assert.ok(start !== -1, 'the shell prerenders #fork-modal');
  const end = html.indexOf('<div id="import-pr-modal"', start);
  return html.slice(start, end === -1 ? undefined : end);
}

/** Visible text, tags removed WITHOUT adding spaces, so a lost space shows. */
function textOf(markup) {
  return markup.replace(/<[^>]*>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');
}

test('the dialog is "Remix <App>", with the name in its sentence and readable', () => {
  const modal = forkModalHtml();
  assert.match(modal, /<h2[^>]*>Remix <span id="fork-source-name">/,
    'a real space between the word and the name');
  const name = modal.match(/<span id="fork-source-name"([^>]*)>/);
  assert.ok(name, '#fork-source-name keeps its id');
  assert.doesNotMatch(name[1], /text-zinc-300/, 'the name is not near-white on the light card');
  assert.doesNotMatch(name[1], /class=/, 'it takes the heading\'s own ink in both themes');
  // The old lead ran the name into its sentence. Every inline element in the
  // dialog now has its space inside a string.
  assert.doesNotMatch(DIALOG_SRC, /<span id="fork-source-name"[^>]*>\s*\{sourceName\}\s*<\/span>\s*\n\s*stands up/);
});

test('the dialog says what a remix copies, what starts fresh and what it leaves behind', () => {
  const text = textOf(forkModalHtml());
  for (const line of [
    'Make your own copy. You get the code and the look, and it starts as Just you.',
    'Name for your copy',
    'Copied: the code, the look and the icon.',
    'Starts fresh: it’s Just you, with an empty database. Invite people or open it up later.',
    'Not copied: anyone’s data, keys, chat or members. If the app needs a key, you’ll add your own before it goes live.',
    'Its code is public on GitHub.',
  ]) {
    assert.ok(text.includes(line), `the dialog says: ${line}`);
  }
  assert.match(forkModalHtml(), /id="fork-submit"[^>]*>Remix</, 'the button says Remix');
  assert.match(forkModalHtml(), /placeholder="My copy"/);
  // The old box promised the opposite of what a remix now does.
  assert.doesNotMatch(text, /public data|Carries over|Fork/,
    'nothing says public data comes along, and people never see "Fork"');
  assert.doesNotMatch(text, /—/, 'no em dashes in the copy');
});

test('the name field suggests "<App> (remix)" and a failed POST says so in plain words', () => {
  assert.match(englishUiSource(DIALOG_SRC), /`\$\{src\?\.name \|\| 'App'\} \(remix\)`/);
  assert.match(englishUiSource(DIALOG_SRC), /\{busy \? 'Remixing…' : 'Remix'\}/);
  assert.match(englishUiSource(DIALOG_SRC), /'Could not make your copy\.'/);
  assert.match(englishUiSource(DIALOG_SRC), /'Your copy is being made\. It will appear in your apps when it is ready\.'/);
  assert.match(englishUiSource(DIALOG_SRC), /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(source\.slug\)\}\/fork`/,
    'the route keeps its name');
});

test('the allowance line names remixing among what shares it', () => {
  const src = englishUiSource(read('frontend/src/features/dialogs/app-allowance.tsx'));
  assert.match(englishUiSource(src), /Creating, importing and remixing share this allowance\./);
  assert.doesNotMatch(englishUiSource(src), /importing and forking/);
});

test('the four doors say "Remix", and keep their ids and data attributes', () => {
  const about = englishUiSource(read('frontend/src/features/app-context/about-pane.tsx'));
  assert.match(englishUiSource(about), /id="app-about-fork"[\s\S]{0,120}label="Remix"\s+sub="Make your own copy"/);

  const plus = englishUiSource(read('frontend/src/features/dev-board/actions-row.tsx'));
  assert.match(englishUiSource(plus), /<PlusRow title="Remix"\s+data-plus="fork"[\s\S]{0,240}sub="Make your own copy"/);

  const home = read('frontend/src/features/home/home.js');
  assert.match(englishUiSource(home), /key: 'fork',\s+label: 'Remix',\s+sub: 'Make your own copy',/,
    'the card menu, which Discover\'s page draws its rows from too');

  const detail = englishUiSource(read('frontend/src/features/apps/browse-detail.tsx'));
  assert.match(englishUiSource(detail), /subtitle=\{a\.sub \|\| undefined\}/, 'Discover shows the line under the label');

  for (const [file, src] of [['about-pane', about], ['actions-row', plus], ['home', home]]) {
    assert.doesNotMatch(englishUiSource(src), /'Fork this app'|"Fork this app"/, `${file}: people never see "Fork this app"`);
  }
});

test('lineage reads "Remixed from" wherever people see it', () => {
  for (const file of [
    'frontend/src/features/apps/browse-detail.tsx',
    'frontend/src/features/home/home.js',
    'frontend/src/features/home/app-grid.tsx',
    'frontend/src/features/app-context/about-pane.tsx',
  ]) {
    const src = read(file);
    assert.match(englishUiSource(src), /Remixed from \$\{/, `${file} says Remixed from`);
    assert.doesNotMatch(englishUiSource(src), /[`"']Forked from|\bForked from \$\{/, `${file} no longer says Forked from`);
  }
});
