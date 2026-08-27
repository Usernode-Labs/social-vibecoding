// The Send Feedback dialog's offline behaviour, as wiring (#1054).
//
// This behaviour was an 800-line block inside `App.bindEvents`. #1078 chunk I
// moved it, unchanged, to frontend/src/features/dialogs/feedback-controller.js,
// which the dialog's island `init()`s from its layout effect — a move, not a
// rewrite, for the reason that component's header gives: the interlocking
// imperative state here (the title-generation sequence counter, the in-flight
// screenshot that survives a failed POST, the sequenced queue-count reads) is
// exactly what #556, #683 and this issue fixed, and re-expressing it as
// `useState` would be re-deriving those fixes. So the assertions below moved
// file but not shape. There is no DOM harness for either file, so this test
// pins the seams as source text — which is exactly what the regression was:
// one `catch` that wrote "Network error" and dropped the message.
//
// What stayed in app.js: `App._applyFeedbackShot` (a method on App, called
// from enterAuthed) and the boot-time `FeedbackQueue.flush('signin')`.
//
// Text assertions here are not decoration: the two dapp.json checks match on
// these sentences, so a reword that breaks them fails here, next to the code,
// instead of in a proposal check.
//
// Run with: node --test tests/feedback-offline-ui.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const appJs = read('public', 'js', 'app.js');
const feedbackJs = read('frontend', 'src', 'features', 'dialogs', 'feedback-controller.js');
const queueJs = read('public', 'js', 'feedback-queue.js');
const indexHtml = read('public', 'index.html');
const shellTsx = read('frontend', 'src', 'Shell.tsx');
const headerTsx = read('frontend', 'src', 'features', 'header', 'platform-header.tsx');
const improveBtnTsx = read('frontend', 'src', 'features', 'improve', 'improve-button.tsx');
const swJs = read('public', 'sw.js');
const dapp = JSON.parse(read('dapp.json'));

// The submit path, from `const submitFeedback` to the open path that follows.
const submitFeedback = feedbackJs.slice(
  feedbackJs.indexOf('const submitFeedback = async () =>'),
  feedbackJs.indexOf('Feedback._open = (opts'),
);
// `App.openFeedbackModal` is two halves now: a one-line entry point that asks
// the island to open, and this — everything it did once the modal was up,
// which the island calls back as its `onOpen`.
const openModal = feedbackJs.slice(
  feedbackJs.indexOf('Feedback._open = (opts'),
  feedbackJs.indexOf("document.getElementById('feedback-btn').addEventListener"),
);

test('a failed submit is saved, not discarded', () => {
  assert.ok(submitFeedback.length > 500, 'located the submit path');
  // The fix itself: the transport failure now routes into the outbox.
  assert.match(submitFeedback, /if \(await saveForLater\(body\)\) return;/);
  // ...and the POST is wrapped narrowly, so a parseable-but-broken RESPONSE
  // can't be mistaken for "never sent" and filed twice.
  assert.ok(
    submitFeedback.indexOf('let res;') < submitFeedback.indexOf("await fetch('/api/feedback'"),
    'the POST has its own try/catch rather than sharing the outer one',
  );
});

