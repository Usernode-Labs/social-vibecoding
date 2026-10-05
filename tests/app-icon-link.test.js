'use strict';
const { englishUiSource } = require("./lib/english-ui-source");

// #3365: an app's icon opens the app, wherever it is drawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const VIEW = read('frontend/src/features/apps/app-card-view.tsx');

test('the icon link goes where Open goes, with a label and a pointer', () => {
  assert.match(englishUiSource(VIEW), /export function appOpenHref\(slug: string\): string \{\s*return `\/app\/\$\{encodeURIComponent\(slug\)\}`;/);
  assert.match(englishUiSource(VIEW), /const label = `Open \$\{name \|\| slug\}`;/);
  assert.match(englishUiSource(VIEW), /app-icon-link cursor-pointer/);
  assert.match(englishUiSource(VIEW), /win\.App\.openAppTab\(slug, 'app'\)/);
});

test('a tap on the icon is never also the card\'s', () => {
  assert.match(VIEW, /function openApp[\s\S]*?event\.stopPropagation\(\);/);
  // Inside another link or button the tile is a focusable role="link" span,
  // since an anchor inside an anchor is invalid markup.
  assert.match(VIEW, /if \(nested\) \{[\s\S]*?role="link"\s+tabIndex=\{0\}/);
  // The Discover row is wired natively, so it skips taps on the tile itself.
  const list = read('frontend/src/features/apps/browse-list.tsx');
  assert.equal((list.match(/closest\?\.\('\.browse-add-btn, \.app-icon-link'\)/g) || []).length, 2);
});

// The project hub's hero drew one until #852; the community's tile is the
// coloured header's now (header-title.tsx, below).
test('every app surface that draws an icon links it', () => {
  for (const file of [
    'frontend/src/features/apps/browse-list.tsx',
    'frontend/src/features/apps/browse-detail.tsx',
    'frontend/src/features/app-context/about-pane.tsx',
    'frontend/src/features/global-chat/renderers.tsx',
    'frontend/src/features/header/header-title.tsx',
    'frontend/src/features/messages/index.tsx',
    'frontend/src/features/workshop/index.tsx',
    'frontend/src/features/workshop/needs-reel.tsx',
    'frontend/src/features/agent-session/index.tsx',
  ]) {
    assert.match(read(file), /<AppIconLink\b/, file);
  }
});
