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

test('its first render is nothing; the draft is read in an effect', () => {
  assert.equal(renderComponent(BAR, 'LiveDraftBar', { rootId: 9, app: { slug: 'gym', name: 'Gym Tracker' } }), '');
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
  assert.equal(message('messages:liveDraft.open'), 'Open app preview');
});

test('the messages pane mounts it on an open thread of theirs about a project', () => {
  const pane = read('frontend/src/features/messages/index.tsx');
  assert.match(pane, /import \{ LiveDraftBar \} from '\.\/live-draft-bar';/);
  assert.match(pane, /privateMine && privateRoot && privateWhere\?\.app\?\.slug && privateWhere\.state === 'open' \? \(\s*<LiveDraftBar rootId=\{privateRoot\} app=\{privateWhere\.app\} \/>/);
});

test('app.js hands the draft\'s socket frame on as the bar\'s window event', () => {
  const { LIVE_DRAFT_EVENT } = loadTsx(BAR);
  const app = read('public/js/app.js');
  assert.match(app, new RegExp(`case 'live_draft_changed':\\s*(//[^\\n]*\\n\\s*)*window\\.dispatchEvent\\(new CustomEvent\\('${LIVE_DRAFT_EVENT}', \\{ detail: data \\}\\)\\);`));
});
