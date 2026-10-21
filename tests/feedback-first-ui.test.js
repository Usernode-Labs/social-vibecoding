const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
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
function harness({ response = { firstFeedback: moment }, ok = true, patchResult } = {}) {
  const els = new Map(), timers = new Map(), intervals = new Map(), calls = [], fixes = [], nav = [], toasts = [], closes = [];
  let id = 0, queueHooks, failedReads = 0, clock = 0;
  const el = id => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); };
  const sandbox = {
    // The binding the controller's i18n import gives it (the import line is stripped above).
    t: englishPlatformI18n().t,
    // The controller's KUDOS_PARKED import, stripped above too: these suites
    // drive the bounty row with the switch off (#5249). The parked state is
    // pinned in tests/feedback-bounty-ui.test.js.
    KUDOS_PARKED: false,
    console, URLSearchParams, location: { search: '', hash: '', pathname: '/' },
    performance: { now: () => clock },
    document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {}, body: { appendChild() {} } },
    localStorage: { getItem() { return null; }, setItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval(fn, ms) { intervals.set(++id, { fn, ms }); return id; }, clearInterval: id => intervals.delete(id),
    addEventListener() {}, publishVisibility() {},
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'PATCH') {
        const result = typeof patchResult === 'function' ? await patchResult(JSON.parse(options.body)) : patchResult;
        return { ok: result.status === 200, status: result.status, json: async () => result.body };
      }
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
  el('feedback-cancel').addEventListener('click', () => {
    // Where the page stood when the dialog closed — see #3683 below.
    closes.push({ hash: sandbox.location.hash, navigations: nav.length });
    el('feedback-modal').classList.add('hidden'); sandbox.Feedback._reset();
  });
  sandbox.App.openFeedbackModal();
  return {
    sandbox, el, timers, calls, fixes, nav, toasts, closes,
    failedReads: () => failedReads,
    advance(ms) { clock += ms; },
    // #2707: this harness opens with an app on screen, so BOTH destinations
    // are real and none is preselected — a submit refuses until one is tapped.
    // Every test below is about what happens AFTER a submit, so the tap is
    // part of getting there, the way typing the description is.
    async submit() {
      el('feedback-text').value = 'The board jumps.';
      el('feedback-target-platform').click();
      el('feedback-submit').click();
      await settle();
    },
    async fireTimers(ms) { for (const [key, timer] of [...timers]) if (timer.ms === ms) { timers.delete(key); timer.fn(); } await settle(); },
    async fireIntervals(ms) { for (const timer of intervals.values()) if (timer.ms === ms) timer.fn(); await settle(); },
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
  for (const id of ['feedback-text', 'feedback-title']) {
    assert.equal(h.el(id).readOnly, true);
    assert.equal(h.el(id).disabled, false);
  }
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
// #3683: closing spends the dialog's back-button record with a history.back()
// that the browser queues, so it lands after an address written later in the
// same click and undoes it: the viewer stays where they sent the request
// from. Every way on writes its address FIRST, and the close then finds the
// page already moved and leaves the record alone (lib/back-stack.ts).
test('every way on from the first-request moment moves the address before the dialog closes', async () => {
  const board = harness(); await board.submit();
  board.el('feedback-first-board').click();
  assert.deepEqual(board.closes, [{ hash: '#app/filed-app/board', navigations: 0 }]);
  const fix = harness(); await fix.submit();
  fix.el('feedback-first-fix').click(); await settle();
  assert.deepEqual(fix.closes, [{ hash: '', navigations: 1 }], 'navigateToApp has written the address');
  assert.deepEqual(fix.fixes, [41], 'and the fix still starts once the app is open');
  const mine = harness(); await mine.submit();
  mine.el('feedback-first-mine').click();
  assert.deepEqual(mine.closes, [{ hash: '#profile/your-requests', navigations: 0 }]);
});
test('view-only access keeps the board usable and explains the disabled fix', async () => {
  const h = harness({ response: { firstFeedback: { ...moment, canFix: false } } });
  await h.submit();
  assert.equal(h.el('feedback-first-fix').disabled, true);
  assert.equal(h.el('feedback-first-board').disabled, false);
  assert.match(h.el('feedback-first-fix-note').textContent, /collaborator access/);
  h.el('feedback-first-fix').click(); await settle(); assert.equal(h.fixes.length, 0);
});
// #3186: the ordinary confirmation used to close itself after 1.5 s, which
// read as the report vanishing and left no time to reach "See your feedback".
test('an ordinary posted request stays on its own confirmation, with the way to Your requests', async () => {
  const h = harness({ response: { bounty: { placed: true, remaining: 4 } } }); await h.submit();
  assert.equal(h.shown(), false, 'not the first-feedback moment');
  const sent = h.el('feedback-sent');
  assert.equal(sent.classList.contains('hidden'), false);
  assert.ok(sent.focused, 'focus leaves the composer, so the keyboard comes down once');
  assert.ok(h.el('feedback-form').classList.contains('hidden'));
  // The heading names where it went; the notice carries only what else
  // happened, here the bounty. #3971: "Thanks!" leads it again, as it did
  // before the UI overhaul (#3400) took it out.
  assert.equal(h.el('feedback-sent-title').textContent, 'Thanks! Posted to Homeroom');
  assert.equal(h.el('feedback-sent-line').textContent,
    'Your idea is on the board now.');
  assert.match(h.el('feedback-sent-notice').textContent, /^Pledged 1 kudos.*4 left/);
  assert.equal(h.el('feedback-sent-notice').classList.contains('hidden'), false);
  for (const id of ['feedback-text', 'feedback-title']) assert.equal(h.el(id).readOnly, true);
  await h.fireTimers(1500);
  assert.equal(h.el('feedback-modal').classList.contains('hidden'), false, 'no auto-close');
  h.el('feedback-sent-mine').click();
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
  assert.equal(h.sandbox.location.hash, '#profile/your-requests');
  // The next open is the form again, not the last confirmation.
  h.sandbox.App.openFeedbackModal();
  assert.ok(sent.classList.contains('hidden'));
  assert.equal(h.el('feedback-form').classList.contains('hidden'), false);
});
test('?shot=feedback-sent poses the sent confirmation without filing anything', async () => {
  const h = harness({ response: {} });
  h.sandbox.App._simulateFeedbackSent();
  assert.equal(h.el('feedback-sent').classList.contains('hidden'), false);
  assert.equal(h.el('feedback-sent-title').textContent, 'Thanks! Posted to Homeroom');
  assert.equal(h.el('feedback-sent-notice').textContent, '');
  assert.ok(h.el('feedback-sent-notice').classList.contains('hidden'), 'nothing else happened, so the notice says nothing');
  assert.equal(h.el('feedback-text').readOnly, true);
  assert.equal(h.el('feedback-submit').disabled, true);
  assert.equal(h.calls.filter((c) => c.url === '/api/feedback').length, 0);
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  assert.match(app, /shot !== 'feedback-sent' && shot !== 'feedback-bot'\) return;/, 'the shot names are accepted');
  assert.match(app, /App\._simulateFeedbackSent\?\.\(\);/);
});
// #5687: the sheet's one job is to confirm the request was posted, so Done
// is the filled primary button and comes first; Open chat is the one neutral
// button under it, and See your requests and Edit are quiet links under the
// buttons.
test('#5687: Done leads the sent confirmation as its filled primary button', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dialogs/feedback.tsx'), 'utf8');
  const at = (id) => src.indexOf(`id="${id}"`);
  const order = ['feedback-sent-done', 'feedback-sent-chat', 'feedback-sent-mine', 'feedback-sent-edit', 'feedback-sent-fix'].map(at);
  assert.ok(order.every((pos) => pos > 0), 'every action is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'Done, then Open chat, See your requests, Edit and the small link');
  assert.match(src, /<Button id="feedback-sent-done" className="min-h-\[44px\]">/, 'the filled, default variant');
  assert.match(src, /<Button id="feedback-sent-chat" variant="neutral" ink="neutral"/, 'Open chat is a secondary button');
});
// Done, then quiet links: See your requests and Edit are one centred row of
// muted, underlined text links ("See your requests · Edit") with 44px tap
// targets. Nothing fills them, so Done is the only filled control on the sheet.
test('See your requests and Edit are one row of quiet links, with a dot only between two shown links', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/features/dialogs/feedback.tsx'), 'utf8');
  const start = src.indexOf('<section id="feedback-sent"');
  const sheet = src.slice(start, src.indexOf('</section>', start));
  const QUIET = 'variant="unstyled" size="inline" ink="none" className="';
  const LINK = 'min-h-[44px] px-2 text-zinc-500 underline underline-offset-2 dark:text-zinc-400"';
  assert.ok(sheet.includes(`<Button id="feedback-sent-mine" type="button" ${QUIET}${LINK}>`), 'See your requests is a quiet link, shown by default');
  assert.ok(sheet.includes(`<Button id="feedback-sent-edit" type="button" ${QUIET}hidden ${LINK}>`), 'Edit is a quiet link, hidden until the controller offers it');
  const row = sheet.slice(sheet.lastIndexOf('<div', sheet.indexOf('id="feedback-sent-mine"')), sheet.indexOf('</div>', sheet.indexOf('id="feedback-sent-edit"')));
  assert.match(row, /^<div className="flex items-center justify-center \[&:not\(:has\(>:not\(\.hidden\)\)\)\]:hidden">/, 'centred, and gone when neither link shows');
  assert.match(row, /<span aria-hidden="true" className="hidden [^"]*\[:not\(\.hidden\)\+&:has\(\+:not\(\.hidden\)\)\]:inline">·<\/span>/, 'the dot shows only between two shown links');
  assert.ok(row.indexOf('id="feedback-sent-mine"') < row.indexOf('·') && row.indexOf('·') < row.indexOf('id="feedback-sent-edit"'), 'See your requests · Edit');
  assert.doesNotMatch(sheet, /id="feedback-sent-(mine|edit)"[^>]*variant="neutral"/, 'neither is a filled button any more');
});
test('Done closes the sent confirmation and goes nowhere', async () => {
  const h = harness({ response: {} }); await h.submit();
  h.el('feedback-sent-done').click();
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
  assert.equal(h.sandbox.location.hash, '');
  assert.ok(h.el('feedback-sent').classList.contains('hidden'));
});
test('the first-request moment offers Your requests too, and replaces a sent confirmation', async () => {
  const h = harness(); await h.submit();
  h.el('feedback-first-mine').click();
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
  assert.equal(h.sandbox.location.hash, '#profile/your-requests');
  const q = harness({ response: {} }); await q.submit();
  q.flush();
  assert.ok(q.shown());
  assert.ok(q.el('feedback-sent').classList.contains('hidden'), 'one confirmation at a time');
});
// #4680: the form carries the same way to Your requests, under the intro
// line, so what is already asked for is readable before a new one is written.
// The route is written before the close, the same as the confirmations' links.
test('the form itself offers Your requests before anything is typed', async () => {
  const h = harness();
  h.sandbox.App.openFeedbackModal();
  assert.equal(h.el('feedback-form').classList.contains('hidden'), false, 'the form, not a confirmation');
  h.el('feedback-form-mine').click();
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
  assert.equal(h.sandbox.location.hash, '#profile/your-requests');
  assert.deepEqual(h.calls.filter((c) => c.url === '/api/feedback').length, 0, 'nothing filed by the look');
});
test('a rejected submission never congratulates the user', async () => {
  const h = harness({ ok: false, response: { error: 'Try again' } }); await h.submit();
  assert.equal(h.shown(), false);
  assert.equal(h.el('feedback-status').textContent, 'Try again');
});
test('Done dismisses the moment and reopening restores the form', async () => {
  const h = harness(); await h.submit(); h.el('feedback-first-done').click();
  for (const id of ['feedback-text', 'feedback-title']) {
    assert.equal(h.el(id).readOnly, false);
    assert.equal(h.el(id).disabled, false);
  }
  h.sandbox.App.openFeedbackModal();
  assert.equal(h.shown(), false);
  // #2707: a reopen asks for the destination again. #2888: Submit stays
  // pressable while it does. What this assertion is about is that the
  // confirmation did not leave the button locked, and that still holds.
  assert.equal(h.el('feedback-submit').disabled, false);
  h.el('feedback-target-platform').click();
  assert.equal(h.el('feedback-submit').disabled, false);
  assert.equal(h.el('feedback-form').classList.contains('hidden'), false);
  for (const id of ['feedback-text', 'feedback-title']) {
    assert.equal(h.el(id).readOnly, false);
    assert.equal(h.el(id).disabled, false);
  }
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
  assert.equal([...h.timers.values()].filter(t => t.ms === 1500).length, 0);
  for (const id of ['feedback-text', 'feedback-title']) {
    assert.equal(h.el(id).readOnly, true);
    assert.equal(h.el(id).disabled, false);
  }
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
  h.el('feedback-text').value = 'Report';
  h.el('feedback-target-platform').click();
  h.el('feedback-submit').click(); await settle();
  h.sandbox.App.user = { id: 8 }; finish({ firstFeedback: moment }); await settle();
  assert.equal(h.shown(), false);
  h.flush(); assert.equal(h.shown(), false);
});
test('a stale submission does not overwrite a reopened draft', async () => {
  let finish;
  const h = harness({ response: () => new Promise(resolve => { finish = resolve; }) });
  h.el('feedback-text').value = 'Old report';
  h.el('feedback-target-platform').click();
  h.el('feedback-submit').click(); await settle();
  h.el('feedback-cancel').click(); h.sandbox.App.openFeedbackModal(); h.el('feedback-text').value = 'New draft';
  finish({ firstFeedback: moment }); await settle();
  assert.equal(h.shown(), false); assert.equal(h.el('feedback-text').value, 'New draft');
});

