// What the nine dialogs DO, now that they own it (#1078 chunk I).
//
// tests/dialog-components.test.js pins the shape of the seam — who renders
// which root, what may and may not appear on it. This file pins the
// behaviour that moved off app.js / app-view.js / app-secrets.js and into the
// islands: each dialog's open, submit and dismiss path, and the two pieces of
// shared machinery they all run through (frontend/src/lib/static-modal.ts and
// features/dialogs/use-dialog.ts).
//
// #1120 slice 3 split the lift itself out of static-modal.ts into
// frontend/src/lib/kit-surface.ts, which the dev console, the hamburger drawer
// and the work drawer now share. The contracts below did not change; the ones
// about the MECHANICS of the lift (the adopted class, the placeholder, the
// rollback) are read from that module, and the ones about what is specific to
// the dialogs (which node is taken, what gate it runs on, the order the open
// branch does things in) stay read from static-modal.ts.
//
// These are source-level assertions on stable tokens, like every other UI test
// in this suite: `npm test` runs with no frontend/node_modules — the root
// install never touches that workspace — so there is no React here to render
// with and no DOM to render into. The runtime half of the verification is the
// dapp.json tests plus the browser pass this chunk's commit describes; what
// source assertions are actually good at is catching a behaviour that silently
// went missing in the move, which is the failure mode of a 3,000-line
// relocation.
//
// Run with: node --test tests/dialog-behaviour.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dialog = (f) => read(`frontend/src/features/dialogs/${f}`);

const STATIC_MODAL = read('frontend/src/lib/static-modal.ts');
const KIT_SURFACE = read('frontend/src/lib/kit-surface.ts');
const USE_DIALOG = dialog('use-dialog.ts');
const APP = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');

// ── the seam: static-modal.ts, over the lift in kit-surface.ts ───────────

test('the lift reproduces what adoptStaticModal did, in the same order', () => {
  // Open: stamp the gesture guard, reveal, THEN present. The stamp has to
  // precede the reveal because the guard window is measured from it, and the
  // reveal has to precede the present because the kit measures the card's
  // computed max-width to size its shell — a hidden card measures zero.
  const branch = STATIC_MODAL.slice(
    STATIC_MODAL.indexOf('if (open) {'),
    STATIC_MODAL.indexOf('} else {', STATIC_MODAL.indexOf('if (open) {')),
  );
  assert.ok(branch, 'the open branch of the layout effect should be findable');
  const stamp = branch.indexOf('dataset.openedAt');
  const reveal = branch.indexOf("classList.remove('hidden')");
  const lift = branch.indexOf('present(root');
  assert.ok(stamp >= 0 && reveal >= 0 && lift >= 0, `open branch is missing a step: ${branch}`);
  assert.ok(stamp < reveal, 'the opening gesture is stamped before the reveal — the guard window runs from it');
  assert.ok(reveal < lift, 'the root is revealed before the card is handed to the kit');
  // What the dialogs ask the shared lift for. `adoptedOn` is the whole reason
  // the dialogs are the odd one out: the kit takes the CARD, but the class
  // belongs on the ROOT, which is what app.css keys the legacy scrim off.
  const call = STATIC_MODAL.slice(
    STATIC_MODAL.indexOf('adoptKitSurface({'),
    STATIC_MODAL.indexOf('});', STATIC_MODAL.indexOf('adoptKitSurface({')),
  );
  assert.match(call, /kind: 'modal'/);
  assert.match(call, /contentEl: card/, 'the kit takes the card, not the whole root');
  assert.match(call, /adoptedOn: root/, 'platform-modal-adopted goes on the root');
  assert.match(call, /hugDesignWidth: true/,
    'the kit shell is still sized from the card’s computed max-width');
  // The three things the old adopter wrote, all still written — by the shared
  // lift now, which is where the other three surfaces get them from too.
  assert.match(KIT_SURFACE, /`platform-\$\{options\.kind\}-adopted`/);
  assert.match(KIT_SURFACE, /classList\.add\('platform-modal-card'\)/);
  assert.match(KIT_SURFACE, /maxWidth/, 'the kit shell is still sized from the card’s computed max-width');
  // …and the max-width has to be read BEFORE platform-modal-card lands, since
  // that class is what strips it.
  assert.ok(KIT_SURFACE.indexOf('const designWidth') < KIT_SURFACE.indexOf("classList.add('platform-modal-card')"),
    'the design width must be measured before the card is neutralized');
});

