// An issue card offers ONE way to start its work, and never a second beside it.
//
// An issue row used to render BOTH "Go to session" and a second "Generate
// proposal" button when a headless auto-solve run finished with a question
// outcome. The card-as-pointer revision removed the shape of that bug rather
// than guarding it: an issue card has exactly ONE state-driven primary action
// (_issuePrimaryActionSpec), so two competing starts are not expressible. The
// headless runs are retired; what this pins is the rule they broke, on the
// two shapes left: a request nobody has started (Work on this with Homeroom
// bot) and one Homeroom bot is building (one disabled primary, and nothing
// that would start the work a second time, on the card or in its ⋯).
//
// Run with: node --test tests/issue-generate-proposal-dedup.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { cardHtml, hasAction } = require('./lib/dev-card-html');

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
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  return AppView;
}

const issue = () => ({ number: 5, title: 'Fix the thing' });

// Count the primary pills on the card face — this file's subject is that an
// issue never offers two ways to start the same work at once, so the count
// must exclude pills that have nothing to do with starting it. The card holds
// its handlers as closures now (#1367's card chunk), so this counts the
// MODEL's action specs and drops the in-progress claim toggle by the call it
// dispatches.
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

test('a request nobody has started yields exactly one primary: Work on this with Homeroom bot', () => {
  const AppView = makeAppView();
  const fresh = AppView._issueCardModel(issue());
  assert.equal(primaryCount(fresh), 1);
  assert.ok(hasAction(fresh, 'workOnIssueWithBot', 5));
  assert.ok(!menuLabels(AppView, fresh).some((l) => /^(Start more work|Generate proposal)$/.test(l)),
    'and no second start in ⋯');
});

// #17: the Homeroom bot building the request is the same shape as a run in
// flight: one primary, disabled, and nothing that would start the work a
// second time beside it.
test('the Homeroom bot building the request: one disabled primary, and no Start work anywhere', () => {
  const AppView = makeAppView();
  const bot = { what: 'building', since: '2026-10-03T10:00:00Z' };
  for (const [surface, opts] of [['board', undefined], ['head', { noNav: true }]]) {
    const model = AppView._issueCardModel({ ...issue(), bot }, opts);
    assert.equal(primaryCount(model), 1, `${surface}: one primary`);
    assert.match(cardHtml(model), /disabled[^>]*>Homeroom bot is building…</, `${surface}: and it waits`);
    assert.ok(!hasAction(model, 'chooseIssueWork'), `${surface}: no Start work`);
    assert.ok(!menuLabels(AppView, model).some((l) => /^(Start more work|Generate proposal)$/.test(l)),
      `${surface}: none in ⋯ either`);
  }
});
