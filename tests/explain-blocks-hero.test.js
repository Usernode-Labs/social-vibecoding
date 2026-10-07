// The change page draws a summary's explanation blocks (#4098) natively,
// under the words, with the shell's list primitives; the About sheet shows
// the same; a summary with none renders exactly as it did.
//
// Two halves: app-view.js splits the stored summary through the React bridge
// (`_changeSummaryView`), and ChangeHero renders `summaryBlocks`.
//
// Run with: node --test tests/explain-blocks-hero.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { topicHeadHtml, BLANK_CARD } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const explainBlocks = require('../src/services/explain-blocks');

const ROOT = path.join(__dirname, '..');
const APP_VIEW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app-view.js'), 'utf8');
const MERGE_STATUS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'merge-status.js'), 'utf8');

const COMPARISON = {
  kind: 'comparison',
  rows: [
    { who: 'Member from before the switch', before: 'Vote counts', after: 'Vote counts' },
    { who: 'New member, unverified', before: 'Vote counts', after: 'Asked to verify first, then counts' },
  ],
  terms: [
    { term: 'Verified', meaning: 'A phone number, GitHub and X both linked, or zkPassport' },
    { term: 'Unverified', meaning: 'None of those yet' },
  ],
};
const STEPS = { kind: 'steps', title: 'Steps for an unverified newcomer', steps: ['Votes on a public app', 'A sheet asks for a phone number', 'Verifies', 'The vote counts'] };
const TABLE = { kind: 'table', title: 'Budgets', columns: ['Who', 'Daily budget', 'Note'], rows: [['Verified', 'Full', 'As before']] };

// The change page (ChangeDetail draws the hero when the body carries a
// changeId) and the About sheet (TopicHead draws it for a body without one).
const hero = (body) => {
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  return renderToHtml(createElement(ChangeDetail, {
    card: BLANK_CARD, body: { changeId: 9, actions: null, ...body }, item: { id: 9, status: 'promoted' }, conversation: false,
  }));
};
const about = (body) => topicHeadHtml(BLANK_CARD, { actions: null, ...body });

test('a comparison draws a Before and after card, a Terms card, and the words above them', () => {
  const html = hero({ summaryHtml: '<p>Admins get a switch.</p>', summaryBlocks: [COMPARISON] });
  const words = html.indexOf('Admins get a switch.');
  const blocks = html.indexOf('data-topic-part="summary-blocks"');
  assert.ok(words > 0 && blocks > words, 'the blocks sit under the words');
  assert.match(html, /<h2[^>]*>Before and after<\/h2>/);
  assert.match(html, /data-explain-block="comparison"/);
  assert.match(html, /Member from before the switch/);
  assert.match(html, /New member, unverified/);
  assert.match(html, /Before<\/span> Vote counts/);
  assert.match(html, /After<\/span> Asked to verify first, then counts/);
  assert.match(html, /<h2[^>]*>Terms<\/h2>/);
  assert.match(html, /data-explain-block="terms"/);
  assert.match(html, /Verified<\/div>[\s\S]*?A phone number, GitHub and X both linked, or zkPassport/);
  assert.doesNotMatch(html, /<svg[^>]*class="[^"]*shrink-0 text-zinc-300/, 'no chevrons: no row goes anywhere');
  assert.doesNotMatch(html, /data-topic-part="summary-blocks"[\s\S]*<button/, 'no row is a button');
});

test('steps draw a numbered tile per row under their own title', () => {
  const html = hero({ summaryHtml: '<p>Words.</p>', summaryBlocks: [STEPS] });
  assert.match(html, /<h2[^>]*>Steps for an unverified newcomer<\/h2>/);
  assert.match(html, /data-explain-block="steps"/);
  for (const [i, step] of STEPS.steps.entries()) {
    assert.match(html, new RegExp(`aria-hidden="true">${i + 1}</div>[\\s\\S]*?${step}`), `step ${i + 1}`);
  }
  assert.doesNotMatch(html, /<h2[^>]*>Steps<\/h2>/, 'the block\'s own title replaces the default label');
});

test('a table is rows titled by the first cell with the other cells named under it', () => {
  const html = hero({ summaryHtml: '<p>Words.</p>', summaryBlocks: [TABLE] });
  assert.match(html, /<h2[^>]*>Budgets<\/h2>/);
  assert.match(html, /data-explain-block="table"/);
  assert.match(html, /Verified<\/div>/);
  assert.match(html, /Daily budget:<\/span> Full/);
  assert.match(html, /Note:<\/span> As before/);
  const untitled = hero({ summaryHtml: '<p>Words.</p>', summaryBlocks: [{ ...TABLE, title: undefined }] });
  assert.match(untitled, /<h2[^>]*>Who<\/h2>/, 'no title: the first column names the card');
});

test('no blocks draws nothing under the words, on the page and in the About sheet', () => {
  for (const summaryBlocks of [undefined, null, []]) {
    for (const html of [hero({ summaryHtml: '<p>Words.</p>', summaryBlocks }),
      about({ summaryHtml: '<p>Words.</p>', summaryBlocks, aboutTitle: 'About this change' })]) {
      assert.match(html, /Words\./);
      assert.doesNotMatch(html, /summary-blocks/);
      assert.doesNotMatch(html, /data-explain-block/);
    }
  }
});

