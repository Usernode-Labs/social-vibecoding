const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { cardHtml } = require('./lib/dev-card-html');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function appView(user = { id: 42 }) {
  const context = { console, App: { user }, relTime: () => 'just now',
    document: { getElementById: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('public/js/app-view.js', 'utf8') + '\n;globalThis.av = AppView;', context);
  return context.av;
}

const failing = { id: 123, user_id: 42, status: 'active', check_state: 'failing',
  session_title: 'Underway fix', linked_issues: [],
  failing_checks: { total: 1, rows: [{ name: 'Open settings', reason: 'Button missing' }] },
  test_results: [{ name: 'Open settings', path: '/settings', status: 'fail',
    failureReason: 'Button missing', consoleErrors: [{ message: 'Settings crashed' }] }] };

function menu(av, card) { return av._cardMenus[card.rail.menuKey] || []; }

test('actual own card renders failure reason and provides inspection and rerun', () => {
  const av = appView();
  const card = av._mySessionCardModel(failing);
  const html = cardHtml(card);
  assert.match(html, /title="Open settings — Button missing"/);
  const items = menu(av, card);
  assert.ok(items.some((r) => r.label === 'View checks'));
  assert.ok(items.some((r) => r.label === 'Re-run checks'));
  let opened;
  av.openSessionChecks = (id) => { opened = id; };
  items.find((r) => r.label === 'View checks').act();
  assert.equal(opened, failing.id);
});

test('shared cards and their topic headers allow inspection, with rerun only for write admins', () => {
  for (const user of [{ id: 99 }, { id: 99, isAdmin: true }, { id: 99, isAdmin: true, canAdminWrite: true }]) {
    for (const noNav of [false, true]) {
      const av = appView(user);
      const items = menu(av, av._sharedSessionCardModel(failing, { noNav }));
      assert.ok(items.some((r) => r.label === 'View checks'));
      assert.equal(items.some((r) => r.label === 'Re-run checks'), !!user.canAdminWrite);
    }
  }
});

test('passing, closed, read-only and in-flight cards cannot offer a duplicate rerun', () => {
  const av = appView();
  for (const patch of [{ check_state: null }, { check_state: 'passing' }, { status: 'paused' }, { status: 'archived' }, { status: 'merged' }]) {
    assert.equal(av._recheckAction({ ...failing, ...patch }), null);
  }
  av.appData = { can_collaborate: false };
  assert.equal(av._recheckAction(failing), null);
  av.appData = { can_collaborate: true };
  av._recheckInFlight.add(failing.id);
  assert.equal(av._recheckAction(failing).disabled, true);
  assert.ok(!menu(av, av._mySessionCardModel(failing)).some((r) => r.label === 'Re-run checks'));
});

test('results render paths, reasons and console errors as visible escaped text', () => {
  const previous = global.window;
  global.window = { AppView: appView() };
  try {
    const { SessionCheckResults } = loadTsx('tests/fixtures/dev-card-api.ts');
    const html = renderToHtml(createElement(SessionCheckResults, { session: {
      ...failing, test_results: [...failing.test_results,
        { name: '<script>bad</script>', status: 'fail', advisory: true, failureReason: 'Advisory detail' },
        { name: 'Retry check', status: 'pass', runs: 2, fails: 1, passedOnRetry: true, failureReason: 'Transient' }],
    } }));
    for (const text of ['Open settings', '/settings', 'Button missing', 'Settings crashed', 'Advisory detail', 'then passed when re-run']) assert.ok(html.includes(text), text);
    assert.ok(html.includes('&lt;script&gt;bad&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
  } finally { global.window = previous; }
});
