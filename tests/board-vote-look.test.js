'use strict';
// THE BOARD'S VOTE PICKER (request #7065): the picker that opens on a card's
// Still yes?, Vote or Approve on the Workshop's All items board is portaled
// out of the page, so the board's scoped rules cannot reach it. Its frame
// carries data-vote-look="board" (dev-card.tsx) and app.css paints its parts
// from the board's own --wip-* tokens, in the standard look and Standard
// (WIP). This suite holds that block: every rule the standard look's alone,
// every colour a token, a No still the app's own red, and nothing sized.
// test:changed: when public/css/app.css (the board's vote-picker block)
//
// Run with: node --test tests/board-vote-look.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

const START = '/* THE BOARD\'S VOTE PICKER (request #7065).';
const END = '/* THE BOARD\'S TIES (board-links.ts)';
const at = css.indexOf(START);
assert.ok(at > 0, 'app.css carries the board vote picker block');
const end = css.indexOf(END, at);
assert.ok(end > at, 'the block is one block');
const block = css.slice(at, end).replace(/\/\*[\s\S]*?\*\//g, '');

// The block's rules, each with its selector written as it stands.
const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }))
  .filter((r) => r.selector);

const ruleAt = (selector) => rules.find((r) => r.selector === selector);
const bodyOf = (selector) => {
  const rule = ruleAt(selector);
  assert.ok(rule, `the block has ${selector}`);
  return rule.body;
};

const P = 'html:not([data-skin])';
const LIGHT = 'html:not([data-skin]):not(.dark):not([data-app-tone="dark"])';
const H = ':is(.dev-vote-pop, .dev-vote-sheet)[data-vote-look="board"]';
const MARK = '[data-vote-look="board"]';

test('the picker\'s frame is the board\'s white card, at the look\'s typeface', () => {
  const frame = bodyOf(`${P} .dev-vote-pop${MARK}`);
  assert.match(frame, /background: var\(--wip-card-bg\)/);
  assert.match(frame, /border-color: transparent/);
  assert.match(frame, /box-shadow: inset 0 0 0 1px var\(--wip-card-line\), var\(--wip-menu-shadow\)/,
    'one hairline and the page\'s menu drop');
  assert.match(frame, /font-family: var\(--wip-font\)/);
});

test('the switch sits in the column tray, and hover is the card', () => {
  assert.match(bodyOf(`${P} ${H} .dev-vote-switch`), /background: var\(--wip-tray\)/);
  assert.match(bodyOf(`${P} ${H} .dev-vote-switch-opt:not([aria-pressed="true"]):hover`),
    /background: var\(--wip-card-bg\)/);
});

test('the picked Yes and Vote yes are the page\'s sun pill', () => {
  const yes = bodyOf(`${P} ${H} .dev-vote-switch-yes[aria-pressed="true"]`);
  assert.match(yes, /background: var\(--wip-top-cta-bg\)/);
  assert.match(yes, /color: var\(--wip-top-cta-ink\)/);
  assert.match(bodyOf(`${P} ${H} .dev-vote-switch-yes[aria-pressed="true"] .dev-vote-n`),
    /color: var\(--wip-top-cta-ink\)/, 'its tally takes the same ink');
  assert.match(bodyOf(`${LIGHT} ${H} .dev-vote-switch-yes[aria-pressed="true"]`),
    /box-shadow: inset 0 0 0 1px var\(--wip-top-cta-ink\)/, 'light gives Yes the ink outline');
  assert.equal(ruleAt(`html:not([data-skin]).dark ${H} .dev-vote-switch-yes[aria-pressed="true"]`), undefined,
    'no dark rule: the dark sun pill is flat');
  const send = bodyOf(`${P} ${H} .dev-vote-reason-send-yes`);
  assert.match(send, /background: var\(--wip-top-cta-bg\)/);
  assert.match(send, /color: var\(--wip-top-cta-ink\)/);
  assert.match(send, /box-shadow: var\(--wip-top-cta-edge\)/);
  assert.match(bodyOf(`${P} ${H} .dev-vote-reason-send-yes:not(:disabled):hover`), /filter: brightness\(1\.04\)/);
  const active = bodyOf(`${P} ${H} .dev-vote-reason-send-yes:not(:disabled):active`);
  assert.match(active, /box-shadow: var\(--wip-top-cta-edge-down\)/);
  assert.match(active, /transform: var\(--wip-top-cta-press\)/);
});