test('the lift is reversible: the card goes home before the root re-hides', () => {
  // adoptStaticModal left a comment placeholder where the card had been and
  // put it back on dismiss. React's reconciler assumes the children it
  // rendered are still where it left them, so a lift that did not restore
  // would break the NEXT render of the dialog, not this one.
  assert.match(STATIC_MODAL, /home: 'placeholder'/,
    "the card goes back to its own backdrop, not to <body> like the drawers' panels");
  assert.match(KIT_SURFACE, /createComment\(/, 'a placeholder marks where the card belongs');
  assert.match(KIT_SURFACE, /replaceChild\(contentEl, placeholder\)/,
    'restore puts the card back at its original position');
  assert.match(KIT_SURFACE, /flagEl\.classList\.remove\(adoptedClass\)/);
  // The restore has to be idempotent, because both the close path and the
  // kit's own onDismiss run it — and it must be reachable without telling the
  // kit anything, which is what separates it from dismiss().
  assert.match(KIT_SURFACE, /if \(undone\) return;/);
  assert.match(KIT_SURFACE, /restore: undo/);
  assert.match(STATIC_MODAL, /adoption\.restore\(\);\n\s*adoption\.dismiss\(\);/,
    'the card comes home BEFORE the kit is told, or the exit animation runs over an empty shell');
});

test('the guard window is the one app-view.js used, and is read by useDialog', () => {
  // AppView.revealModal stamped and AppView.modalDismissGuarded checked; both
  // still exist for the surfaces that are not dialogs (settings, the compare
  // overlay), so the constant must not drift between the two copies.
  assert.match(STATIC_MODAL, /MODAL_GESTURE_GUARD_MS = 450/);
  assert.match(APP_VIEW, /MODAL_GESTURE_GUARD_MS: 450/,
    'app-view.js still owns the guard for the non-dialog modals — keep the two in step');
  assert.match(USE_DIALOG, /if \(isDismissGuarded\(rootRef\.current\)\) return;/);
});

test('an external `hidden` write is reported to React, not acted on', () => {
  // "It reports, React decides": the observer exists because a public/js/**
  // straggler could still toggle the class. If the observer closed the dialog
  // itself, the hook's own writes would feed back into it.
  assert.match(STATIC_MODAL, /MutationObserver/);
  assert.match(STATIC_MODAL, /attributeFilter: \['class'\]/);
  assert.match(STATIC_MODAL, /nowOpen !== open/, 'only a DISAGREEMENT with React state is reported');
  assert.match(USE_DIALOG, /onExternalToggle: \(nowOpen\) => setIsOpen\(nowOpen\)/);
});

test('presentation is gated on kit presence, never on isTouch()', () => {
  // The retired adopter ran adoptAll() whenever a kit was present, desktop
  // included. Routing on isTouch() here would silently restyle every dialog on
  // desktop, which "zero visual change" forbids.
  assert.match(STATIC_MODAL, /gate: 'kit'/);
  // The header explains the decision at length, so check the CODE lines only.
  const code = STATIC_MODAL.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!code.some((l) => l.includes('isTouch')),
    'static-modal.ts must not branch on isTouch() — see the header');
  assert.ok(!code.some((l) => l.includes("gate: 'touch'")),
    "static-modal.ts must not take the drawers' touch gate — see the header");
  // And that is what `gate: 'kit'` means in the shared lift: kit presence,
  // desktop included. The touch gate is the OTHER branch.
  const gate = KIT_SURFACE.slice(
    KIT_SURFACE.indexOf("if (options.gate === 'kit')"),
    KIT_SURFACE.indexOf('const presentFn'),
  );
  assert.match(gate, /ui\.hasKit\(\)/);
  assert.match(gate, /ui\.isTouch\(\)/);
});

// ── the shared lifecycle: use-dialog.ts ──────────────────────────────────

