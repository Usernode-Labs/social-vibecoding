'use strict';

// 20 Nov 2026 (live-draft review, G to J and K's screens): a private thread
// with Homeroom bot shows its artifacts and its live draft in one column.
//
//   I  the head's Artifacts button shows whenever the thread has any of them
//      and toggles the column; the column's picker lists every artifact by
//      its title and the live draft as "Live preview of <app>"; a version's
//      card opens the column on that artifact; a message sent says what the
//      column shows (metadata.showing)
//   K  the client reads an artifact by its own address under the thread,
//      and a pin carries the artifact it was pinned on
//   J  Comment on a live draft's preview pins a comment in the app and posts
//      it in the draft's thread (metadata.previewPin), with what the app's
//      bridge said is under it; any other preview keeps today's comment mode
//   H  a narrow head keeps its title: the Artifacts word gives way to its glyph

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CSS = read('public/css/app.css');

test('I: the head\'s Artifacts button is named "Artifacts", shows only with something to show, and toggles the column', () => {
  const BUTTON = 'frontend/src/features/messages/artifacts-button.tsx';
  assert.equal(message('messages:artifacts.button'), 'Artifacts');
  assert.equal(renderComponent(BUTTON, 'ArtifactsButton', { conversationId: 1, rootId: 9, hasArtifact: false, liveDraft: null, className: 'x' }), '',
    'a thread with no artifact and no live draft shows no button');
  const html = renderComponent(BUTTON, 'ArtifactsButton', { conversationId: 1, rootId: 9, hasArtifact: true, liveDraft: null, className: 'x' });
  assert.match(html, /data-reply-artifacts=""/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, />Artifacts<\/span>/);
  const { artifactsOpen } = loadTsx(BUTTON);
  assert.equal(artifactsOpen({ owner: 'private:9' }, 9), true);
  assert.equal(artifactsOpen({ owner: 'private:8' }, 9), false, 'another thread\'s column is not this one\'s');
  assert.equal(artifactsOpen(null, 9), false);
  const src = read(BUTTON);
  assert.match(src, /if \(open\) \{\s*closeDetail\(\);/, 'a second press closes it');
  assert.match(src, /takeHeldDetail\(owner\) \|\| lastDetail\(owner\)/, 'it opens on what the thread showed last');
  // On a phone, the Preview and Chat switch is named to match.
  assert.match(read('frontend/src/features/messages/design-pane.tsx'), /onView\('preview'\)\}>\s*\{\/\*[^*]*\*\/\}\s*\{t\('messages:artifacts\.button'\)\}/);
  assert.equal(read('frontend/locales/en/messages.json').includes('"design.pane.showPreview"'), false, 'the old Preview word is gone');
});