test('a known-offline submit never spends a doomed round trip', () => {
  assert.match(submitFeedback, /if \(isOfflineNow\(\)\) \{\n\s+if \(await saveForLater\(body\)\) return;/);
  // Connectivity comes from the /health probe (window.Offline), never
  // navigator.onLine — the same rule the rest of the shell follows.
  assert.match(feedbackJs, /const isOfflineNow = \(\) => \{\s*\n\s*try \{ return !!\(window\.Offline && window\.Offline\.isOffline/);
  assert.doesNotMatch(submitFeedback, /navigator\.onLine/);
});

test('the saved confirmation reads as success, and consumes the draft', () => {
  const saveForLater = feedbackJs.slice(
    feedbackJs.indexOf('const saveForLater = async (body)'),
    feedbackJs.indexOf('// Keep the dialog honest while it is open'),
  );
  assert.match(saveForLater, /Saved on this device. We'll send it as soon as you're back online\./);
  assert.match(saveForLater, /text-emerald-400/, 'the same green a filed issue gets');
  // Same cleanup as a successful submit: the draft is gone, the dialog locks
  // and closes on the shared 1500 ms grace window.
  assert.match(saveForLater, /feedbackText\.value = '';/);
  assert.match(saveForLater, /resetScreenshotState\(\);/);
  assert.match(saveForLater, /feedback-cancel'\)\.click\(\), 1500/);
  // And a probe, so a connection that quietly returned sends it in seconds.
  assert.match(saveForLater, /window\.Offline\?\.nudge\?\.\(\)/);
});

test('a refused save is explained instead of silently dropped', () => {
  assert.match(feedbackJs, /const queueRefusal = \(code\) => \{/);
  for (const code of ['duplicate', 'full', 'too-large']) {
    assert.match(feedbackJs, new RegExp(`code === '${code}'`), `no sentence for the '${code}' refusal`);
  }
});

test('the dialog states the offline situation on open, in the words dapp.json checks', () => {
  assert.match(openModal, /refreshQueueState\(\);/);
  // dapp.json /?shot=feedback-offline matches this sentence.
  assert.match(feedbackJs, /saved on this device and sent automatically/);
  // dapp.json /?shot=feedback-queued matches this one (singular form).
  assert.match(feedbackJs, /1 message saved on this device is waiting to send/);
  // The button says what it will do.
  assert.match(feedbackJs, /feedbackBtn\.textContent = isOfflineNow\(\) \? 'Save for later' : 'Submit'/);
});

test('the dialog repaints when connectivity changes under it', () => {
  // The probe re-runs every 15s, so the state described on open can be stale
  // by the time someone finishes typing.
  const listener = feedbackJs.slice(feedbackJs.indexOf("window.addEventListener('usernode:offline-change', () => {"));
  assert.match(listener.slice(0, 400), /refreshQueueState\(\)/);
});

test('a permanently-refused message is handed back with the words intact', () => {
  assert.match(openModal, /FeedbackQueue\.takeFailed\(\)/);
  assert.match(openModal, /feedbackText\.value = p\.description \|\| '';/);
  assert.match(openModal, /This message couldn't be sent/);
  // Live text always wins — a returned draft must not overwrite typing.
  assert.match(openModal, /if \(feedbackText\.disabled \|\| feedbackText\.value\.trim\(\)\) return;/);
});

test('a captured screenshot survives a failed upload', () => {
  // The bug: resetScreenshotState() on a network failure threw the capture
  // away at the exact moment it could not be re-taken cheaply.
  const uploadCatch = feedbackJs.slice(
    feedbackJs.indexOf("screenshotState.textContent = 'Uploading…';"),
    feedbackJs.indexOf("screenshotRemove.addEventListener('click'"),
  );
  const networkCatch = uploadCatch.slice(uploadCatch.indexOf('} catch {'));
  assert.doesNotMatch(networkCatch, /resetScreenshotState\(\)/, 'the blob must be kept for the outbox');
  assert.match(networkCatch, /Saved with your feedback. It'll upload when you're back online/);
  assert.match(feedbackJs, /let screenshotBlob = null;/);
  // Cleared with the rest of the attachment state, and re-uploaded before an
  // online submit so the promise on screen stays true.
  assert.match(feedbackJs, /screenshotBlob = null;\n\s+if \(screenshotObjectUrl\)/);
  assert.match(submitFeedback, /if \(!screenshotId && screenshotBlob && !isOfflineNow\(\)\)/);
});

test('the outbox is armed once, and flushed when a session exists', () => {
  assert.match(feedbackJs, /window\.FeedbackQueue\.init\(\{/);
  assert.match(feedbackJs, /onFlushed: \(res\) => \{/);
  // A flush that filed something says so — the user wrote it long ago.
  assert.match(feedbackJs, /Your saved feedback has been sent\./);
  // And the Dev screen's Open Issues panel refreshes, exactly as a live
  // submit refreshes it.
  const flushed = feedbackJs.slice(feedbackJs.indexOf('onFlushed: (res) => {'), feedbackJs.indexOf('const submitFeedback'));
  assert.match(flushed, /AppView\.refreshDevData\('issue'\)/);
  // /api/feedback is session-gated, so the boot flush waits for enterAuthed.
  assert.match(appJs, /if \(window\.FeedbackQueue\) FeedbackQueue\.flush\('signin'\);/);
});

test('a stale count read cannot paint over a newer one', () => {
  // count() is async and three things ask for one — the dialog opening, a
  // connectivity change, and the store's change notifications. They resolve
  // out of order: the dot vanished from ?shot=feedback-queued because the
  // offline-change read (empty store, slow IndexedDB open) landed after the
  // seeded one. Every read is sequenced, and only the newest may paint.
  assert.match(feedbackJs, /let queueReadSeq = 0;/);
  const read = feedbackJs.slice(feedbackJs.indexOf('const readQueueCount = () =>'));
  assert.match(read.slice(0, 500), /const seq = \+\+queueReadSeq;/);
  assert.match(read.slice(0, 500), /if \(seq !== queueReadSeq\) return null;/);
  // A just-saved message is the freshest fact there is, so it invalidates
  // anything in flight rather than racing it.
  assert.match(feedbackJs, /queueReadSeq \+= 1;\n\s+queuePendingCount \+= 1;/);
  // And only one place reads the count, so a later call site can't reintroduce
  // the unsequenced version.
  assert.equal(feedbackJs.match(/FeedbackQueue\.count\(\)/g).length, 1);
});

test('the queued shot seeds the store before it pins connectivity', () => {
  // Order matters: forceOffline() dispatches usernode:offline-change, whose
  // handler reads the count — it must see the seeded queue, not the device's.
  const shot = appJs.slice(appJs.indexOf('_applyFeedbackShot() {'), appJs.indexOf('renderAdminButton() {'));
  assert.ok(
    shot.indexOf('seedDisplayOnly?.(') < shot.indexOf('window.Offline?.forceOffline()'),
    'seed first, then pin — otherwise the offline-change read races the seed',
  );
  assert.ok(
    shot.indexOf('seedDisplayOnly?.(') < shot.indexOf('setTimeout(() =>'),
    'the display-only store must be installed before enterAuthed starts the sign-in flush',
  );
  assert.ok(
    shot.indexOf('window.Offline?.forceOffline()') < shot.indexOf('setTimeout(() =>'),
    'the offline body state is address state, not delayed modal presentation',
  );
});

test('the header dot is markup, hidden, and toggled from the store', () => {
  // THE UI OVERHAUL retired #feedback-btn: the dialog opens from the Improve
  // panel now. The dot moved onto #improve-btn rather than going with it,
  // because that button is the only remaining way to reach the dialog from the
  // header — an unsent draft with no visible cue is exactly what it exists to
  // prevent. Same id, same writer, same publish seam; new host component.
  assert.match(improveBtnTsx, /id="feedback-queue-dot"/);
  assert.match(improveBtnTsx, /const IMPROVE_BTN_CLASS =\n  'relative /,
    'the dot is positioned against the button');
  const dot = improveBtnTsx.slice(improveBtnTsx.indexOf('id="feedback-queue-dot"'));
  assert.match(dot.slice(0, 200), /className="hidden absolute/,
    'ships hidden: an island renders empty/hidden markup');
  assert.doesNotMatch(headerTsx, /id="feedback-queue-dot"/,
    'exactly one host for the dot — it did not get left behind in the header');
  // The generated document carries it too (build:shell was run).
  assert.match(indexHtml, /id="feedback-queue-dot"/);
});

test('the dot travels through the visibility store, not a classList write', () => {
  // The dot lives inside the React header island. A classList toggle by id
  // that lands before the header's hydration commit is a mismatch React 19
  // patches back to the constant className — the dot un-paints and, with
  // connectivity pinned by ?shot=feedback-queued, nothing ever repaints it.
  // So the writer publishes and the header subscribes (mount-time apply
  // covers a publish that happened first). Same seam as the offline banner.
  assert.match(feedbackJs, /publishVisibility\('feedback-queue-dot', n > 0\)/);
  assert.doesNotMatch(feedbackJs, /getElementById\('feedback-queue-dot'\)/,
    'no direct DOM write may sneak back in beside the publish');
  assert.match(improveBtnTsx, /useVisibilityHiddenClass\(dotRef, 'feedback-queue-dot', false\)/);
  assert.match(improveBtnTsx, /ref=\{dotRef\}\n\s+id="feedback-queue-dot"/);
});

test('the queue module loads before app.js and is precached', () => {
  assert.match(shellTsx, /<script src="\/js\/feedback-queue\.js" \/>/);
  const order = [
    indexHtml.indexOf('/js/feedback-queue.js'),
    indexHtml.lastIndexOf('/js/app.js'),
  ];
  assert.ok(order[0] > 0, 'the generated document loads the module');
  // The controller reads `window.FeedbackQueue` from its init(), which the
  // island calls from a layout effect — i.e. after every classic script — so
  // the module only has to be a shell tag. It stays ahead of app.js anyway:
  // that is the order the document has always had, and app.js's own
  // `FeedbackQueue.flush('signin')` at sign-in still depends on it.
  assert.ok(order[0] < order[1], 'the queue module loads before app.js');
  // The whole point is working on the load where the network does not.
  assert.match(swJs, /'\/js\/feedback-queue\.js',/);
});

test('the module keeps its Node-testable export guard and touches no window at load', () => {
  assert.match(queueJs, /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = FeedbackQueue;/);
  assert.match(queueJs, /if \(hasWindow\) window\.FeedbackQueue = FeedbackQueue;/);
});

test('the two screenshot deep links exist and are display-only', () => {
  // The method body, not its call site in enterAuthed.
  const shot = appJs.slice(appJs.indexOf('_applyFeedbackShot() {'), appJs.indexOf('renderAdminButton() {'));
  assert.ok(shot.length > 200, 'located _applyFeedbackShot');
  assert.match(shot, /shot !== 'feedback-offline' && shot !== 'feedback-queued'/);
  assert.match(shot, /window\.Offline\?\.forceOffline\(\)/, 'the offline state has to be pinned to be photographable');
  assert.match(shot, /seedDisplayOnly/);
  // seedDisplayOnly swaps in the in-memory adapter AND disables flushing, so
  // a screenshot link can neither write to the device nor file an issue.
  assert.match(queueJs, /seedDisplayOnly\(entries\) \{/);
  const seed = queueJs.slice(queueJs.indexOf('seedDisplayOnly(entries) {'));
  assert.match(seed.slice(0, 900), /flushDisabled = true;/);

  const paths = dapp.tests.map((t) => t.path);
  assert.ok(paths.includes('/?shot=feedback-offline'), 'dapp.json checks the offline dialog');
  assert.ok(paths.includes('/?shot=feedback-queued'), 'dapp.json checks the queued state');
  for (const check of dapp.tests.filter((t) => String(t.path).startsWith('/?shot=feedback-'))) {
    if (!check.expectText) continue;
    assert.ok(
      feedbackJs.includes(check.expectText),
      `dapp.json expects "${check.expectText}" but no such string is in feedback-controller.js`,
    );
  }
});

test('the failed-capture deep link is reviewable and display-only (#1284)', () => {
  const shot = appJs.slice(appJs.indexOf('_applyFeedbackShot() {'), appJs.indexOf('renderAdminButton() {'));
  assert.match(shot, /shot !== 'feedback-capture-failed'/, 'the new state joins the same guard');
  assert.match(shot, /const captureFailed = shot === 'feedback-capture-failed'/);
  // Seeded words, then the controller's REAL capture round trip with a
  // capture that throws the way the native bridge does — so the photograph
  // shows the shipping notice and the retained draft, not a mock of them.
  assert.match(shot, /The board scrolls back to the top when I drag a card\./);
  assert.match(shot, /App\._simulateFeedbackCaptureFailure\?\.\(\)/);
  // Display-only: nothing typed (an input event would start the title LLM),
  // no bridge call, and the stash skips ?shot= routes so a synthetic draft
  // cannot follow the reviewer into a real session.
  assert.ok(!shot.includes("dispatchEvent(new Event('input'"),
    'the seeded description is assigned, not typed');
  const inject = feedbackJs.slice(feedbackJs.indexOf('App._simulateFeedbackCaptureFailure'));
  assert.match(inject, /err\.code = 'capture_failed'/);
  assert.ok(!/usernode\.captureScreenshot/.test(inject), 'the injected failure calls no bridge');

  const paths = dapp.tests.map((t) => t.path);
  assert.equal(paths.filter((p) => p === '/?shot=feedback-capture-failed').length, 2,
    'both the notice and the still-usable Submit are checked');
  const checks = dapp.tests.filter((t) => t.path === '/?shot=feedback-capture-failed');
  // The dialog is still THERE — that is the whole bug — with its status line
  // showing and Submit ready to send the words that survived. Both selectors
  // reach the card through `body:has(...)` rather than through the root,
  // because the kit lifts the card OUT of #feedback-modal when it presents
  // it — the same reason the offline checks above key off `body.is-offline`.
  for (const check of checks) {
    assert.match(check.expectSelector, /^body:has\(#feedback-modal:not\(\.hidden\)\) /,
      'the card is not a descendant of the root once the kit has adopted it');
  }
  assert.ok(checks.some((c) => /#feedback-status:not\(\.hidden\)$/.test(c.expectSelector)));
  assert.ok(checks.some((c) => /#feedback-submit:not\(:disabled\)$/.test(c.expectSelector)));
  assert.ok(checks.some((c) => c.expectText === 'your feedback is safe'));
});
