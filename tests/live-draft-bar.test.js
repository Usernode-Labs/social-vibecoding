'use strict';

// A live draft's bar in its private thread with Homeroom bot
// (frontend/src/features/messages/live-draft-bar.tsx): its first render is
// nothing (the draft is read in an effect), the status line's words for each
// state of the preview, where the messages pane mounts it (an open thread of
// theirs that is about a project), and the socket frame app.js hands it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BAR = 'frontend/src/features/messages/live-draft-bar.tsx';

const draft = (over = {}) => ({
  id: 1, state: 'open', live: 'live', sessionId: 5, rootId: 9, app: { slug: 'gym', name: 'Gym Tracker' },
  edits: 0, headSha: null, prNumber: null, error: null, ...over,
});

test('there is no bar (G): what it did besides drawing is a part that draws nothing, read in an effect', () => {
  assert.equal(renderComponent(BAR, 'LiveDraftWatch', { rootId: 9 }), '');
  assert.equal(renderComponent(BAR, 'LiveDraftControls', { draft: null }), '', 'no controls for a preview that is not a draft\'s');
  assert.doesNotMatch(read(BAR), /export function LiveDraftBar/);
  assert.doesNotMatch(read(BAR), /data-live-draft-open/, 'a draft is opened by asking Homeroom bot, never by a button on every thread');
  assert.match(read(BAR), /fetch\(path, \{ credentials: 'same-origin'/);
  assert.match(read(BAR), /\/api\/live-drafts\?rootId=/);
});

test('the status line says where the preview stands', () => {
  const { draftLine } = loadTsx(BAR);
  assert.deepEqual(draftLine(draft({ live: 'starting' })), { id: 'messages:liveDraft.starting' });
  assert.deepEqual(draftLine(draft({ live: 'rebuilding', edits: 2 })), { id: 'messages:liveDraft.rebuilding' });
  assert.deepEqual(draftLine(draft({ live: 'failed' })), { id: 'messages:liveDraft.failed' });
  assert.deepEqual(draftLine(draft()), { id: 'messages:liveDraft.liveNone' });
  assert.deepEqual(draftLine(draft({ edits: 3 })), { id: 'messages:liveDraft.live', values: { count: 3 } });
  assert.equal(message('messages:liveDraft.live_other').replace('{{count}}', '3'), 'Live preview · 3 changes');
});

test('the preview\'s header says where the draft stands in one short line, and offers its one action (G, C)', () => {
  const { draftHeadLine, draftAction, liveDraftShown } = loadTsx(BAR);
  assert.deepEqual(draftHeadLine(draft({ live: 'failed' })), { id: 'messages:liveDraft.head.failed', bad: true }, 'a preview that could not start is still said');
  assert.deepEqual(draftHeadLine(draft({ live: 'starting' })), { id: 'messages:liveDraft.head.starting', bad: false });
  assert.deepEqual(draftHeadLine(draft()), { id: 'messages:liveDraft.head.none', bad: false });
  assert.deepEqual(draftHeadLine(draft({ edits: 2 })), { id: 'messages:liveDraft.head.edits', values: { count: 2 }, bad: false });
  const proposed = (pending) => draft({ state: 'proposed', editable: true, edits: 4, proposal: { sessionId: 50, prNumber: 142, open: true, pending, headSha: null } });
  assert.deepEqual(draftHeadLine(proposed(1)), { id: 'messages:liveDraft.head.pending', values: { count: 1 }, bad: false });
  assert.equal(message('messages:liveDraft.head.pending_one').replace('{{count}}', '1'), '1 change not in the proposal yet');
  assert.deepEqual(draftHeadLine(proposed(0)), { id: 'messages:liveDraft.head.inProposal', bad: false });
  assert.equal(draftAction(draft()), null, 'nothing to propose before an edit');
  assert.equal(draftAction(draft({ edits: 1 })), 'propose');
  assert.equal(draftAction(proposed(2)), 'update');
  assert.equal(draftAction(proposed(0)), null);
  assert.equal(message('messages:liveDraft.update'), 'Update proposal');
  assert.equal(liveDraftShown(proposed(0)), true, 'a draft up for a vote is still shown');
  assert.equal(liveDraftShown(draft({ state: 'proposed' })), false, 'one proposed before drafts survived Propose is not');
});

test('the controls are the preview header\'s, beside its way out; Discard draft is the title menu\'s and asks first', () => {
  const overlay = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(overlay, /const liveDraft = useDraftForSession\(state\.open \? state\.sessionId : null\);/);
  assert.match(overlay, /const draftActs = useLiveDraftActs\(liveDraft\);/);
  assert.match(overlay, /<LiveDraftControls draft=\{liveDraft\} acts=\{draftActs\} \/>\s*<div className="staging-tools">/);
  const bar = read(BAR);
  assert.match(bar, /data-live-draft-propose=""/);
  assert.match(bar, /data-live-draft-update=""/);
  // 24 Nov 2026: beside Propose, "Close draft" read as the preview's ×, which
  // only hides the preview. The header's row keeps its line and its one
  // action; ending the draft is Discard draft, the title menu's last entry.
  const acts = { busy: null, error: null, act: async () => {}, discard: async () => {}, discardItem: null };
  const header = renderComponent(BAR, 'LiveDraftControls', { draft: draft({ edits: 2 }), acts });
  assert.match(header, /data-live-draft-propose=""/);
  assert.doesNotMatch(header, /data-live-draft-close|Close draft|Discard draft/, 'no way to end the draft beside Propose');
  assert.match(bar, /data: \{ 'data-live-draft-close': '' \},/, 'the check hook moves with it, to the menu entry');
  assert.match(bar, /label: t\('messages:liveDraft\.discard'\),/);
  assert.match(bar, /const ok = await confirmAction\(\{\s*title: t\('messages:liveDraft\.closeConfirm\.title'\)/);
  assert.match(bar, /confirmLabel: t\('messages:liveDraft\.close'\),\s*danger: true,/);
  assert.match(bar, /await call\(`\/api\/live-drafts\/\$\{draft\.id\}\/close`, \{ method: 'POST' \}\);/, 'it ends the draft as Close draft did');
  assert.equal(message('messages:liveDraft.discard'), 'Discard draft');
  assert.equal(message('messages:liveDraft.close'), 'Discard draft', 'the confirm button says the menu entry\'s words');
  assert.equal(message('messages:liveDraft.closeConfirm.title'), 'Discard this draft?');
  // The menu is there whenever the preview is a draft's, beside a thread or
  // in the whole window (a phone), where Discard draft is its only entry.
  assert.match(overlay, /const menuHere = pickHere \|\| !!liveDraft;/);
  assert.match(overlay, /return menuHere \? \(/);
  assert.match(overlay, /end=\{draftActs\.discardItem\}>/);
  const card = read('frontend/src/features/detail/detail-card.tsx');
  assert.match(card, /<div className="detail-card-menu-end" data-alone=\{rows\.length \? undefined : ''\}>/);
  assert.match(card, /role="menuitem"[\s\S]{0,200}data-danger=\{end\.danger \? '' : undefined\}[\s\S]{0,200}\{\.\.\.end\.data\}/);
  assert.match(read('frontend/src/features/staging/placement.ts'), /sessionId: Number\(input\.sessionId\) \|\| null,/);
});

test('the messages pane reads the draft on an open thread of theirs, with no bar; a newly opened draft brings its preview up', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.doesNotMatch(pane, /<LiveDraftBar/);
  assert.match(pane, /import \{ useLiveDraft \} from '\.\/live-draft-bar';/);
  assert.match(pane, /const liveDraft = useLiveDraft\(privateMine && privateRoot && privateWhere\?\.state === 'open' \? privateRoot : null\);/);
  assert.match(read(BAR), /if \(detail\.opened && shown\) openPreview\(next\);/);
});

test('app.js hands the draft\'s socket frame on as the bar\'s window event', () => {
  const { LIVE_DRAFT_EVENT } = loadTsx(BAR);
  const app = read('public/js/app.js');
  assert.match(app, new RegExp(`case 'live_draft_changed':\\s*(//[^\\n]*\\n\\s*)*window\\.dispatchEvent\\(new CustomEvent\\('${LIVE_DRAFT_EVENT}', \\{ detail: data \\}\\)\\);`));
});

test('New chat offers "I want to change an app live…" once a project of its own is picked', () => {
  const NEW = 'frontend/src/features/messages/new-thread.tsx';
  const { LIVE_START, offersLive, NEW_THREAD_STARTS, startOf } = loadTsx(NEW);
  assert.equal(offersLive('', {}), false, 'not for Any project');
  assert.equal(offersLive('gym', {}), true);
  assert.equal(offersLive('gym', { gym: { selfHosted: false } }), true);
  // #6961: Homeroom's own app is offered to its admins, and only to them.
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }), false, 'never to a non-admin');
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }, { platformSlug: 'homeroom' }), false);
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }, { platformSlug: 'homeroom', isAdmin: true }), true);
  assert.equal(offersLive('homeroom', {}, { platformSlug: 'homeroom', isAdmin: true }), true, 'even before the project is described');
  assert.equal(offersLive('other-self', { 'other-self': { selfHosted: true } }, { platformSlug: 'homeroom', isAdmin: true }), false,
    'another self-hosted app is never offered, admins included');
  assert.equal(offersLive('gym', { gym: { selfHosted: false } }, { platformSlug: 'homeroom', isAdmin: true }), true);
  const words = message(LIVE_START.text);
  assert.equal(words, 'I want to change an app live');
  assert.equal(message(LIVE_START.label).replace(/<\/?0>/g, ''), `${words}…`, 'the pill says the words it writes, then "…"');
  assert.equal(LIVE_START.kind, 'any');
  assert.ok(!NEW_THREAD_STARTS.some((s) => s.key === 'live'), 'the five starts stay five; the sixth is drawn only with a project');
  const starts = [...NEW_THREAD_STARTS, LIVE_START].map((s) => ({ ...s, text: message(s.text) }));
  assert.equal(startOf('I want to change an app live: make the button bigger', starts).key, 'live');
  assert.match(read(NEW), /offersLive\(project, scope\.info[\s\S]*?platformSlug: platformSlug\(\),[\s\S]*?isAdmin: typeof window !== 'undefined' && !!\(window as any\)\.App\?\.user\?\.isAdmin,/);
  // Homeroom bot is what opens it: the chat's tool, named for that start.
  const mayor = require('../src/services/homeroom-bot-mayor');
  const tool = mayor.TOOLS.find((t) => t.function.name === 'open_app_preview').function;
  assert.match(tool.description, /I want to change an app live/);
  // Step 6 (#6864): opening it loads the draft's tools into the same turn,
  // so the change they asked for is made then, and replied to.
  assert.match(tool.description, /It gives you the draft's tools for the rest of this turn: when they asked for a change, make it then, and reply\./);
});
