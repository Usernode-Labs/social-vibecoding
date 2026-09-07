const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dialogs/feedback-controller.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.Feedback = Feedback;';
const moment = { userId: 7, appSlug: 'filed-app', issueNumber: 41, canFix: true };
const settle = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };

function element(id) {
  const listeners = {}, classes = new Set(), children = new Map();
  return {
    id, dataset: {}, style: {}, value: '', textContent: '', className: '', disabled: false, checked: false,
    focused: false, innerHTML: '', placeholder: '',
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x), toggle(x, on) { if (on) classes.add(x); else classes.delete(x); } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type) { for (const fn of listeners[type] || []) fn({ target: this, currentTarget: this }); },
    click() { this.fire('click'); }, focus() { this.focused = true; },
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; },
    querySelector(sel) { if (!children.has(sel)) children.set(sel, element(sel)); return children.get(sel); },
    querySelectorAll() { return []; },
  };
}
function harness({ response = { firstFeedback: moment }, ok = true } = {}) {
  const els = new Map(), timers = new Map(), calls = [], fixes = [], nav = [], toasts = [];
  let id = 0, queueHooks, failedReads = 0;
  const el = id => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); };
  const sandbox = {
    console, URLSearchParams, location: { search: '', hash: '', pathname: '/' },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {}, body: { appendChild() {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval() {}, clearInterval() {}, addEventListener() {}, publishVisibility() {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok, json: async () => typeof response === 'function' ? response() : response };
    },
    App: { user: { id: 7 }, currentApp: 'other-app', currentTab: 'app', async navigateToApp(...args) {
      nav.push(args); this.currentApp = args[0]; sandbox.AppView.appData = { slug: args[0] };
    } },
    AppView: { appData: { slug: 'other-app', name: 'Other App', repo_url: 'https://github.com/owner/other' }, issueStateAvailable: () => false, async createPrForIssue(n) { fixes.push(n); } },
    PlatformUI: { toast: message => toasts.push(message) },
    FeedbackQueue: {
      init(opts) { queueHooks = opts; }, count: async () => 0,
      takeFailed: async () => { failedReads++; return null; }, enqueue: async () => {},
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  sandbox.init();
  el('feedback-modal').classList.add('hidden');
  sandbox.UsernodeReact = { dialogs: { feedback: {
    open(opts) { el('feedback-modal').classList.remove('hidden'); sandbox.Feedback._open(opts); },
  } } };
  el('feedback-cancel').addEventListener('click', () => { el('feedback-modal').classList.add('hidden'); sandbox.Feedback._reset(); });
  sandbox.App.openFeedbackModal();
  return {
    sandbox, el, timers, calls, fixes, nav, toasts,
    failedReads: () => failedReads,
    async submit() { el('feedback-text').value = 'The board jumps.'; el('feedback-submit').click(); await settle(); },
    async fireTimers(ms) { for (const [key, timer] of [...timers]) if (timer.ms === ms) { timers.delete(key); timer.fn(); } await settle(); },
    flush(result = moment) { queueHooks.onFlushed({ sent: 1, filed: [{ target: 'platform', firstFeedback: result }] }); },
    shown: () => !el('feedback-first-success').classList.contains('hidden'),
  };
}

test('first feedback stays open, focuses the confirmation, and preserves bounty outcomes', async () => {
  const h = harness({ response: { firstFeedback: moment, bounty: { placed: true, remaining: 4 } } });
  await h.submit();
  assert.ok(h.shown());
  assert.ok(h.el('feedback-first-success').focused);
  assert.ok(h.el('feedback-form').classList.contains('hidden'));
  assert.match(h.el('feedback-first-notice').textContent, /Pledged 1 kudos.*4 left/);
  assert.equal([...h.timers.values()].filter(t => t.ms === 1500).length, 0);
  h.el('feedback-submit').click(); await settle();
  assert.equal(h.calls.filter(c => c.url === '/api/feedback').length, 1);
});
test('the board action uses the filed destination, not the currently open app', async () => {
  const h = harness(); await h.submit();
  h.el('feedback-first-board').click();
  assert.equal(h.sandbox.location.hash, '#app/filed-app/board');
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
  assert.equal(h.fixes.length, 0);
});
test('try a fix opens the filed issue through the existing editable-draft flow', async () => {
  const h = harness(); await h.submit();
  h.el('feedback-first-fix').click(); h.el('feedback-first-fix').click(); await settle();
  assert.deepEqual(h.nav, [['filed-app', 'dev', 41, 'issues']]);
  assert.deepEqual(h.fixes, [41]);
});
test('view-only access keeps the board usable and explains the disabled fix', async () => {
  const h = harness({ response: { firstFeedback: { ...moment, canFix: false } } });
  await h.submit();
  assert.equal(h.el('feedback-first-fix').disabled, true);
  assert.equal(h.el('feedback-first-board').disabled, false);
  assert.match(h.el('feedback-first-fix-note').textContent, /collaborator access/);
  h.el('feedback-first-fix').click(); await settle(); assert.equal(h.fixes.length, 0);
});
test('ordinary successful feedback retains the brief confirmation and auto-close', async () => {
  const h = harness({ response: {} }); await h.submit();
  assert.equal(h.shown(), false);
  await h.fireTimers(1500);
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
});
test('a rejected submission never congratulates the user', async () => {
  const h = harness({ ok: false, response: { error: 'Try again' } }); await h.submit();
  assert.equal(h.shown(), false);
  assert.equal(h.el('feedback-status').textContent, 'Try again');
});
test('Done dismisses the moment and reopening restores the form', async () => {
  const h = harness(); await h.submit(); h.el('feedback-first-done').click();
  h.sandbox.App.openFeedbackModal();
  assert.equal(h.shown(), false);
  assert.equal(h.el('feedback-submit').disabled, false);
  assert.equal(h.el('feedback-form').classList.contains('hidden'), false);
});
test('queued success waits for an active draft to close before showing the moment', async () => {
  const h = harness(); h.el('feedback-text').value = 'Still writing'; h.flush();
  assert.equal(h.shown(), false);
  assert.equal(h.el('feedback-text').value, 'Still writing');
  h.el('feedback-cancel').click(); await h.fireTimers(0);
  assert.ok(h.shown());
});
test('queued success cancels an existing auto-close timer', async () => {
  const h = harness({ response: {} }); await h.submit(); h.flush();
  await h.fireTimers(1500);
  assert.ok(h.shown());
  assert.equal(h.el('feedback-modal').classList.contains('hidden'), false);
});
test('opening queued success does not consume failed outbox drafts', async () => {
  const h = harness(); await settle(); h.el('feedback-cancel').click();
  const before = h.failedReads(); h.flush(); await settle();
  assert.ok(h.shown());
  assert.equal(h.failedReads(), before);
});
test('an account change during submit cannot show another user’s first feedback', async () => {
  let finish;
  const h = harness({ response: () => new Promise(resolve => { finish = resolve; }) });
  h.el('feedback-text').value = 'Report'; h.el('feedback-submit').click(); await settle();
  h.sandbox.App.user = { id: 8 }; finish({ firstFeedback: moment }); await settle();
  assert.equal(h.shown(), false);
  h.flush(); assert.equal(h.shown(), false);
});
test('a stale submission does not overwrite a reopened draft', async () => {
  let finish;
  const h = harness({ response: () => new Promise(resolve => { finish = resolve; }) });
  h.el('feedback-text').value = 'Old report'; h.el('feedback-submit').click(); await settle();
  h.el('feedback-cancel').click(); h.sandbox.App.openFeedbackModal(); h.el('feedback-text').value = 'New draft';
  finish({ firstFeedback: moment }); await settle();
  assert.equal(h.shown(), false); assert.equal(h.el('feedback-text').value, 'New draft');
});
