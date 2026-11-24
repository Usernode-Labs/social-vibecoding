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

test('a draft started on their own proposal says it is on that PR until it has a change of its own', () => {
  const { draftHeadLine } = loadTsx(BAR);
  const onTheirs = (over = {}) => draft({
    state: 'proposed', editable: true, edits: 0,
    proposal: { sessionId: 50, prNumber: 142, open: true, pending: 0, headSha: null },
    builtOn: { sessionId: 50, prNumber: 142, open: true, merged: false, linked: true },
    ...over,
  });
  assert.deepEqual(draftHeadLine(onTheirs()), { id: 'messages:liveDraft.head.onProposal', values: { number: 142 }, bad: false },
    'not "Up for a vote with every change" before any change');
  assert.equal(message('messages:liveDraft.head.onProposal').replace('{{number}}', '142'), 'On PR #142 · no changes yet');
  // A change of its own, not in the proposal yet, then put in it.
  assert.deepEqual(draftHeadLine(onTheirs({ edits: 1, proposal: { sessionId: 50, prNumber: 142, open: true, pending: 1, headSha: null } })),
    { id: 'messages:liveDraft.head.pending', values: { count: 1 }, bad: false });
  assert.deepEqual(draftHeadLine(onTheirs({ edits: 1 })), { id: 'messages:liveDraft.head.inProposal', bad: false });
  // No number to say: no changes yet, which is still true.
  assert.deepEqual(draftHeadLine(onTheirs({
    proposal: { sessionId: 50, prNumber: null, open: true, pending: 0, headSha: null },
    builtOn: { sessionId: 50, prNumber: null, open: true, merged: false, linked: true },
  })), { id: 'messages:liveDraft.head.none', bad: false });
  // On someone else's proposal the draft is open and linked to nothing: as before.
  assert.deepEqual(draftHeadLine(draft({ builtOn: { sessionId: 60, prNumber: 150, open: true, merged: false, linked: false } })),
    { id: 'messages:liveDraft.head.none', bad: false });
  assert.deepEqual(draftHeadLine(onTheirs({ live: 'starting' })), { id: 'messages:liveDraft.head.starting', bad: false }, 'a start is still said first');
});

test('a draft\'s preview opens look-only and waits for a start, so it never lands on "isn\'t running"', () => {
  const { draftPreviewOpts, openLivePreview } = loadTsx(BAR);
  for (const live of ['starting', 'live', 'rebuilding']) {
    assert.deepEqual(draftPreviewOpts(draft({ live })), { readOnly: true, app: { slug: 'gym' }, waitForStart: true }, live);
  }
  assert.deepEqual(draftPreviewOpts(draft({ live: 'failed' })), { readOnly: true, app: { slug: 'gym' } },
    'one that could not start is not waited for: the header says it failed');

  // Pressed in the Artifacts column: AppView.ensureStaging is asked with them.
  const asked = [];
  const had = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = { AppView: { ensureStaging: (...args) => { asked.push(args); return Promise.resolve(); } } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ draft: null }) });
  try {
    openLivePreview(draft({ live: 'starting', sessionId: 41 }));
  } finally {
    globalThis.window = had.window;
    globalThis.fetch = had.fetch;
  }
  assert.deepEqual(asked, [[41, null, null, { readOnly: true, app: { slug: 'gym' }, waitForStart: true }]]);
  assert.match(read(BAR), /void view\.ensureStaging\(draft\.sessionId, null, null, draftPreviewOpts\(draft\)\);/,
    'the reload frame\'s open (draftPreviewStep \'open\') goes the same way');
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

test('a refusal on the header\'s line goes once the draft is proposed (24 Nov 2026: two Proposes at once)', () => {
  // The Propose under the bot's reply and this one, tapped together: this one
  // is told the draft is being put up for a vote, and that line goes once the
  // other has proposed it, rather than standing in for "Up for a vote".
  assert.match(read(BAR), /useEffect\(\(\) => \{ setError\(null\); \}, \[draft\?\.id, draft\?\.state\]\);/);
  const acts = { busy: null, error: 'It is being put up for a vote right now.', act: async () => {}, discard: async () => {}, discardItem: null };
  assert.match(renderComponent(BAR, 'LiveDraftControls', { draft: draft({ edits: 2 }), acts }), /It is being put up for a vote right now\./);
});

