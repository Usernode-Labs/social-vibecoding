// The duplicate "Generate proposal" button, and why it can no longer recur.
//
// An issue row used to render BOTH "Go to session" and a second "Generate
// proposal" button when a headless auto-solve run finished with a *question*
// outcome and the viewer had already cloned it — two competing actions for a
// proposal that already exists. The original fix was a \`!h.mySessionId\`
// guard on the append, and this file grepped the source for that guard.
//
// The card-as-pointer revision removes the shape of the bug rather than
// guarding it: an issue card now has exactly ONE state-driven primary action
// (_issuePrimaryActionHtml) and at most one "Generate proposal" row in its ⋯
// menu (_issueMenuItems), so two Generate affordances are not expressible.
// These tests pin that behaviourally — one primary, and never a re-run
// offered beside "Go to session".
//
// Run with: node --test tests/issue-generate-proposal-dedup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const {
  cardHtml, hasAction, issueCardHtml, detailActionsHtml,
} = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf-8'
);

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 } },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({}) },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  return AppView;
}

const issue = (headless) => ({ number: 5, title: 'Fix the thing', headless });

// Count the HEADLESS text pills on the card face — this file's subject is that
// an issue never offers two ways to generate the same proposal at once, so the
// count must exclude pills that have nothing to do with the run. The card
// holds its handlers as closures now (#1367's card chunk), so this counts the
// MODEL's action specs and drops the in-progress claim toggle by the call it
// dispatches, which is what it was filtering on before.
const CLAIM = /^(markIssueInProgress|clearIssueClaim)$/;
function primaryCount(model) {
  return (model.actions || [])
    .filter((a) => !(a.act && CLAIM.test(a.act.fn))).length;
}
function menuLabels(AppView, model) {
  const key = model.rail && model.rail.menuKey;
  if (!key) return [];
  return (AppView._cardMenus[key] || []).map((it) => it.label);
}

test('a question outcome the viewer has NOT cloned: one primary + one ⋯ re-run', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(issue({ status: 'ready', outcome: 'question', sessionId: 91 }));
  const html = cardHtml(model);
  assert.equal(primaryCount(model), 1, 'exactly one headless pill on the card face');
  assert.match(html, /Answer &amp; regenerate/, 'the folded primary');
  // The band's other pill is the promoted claim toggle, which is not a second
  // way to do this — it is a different action entirely.
  assert.ok(hasAction(model, 'markIssueInProgress', 5));
  const generate = menuLabels(AppView, model).filter((l) => /^Generate proposal$/.test(l));
  assert.equal(generate.length, 1, 'exactly one Generate proposal affordance, in ⋯');
});

test('a question outcome the viewer HAS cloned: Go to session and NO re-run anywhere', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(issue({
    status: 'ready', outcome: 'question', sessionId: 91, mySessionId: 92,
  }));
  const html = cardHtml(model);
  assert.equal(primaryCount(model), 1);
  assert.ok(hasAction(model, 'goToAutoSessionClone', 92));
  assert.match(html, />Go to session</);
  // The original bug, stated directly: no second Generate beside it.
  assert.ok(!menuLabels(AppView, model).some((l) => /^Generate proposal$/.test(l)),
    'the proposal already exists — offering a re-run here is the #150 bug');
  assert.ok(!hasAction(model, 'confirmAutoSession'), 'no re-run wiring on the card at all');
});

test('a run in flight offers neither a clone nor a re-run', () => {
  const AppView = makeAppView();
  const model = AppView._issueCardModel(issue({ status: 'generating', sessionId: 93 }));
  const html = cardHtml(model);
  assert.equal(primaryCount(model), 1);
  assert.match(html, /disabled[^>]*>Generating proposal/);
  assert.ok(!menuLabels(AppView, model).some((l) => /^Generate proposal$/.test(l)),
    'nothing to generate while one is already running');
});

test('every other outcome also yields exactly one primary', () => {
  const AppView = makeAppView();
  for (const outcome of ['spec', 'code', 'spec_code', undefined]) {
    const model = AppView._issueCardModel(issue({ status: 'ready', outcome, sessionId: 90 }));
    assert.equal(primaryCount(model), 1, `outcome ${outcome}: one primary`);
    assert.ok(hasAction(model, 'startFromAutoSession', 90));
  }
  // …and so does a never-started issue.
  const fresh = AppView._issueCardModel(issue(null));
  assert.equal(primaryCount(fresh), 1);
  assert.ok(hasAction(fresh, 'createPrForIssue', 5));
});

// ── The topic head is not the board ────────────────────────────────────
//
// The same _issueCardModel draws the board card AND the topic head
// (app-view.js's _renderTopicHead calls it with { noNav: true }). On the
// board, the question-outcome primary is a real navigation: "Answer &
// regenerate" opens the issue's discussion, which is where the run posted
// its questions. On the head you are ALREADY in that discussion, so the
// same spec becomes a button whose whole action is to re-render the view
// it is drawn on — it looks broken because nothing visibly happens.
//
// The head is not left without the action: _detailActionsView already
// spells "Generate proposal" out in full there, which is the re-run the
// board's button was only pointing at. That is also why the head must not
// grow its own copy — two Generate affordances is this file's subject.

test('the topic head does not draw a primary that navigates to itself', () => {
  const AppView = makeAppView();
  const head = AppView._issueCardModel(
    issue({ status: 'ready', outcome: 'question', sessionId: 91 }),
    { noNav: true }
  );
  const acts = (head.actions || []).map((a) => a.act).filter(Boolean);
  assert.ok(!acts.some((a) => a.fn === 'openTopic'),
    'the head\'s own card must not offer "open this issue" — it IS this issue');
  assert.ok(!cardHtml(head).includes('Answer &amp; regenerate'),
    'the board\'s wording promises a navigation the head cannot perform');
});

test('the board card keeps it — the fix is scoped to the head', () => {
  const AppView = makeAppView();
  const board = AppView._issueCardModel(issue({ status: 'ready', outcome: 'question', sessionId: 91 }));
  assert.ok(hasAction(board, 'openTopic', 'issue', 5), 'still a real navigation on the board');
  assert.match(cardHtml(board), /Answer &amp; regenerate/);
});

test('the head still offers exactly one Generate affordance, in its detail actions', () => {
  const AppView = makeAppView();
  const item = issue({ status: 'ready', outcome: 'question', sessionId: 91 });
  const head = AppView._issueCardModel(item, { noNav: true });
  assert.ok(!hasAction(head, 'confirmAutoSession'),
    'the head card must not grow its own re-run — the detail list owns it');
  assert.match(detailActionsHtml(AppView, 'issue', item), />Generate proposal</,
    'and the detail list does offer it');
});
