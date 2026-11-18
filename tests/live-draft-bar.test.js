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

test('its first render is nothing; the draft is read in an effect, and there is no standing button', () => {
  assert.equal(renderComponent(BAR, 'LiveDraftBar', { rootId: 9 }), '');
  assert.doesNotMatch(read(BAR), /data-live-draft-open/, 'a draft is opened by asking Homeroom bot, never by a bar on every thread');
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

test('the messages pane mounts it on an open thread of theirs; a newly opened draft brings its preview up', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /import \{ LiveDraftBar \} from '\.\/live-draft-bar';/);
  assert.match(pane, /privateMine && privateRoot && privateWhere\?\.state === 'open' \? \(\s*<LiveDraftBar rootId=\{privateRoot\} \/>/);
  assert.match(read(BAR), /if \(detail\.opened && next\.state === 'open'\) openPreview\(next\);/);
});

test('app.js hands the draft\'s socket frame on as the bar\'s window event', () => {
  const { LIVE_DRAFT_EVENT } = loadTsx(BAR);
  const app = read('public/js/app.js');
  assert.match(app, new RegExp(`case 'live_draft_changed':\\s*(//[^\\n]*\\n\\s*)*window\\.dispatchEvent\\(new CustomEvent\\('${LIVE_DRAFT_EVENT}', \\{ detail: data \\}\\)\\);`));
});

test('New chat offers "I want to change it live…" once a project of its own is picked', () => {
  const NEW = 'frontend/src/features/messages/new-thread.tsx';
  const { LIVE_START, offersLive, NEW_THREAD_STARTS, startOf } = loadTsx(NEW);
  assert.equal(offersLive('', {}), false, 'not for Any project');
  assert.equal(offersLive('gym', {}), true);
  assert.equal(offersLive('gym', { gym: { selfHosted: false } }), true);
  assert.equal(offersLive('homeroom', { homeroom: { selfHosted: true } }), false, 'never Homeroom itself');
  const words = message(LIVE_START.text);
  assert.equal(words, 'I want to change it live');
  assert.equal(message(LIVE_START.label).replace(/<\/?0>/g, ''), `${words}…`, 'the pill says the words it writes, then "…"');
  assert.equal(LIVE_START.kind, 'any');
  assert.ok(!NEW_THREAD_STARTS.some((s) => s.key === 'live'), 'the five starts stay five; the sixth is drawn only with a project');
  const starts = [...NEW_THREAD_STARTS, LIVE_START].map((s) => ({ ...s, text: message(s.text) }));
  assert.equal(startOf('I want to change it live: make the button bigger', starts).key, 'live');
  assert.match(read(NEW), /offersLive\(project, scope\.info[^)]*\)\s*\?\s*\[\.\.\.NEW_THREAD_STARTS, LIVE_START\]/);
  // Homeroom bot is what opens it: the chat's tool, named for that start.
  const mayor = require('../src/services/homeroom-bot-mayor');
  const tool = mayor.TOOLS.find((t) => t.function.name === 'open_app_preview').function;
  assert.match(tool.description, /I want to change it live/);
  assert.match(tool.description, /Call it alone, and do not reply/);
});