// ── B8: Homeroom bot is on it ────────────────────────────────────────────
//
// #3971: B8 answered with "Got it" / "Homeroom bot is on it, usually about N
// minutes.", which the request called bland next to what it replaced. The
// answer says the idea is underway and what happens next now, and a first
// request says so inside it rather than being skipped.
const BOT = { botWillBuild: true, typicalMinutes: 6, canFix: true, appSlug: 'filed-app', issueNumber: 41 };
const BOT_TITLE = 'Your idea is underway!';
const botLine = (n) => `Homeroom bot is building it now, usually about ${n} minutes. You'll get a message when it's ready to try.`;
test('B8: a request Homeroom bot builds is answered with its idea underway, how long it takes and Open chat', async () => {
  const opened = [];
  const h = harness({ response: { homeroomBot: BOT } });
  h.sandbox.UsernodeReact.messages = { openBot() { opened.push(true); } };
  await h.submit();
  assert.equal(h.shown(), false, 'not the first-request moment: the bot is on it');
  assert.equal(h.el('feedback-sent').classList.contains('hidden'), false);
  assert.equal(h.el('feedback-sent-title').textContent, BOT_TITLE);
  assert.equal(h.el('feedback-sent-line').textContent, botLine(6));
  assert.ok(h.el('feedback-sent-first').classList.contains('hidden'), 'not a first request, so no first-request line');
  assert.equal(h.el('feedback-sent-chat').classList.contains('hidden'), false, 'Open chat shows, under Done');
  assert.ok(h.el('feedback-sent-mine').classList.contains('hidden'), 'the chat is where to find it');
  assert.equal(h.el('feedback-sent-fix').classList.contains('hidden'), false, 'building it yourself is the small link');
  h.el('feedback-sent-chat').click();
  assert.deepEqual(opened, [true]);
  assert.ok(h.el('feedback-modal').classList.contains('hidden'));
});
test('#3971: a first request the bot builds is the bot\'s answer, with the first-request line naming the app', async () => {
  const h = harness({ response: { firstFeedback: moment, homeroomBot: BOT } });
  await h.submit();
  assert.equal(h.shown(), false, 'the moment\'s own next steps would compete with Open chat');
  assert.equal(h.el('feedback-sent').classList.contains('hidden'), false);
  assert.equal(h.el('feedback-sent-title').textContent, BOT_TITLE);
  assert.equal(h.el('feedback-sent-line').textContent, botLine(6));
  assert.equal(h.el('feedback-sent-first').classList.contains('hidden'), false, 'the first request says so');
  // #5757: this submits to Homeroom, so the box names Homeroom rather than
  // the app that happened to be open.
  assert.equal(h.el('feedback-sent-first-line').textContent, 'You just helped shape Homeroom.');
  assert.equal(h.el('feedback-sent-chat').classList.contains('hidden'), false, 'Open chat is still there, under Done');
  // Another account's moment is not this person's first request.
  const other = harness({ response: { firstFeedback: { ...moment, userId: 8 }, homeroomBot: BOT } });
  await other.submit();
  assert.ok(other.el('feedback-sent-first').classList.contains('hidden'));
  // The next confirmation, a second request, does not carry it over.
  h.el('feedback-sent-done').click();
  h.sandbox.App.openFeedbackModal();
  h.sandbox.fetch = async () => ({ ok: true, json: async () => ({ homeroomBot: BOT }) });
  await h.submit();
  assert.ok(h.el('feedback-sent-first').classList.contains('hidden'));
});
// #5757: the box names the place the request went to. A first request sent to
// an app still names that app; and the box now says what the bot does next.
test('#5757: a first request to an app names the app, and the box says the bot will look at it', async () => {
  const h = harness({ response: { firstFeedback: moment, homeroomBot: BOT } });
  h.el('feedback-text').value = 'The board jumps.';
  h.el('feedback-target-app').click();
  h.el('feedback-submit').click();
  await settle();
  assert.equal(h.el('feedback-sent-first-line').textContent, 'You just helped shape Other App.');
  // The line is static React text, so the controller never writes into it.
  const tsx = require('node:fs').readFileSync(require('node:path').join(__dirname, '../frontend/src/features/dialogs/feedback.tsx'), 'utf8');
  const box = tsx.slice(tsx.indexOf('<div id="feedback-sent-first"'), tsx.indexOf('<div id="feedback-sent-first"') + 2000);
  assert.match(box, /t\('dialogs:feedback\.sent\.firstBot'\)/);
  assert.equal(message('dialogs:feedback.sent.firstBot'),
    'Homeroom bot will pick up your request and look at it. It will message you in your chat with it: a question if something is unclear, a note if a person needs to decide, or a change to vote on if it can build it.');
});
test('#3971: the minutes fall back to 8 when the post does not say', async () => {
  const h = harness({ response: { homeroomBot: { ...BOT, typicalMinutes: null } } });
  await h.submit();
  assert.equal(h.el('feedback-sent-line').textContent, botLine(8));
});
test('#3971: the group path is thanked and still says where it went', async () => {
  const h = harness({ response: { homeroomBot: { botWillBuild: false } } });
  h.el('feedback-text').value = 'The board jumps.';
  h.el('feedback-target-app').click();
  h.el('feedback-submit').click();
  await settle();
  assert.equal(h.el('feedback-sent-title').textContent, "Thanks! Sent to Other App's group");
  assert.equal(h.el('feedback-sent-line').textContent,
    'Your idea is on the board now.');
  assert.ok(h.el('feedback-sent-first').classList.contains('hidden'));
});
test('B8: Build it now opens the request on the board and starts a change from it', async () => {
  const h = harness({ response: { homeroomBot: BOT } });
  await h.submit();
  h.el('feedback-sent-fix').click(); await settle();
  assert.deepEqual(h.nav, [['filed-app', 'dev', 41, 'issues']]);
  assert.deepEqual(h.fixes, [41]);
});
test('B8: no link for somebody who could not build it, and the ordinary words when the bot is not on it', async () => {
  const h = harness({ response: { homeroomBot: { ...BOT, canFix: false } } });
  await h.submit();
  assert.ok(h.el('feedback-sent-fix').classList.contains('hidden'));
  const plain = harness({ response: {} });
  await plain.submit();
  assert.equal(plain.el('feedback-sent-line').textContent,
    'Your idea is on the board now.');
  assert.ok(plain.el('feedback-sent-chat').classList.contains('hidden'));
  assert.equal(plain.el('feedback-sent-mine').classList.contains('hidden'), false);
  // ?shot=feedback-bot poses it without filing anything.
  const shot = harness({ response: {} });
  shot.sandbox.App._simulateFeedbackBot();
  assert.equal(shot.el('feedback-sent-title').textContent, BOT_TITLE);
  assert.ok(shot.el('feedback-sent-first').classList.contains('hidden'));
  assert.equal(shot.calls.filter((c) => c.url === '/api/feedback').length, 0);
});