test('the About sheet shows the same blocks under What changes for you', () => {
  const html = about({ summaryHtml: '<p>Words.</p>', summaryBlocks: [STEPS], aboutTitle: 'About this change' });
  const label = html.indexOf('What changes for you');
  assert.ok(label > 0);
  const words = html.indexOf('Words.', label);
  const blocks = html.indexOf('data-explain-block="steps"', label);
  assert.ok(words > label && blocks > words, 'under the words, in the sheet');
  assert.match(html, /<h2[^>]*>Steps for an unverified newcomer<\/h2>/);
});

test('nothing from a block reaches an attribute, and text is escaped', () => {
  const html = hero({ summaryHtml: '<p>Words.</p>', summaryBlocks: [{ kind: 'steps', steps: ['<img src=x onerror=alert(1)>', '" onclick="x'] }] });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onclick="x/, 'the quote is escaped, so no attribute opens');
  assert.match(html, /&quot; onclick=&quot;x/);
});

// ── app-view.js: the split through the bridge ─────────────────────────

function makeAppView({ bridge }) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 42 } },
    DevChat: { renderMarkdown: (s) => `<md>${s}</md>` },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (bridge) sandbox.UsernodeReact = { devBoard: bridge };
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox.__AppView;
}

const client = loadTsx('frontend/src/lib/explain-blocks.ts');
const BRIDGE = { splitExplainBlocks: client.split, explainBlocksToMarkdown: client.toMarkdown };
const STORED = explainBlocks.embed('Admins get a switch.', [COMPARISON, STEPS]);

test('_changeSummaryView hands the hero the words as HTML and the blocks as data', () => {
  const AppView = makeAppView({ bridge: BRIDGE });
  const view = AppView._changeSummaryView({ id: 9, pr_summary_md: STORED });
  assert.equal(view.summaryHtml, '<div class="dev-issue-body"><md>Admins get a switch.</md></div>', 'the fence is off the words');
  assert.deepEqual(view.summaryBlocks, [COMPARISON, STEPS]);
  assert.equal(view.summaryMore, null);
  const plain = AppView._changeSummaryView({ id: 9, pr_summary_md: 'Just words.' });
  assert.equal(plain.summaryHtml, '<div class="dev-issue-body"><md>Just words.</md></div>');
  assert.deepEqual(plain.summaryBlocks, []);
});

test('an HTML-only sink gets the blocks as Markdown through the same renderer', () => {
  const AppView = makeAppView({ bridge: BRIDGE });
  const html = AppView._proposalSummaryHtml({ pr_summary_md: STORED });
  assert.equal(html, `<div class="dev-issue-body"><md>Admins get a switch.\n\n${explainBlocks.toMarkdown([COMPARISON, STEPS])}</md></div>`);
  assert.doesNotMatch(html, /```explain/, 'never the fence');
});

test('an invalid fence stays in the words, so the renderer shows the code block it is', () => {
  const AppView = makeAppView({ bridge: BRIDGE });
  const bad = 'Words.\n\n```explain\n{not json\n```';
  const view = AppView._changeSummaryView({ id: 9, pr_summary_md: bad });
  assert.equal(view.summaryHtml, `<div class="dev-issue-body"><md>${bad}</md></div>`);
  assert.deepEqual(view.summaryBlocks, []);
});

test('without the bridge (a stale shell) the summary renders as given, fence and all', () => {
  const AppView = makeAppView({ bridge: null });
  const view = AppView._changeSummaryView({ id: 9, pr_summary_md: STORED });
  assert.equal(view.summaryHtml, `<div class="dev-issue-body"><md>${STORED}</md></div>`);
  assert.equal(view.summaryBlocks.length, 0);
  assert.equal(AppView._proposalSummaryHtml({ pr_summary_md: STORED }), `<div class="dev-issue-body"><md>${STORED}</md></div>`);
});

test('the staging mock proposal 9000001 carries a comparison with terms and a steps block, canonically', () => {
  // The rows stagingMockProposals actually serves, evaluated on their own as
  // tests/dev-status-pill.test.js does, so the fixture must need nothing
  // outside the function.
  const src = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'votes.js'), 'utf8');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  const rows = ctx.__rows('tester');
  const row = rows.find((r) => r.id === 9000001);
  assert.ok(row, 'the first mock');
  const { text, blocks } = explainBlocks.split(row.pr_summary_md);
  assert.match(text, /^This is a sample plain-language summary/);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'comparison');
  assert.equal(blocks[0].rows.length, 4);
  assert.equal(blocks[0].terms.length, 2);
  assert.equal(blocks[1].kind, 'steps');
  assert.equal(blocks[1].steps.length, 4);
  assert.equal(explainBlocks.embed(text, blocks), row.pr_summary_md, 'stored exactly as embed writes it');
  // The other mocks keep the sentence alone, so the deck still shows both states.
  assert.ok(rows.some((r) => r.id !== 9000001 && !String(r.pr_summary_md || '').includes('```explain')));
});
