'use strict';

// #3572: a project's short description has a limit, and it is two lines.
//
//   1. THE LIMIT IS 90, IN BOTH PLACES. services/create-options.js refuses a
//      longer "What is it?" with a sentence that names the number; the create
//      dialog's field stops taking letters at the same number. 90 is two lines
//      of the project's hub hero on a 360px phone with room to spare (the
//      measurement is written out beside DESCRIPTION_MAX).
//   2. THE FIELD COUNTS DOWN, LATE. "12 characters left" on the label's line,
//      for the last 20 only, amber for the last 5. Rendered only once it says
//      something, so the prerendered dialog is unchanged.
//   3. LONGER LINES ARE CLAMPED, NOT REFUSED. A repository's own dapp.json can
//      say more (an import, a later proposal); the deploy keeps it, and the
//      hub hero draws two lines of it and the About pane three, with an
//      ellipsis. Discover and the join screen already clamped at two.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');
const { loadTsx } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const options = require('../src/services/create-options');
const manifest = require('../src/services/app-manifest');
const dialog = loadTsx('frontend/src/features/dialogs/create-app.tsx');
const SRC = read('frontend/src/features/dialogs/create-app.tsx');

test('#3572: the create dialog and the server hold the same limit, 90', () => {
  assert.equal(options.DESCRIPTION_MAX, 90);
  assert.equal(dialog.DESCRIPTION_MAX, options.DESCRIPTION_MAX, 'the field stops where the server would refuse');
  const field = SRC.slice(SRC.indexOf('id="app-description"'), SRC.indexOf('/>', SRC.indexOf('id="app-description"')));
  assert.match(field, /maxLength=\{DESCRIPTION_MAX\}/, 'the field\'s maxLength is the constant');
  assert.doesNotMatch(field, /maxLength=\{\d+\}/, 'not a second copy of the number');
  assert.match(options.parseCreateOptions({ audience: 'open', description: 'x'.repeat(91) }).error,
    /^Say what it is in 90 characters or fewer\.$/, 'the refusal names the limit');
});

test('#3572: the field counts down its last 20 characters, in words', () => {
  const left = dialog.descriptionLeft;
  assert.equal(left(0), '', 'nothing while there is room');
  assert.equal(left(69), '');
  assert.equal(left(70), '20 characters left', 'from 20 left');
  assert.equal(left(85), '5 characters left');
  assert.equal(left(89), '1 character left');
  assert.equal(left(90), '0 characters left');
  assert.equal(left(120), '0 characters left', 'never a negative count (a paste is cut by maxLength anyway)');

  const row = SRC.slice(SRC.indexOf("' create-describe-row"), SRC.indexOf('</div>', SRC.indexOf('id="app-description"')));
  assert.match(row, /' create-describe-row relative /, 'the row positions the count on the label\'s line');
  assert.match(row, /\{describeLeftText \? \(\s*<span\s+id="app-description-left"\s+aria-live="polite"/, 'rendered only once it says something');
  assert.match(row, /aria-describedby=\{describeLeftText \? 'app-description-left' : undefined\}/, 'the field points at it while it is there');
  assert.match(row, /describe\.length >= DESCRIPTION_MAX - 5\s*\? 'text-amber-800 dark:text-amber-300'\s*: 'text-zinc-500 dark:text-zinc-400'/,
    'muted, then amber for the last five');
  assert.match(SRC, /const DESCRIPTION_LEFT = 'absolute right-4 top-3 text-\[13px\] tabular-nums';/);
  assert.match(SRC, /const describeLeftText = descriptionLeft\(describe\.length\);/);

  // The prerendered dialog has an empty field, so no count and no reference.
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  assert.match(card, /id="app-description"/);
  assert.doesNotMatch(card, /app-description-left/, 'nothing new in the shipped markup');
  assert.match(card, /<input[^>]*id="app-description"[^>]*maxLength="90"|<input[^>]*maxLength="90"[^>]*id="app-description"/i);
});

test('#3572: a longer line from a repository is kept, and clamped where it is drawn', () => {
  const long = 'x '.repeat(80).trim();
  assert.equal(manifest.readDescription({ description: long }), long, 'the deploy keeps it: no import or deploy fails on it');
  assert.equal(manifest.readDescription({ description: 'y'.repeat(400) }).length, 280, 'the reader\'s own ceiling is unchanged');

  // The hub hero: two lines, the measure the limit was taken against.
  const css = read('public/css/app.css');
  const hero = css.slice(css.indexOf('.dev-ws-hero-desc {\n  display'), css.indexOf('}', css.indexOf('.dev-ws-hero-desc {\n  display')));
  assert.match(hero, /display: -webkit-box;/);
  assert.match(hero, /-webkit-box-orient: vertical;/);
  assert.match(hero, /-webkit-line-clamp: 2;/);
  assert.match(hero, /line-clamp: 2;/);
  assert.match(hero, /overflow: hidden;/);
  assert.match(read('frontend/src/features/dev-board/workshop/community-card.tsx'),
    /<p className="dev-ws-hero-desc" data-ws-community-description="">\{data\.description\}<\/p>/);

  // The About pane: three, beside the icon and a size smaller.
  assert.match(read('frontend/src/features/app-context/about-pane.tsx'),
    /<p id="app-about-tagline" className="mt-0\.5 line-clamp-3 text-\[0\.8125rem\] leading-snug/);

  // Discover and the join screen already stopped at two.
  assert.match(css, /\.home-discover-blurb \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(read('frontend/src/features/auth/communities-first-run.js'), /'mt-0\.5 line-clamp-2 text-\[0\.8125rem\]/);
});

test('#3572: the conventions tell an app\'s builders the limit', () => {
  const doc = read('src/prompts/app-conventions.md');
  const section = doc.slice(doc.indexOf('### Top-level `description`'), doc.indexOf('### Top-level `visibility`'));
  assert.ok(section.length > 0, 'a section of its own, after `name`');
  assert.match(section, /\*\*90 characters or fewer\*\*/);
  assert.match(section, /two lines\s+on a phone/);
});