test('open/close run the island’s populate and reset halves', () => {
  assert.match(USE_DIALOG, /if \(isOpen\) opts\.current\.onOpen\?\.\(payloadRef\.current\);/);
  assert.match(USE_DIALOG, /else opts\.current\.onClose\?\.\(\);/);
  // Not on mount: the prerendered document is already hidden, so a mount-time
  // onClose would reset fields the user could not have filled yet — and, for
  // the controller-backed dialogs, would call into a module that has not run
  // its init() yet.
  assert.match(USE_DIALOG, /if \(!mounted\.current\)/);
  // Layout, so populate lands in the same frame as the reveal.
  assert.match(USE_DIALOG, /useIsomorphicLayoutEffect\(\(\) => \{\n\s*if \(!mounted\.current\)/);
});

test('suspend/resume move the dialog without running the lifecycle', () => {
  // The feedback screenshot capture's round trip. If this regressed to
  // close()/open(), taking a screenshot would wipe the draft it is being
  // attached to — the bug the flag exists to prevent.
  assert.match(USE_DIALOG, /const bookkeeping = useRef\(false\)/);
  assert.match(USE_DIALOG, /const suspend = useCallback\(\(\) => \{\n\s*bookkeeping\.current = true;\n\s*setIsOpen\(false\);/);
  assert.match(USE_DIALOG, /const resume = useCallback\(\(\) => \{\n\s*bookkeeping\.current = true;\n\s*setIsOpen\(true\);/);
  // Consumed by exactly one effect pass, so an ordinary open or close on
  // either side of the round trip still runs its half.
  assert.match(USE_DIALOG, /if \(bookkeeping\.current\) \{\n\s*bookkeeping\.current = false;\n\s*return;\n\s*\}/);
  const feedback = dialog('feedback-controller.js');
  assert.match(feedback, /function suspendDialog\(\)/);
  assert.match(feedback, /function resumeDialog\(\)/);
  assert.ok(!/modal\.classList\.(add|remove)\('hidden'\)/.test(feedback),
    'the screenshot path must not write `hidden` on the root itself any more');
});

test('canClose can veto a dismiss, and import-pr uses it', () => {
  assert.match(USE_DIALOG, /if \(opts\.current\.canClose && !opts\.current\.canClose\(\)\) return;/);
  assert.match(dialog('import-pr.tsx'), /canClose: \(\) => !busyRef\.current/);
});

test('the backdrop dismiss rule matches the handlers it replaced', () => {
  // Every bindEvents handler spelled out the same three conditions: the click
  // must be on the root or on [data-modal-backdrop], and must not land inside
  // the opening gesture's ghost-click window.
  assert.match(USE_DIALOG, /target === event\.currentTarget \|\|\s*target\.dataset\?\.modalBackdrop !== undefined/);
  assert.match(USE_DIALOG, /if \(!isBackdrop\) return;/);
});

test('the controller is published by name and withdrawn on unmount', () => {
  assert.match(USE_DIALOG, /dialogs\[name\] = controller/);
  assert.match(USE_DIALOG, /if \(dialogs\[name\] === controller\) delete dialogs\[name\]/);
  // isOpen() reads the DOM rather than the state, because its callers are
  // legacy modules that ask mid-gesture.
  assert.match(USE_DIALOG, /isOpen: \(\) => !!rootRef\.current && !rootRef\.current\.classList\.contains\('hidden'\)/);
});

// ── each dialog's own behaviour ──────────────────────────────────────────

test('create: mode, import check and POST /api/apps all moved', () => {
  const src = dialog('create-app.tsx');
  assert.match(src, /applyMode\('new'\)/);
  assert.match(src, /\/api\/github\/verify-access\?url=/, 'the import URL check moved with it');
  assert.match(src, /fetch\('\/api\/apps', \{/, 'the create POST moved with it');
  // Close resets the form, so a half-finished import is never inherited.
  assert.match(src, /formRef\.current\?\.reset\(\)/);
  // The home screen's "+" still opens it by name.
  assert.match(APP, /window\.UsernodeReact\?\.dialogs\?\.create\?\.open\(\)/);
});

test('rename: prefills the current name and PUTs to /rename', () => {
  const src = dialog('rename-app.tsx');
  assert.match(src, /window\.AppView\?\.appData\?\.name/);
  assert.match(src, /\/rename`/);
  assert.match(src, /inputRef\.current\?\.select\(\)/, 'the prefilled name is selected, as promptRename did');
  // AppView.applyRename stays put: it is the websocket handler's, not the
  // dialog's.
  assert.match(APP_VIEW, /applyRename/);
});

test('fork: takes its source from the open payload, POSTs to /fork', () => {
  const src = dialog('fork-app.tsx');
  assert.match(src, /useDialog<ForkSource>\('fork'/);
  assert.match(src, /\(fork\)`/, 'the "<name> (fork)" default is still suggested');
  assert.match(src, /\/fork`/);
  // _forkSource was a field on AppView; the payload replaces it. (The name
  // survives in app-view.js only in the comment that records the move.)
  assert.ok(!/^\s*_forkSource:/m.test(APP_VIEW),
    'AppView._forkSource should be gone — the open payload carries the source now');
  assert.ok(!/AppView\._forkSource\s*=/.test(APP_VIEW));
});

test('close-issue: takes the issue number as payload and POSTs a close', () => {
  const src = dialog('close-issue.tsx');
  assert.match(src, /useDialog<number \| string>\('closeIssue'/);
  assert.match(src, /\/issues`/);
  assert.match(src, /reasonRef\.current\.value = ''/, 'the reason field is cleared on both open and close');
});

test('import-pr: loads candidates on open, imports the selected one', () => {
  const src = dialog('import-pr.tsx');
  assert.match(src, /\/pr-import\/candidates`/);
  assert.match(src, /\/pr-import`/);
  assert.match(src, /void loadCandidates\(\)/, 'candidates load on open, not at mount');
  // The list only exists while open, which is what keeps a controlled radio
  // out of the prerendered document.
  assert.match(src, /!dialog\.isOpen \? null/);
});

test('share: fills the URL through resolveDevHost and flashes the copy button', () => {
  const src = dialog('share.tsx');
  assert.match(src, /window\.resolveDevHost/);
  assert.match(src, /navigator\.clipboard\?\.writeText/);
  assert.match(src, /document\.execCommand\('copy'\)/, 'the non-clipboard fallback moved too');
  assert.match(src, /setCopyLabel\('Copied!'\)|setCopyLabel\(ok \? 'Copied!'/);
});

test('members: the island owns the lifecycle, the controller owns the card', () => {
  const src = dialog('members.tsx');
  const ctl = dialog('members-controller.js');
  assert.match(src, /onOpen: \(\) => \{ void Members\._load\(\); \}/);
  assert.match(src, /onClose: \(\) => Members\._reset\(\)/);
  // The controller's open/close became forwards to the island, so every
  // AppView call site reaches the same lifecycle.
  assert.match(ctl, /function dialogController\(\)/);
  assert.match(ctl, /AppView\.openMembersModal = \(\) => \{[\s\S]*island\.open\(\)/);
  // The prerender pass evaluates this module in Node, so every window touch is
  // guarded and the publication happens from init(), not at import time.
  assert.match(ctl, /export function init\(\) \{\n\s*if \(typeof window === 'undefined'\) return;/);
});

test('feedback: the island owns the lifecycle, the controller keeps its logic', () => {
  const src = dialog('feedback.tsx');
  const ctl = dialog('feedback-controller.js');
  assert.match(src, /onOpen: \(opts\) => Feedback\._open\(opts \|\| \{\}\)/);
  assert.match(src, /onClose: \(\) => Feedback\._reset\(\)/);
  assert.match(src, /initFeedback\(\)/);
  // The pieces with issue numbers on them, still present after the move.
  assert.match(ctl, /App\.openFeedbackModal = /, 'the legacy entry point is re-published from the controller');
  assert.match(ctl, /import '\.\/screenshot-select'/);
  assert.ok(!/document\.addEventListener\('DOMContentLoaded'/.test(ctl),
    'the bootstrap became the island’s init() call');
  // app.js keeps only the forward; the 800-line block is gone from bindEvents.
  assert.ok(!/feedback-submit/.test(APP), 'the feedback block should be out of app.js');
});

test('app-secrets: open/close forward to the island, load/reset stay in the controller', () => {
  const src = dialog('app-secrets.tsx');
  const ctl = dialog('app-secrets-controller.js');
  assert.match(src, /onOpen: \(payload\) => \{[\s\S]*Secrets\._load\(payload\.slug/);
  assert.match(src, /onClose: \(\) => Secrets\._reset\(\)/);
  assert.match(src, /initSecrets\(\)/);
  assert.match(ctl, /async open\(slug, opts = \{\}\) \{[\s\S]*island\.open\(\{ slug, opts \}\)/);
  assert.match(ctl, /close\(\) \{[\s\S]*island\.close\(\)/);
  // Callers that arrive before hydration still get the data half — AppView
  // .close() calls Secrets.hide() on every app teardown.
  assert.match(ctl, /if \(!island\) return Secrets\._load\(slug, opts\)/);
  assert.match(ctl, /if \(!island\) return Secrets\._reset\(\)/);
  assert.match(ctl, /window\.Secrets = Secrets/);
});

test('the legacy entry points still exist, as forwards', () => {
  // The whole point of keeping these names: nothing else in public/js/** had
  // to change. If a forward disappears, the caller silently no-ops.
  for (const name of ['promptRename', 'promptFork', 'promptCloseIssue', 'openImportPrModal', 'openShareModal']) {
    assert.ok(APP_VIEW.includes(`${name}`), `AppView.${name} should survive as a forward`);
  }
  assert.match(APP, /showCreateModal/);
});
