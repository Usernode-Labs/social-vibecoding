'use strict';

// #6354 (Part 2): the widths designPrompt gives when the bot draws one of
// Homeroom's own pages from the code. A redraw that guesses wider than the
// real page is the bug this reference exists to stop (private thread 16876).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const layout = require('../src/services/design-layout');
const { designPrompt } = require('../src/services/design-bot');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

test('the bot page\'s numbers are the ones the stylesheet sets', () => {
  // The AI page's rules, as public/css/app.css writes them.
  assert.match(CSS, /--ai-list-min: 480px;/);
  assert.match(CSS, /--ai-main-auto: max\(400px, calc\(var\(--ai-room\) - 720px\)\);/);
  assert.match(CSS, /--platform-rail-full: 212px;/);

  const bot = layout.WIDTHS['homeroom-bot'];
  const room = layout.DESKTOP - layout.RAIL_FULL;
  assert.equal(layout.RAIL_FULL, 212, 'the desktop rail is --platform-rail-full');
  assert.equal(bot.desktop.mainChat, 400, '--ai-main-auto at 1280: the 400px floor');
  assert.equal(bot.desktop.list, room - bot.desktop.mainChat, 'the list takes the room Main does not');
  assert.equal(bot.desktop.listContent, 672, 'the list content is capped at max-w-2xl');
  assert.equal(bot.phone.list, 390, 'a phone has no columns: the list is the screen');
});

test('every page designPrompt lists has a phone and a desktop width', () => {
  for (const [key, page] of Object.entries(layout.WIDTHS)) {
    assert.equal(typeof page.name, 'string', `${key} has the name people see`);
    for (const size of ['phone', 'desktop']) {
      const widths = Object.values(page[size]).filter((value) => typeof value === 'number' && value > 0);
      assert.ok(widths.length > 0, `${key} ${size} has at least one width`);
    }
  }
  for (const page of ['homeroom-bot', 'main-chat', 'workshop', 'request']) {
    assert.ok(layout.WIDTHS[page], `${page} is in the reference`);
  }
});

test('layoutLines names each page, its widths and the rule', () => {
  const lines = layout.layoutLines();
  assert.match(lines[0], /^REAL SIZES/);
  assert.match(lines.join('\n'), /the Homeroom bot page:[\s\S]*mainChat 400px/);
  assert.match(lines.join('\n'), /never make a column wider than the real one/);
  assert.doesNotMatch(lines.join('\n'), /—/);
});

test('the prompt carries REAL SIZES and the capture list for Homeroom\'s designs, and not for another project\'s', () => {
  const homeroom = designPrompt({ username: 'evan', homeroom: true });
  assert.match(homeroom, /REAL SIZES/);
  assert.match(homeroom, /Homeroom bot page/);
  assert.match(homeroom, /capture_page/);
  assert.match(homeroom, /never their own account/i);

  const other = designPrompt({ username: 'evan', surface: 'app', app: { slug: 'ear', name: 'Ear Trainer' } });
  assert.doesNotMatch(other, /REAL SIZES/);
  assert.doesNotMatch(other, /capture_page/);
});