test('the labels are the look\'s muted ink, and the line box is a white field', () => {
  assert.match(bodyOf(`${P} ${H} :is(.dev-vote-switch-label, .dev-vote-uncounted, .dev-vote-reason-label)`),
    /color: var\(--wip-ink-muted\)/);
  const box = bodyOf(`${P} ${H} .dev-vote-reason-box`);
  assert.match(box, /background: var\(--wip-card-bg\)/);
  assert.match(box, /color: var\(--wip-ink\)/);
  assert.match(box, /box-shadow: inset 0 0 0 1px var\(--wip-card-line\), var\(--wip-field-drop\)/);
  assert.match(bodyOf(`${P} ${H} .dev-vote-reason-box:focus`), /outline-color: var\(--wip-ink-action\)/);
  assert.match(bodyOf(`${P} ${H} .dev-vote-why-opt:focus-visible`), /outline-color: var\(--wip-ink-action\)/);
  assert.match(bodyOf(`${P} ${H} .dev-vote-reason-cancel:hover`), /background: var\(--wip-ghost\)/);
});

test('a No keeps the app\'s own red, both in the switch and the answers', () => {
  const picked = bodyOf(`${P} ${H} .dev-vote-why-opt[aria-checked="true"]`);
  assert.match(picked, /background: var\(--state-blocked-bg\)/);
  assert.match(picked, /color: var\(--state-blocked\)/);
  assert.match(picked, /box-shadow: none/);
  for (const rule of rules) assert.doesNotMatch(rule.selector, /\.dev-vote-switch-no|\.dev-vote-reason-send-no/,
    `${rule.selector} leaves a No its own red`);
});

test('every rule is the standard look\'s and names the board\'s marker', () => {
  assert.ok(rules.length >= 14, 'the block is read whole');
  for (const rule of rules) {
    assert.ok(rule.selector.startsWith('html:not([data-skin])'), `"${rule.selector}" is the standard look's`);
    assert.ok(rule.selector.includes(MARK), `"${rule.selector}" reaches only the board's marked picker`);
  }
});

test('no declaration writes a colour of its own, and none moves a size or type', () => {
  for (const rule of rules) {
    assert.doesNotMatch(rule.body, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/,
      `"${rule.selector}" writes a colour of its own`);
    assert.doesNotMatch(rule.body, /\b(?:height|padding|border-radius|font-size|font):/,
      `"${rule.selector}" changes no size or type`);
  }
});

test('the dark look follows the same tokens, and the field drop is a token in both modes', () => {
  const darkAt = css.indexOf('html:not([data-skin]).dark {');
  assert.ok(darkAt > 0, 'the dark token rule is there');
  const darkTokens = css.slice(darkAt, css.indexOf('\n}', darkAt));
  assert.match(darkTokens, /--wip-card-bg: #171715;/);
  assert.match(darkTokens, /--wip-top-cta-bg: #f3d920;/);
  assert.match(darkTokens, /--wip-field-drop:/);
  const lightAt = css.indexOf("html:not([data-skin]) {\n  /* The kit's three colours");
  assert.ok(lightAt > 0, 'the light token rule is there');
  const lightTokens = css.slice(lightAt, css.indexOf('\n}', lightAt));
  assert.match(lightTokens, /--wip-card-bg: #ffffff;/);
  assert.match(lightTokens, /--wip-top-cta-bg: #ffee6f;/);
  assert.match(lightTokens, /--wip-field-drop:/);
  // The block itself has no mode-specific colour rule beyond the light ink outline.
  const modeSpecific = rules.filter((r) => /:not\(\.dark\)|\.dark\b/.test(r.selector));
  assert.equal(modeSpecific.length, 1, 'the picked Yes\'s ink outline is the only one');
  assert.match(modeSpecific[0].body, /box-shadow: inset 0 0 0 1px var\(--wip-top-cta-ink\)/);
});