// #4803: the actual controller, with network responses and a monotonic clock.
const EDIT = { reportId: 12, version: 0, title: 'Original title', description: 'Original words', secondsLeft: 300 };
test('a just-filed request offers the same editor on both confirmations; Cancel keeps the request', async () => {
  for (const firstFeedback of [moment, undefined]) {
    const h = harness({ response: { firstFeedback, edit: EDIT } });
    await h.submit();
    const button = firstFeedback ? 'feedback-first-edit' : 'feedback-sent-edit';
    assert.equal(h.el(button).classList.contains('hidden'), false);
    h.el(button).click();
    assert.equal(h.el('feedback-edit').classList.contains('hidden'), false);
    assert.equal(h.el('feedback-edit-title').value, EDIT.title);
    assert.equal(h.el('feedback-edit-text').value, EDIT.description);
    h.el('feedback-edit-text').value = 'Unsent correction';
    h.el('feedback-edit-cancel').click();
    assert.equal(h.el('feedback-edit').classList.contains('hidden'), true);
    assert.equal(h.calls.filter(c => c.options?.method === 'PATCH').length, 0);
    h.el(button).click();
    assert.equal(h.el('feedback-edit-text').value, EDIT.description);
  }
});
test('Save corrects the same request and returns to its confirmation with the saved notice', async () => {
  const saved = { ...EDIT, title: 'Correct title', description: 'Correct words', version: 1, secondsLeft: 280 };
  const h = harness({ response: { edit: EDIT }, patchResult: { status: 200, body: { ok: true, edit: saved } } });
  await h.submit(); h.el('feedback-sent-edit').click();
  h.el('feedback-edit-title').value = '  Correct title  ';
  h.el('feedback-edit-text').value = '  Correct words  ';
  h.el('feedback-edit-save').click(); await settle();
  const call = h.calls.find(c => c.options?.method === 'PATCH');
  assert.equal(call.url, '/api/feedback/12');
  assert.deepEqual(JSON.parse(call.options.body), { title: 'Correct title', description: 'Correct words', version: 0 });
  assert.match(h.el('feedback-sent-notice').textContent, /Changes saved/);
  assert.equal(h.el('feedback-sent').classList.contains('hidden'), false);
  h.el('feedback-sent-edit').click();
  assert.equal(h.el('feedback-edit-title').value, saved.title);
  assert.equal(h.el('feedback-edit-text').value, saved.description);
});
test('blank corrections are refused without a request', async () => {
  const h = harness({ response: { edit: EDIT } }); await h.submit();
  h.el('feedback-sent-edit').click(); h.el('feedback-edit-text').value = ' ';
  h.el('feedback-edit-save').click(); await settle();
  assert.match(h.el('feedback-edit-status').textContent, /Fill in both/);
  assert.equal(h.calls.filter(c => c.options?.method === 'PATCH').length, 0);
});
test('expiration hides Edit and preserves words when it happens inside the editor', async () => {
  const h = harness({ response: { edit: EDIT } }); await h.submit();
  h.el('feedback-sent-edit').click(); h.el('feedback-edit-text').value = 'Keep these words';
  h.advance(300000); await h.fireTimers(300000);
  assert.equal(h.el('feedback-sent-edit').classList.contains('hidden'), true);
  assert.equal(h.el('feedback-edit-save').disabled, true);
  assert.equal(h.el('feedback-edit-text').value, 'Keep these words');
  assert.match(h.el('feedback-edit-status').textContent, /5 minutes.*passed/);
});
test('server expiry and competing edits preserve corrections and stop another stale save', async () => {
  for (const code of ['edit_window_closed', 'edit_conflict']) {
    const h = harness({ response: { edit: EDIT }, patchResult: { status: 409, body: { code } } });
    await h.submit(); h.el('feedback-sent-edit').click(); h.el('feedback-edit-text').value = 'Keep this';
    h.el('feedback-edit-save').click(); await settle();
    assert.equal(h.el('feedback-edit-text').value, 'Keep this');
    assert.equal(h.el('feedback-edit-save').disabled, true);
    assert.equal(h.el('feedback-edit-cancel').disabled, false);
    assert.ok(h.el('feedback-edit-status').textContent);
    h.advance(1000); await h.fireIntervals(1000);
    assert.equal(h.el('feedback-edit-window').textContent, '');
    h.el('feedback-edit-cancel').click();
    assert.equal(h.el('feedback-sent-edit').classList.contains('hidden'), true);
  }
});
test('a failed save keeps the corrections and enables a retry', async () => {
  for (const patchResult of [{ status: 502, body: {} }, async () => { throw new Error('offline'); }]) {
    const h = harness({ response: { edit: EDIT }, patchResult }); await h.submit();
    h.el('feedback-sent-edit').click(); h.el('feedback-edit-text').value = 'Keep this';
    h.el('feedback-edit-save').click(); await settle();
    assert.equal(h.el('feedback-edit-text').value, 'Keep this');
    assert.equal(h.el('feedback-edit-save').disabled, false);
    assert.equal(h.el('feedback-edit-text').readOnly, false);
    assert.match(h.el('feedback-edit-status').textContent, /could not be saved/);
  }
});
test('profile editing skips drafts, the outbox and the comment shortcut, then refreshes after saving', async () => {
  let refreshed = 0, shortcut = 0;
  const h = harness({ patchResult: { status: 200, body: { edit: { ...EDIT, version: 1 } } } });
  h.el('feedback-cancel').click();
  const reads = h.failedReads();
  h.sandbox.UsernodeReact.suggestShortcut = { opensComment: () => true, openComment() { shortcut++; } };
  h.sandbox.App.openFeedbackModal({ edit: EDIT, onEditSaved() { refreshed++; } });
  await settle();
  assert.equal(h.failedReads(), reads);
  assert.equal(shortcut, 0);
  assert.equal(h.el('feedback-edit').classList.contains('hidden'), false);
  h.el('feedback-edit-text').value = 'Corrected'; h.el('feedback-edit-save').click(); await settle();
  assert.equal(refreshed, 1);
  assert.deepEqual(h.toasts, ['Changes saved']);
  assert.equal(h.el('feedback-modal').classList.contains('hidden'), true);
});
test('an edit response cannot change a reopened dialog or a different account', async () => {
  for (const differentUser of [false, true]) {
    let finish;
    const h = harness({ response: { edit: EDIT }, patchResult: () => new Promise(resolve => { finish = resolve; }) });
    await h.submit(); h.el('feedback-sent-edit').click(); h.el('feedback-edit-save').click(); await settle();
    h.el('feedback-cancel').click();
    if (differentUser) h.sandbox.App.user = { id: 8 };
    h.sandbox.App.openFeedbackModal();
    h.el('feedback-text').value = 'New draft';
    finish({ status: 200, body: { edit: { ...EDIT, version: 1 } } }); await settle();
    assert.equal(h.el('feedback-text').value, 'New draft');
    assert.equal(h.el('feedback-sent').classList.contains('hidden'), true);
    assert.equal(h.toasts.length, 0);
  }
});

test('the editor countdown follows elapsed time and does not reset after Cancel', async () => {
  const h = harness({ response: { edit: EDIT } }); await h.submit();
  h.el('feedback-sent-edit').click();
  h.advance(61000); await h.fireIntervals(1000);
  assert.match(h.el('feedback-edit-window').textContent, /4 more minutes/);
  h.el('feedback-edit-cancel').click();
  h.advance(240000); await h.fireTimers(239000);
  assert.equal(h.el('feedback-sent-edit').classList.contains('hidden'), true);
});
