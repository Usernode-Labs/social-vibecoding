// The Send Feedback dialog's offline behaviour, as wiring (#1054).
//
// The dialog's markup is a static React component and ALL of its behaviour is
// in public/js/app.js (frontend/src/features/dialogs/feedback.tsx's header
// comment explains why it must stay there: PlatformUI.adoptStaticModal lifts
// the card out of its root, so the subtree cannot be React-owned). There is no
// DOM harness for that file, so this test pins the seams as source text —
// which is exactly what the regression was: one `catch` that wrote "Network
// error" and dropped the message.
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
const queueJs = read('public', 'js', 'feedback-queue.js');
const indexHtml = read('public', 'index.html');
const shellTsx = read('frontend', 'src', 'Shell.tsx');
const headerTsx = read('frontend', 'src', 'features', 'header', 'platform-header.tsx');
const swJs = read('public', 'sw.js');
const dapp = JSON.parse(read('dapp.json'));

// The submit path, from `const submitFeedback` to the handler that follows it.
const submitFeedback = appJs.slice(
  appJs.indexOf('const submitFeedback = async () =>'),
  appJs.indexOf('App.openFeedbackModal = (opts'),
);
const openModal = appJs.slice(
  appJs.indexOf('App.openFeedbackModal = (opts'),
  appJs.indexOf("document.getElementById('feedback-btn').addEventListener"),
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
  assert.match(appJs, /const isOfflineNow = \(\) => \{\s*\n\s*try \{ return !!\(window\.Offline && window\.Offline\.isOffline/);
  assert.doesNotMatch(submitFeedback, /navigator\.onLine/);
});

test('the saved confirmation reads as success, and consumes the draft', () => {
  const saveForLater = appJs.slice(
    appJs.indexOf('const saveForLater = async (body)'),
    appJs.indexOf('// Keep the dialog honest while it is open'),
  );
  assert.match(saveForLater, /Saved on this device — we'll send it as soon as you're back online\./);
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
  assert.match(appJs, /const queueRefusal = \(code\) => \{/);
  for (const code of ['duplicate', 'full', 'too-large']) {
    assert.match(appJs, new RegExp(`code === '${code}'`), `no sentence for the '${code}' refusal`);
  }
});

test('the dialog states the offline situation on open, in the words dapp.json checks', () => {
  assert.match(openModal, /refreshQueueState\(\);/);
  // dapp.json /?shot=feedback-offline matches this sentence.
  assert.match(appJs, /saved on this device and sent automatically/);
  // dapp.json /?shot=feedback-queued matches this one (singular form).
  assert.match(appJs, /1 message saved on this device is waiting to send/);
  // The button says what it will do.
  assert.match(appJs, /feedbackBtn\.textContent = isOfflineNow\(\) \? 'Save for later' : 'Submit'/);
});

test('the dialog repaints when connectivity changes under it', () => {
  // The probe re-runs every 15s, so the state described on open can be stale
  // by the time someone finishes typing.
  const listener = appJs.slice(appJs.indexOf("window.addEventListener('usernode:offline-change', () => {"));
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
  const uploadCatch = appJs.slice(
    appJs.indexOf("screenshotState.textContent = 'Uploading…';"),
    appJs.indexOf("screenshotRemove.addEventListener('click'"),
  );
  const networkCatch = uploadCatch.slice(uploadCatch.indexOf('} catch {'));
  assert.doesNotMatch(networkCatch, /resetScreenshotState\(\)/, 'the blob must be kept for the outbox');
  assert.match(networkCatch, /Saved with your feedback — it'll upload when you're back online/);
  assert.match(appJs, /let screenshotBlob = null;/);
  // Cleared with the rest of the attachment state, and re-uploaded before an
  // online submit so the promise on screen stays true.
  assert.match(appJs, /screenshotBlob = null;\n\s+if \(screenshotObjectUrl\)/);
  assert.match(submitFeedback, /if \(!screenshotId && screenshotBlob && !isOfflineNow\(\)\)/);
});

test('the outbox is armed once, and flushed when a session exists', () => {
  assert.match(appJs, /window\.FeedbackQueue\.init\(\{/);
  assert.match(appJs, /onFlushed: \(res\) => \{/);
  // A flush that filed something says so — the user wrote it long ago.
  assert.match(appJs, /Your saved feedback has been sent\./);
  // And the Dev screen's Open Issues panel refreshes, exactly as a live
  // submit refreshes it.
  const flushed = appJs.slice(appJs.indexOf('onFlushed: (res) => {'), appJs.indexOf('const submitFeedback'));
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
  assert.match(appJs, /let queueReadSeq = 0;/);
  const read = appJs.slice(appJs.indexOf('const readQueueCount = () =>'));
  assert.match(read.slice(0, 500), /const seq = \+\+queueReadSeq;/);
  assert.match(read.slice(0, 500), /if \(seq !== queueReadSeq\) return null;/);
  // A just-saved message is the freshest fact there is, so it invalidates
  // anything in flight rather than racing it.
  assert.match(appJs, /queueReadSeq \+= 1;\n\s+queuePendingCount \+= 1;/);
  // And only one place reads the count, so a later call site can't reintroduce
  // the unsequenced version.
  assert.equal(appJs.match(/FeedbackQueue\.count\(\)/g).length, 1);
});

test('the queued shot seeds the store before it pins connectivity', () => {
  // Order matters: forceOffline() dispatches usernode:offline-change, whose
  // handler reads the count — it must see the seeded queue, not the device's.
  const shot = appJs.slice(appJs.indexOf('_applyFeedbackShot() {'), appJs.indexOf('renderAdminButton() {'));
  assert.ok(
    shot.indexOf('seedDisplayOnly?.(') < shot.indexOf('window.Offline?.forceOffline()'),
    'seed first, then pin — otherwise the offline-change read races the seed',
  );
});

test('the header dot is markup, hidden, and toggled from the store', () => {
  assert.match(headerTsx, /id="feedback-queue-dot"/);
  assert.match(headerTsx, /<button id="feedback-btn" className="relative /, 'the dot is positioned against the button');
  const dot = headerTsx.slice(headerTsx.indexOf('id="feedback-queue-dot"'));
  assert.match(dot.slice(0, 200), /className="hidden absolute/, 'ships hidden: an island renders empty/hidden markup');
  // The generated document carries it too (build:shell was run).
  assert.match(indexHtml, /id="feedback-queue-dot"/);
  assert.match(appJs, /const dot = document\.getElementById\('feedback-queue-dot'\);/);
});

test('the queue module loads before app.js and is precached', () => {
  assert.match(shellTsx, /<script src="\/js\/feedback-queue\.js" \/>/);
  const order = [
    indexHtml.indexOf('/js/feedback-queue.js'),
    indexHtml.lastIndexOf('/js/app.js'),
  ];
  assert.ok(order[0] > 0, 'the generated document loads the module');
  assert.ok(order[0] < order[1], 'app.js calls FeedbackQueue.init(), so it must load second');
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
      appJs.includes(check.expectText),
      `dapp.json expects "${check.expectText}" but no such string is in app.js`,
    );
  }
});
