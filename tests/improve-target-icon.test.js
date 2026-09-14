// The Improve panel names its target with artwork, not just a word (#1599).
//
// The header read "Improve · <name>", and on a phone the panel is a bottom
// sheet covering the app it is about — so the only cue for WHICH app you were
// improving was a name in muted 14px, over the app it had just hidden.
//
// Nothing new is fetched: improve-store has carried `iconUrl`/`iconEmoji`
// since the session rows needed them, and the choice between image, emoji and
// letter comes from the same `iconViewFor` every other app surface uses, so an
// app cannot show one icon here and a different one on Home.
//
// Run with: node --test tests/improve-target-icon.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PANEL = read('frontend/src/features/improve/improve-panel.tsx');
const TILE = read('frontend/@/components/ui/icon-tile.tsx');
const INDEX = read('public/index.html');

test('the header tile draws the shared icon decision, not its own', () => {
  assert.match(PANEL, /import \{ iconViewFor \} from '\.\.\/apps\/app-card\.js'/,
    'which of image/emoji/letter to draw is one decision, made in one place');
  assert.match(PANEL, /iconViewFor\(\{ icon_url: iconUrl, icon_emoji: iconEmoji, name \}\)/);
  // All three branches are handled: a missing icon must fall back, never blank.
  for (const kind of ['image', 'emoji', 'letter']) {
    assert.ok(PANEL.includes(`icon.kind === '${kind}'`) || PANEL.includes(`icon.${kind}`),
      `the ${kind} branch is rendered`);
  }
});

test('it uses the tile primitive at a header size, not a hand-rolled face', () => {
  assert.match(PANEL, /import \{ IconTile \} from '@\/components\/ui\/icon-tile'/);
  assert.match(PANEL, /<IconTile size="2xs"/);
  // The size is a real variant of the primitive, so the face, hairline and
  // rounding stay that component's decision.
  assert.match(TILE, /'2xs': 'h-6 w-6 rounded-md/);
  // …and the existing sizes are untouched.
  assert.match(TILE, /xs: 'h-8 w-8 rounded-lg/);
  assert.match(TILE, /sm: 'h-11 w-11 rounded-xl/);
  assert.match(TILE, /lg: 'h-16 w-16 rounded-2xl/);
});

test('nothing is drawn until there is a target, so the prerender still matches', () => {
  // The panel is always mounted and slid off-screen, so it IS prerendered —
  // with the store's initial, target-less value. A tile rendered from an empty
  // name would be a hydration mismatch, and a console error on any route fails
  // proposal checks.
  assert.match(PANEL, /\{slug \? \(\s*<TargetIcon/,
    'the tile is conditional on a resolved target');
  const header = INDEX.slice(INDEX.indexOf('id="improve-panel"'));
  const upToTitle = header.slice(0, header.indexOf('Improve<'));
  assert.ok(!upToTitle.includes('<img'),
    'the prerendered header carries no app artwork');
});

test('the header is still one line: the tile sits in it, not above it', () => {
  const header = PANEL.slice(PANEL.indexOf('<div className="flex items-center gap-2 px-4 py-2 shrink-0">'));
  const oneLine = header.slice(0, header.indexOf('id="improve-close"'));
  assert.match(oneLine, /<TargetIcon/);
  assert.match(oneLine, /Improve/);
  assert.match(oneLine, /id="improve-target-name"/,
    'the name keeps its id and its job beside the icon');
});
