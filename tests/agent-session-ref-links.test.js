'use strict';

// #5728: the agent's replies link the references they name.
//
// The reporter's screenshot is an agent session: the reply says "The close
// proposal on #34 … both #34 and #118" as plain text, so the numbers were a
// dead end in the one place a reader is most likely to want them. This pins
// that a reply is chipped the way Messages and the project chat chip the same
// numbers — `#N` to the project's request page, `PR#N` to its proposal page
// — and that a conversation with no project leaves its reply as it was.
//
//   1. `MayorText` runs its sanitized markdown through `linkRefsInHtml` with
//      the project it was handed, and a reply with none is not decorated.
//   2. Both of the panel's reply surfaces hand it over: the past reply (the
//      `Item` mayor case) and the live turn's stream.
//   3. The project is the active change's, then the session's focus — the
//      order "Open app" uses.
//   4. Rendered: the reporter's own reply, with a project, becomes three
//      links to its board; with none, three plain numbers.
//
// Run with: node --test tests/agent-session-ref-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { makeHtmlDocument } = require('./lib/html-dom');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const PANEL = 'frontend/src/features/agent-session/index.tsx';

const REPLY = 'The close proposal on #34 went through: the group is now voting on closing it, '
  + "and the request stays open on the board until that vote passes. Nothing else is queued "
  + "up from before, so the ball's with the group on both #34 and #118.";

test('a reply is chipped with the conversation\'s project, and a past reply and the live turn both hand it over', () => {
  const panel = read(PANEL);
  const mayorText = panel.slice(panel.indexOf('const MayorText = memo('), panel.indexOf('\nfunction appInitial'));
  assert.match(mayorText, /linkRefsInHtml\(rendered, appSlug\)/, 'the rendered reply goes through the shared decoration');
  assert.match(mayorText, /\}, \[text, appSlug\]\)/, 'and is re-decorated only when the reply or the project changes');

  assert.match(panel, /<MayorText text=\{item\.text\} appSlug=\{appSlug\} \/>/, 'a past reply gets the project');
  assert.match(panel, /<MayorText text=\{turn\.streamText\} appSlug=\{appSlug\} \/>/, 'so does the live turn, while it is written');
  assert.match(panel, /<Item key=\{item\.key\} item=\{item\} sessionId=\{snapshot\.id\} appSlug=\{refSlug\} \/>/);
  assert.match(panel, /<LiveTurn runShown=\{runShown\} appSlug=\{refSlug\} \/>/);

  assert.match(panel, /const refSlug = snapshot\.session\?\.activeChange\?\.appSlug \|\| about\?\.focusApp\?\.slug \|\| null;/,
    'the active change\'s project first, then the session\'s focus, as "Open app" reads it');
});

test('with a project the reply\'s numbers are links to its board; with none they stay text', () => {
  const { MayorText } = loadTsx(PANEL);
  globalThis.window = { DevChat: { renderMarkdown: (text) => `<p>${text}</p>` } };
  globalThis.document = makeHtmlDocument();
  try {
    const linked = renderToHtml(createElement(MayorText, { text: REPLY, appSlug: 'goal-champions' }));
    const hrefs = [...linked.matchAll(/<a href="([^"]+)" class="gc-ref/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, [
      '#app/goal-champions/dev/issues/34',
      '#app/goal-champions/dev/issues/34',
      '#app/goal-champions/dev/issues/118',
    ], 'each request number opens that request\'s page on the project\'s board');
    assert.match(linked, /#34<\/a> went through/, 'the words stay the reply\'s own');
    assert.doesNotMatch(linked, /<a [^>]*>PR#/, 'no proposal is named here');

    const plain = renderToHtml(createElement(MayorText, { text: REPLY, appSlug: null }));
    assert.doesNotMatch(plain, /<a /, 'no project: nothing becomes a link');
    assert.match(plain, /The close proposal on #34 went through/);

    const proposal = renderToHtml(createElement(MayorText, { text: 'filed as PR#9 beside #14', appSlug: 'goal-champions' }));
    assert.match(proposal, /<a href="#app\/goal-champions\/dev\/changes\/9" class="gc-ref gc-ref-pr"[^>]*>PR#9<\/a>/,
      'a PR opens its proposal page');
    assert.match(proposal, /<a href="#app\/goal-champions\/dev\/issues\/14" class="gc-ref gc-ref-issue"/);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});