test('I: the column\'s picker lists each artifact by its title, and the live draft as "Live preview of <app>"', () => {
  const card = read('frontend/src/features/detail/detail-card.tsx');
  assert.match(card, /listed\.forEach\(\(a, i\) => \{/);
  assert.match(card, /title: a\.title \|\| t\('messages:detail\.kind\.design'\)/);
  assert.match(card, /open: \(\) => openPreview\(\{ conversationId, rootId: design\.rootId, version: null, artifactId \}\)/);
  assert.match(card, /t\('messages:detail\.row\.livePreview', \{ app: live\.app\.name \}\)/);
  assert.equal(message('messages:detail.row.livePreview').replace('{{app}}', 'Gym Tracker'), 'Live preview of Gym Tracker');
  const { threadHasArtifacts } = loadTsx('frontend/src/features/detail/detail-card.tsx');
  assert.equal(threadHasArtifacts(null, null), false);
  assert.equal(threadHasArtifacts({ latest: 2, artifacts: [] }, null), true);
  assert.equal(threadHasArtifacts(null, { sessionId: 5, state: 'proposed', editable: true }), true, 'a draft up for a vote is still shown');
  // A version's card opens the column on its artifact, at its version.
  assert.match(read('frontend/src/features/messages/design-card.tsx'), /const open = \(\) => openPreview\(\{ conversationId, rootId, version, artifactId \}\);/);
  // The column's identity of a design names its artifact; none is the thread's first.
  const detail = loadTsx('frontend/src/features/ai/detail.ts');
  assert.equal(detail.detailIdentity({ kind: 'design', ref: { rootId: 9 } }), 'design:9');
  assert.equal(detail.detailIdentity({ kind: 'design', ref: { rootId: 9, artifactId: 4 } }), 'design:9:4');
});

test('K: the client reads an artifact at its own address; the old address is the thread\'s first', () => {
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /return artifactId \? `\$\{DESIGNS\}\/\$\{rootId\}\/artifacts\/\$\{artifactId\}` : `\$\{DESIGNS\}\/\$\{rootId\}`;/);
  assert.match(api, /request<unknown>\(`\$\{artifactPath\(rootId, artifactId\)\}\/versions\/\$\{version\}`\)/);
  assert.match(api, /request<unknown>\(`\$\{artifactPath\(rootId, artifactId\)\}\/propose`/, '"Request it" files the artifact shown');
  const { normalizeDesignPin, normalizeMessage } = loadTsx('frontend/src/features/messages/api.ts');
  assert.deepEqual(normalizeDesignPin({ version: 2, x: 0.5, y: 0.25, artifactId: 7 }), { version: 2, x: 0.5, y: 0.25, artifactId: 7 });
  assert.deepEqual(normalizeDesignPin({ version: 2, x: 0.5, y: 0.25 }), { version: 2, x: 0.5, y: 0.25 }, 'a pin from before names none');
  const said = normalizeMessage({ id: 3, content: 'Layouts, version 2: …', sender: { id: 1, username: 'homeroom-bot', bot: true },
    metadata: { homeroomBot: { kind: 'design_version', designVersion: 2, artifactId: 7 } } }, 1);
  assert.equal(said.metadata.homeroomBot.artifactId, 7);
  // The pane keeps a thread's other artifacts' versions and pins out of this one's.
  const pane = read('frontend/src/features/messages/design-pane.tsx');
  assert.match(pane, /if \(pin && pin\.version === shown && ofThis\(pin\.artifactId\)\)/);
  assert.match(pane, /api\.getDesign\(rootId, artifactId\)/);
});

test('C, I: a message sent beside the column says what it shows', () => {
  const store = read('frontend/src/features/messages/store.ts');
  assert.match(store, /const showing = threadRootId && state\.active\?\.homeroomBot \? showingFor\(threadRootId\) : null;/);
  assert.match(read('frontend/src/features/messages/api.ts'), /if \(input\.showing\) payload\.showing = input\.showing/);
  const { showingFor } = loadTsx('frontend/src/features/messages/showing.ts');
  const holder = (globalThis.__usernodeDetail ||= { state: { entry: null }, seq: 0, listeners: new Set() });
  const drafts = (globalThis.__usernodeLiveDrafts ||= { drafts: new Map(), listeners: new Set(), version: 0 });
  const had = holder.state;
  try {
    holder.state = { entry: { kind: 'design', ref: { rootId: 9, artifactId: 4 }, owner: 'private:9' } };
    assert.deepEqual(showingFor(9), { artifactId: 4 });
    assert.equal(showingFor(8), null, 'another thread\'s column says nothing about this one');
    drafts.drafts.set(55, { id: 3, rootId: 9, sessionId: 55 });
    holder.state = { entry: { kind: 'preview', ref: { sessionId: 55 }, owner: 'private:9' } };
    assert.deepEqual(showingFor(9), { liveDraftId: 3 });
  } finally {
    holder.state = had;
    drafts.drafts.delete(55);
  }
});

test('J: Comment on a live draft\'s preview pins a comment in the app; any other preview keeps its comment mode', () => {
  const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(overlay, /onClick=\{\(\) => \(liveDraft \? togglePreviewPins\(\) : stagingHandlers\.onComment\?\.\(\)\)\}/);
  assert.match(overlay, /<PreviewPinLayer draft=\{showingShots \? null : liveDraft\} \/>/);
  const PIN = 'frontend/src/features/staging/preview-pin.tsx';
  assert.equal(renderComponent(PIN, 'PreviewPinLayer', { draft: { id: 3, rootId: 9, conversationId: 1 } }), '', 'nothing until Comment is pressed');
  const { pinPoint, pinRoute } = loadTsx(PIN);
  assert.deepEqual(pinPoint({ x: 150, y: 120 }, { left: 100, top: 20, width: 200, height: 400 }), { x: 0.25, y: 0.25 });
  assert.equal(pinPoint({ x: 10, y: 120 }, { left: 100, top: 20, width: 200, height: 400 }), null, 'a press outside the app is no pin');
  assert.equal(pinRoute('/workouts'), '/workouts');
  assert.equal(pinRoute('//evil.example/x'), undefined);
  assert.equal(pinRoute(''), undefined);
  const src = read(PIN);
  // What is under it comes from the bridge every app loads (no script added to apps).
  assert.match(src, /requestAppPicture\(frame, \{ scale: 0\.25, x: at\.x \* viewport\.width, y: at\.y \* viewport\.height \}, ELEMENT_TIMEOUT_MS\)/);
  // It goes to the draft's thread, carrying the pin, and says the live preview is what was open.
  assert.match(src, /threadRootId: draft\.rootId,/);
  assert.match(src, /previewPin: \{\s*draftId: draft\.id, x: pin\.x, y: pin\.y,/);
  assert.match(src, /showing: \{ liveDraftId: draft\.id \},/);
  const { normalizePreviewPin } = loadTsx('frontend/src/features/messages/api.ts');
  assert.deepEqual(normalizePreviewPin({ draftId: 3, x: 0.4, y: 0.2, route: '/w', viewport: { width: 390, height: 844 }, element: { tag: 'button', id: '', text: 'Delete' } }),
    { draftId: 3, x: 0.4, y: 0.2, route: '/w', viewport: { width: 390, height: 844 }, element: { tag: 'button', id: '', text: 'Delete' } });
  // The layer covers the app's frame only.
  assert.match(CSS, /\.staging-pin-layer \{\n  position: absolute;\n  inset: 0;/);
});

test('H: a narrow head keeps its title; the Artifacts word gives way to its glyph first', () => {
  assert.match(CSS, /\.messages-thread-header\[data-reply-head\] \{ container: bot-thread-head \/ inline-size; \}/);
  assert.match(CSS, /\.messages-thread-header\[data-reply-head\] \.dev-thread-bar-text \{ min-width: min\(7\.5rem, 40%\); \}/);
  assert.match(CSS, /@container bot-thread-head \(max-width: 460px\) \{/);
  assert.match(CSS, /\.messages-thread-action\.messages-thread-preview \.messages-thread-artifacts-word \{\n    position: absolute;/);
});

test('K: an artifact after a thread\'s first is named in the address, the request page\'s door and Make it', () => {
  const { botDetailAt } = loadTsx('frontend/src/features/ai/door.ts');
  assert.deepEqual(botDetailAt('#homeroom-bot/thread/9/design/2'), { kind: 'design', version: 2 }, 'the first, as before');
  assert.deepEqual(botDetailAt('#homeroom-bot/thread/9/design/2?artifact=3'), { kind: 'design', version: 2, artifactId: 3 });
  assert.deepEqual(botDetailAt('#homeroom-bot/thread/9/design?artifact=1'), { kind: 'design', version: null }, 'artifact 1 is the first');
  assert.match(read('frontend/src/features/dev-board/topic/request-head.tsx'),
    /\$\{r\.fromThread\.artifactId && r\.fromThread\.artifactId > 1 \? `\?artifact=\$\{r\.fromThread\.artifactId\}` : ''\}/);
  const { makeBody } = loadTsx('frontend/src/features/messages/bot-make.tsx');
  assert.deepEqual(makeBody({ name: 'Layouts', rootId: 9, version: 2, artifactId: 2 }, 'Layouts', 'solo').design, { rootId: 9, version: 2, artifactId: 2 });
  assert.deepEqual(makeBody({ name: 'Layouts', rootId: 9, version: 2 }, 'Layouts', 'solo').design, { rootId: 9, version: 2 });
});
