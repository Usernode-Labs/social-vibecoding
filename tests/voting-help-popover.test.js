// "How voting & merges work" — the read-only popover the `?` button and the
// inline "How voting works" link open.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// The eight rules were an HTML string constant in public/js/app-view.js
// (`_VOTING_HELP_RULES_HTML`) and nothing checked them. They are the
// platform's own explanation of how a change gets merged — the text a reader
// opens when they cannot tell why a proposal is or is not moving — so an
// accidental edit is a real cost, and the conversion to JSX (#1191) is the
// moment to pin them.
//
// What is pinned is deliberately narrow: how many rules there are, and where
// the EMPHASIS falls. The emphasis is the part a string-to-JSX conversion can
// silently lose (a `<strong>` that swallows a trailing space, or a run that
// ends up outside it), and it is what makes the list skimmable.
//
// The wording itself is not transcribed here. It was verified byte for byte
// against the retired constant at conversion time, and copying it into a test
// would only mean editing the same prose twice.
//
// Run with: node --test tests/voting-help-popover.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const HELP = 'frontend/src/features/dev-board/voting-help.tsx';
const render = (live) => renderComponent(HELP, 'VotingHelp', { live });

test('eight rules, and the emphasis falls where it was written', () => {
  const html = render('');
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(items.length, 8, 'the rule count is part of the explanation');

  // The seven emphasised runs, in order. A conversion that dropped one, or
  // widened it to swallow the words either side, changes what the list says
  // at a glance.
  assert.deepEqual(
    [...html.matchAll(/<strong>([\s\S]*?)<\/strong>/g)].map((m) => m[1]),
    [
      'silence counts as agreement',
      'No',
      'Contested',
      'automated checks pass',
      'up to date with the main app',
      'invited approvers',
      '“at least N approvals”',
    ],
  );

  // Emphasis is inline, so the words either side of it have to keep their
  // spacing. `<strong>No</strong> votes` and `becomes <strong>Contested</strong> —`
  // are the two that a trimmed JSX text child would run together.
  assert.match(html, /<strong>No<\/strong> votes make a proposal harder/);
  assert.match(html, /becomes <strong>Contested<\/strong> — the time-based path/);
  assert.match(html, /its <strong>automated checks pass<\/strong> and it’s <strong>up to date/);
  assert.ok(!/<strong>\s|\s<\/strong>/.test(html), 'no emphasis run has leading or trailing space');
});

test('the live line is the module’s, and absent when there is no proposal', () => {
  // `_votingHelpText` reads the serialized gate fields so its wording never
  // contradicts the tally pill beside it; it stays in app-view.js and
  // tests/explicit-approval-vote-panel.test.js pins what it says.
  const withRow = render('It needs 4 of 10 active testers to vote Yes.');
  assert.match(withRow, /<div class="vh-live"><div class="vh-live-title">This proposal, right now<\/div>/);
  assert.match(withRow, /<div class="vh-live-body">It needs 4 of 10 active testers to vote Yes\.<\/div>/);

  // No row — the `?` opened from somewhere with no proposal in view — draws
  // the rules alone rather than an empty box.
  const bare = render('');
  assert.ok(!bare.includes('vh-live'), 'no empty live block');
  assert.match(bare, /<div class="attr-pop-head">How voting &amp; merges work<\/div>/);
  assert.equal((bare.match(/<li>/g) || []).length, 8);
});

test('the live line reaches the DOM as text', () => {
  // It is assembled from server-serialized numbers and status strings, and it
  // used to go through `escapeHtml` on its way into an `innerHTML`. React
  // escapes a text child by construction; this is the property that guarantee
  // was for.
  const html = render('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the module keeps the host, the geometry and the wording', () => {
  const src = read('public/js/app-view.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const open = code.match(/_openVotingHelpPopover\(anchorEl, pr\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(open, '_openVotingHelpPopover() found');
  assert.doesNotMatch(open[1], /innerHTML/, 'the popover builds no markup');
  assert.match(open[1], /mountVotingHelp\(pop, \{ live: AppView\._votingHelpText\(pr\) \}\)/);
  // The geometry that makes it usable on a phone: a width capped to the
  // viewport, a side chosen by whichever has more room, and a height cap so
  // the body scrolls inside rather than spilling past the edge.
  assert.match(open[1], /const placeBelow = spaceBelow >= spaceAbove;/);
  assert.match(open[1], /pop\.style\.maxHeight = `\$\{avail\}px`;/);
  assert.match(open[1], /document\.body\.appendChild\(pop\)/);
  // And the string constant is gone, not left as a second copy to drift.
  assert.doesNotMatch(code, /_VOTING_HELP_RULES_HTML/);
});
