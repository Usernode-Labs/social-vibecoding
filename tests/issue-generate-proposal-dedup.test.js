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
// count must exclude pills that have nothing to do with the run. The ⋯ trigger
// and the preview icon carry .gc-vote-btn-icon; the in-progress claim toggle is
// a second, unrelated promoted pill (it names its own handlers, so it filters
// out by wiring rather than by position).
function primaryCount(html) {
  const row = html.match(/<div class="gc-card-actions">([\s\S]*?)<\/div>/);
  if (!row) return 0;
  return (row[1].match(/<button[^>]*>/g) || [])
    .filter((b) => !/gc-vote-btn-icon/.test(b))
    .filter((b) => !/markIssueInProgress|clearIssueClaim/.test(b)).length;
}
function menuLabels(AppView, html) {
  const m = html.match(/data-card-menu="([^"]+)"/);
  if (!m) return [];
  return (AppView._cardMenus[m[1]] || []).map((it) => it.label);
}

test('a question outcome the viewer has NOT cloned: one primary + one ⋯ re-run', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(issue({ status: 'ready', outcome: 'question', sessionId: 91 }));
  assert.equal(primaryCount(html), 1, 'exactly one headless pill on the card face');
  assert.match(html, /Answer &amp; regenerate/, 'the folded primary');
  // The band's other pill is the promoted claim toggle, which is not a second
  // way to do this — it is a different action entirely.
  assert.match(html, /markIssueInProgress\(5\)/);
  const generate = menuLabels(AppView, html).filter((l) => /^Generate proposal$/.test(l));
  assert.equal(generate.length, 1, 'exactly one Generate proposal affordance, in ⋯');
});

test('a question outcome the viewer HAS cloned: Go to session and NO re-run anywhere', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(issue({
    status: 'ready', outcome: 'question', sessionId: 91, mySessionId: 92,
  }));
  assert.equal(primaryCount(html), 1);
  assert.match(html, /goToAutoSessionClone\(92\)/);
  assert.match(html, />Go to session</);
  // The original bug, stated directly: no second Generate beside it.
  assert.ok(!menuLabels(AppView, html).some((l) => /^Generate proposal$/.test(l)),
    'the proposal already exists — offering a re-run here is the #150 bug');
  assert.doesNotMatch(html, /confirmAutoSession/, 'no re-run wiring on the card at all');
});

test('a run in flight offers neither a clone nor a re-run', () => {
  const AppView = makeAppView();
  const html = AppView._renderIssueRow(issue({ status: 'generating', sessionId: 93 }));
  assert.equal(primaryCount(html), 1);
  assert.match(html, /disabled[^>]*>Generating proposal/);
  assert.ok(!menuLabels(AppView, html).some((l) => /^Generate proposal$/.test(l)),
    'nothing to generate while one is already running');
});

test('every other outcome also yields exactly one primary', () => {
  const AppView = makeAppView();
  for (const outcome of ['spec', 'code', 'spec_code', undefined]) {
    const html = AppView._renderIssueRow(issue({ status: 'ready', outcome, sessionId: 90 }));
    assert.equal(primaryCount(html), 1, `outcome ${outcome}: one primary`);
    assert.match(html, /startFromAutoSession\(90\)/);
  }
  // …and so does a never-started issue.
  const fresh = AppView._renderIssueRow(issue(null));
  assert.equal(primaryCount(fresh), 1);
  assert.match(fresh, /createPrForIssue\(5\)/);
});
