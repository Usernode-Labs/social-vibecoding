'use strict';

// #1885: opening a Workshop row dropped its card into a padded, frosted
// frame — the sheet's 10px padding sat around the card as well as around the
// thread under it. The card is now pulled out to the sheet's edges and takes
// its corners; the thread, reply box and "Open on its own page" keep the
// sheet's padding, which their own margins are measured from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CSS = read('public/css/app.css');
const FOLD = read('frontend/src/features/dev-board/card/fold.tsx');

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('the sheet keeps its padding for what hangs under the card', () => {
  assert.match(rule('#dev-workshop .dev-feed-entry'), /\n\s*padding: 10px 10px 12px;/);
});

test('the card is pulled flush to the sheet\'s top and sides, and takes its corners', () => {
  const body = rule('#dev-workshop .dev-feed-entry > div:is(.dev-card-dense, .dev-card-topic):first-child');
  // Exactly cancels the sheet's 10px top/side padding.
  assert.match(body, /\n\s*margin: -10px -10px 0;/);
  // `w-full` is 100% of the CONTENT box, so it has to grow by both sides.
  assert.match(body, /\n\s*width: calc\(100% \+ 20px\);/);
  assert.match(body, /\n\s*border-radius: inherit;/);
});

test('a card with nothing under it is the whole sheet', () => {
  const body = rule('#dev-workshop .dev-feed-entry > div:is(.dev-card-dense, .dev-card-topic):only-child');
  assert.match(body, /\n\s*margin-bottom: -12px;/, 'cancels the 12px bottom padding');
});

test('the card is the sheet\'s first child, which is what the selector relies on', () => {
  assert.match(FOLD, /<div className="dev-feed-entry dev-ws-sheet" data-ws-sheet=\{row\.key\}>\s*<DevCard /);
});
