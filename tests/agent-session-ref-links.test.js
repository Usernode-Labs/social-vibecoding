'use strict';

// #5728: an agent session's reply links the numbers it names.
//
// The reporter's screenshot: the Mayor answered "The close proposal on #34 …
// both #34 and #118" and every number was plain text. Pinned here:
//
//   1. `MayorText` runs the sanitized reply through `linkRefsInHtml` with
//      the conversation's project, for a past reply and for the one still
//      being written; with no project the text stays plain.
//   2. The project is the active change's app, else the one the
//      conversation was started from (the order openAppTarget uses).
//   3. Rendered: the reporter's reply yields request links; the same reply
//      with no project yields none.
//
// Run with: node --test tests/agent-session-ref-links.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { makeDocument } = require('./lib/mini-dom');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const PANEL = 'frontend/src/features/agent-session/index.tsx';

test('a reply is chipped with the conversation\'s project, past or streaming', () => {
  const src = read(PANEL);
  const mayor = src.slice(src.indexOf('export const MayorText'), src.indexOf('function appInitial('));
  assert.match(mayor, /linkRefsInHtml\(markdown\(text\) \|\| '', appSlug\)/,
    'MayorText decorates the sanitized markdown with its appSlug');
  assert.match(mayor, /\[text, appSlug\]/, 'and parses again only when one of them changes');

  const item = src.slice(src.indexOf('const Item = memo('), src.indexOf('/** What a finished run reads'));
  assert.match(item, /appSlug\?: string \| null/, 'the row carries the project');
  assert.match(item, /<MayorText text=\{item\.text\} appSlug=\{appSlug\} \/>/, 'and hands it to the reply it draws');

  const live = src.slice(src.indexOf('function LiveTurn('), src.indexOf('// Message ids: the whole line'));
  assert.match(live, /appSlug\?: string \| null/);
  assert.match(live, /<MayorText text=\{turn\.streamText\} appSlug=\{appSlug\} \/>/, 'the reply being written is chipped too');

  assert.match(src, /const refSlug = snapshot\.session\?\.activeChange\?\.appSlug \|\| about\?\.focusApp\?\.slug \|\| null;/,
    "the active change's app first, then the one the conversation was started from");
  assert.match(src, /<Item key=\{item\.key\} item=\{item\} sessionId=\{snapshot\.id\} appSlug=\{refSlug\} \/>/);
  assert.match(src, /<LiveTurn runShown=\{runShown\} appSlug=\{refSlug\} \/>/);
});

const REPLY = 'The close proposal on #34 went through: the group is now voting on closing it, and the request stays open on the board until that vote passes. Nothing else is queued up from before, so the ball\'s with the group on both #34 and #118.';

/** `linkRefsInHtml` needs a document, and `markdown` needs the dev chat's renderer. */
function withBrowserDom(run) {
  const before = { document: global.document, window: global.window };
  global.document = makeDocument();
  global.window = {
    DevChat: {
      renderMarkdown: (text) => `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
    },
  };
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete global[key]; else global[key] = value;
    }
  }
}

test('the reporter\'s reply renders every number as a link to its request', () => {
  const { MayorText } = loadTsx(PANEL);
  const linked = withBrowserDom(() => renderToHtml(createElement(MayorText, { text: REPLY, appSlug: 'goal-champions' })));
  const hrefs = [...linked.matchAll(/<a href="#app\/goal-champions\/dev\/issues\/(\d+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ['34', '34', '118'], 'all three numbers open their request');
  assert.match(linked, /class="gc-ref gc-ref-issue"/, 'drawn as the project chat\'s chip');

  const plain = withBrowserDom(() => renderToHtml(createElement(MayorText, { text: REPLY })));
  assert.doesNotMatch(plain, /gc-ref|<a /, 'no project: the reply is the text it was');
  assert.match(plain, /both #34 and #118/);
});
