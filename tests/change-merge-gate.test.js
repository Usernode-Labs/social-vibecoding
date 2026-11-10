// #6563: a change that is approved and tested, but which GitHub has not
// merged yet, says what it waits on. The change's page gets a third card,
// Merging, under Votes and Tested; its times are counted from the viewer's
// own clock; a wait of about 30 minutes or more is called out; GitHub's own
// required checks failing again is red and names no times.
//
// Run with: node --test tests/change-merge-gate.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const HEAD = 'frontend/src/features/dev-board/topic/change-head.tsx';
const NOW = Date.parse('2026-11-10T20:30:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const ahead = (min) => new Date(NOW + min * 60000).toISOString();

// Effects do not run under renderToStaticMarkup, so the card's times are
// read from the clock as this one render finds it. Pin Date.now for the call.
function render(g) {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    // React escapes the apostrophes in "GitHub's": read the words back.
    return renderComponent(HEAD, 'MergeCard', { g, id: 7 })
      .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  } finally {
    Date.now = real;
  }
}

const held = (over = {}) => ({
  name: message('changes:page.merge.name'),
  figure: message('changes:page.merge.figure.githubChecks'),
  tone: 'muted', done: false,
  segments: [{ weight: 1, pct: 60, state: 'moving' }],
  label: message('changes:page.merge.label.githubChecks'),
  note: [message('changes:page.merge.note.githubChecks')],
  wait: { triedAt: ago(2), retryAt: ahead(3), since: ago(2) },
  ...over,
});

test('the Merging card names the wait and counts the last try and the next one', () => {
  const html = render(held());
  assert.match(html, /data-change-gate="merge"/);
  assert.match(html, /Merging/);
  assert.match(html, /Waiting on GitHub's checks/);
  assert.match(html, /Tried 2 min ago\./);
  assert.match(html, /Trying again in about 3 min\./);
  assert.match(html, /data-tone="muted"/);
});

test('under a minute reads just now, and a retry that has come round reads now', () => {
  const just = render(held({ wait: { triedAt: ago(0), retryAt: ahead(4), since: ago(0) } }));
  assert.match(just, /Tried just now\./);
  const now = render(held({ wait: { triedAt: ago(4), retryAt: new Date(NOW - 1000).toISOString(), since: ago(4) } }));
  assert.match(now, /Trying again now\./);
  assert.doesNotMatch(now, /Trying again in about/);
});

test('a long wait is called out at about 30 minutes, and not before', () => {
  const short = render(held({ wait: { triedAt: ago(1), retryAt: ahead(3), since: ago(29) } }));
  assert.match(short, /Waiting on GitHub's checks/);
  assert.match(short, /data-tone="muted"/);
  assert.doesNotMatch(short, /Waiting longer than usual/);

  const long = render(held({ wait: { triedAt: ago(1), retryAt: ahead(3), since: ago(31) } }));
  assert.match(long, /Waiting longer than usual/);
  assert.match(long, /data-tone="warn"/);
  assert.match(long, /it has waited 31 min/);
  assert.match(long, /say so in this change's thread/);
});

test('while the merge is under way it reads Merging now on a moving bar, with no times', () => {
  const html = render({
    name: message('changes:page.merge.name'),
    figure: message('changes:page.merge.figure.merging'),
    tone: 'muted', done: false,
    segments: [{ weight: 1, pct: 60, state: 'moving' }],
    label: message('changes:page.merge.label.merging'),
    note: [], wait: null,
  });
  assert.match(html, /data-change-gate="merge"/);
  assert.match(html, /data-tone="muted"/);
  assert.match(html, /Merging now/);
  assert.match(html, /data-state="moving"/);
  assert.doesNotMatch(html, /Tried |Trying again/);
  assert.doesNotMatch(html, /<button/);
});

test("GitHub's checks failing is red, names no times, and offers no button", () => {
  const html = render({
    name: message('changes:page.merge.name'),
    figure: message('changes:page.merge.figure.failing'),
    tone: 'bad', done: false,
    segments: [{ weight: 1, pct: 100, state: 'bad' }],
    label: message('changes:page.merge.label.failing'),
    note: [message('changes:page.merge.note.failing')],
  });
  assert.match(html, /GitHub's checks failed/);
  assert.match(html, /data-tone="bad"/);
  assert.match(html, /Its author has to fix them/);
  assert.doesNotMatch(html, /Tried |Trying again/);
  assert.doesNotMatch(html, /<button/);
});

test('the card is the same card as Votes and Tested, with a name and a bar', () => {
  const html = render(held());
  assert.match(html, /class="dev-change-gate"/);
  assert.match(html, /class="dev-change-bar"/);
  const changes = require('../frontend/locales/en/changes.json');
  const project = require('../frontend/locales/en/project.json');
  for (const key of ['page.merge.name', 'page.merge.figure.githubChecks', 'page.merge.figure.githubWait',
    'page.merge.figure.failing', 'page.merge.figure.merging', 'page.merge.note.githubChecks',
    'page.merge.note.githubWait', 'page.merge.note.failing', 'page.testing.figure.passedHomeroom',
    'page.testing.label.passedHomeroom']) {
    assert.ok(changes[key] && changes[key].text && changes[key].description, key);
  }
  for (const key of ['topic.change.gate.merge.tried_one', 'topic.change.gate.merge.tried_other',
    'topic.change.gate.merge.triedJustNow', 'topic.change.gate.merge.next_one',
    'topic.change.gate.merge.next_other', 'topic.change.gate.merge.nextNow',
    'topic.change.gate.merge.longFigure', 'topic.change.gate.merge.long']) {
    assert.ok(project[key] && project[key].text && project[key].description, key);
  }
});