test('the messages pane reads the draft on an open thread of theirs, with no bar; a newly opened draft brings its preview up', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.doesNotMatch(pane, /<LiveDraftBar/);
  assert.match(pane, /import \{ useLiveDraft \} from '\.\/live-draft-bar';/);
  assert.match(pane, /const liveDraft = useLiveDraft\(privateMine && privateRoot && privateWhere\?\.state === 'open' \? privateRoot : null\);/);
  const { draftPreviewStep } = loadTsx(BAR);
  const step = (over) => draftPreviewStep({ draft: draft(), last: null, paneHere: false, framed: false, ...over });
  assert.equal(step({ opened: true, draft: draft({ live: 'starting' }) }), 'open');
  assert.equal(step({ opened: true, draft: draft({ state: 'closed' }) }), null, 'not one that is closed');
  const bar = read(BAR);
  assert.match(bar, /const step = draftPreviewStep\(\{[\s\S]{0,200}paneHere: paneOn\(next\.sessionId\), framed: frameShowsPreview\(\),\s*\}\);/);
  assert.match(bar, /if \(step === 'open'\) openPreview\(next\);\s*else if \(step === 'reload'\) void reloadPreview\(next\.sessionId, next\.app\.slug\);/);
});

// 24 Nov 2026: a cleared frame's `src` property reads back as Homeroom's own
// page, so the old "has it a src" guard never fired. Only an address on the
// preview's own origin is a preview in the frame.
test('a frame shows a preview only when its src attribute is an address on another origin', () => {
  const { showsPreview } = loadTsx(BAR);
  const HOME = 'https://app.onhomeroom.com';
  assert.equal(showsPreview(null, HOME), false, 'no attribute');
  assert.equal(showsPreview('', HOME), false, 'cleared');
  assert.equal(showsPreview('about:blank', HOME), false);
  assert.equal(showsPreview('https://app.onhomeroom.com/', HOME), false, 'Homeroom\'s own page');
  assert.equal(showsPreview('https://app.onhomeroom.com/app/gym/dev?x=1#chat', HOME), false);
  assert.equal(showsPreview('/app/gym', HOME), false, 'a path is Homeroom\'s own');
  assert.equal(showsPreview('javascript:void(0)', HOME), false);
  assert.equal(showsPreview('https://gym--s41.onhomeroom.dev/?token=x', HOME), true);
  assert.equal(showsPreview('http://localhost:4100/', 'http://localhost:3000'), true, 'a local preview on its own port');
  assert.equal(showsPreview('not a url', HOME), false);
  const bar = read(BAR);
  assert.match(bar, /showsPreview\(frame\.getAttribute\('src'\), home\)/, 'the attribute is read, never the property');
  assert.doesNotMatch(bar, /frame\.src\b/);
  // reloadPreview never points the frame at Homeroom's own page.
  assert.match(bar, /if \(!frame \|\| !frameShowsPreview\(frame\)\) return;\s*let src = frame\.getAttribute\('src'\) as string;/);
});

test('a preview still starting when its pane opened comes up by itself when it goes live', () => {
  const { draftPreviewStep } = loadTsx(BAR);
  const step = (over) => draftPreviewStep({ draft: draft(), last: 'live', paneHere: true, framed: true, ...over });
  // The pane opened on a dead end, or a loader: the frame holds no preview.
  assert.equal(step({ last: 'starting', reload: true, framed: false }), 'open', 'deployed: the pane is opened on it again');
  assert.equal(step({ last: 'starting', framed: false }), 'open', 'starting to live, with no reload asked');
  assert.equal(step({ last: 'rebuilding', framed: false }), 'open');
  assert.equal(step({ reload: true, framed: false }), 'open', 'a saved edit while the frame holds none');
  // The frame shows the preview: it is reloaded, as before.
  assert.equal(step({ reload: true }), 'reload');
  assert.equal(step({ last: 'rebuilding' }), 'reload', 'built again');
  assert.equal(step({ last: 'starting' }), 'reload');
  // Not on this draft's pane: the reload is left to reloadPreview's own guard.
  assert.equal(step({ last: 'starting', reload: true, paneHere: false, framed: false }), 'reload');
  // Nothing came up and nothing was asked.
  assert.equal(step({}), null);
  assert.equal(step({ last: 'starting', draft: draft({ live: 'starting' }), framed: false }), null);
  assert.equal(step({ last: 'live', draft: draft({ live: 'rebuilding' }), framed: false }), null);
  assert.equal(step({ last: 'starting', draft: draft({ live: 'failed' }), framed: false }), null);
  assert.equal(step({ reload: true, framed: false, draft: draft({ state: 'closed' }) }), 'reload', 'a closed draft is never opened again');
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
