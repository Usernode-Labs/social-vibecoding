'use strict';

// #3407: A CHANNEL LEADS WITH ITS WAY BACK TO ITS HUB.
//
// The hub's own pages (Needs you, the Workshop, All items) open with a round
// chevron back to the hub; the project's channel, whose door is the hub's
// Channel card, had only the platform header's arrow. Pinned here:
//
//   1. ONE DISC: `PageBackButton` in dev-board/workshop/page-back.tsx is the
//      chevron the Workshop's `PageBack` draws and the channel panes draw, so
//      the two cannot drift apart.
//   2. BOTH CHANNELS CARRY IT, first in their header row: a project's channel
//      (`AppDiscussionThread`) and #general (`ThreadHeader`, channel only —
//      a conversation's way back is the header's, to the list).
//   3. IT IS A DOOR TO THE HUB: AppView._landOnHub, then the hub's address,
//      so it lands on the hub rather than the tab the page was last left on.
//
// Run with: node --test tests/channel-back-to-hub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const BACK = read('frontend/src/features/dev-board/workshop/page-back.tsx');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

test('one disc: the Workshop\'s page head and the channels draw the same button', () => {
  const button = fn(BACK, 'PageBackButton');
  assert.match(button, /className="dev-ws-page-back un-touch-target"/);
  assert.match(button, /aria-label=\{`Back to \$\{label\}`\}/);
  assert.match(button, /<ChevronLeftIcon className="dev-ws-page-back-glyph" aria-hidden="true" \/>/);
  assert.match(fn(BACK, 'PageBack'), /<PageBackButton label=\{label\} onBack=\{onBack\} data-ws-page-back="" \/>/);
  assert.match(WORKSHOP, /import \{ PageBack \} from '\.\/page-back';/);
  assert.doesNotMatch(WORKSHOP, /function PageBack\(/, 'defined once, in page-back.tsx');
  assert.match(SCREEN, /import \{ PageBackButton \} from '\.\.\/dev-board\/workshop\/page-back';/);
});

test('a project\'s channel leads its header with the way back to its hub', () => {
  const pane = fn(SCREEN, 'AppDiscussionThread');
  assert.match(pane,
    /<header className="messages-thread-header">\s*<PageBackButton label=\{name\} onBack=\{\(\) => openChannelHub\(slug\)\} data-channel-back="" \/>\s*<AppIconLink/);
});

test('#general leads with the way back to the Homeroom hub; a conversation does not', () => {
  const header = fn(SCREEN, 'ThreadHeader');
  assert.match(header, /const hubSlug = channel \? platformSlug\(\) : null;/);
  assert.match(header,
    /\{channel \? <PageBackButton label=\{hubSlug \? 'Homeroom' : 'Communities'\} onBack=\{\(\) => openChannelHub\(hubSlug\)\} data-channel-back="" \/> : null\}/);
  assert.equal((header.match(/<PageBackButton /g) || []).length, 1, 'only behind `channel`');
});

test('it is a door to the hub: _landOnHub first, then the hub\'s address', () => {
  const open = fn(SCREEN, 'openChannelHub');
  const land = open.indexOf('win.AppView?._landOnHub?.(slug)');
  const go = open.indexOf('window.location.hash = slug ? `#app/${encodeURIComponent(slug)}/workshop` : \'#communities\';');
  assert.ok(land > 0 && go > land, 'lands on the hub, then navigates');
  assert.match(fn(SCREEN, 'platformSlug'), /PlatformTarget\?\.slug\?\.\(\) \|\| null/);
});
