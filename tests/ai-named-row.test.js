'use strict';

// Mobile 04 (24 Nov 2026, Evan): being named with @ is Needs you until you
// answer or dismiss it, and every thread you are in is on the Homeroom bot
// tab. The tab's pure part (frontend/src/features/ai/model.ts, lines.ts),
// the row drawn on the three bands (lists.tsx), and the thread reveal its
// Reply asks for (public/js/group-chat.js revealInThread). The server half
// is tests/ai-work-named-postgres.test.js.
//
// Run with: node --test tests/ai-named-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const { withWords } = require('./lib/work-words');

const MODEL = 'frontend/src/features/ai/model.ts';
const LINES = 'frontend/src/features/ai/lines.ts';
const LISTS = 'frontend/src/features/ai/lists.tsx';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const words = (p) => message(p.id, {
  ...p.values,
  ...Object.fromEntries(Object.entries(p.nested || {}).map(([k, q]) => [k, words(q)])),
});

const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
const named = (threadId, extra = {}) => ({
  threadId, number: 6994, kind: 'request', title: 'Seed swap', app, change: null,
  href: '#app/garden/dev/issues/6994', at: '2026-11-24T10:00:00Z', by: 'sam', messageId: 501, ...extra,
});
const thread = (threadId, extra = {}) => withWords({
  threadId, number: 6994, kind: 'request', title: 'Seed swap', app, change: null,
  href: '#app/garden/dev/issues/6994', group: 'waiting', work: { stage: 'reading', line: { code: 'waiting' } },
  at: '2026-11-23T10:00:00Z', ...extra,
});
const work = (extra = {}) => ({ private: [], needs: [], next: [], waiting: [], live: [], named: [], ...extra });

test('being named is one Needs you row a thread, with its pill, saying who and where', () => {
  const { needsYou, owedCount, NAMED_PILL } = loadTsx(MODEL);
  const rows = needsYou([], work({ named: [named(7)] }));
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.key, 'named:7');
  assert.equal(row.title, 'Seed swap', 'its title is the thread\'s');
  assert.equal(words(row.sub), 'sam named you · Garden club · #6994', 'who named you, the project and the number');
  assert.equal(words(row.why), 'sam named you', 'its second line');
  assert.equal(row.pill.id, NAMED_PILL);
  assert.equal(message(NAMED_PILL), 'Named you');
  assert.equal(owedCount(rows), 1, 'it has a pill, so it is in Needs you\'s count');
  assert.deepEqual(row.named, { messageId: 501 }, 'Reply opens it at the message that named you');
  assert.equal(row.href, '#app/garden/dev/issues/6994');
  assert.equal(row.threadId, 7);
  // Homeroom bot naming you counts, and an account since removed is Somebody.
  assert.equal(words(needsYou([], work({ named: [named(7, { by: null, byBot: true })] }))[0].why), 'Homeroom bot named you');
  assert.equal(words(needsYou([], work({ named: [named(7, { by: null })] }))[0].why), 'Somebody named you');
  // A change on GitHub is PR 12; a decision has no number.
  const pr = needsYou([], work({ named: [named(7, { kind: 'change', number: 12, app: { ...app, changesOnGithub: true } })] }))[0];
  assert.equal(words(pr.sub), 'sam named you · Garden club · PR 12');
  assert.equal(words(needsYou([], work({ named: [named(7, { kind: 'decision', number: null })] }))[0].sub), 'sam named you · Garden club');
});

test('a vote owed wins, and so does any other Needs you row of the thread', () => {
  const { needsYou, namedRows } = loadTsx(MODEL);
  // The same thread owes you a vote: one row, the Vote row.
  const vote = { kind: 'proposal', id: 40, number: 41, title: 'Seed swap', app, threadId: 7, request: { number: 6994 } };
  assert.deepEqual(needsYou([vote], work({ named: [named(7)] })).map((r) => r.key), ['need:proposal:40']);
  // Matched by its request too, when the feed names no thread.
  const { threadId, ...noThread } = vote;
  void threadId;
  assert.deepEqual(namedRows([noThread], work({ named: [named(7)] })), []);
  // The bot's plan waiting for your Build it is that thread's row.
  const plan = thread(7, { group: 'needs', work: { stage: 'waiting_for_you', why: 'plan' } });
  assert.deepEqual(needsYou([], work({ needs: [plan], named: [named(7)] })).map((r) => r.key.split(':')[0]), ['plan']);
  // Another thread's vote leaves this one's @ row alone.
  assert.equal(needsYou([{ ...vote, threadId: 99, request: { number: 1 } }], work({ named: [named(7)] })).length, 2);
});

test('while the @ row stands its thread is in no other list; dismissed, it is back at once', () => {
  const { inProgress, upNext, needsYou, withoutDismissed } = loadTsx(MODEL);
  const lists = work({ waiting: [thread(7)], next: [thread(8, { group: 'next', number: 7000, work: { stage: 'checking' } })], named: [named(7)] });
  assert.deepEqual(upNext([], lists).map((t) => t.threadId), [], 'not In progress while Needs you holds it');
  assert.deepEqual(inProgress([], lists).map((t) => t.threadId), [8], 'the rest are where they were');
  // Dismiss on this page: by thread, and the moment of the @ dismissed.
  const after = withoutDismissed(lists, new Map([[7, '2026-11-24T10:00:00Z']]));
  assert.deepEqual(needsYou([], after), [], 'it leaves Needs you');
  assert.deepEqual(upNext([], after).map((t) => t.threadId), [7], 'and moves to where the thread would otherwise be');
  // A newer @ in the same thread comes back; nothing dismissed is the same lists.
  const newer = withoutDismissed(work({ named: [named(7, { at: '2026-11-24T11:00:00Z' })] }), new Map([[7, '2026-11-24T10:00:00Z']]));
  assert.equal(newer.named.length, 1, 'a new @ after a dismiss starts it again');
  assert.equal(withoutDismissed(lists, new Map()), lists);
});

test('its project counts it: Home\'s "need you" number and the chips read rankProjects', () => {
  const { needsYou, rankProjects } = loadTsx(MODEL);
  const rows = needsYou([], work({ named: [named(7), named(8, { app: { ...app, slug: 'games', name: 'Games' } })] }));
  const tally = rankProjects(rows, [], [], []);
  assert.deepEqual(tally.map((p) => [p.app.slug, p.needs]), [['games', 1], ['garden', 1]]);
});

test('on the three bands: Reply at the row\'s end, Dismiss beside it, on a phone too', () => {
  const { verbOf, needReason, ownFirst } = loadTsx(LINES);
  const { needsYou } = loadTsx(MODEL);
  const [row] = needsYou([], work({ named: [named(7)] }));
  assert.equal(message(verbOf(row.pill)), 'Reply', 'its verb');
  assert.equal(words(needReason(row)), 'sam named you', 'its second line says who');
  const dismissed = [];
  const html = renderComponent(LISTS, 'AiLists', {
    ready: true, owed: 1, rows: [row], progress: [], waiting: [], live: [],
    openRow() {}, openThread() {}, onDismiss: (r) => dismissed.push(r.key),
  });
  assert.match(html, /data-ai-line="named"/);
  assert.match(html, /data-ai-row-end="act">Reply</);
  assert.match(html, /<button[^>]*aria-label="Dismiss Seed swap"[^>]*data-ai-dismiss=""[^>]*>Dismiss<\/button>/);
  // Dismiss is its own button beside the row's, outside the ⋯'s room that a
  // narrow row drops (app.css .ai-row-menu).
  const src = read(LISTS);
  assert.match(src, /\{dismiss \? \(\s*<button\s+type="button"\s+className=\{DISMISS\}/);
  assert.ok(src.indexOf('data-ai-dismiss=""') < src.indexOf('<span className="ai-row-menu'), 'before the ⋯\'s room, not inside it');
  assert.match(src, /const DISMISS = `inline-flex min-h-\[44px\] md:min-h-\[36px\]/, 'a 44px target on a phone');
  // Without the page's handler there is no Dismiss (the looks' list).
  const bare = renderComponent(LISTS, 'AiLists', { ready: true, owed: 1, rows: [row], progress: [], waiting: [], live: [], openRow() {}, openThread() {} });
  assert.doesNotMatch(bare, /data-ai-dismiss/);
  // In progress: your own first, then the threads you only wrote or were named in.
  assert.deepEqual(ownFirst([{ k: 'a', tookPart: true }, { k: 'b' }, { k: 'c', tookPart: true }, { k: 'd' }]).map((r) => r.k), ['b', 'd', 'a', 'c']);
});

test('the page dismisses at once, keeps it on the server, and Reply opens the thread at the message', () => {
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/threads\/mentions\/dismiss\$\{demoQuery\(\)\}`/);
  assert.match(index, /setDismissed\(\(had\) => new Map\(\[\.\.\.had, \[threadId, row\.at\]\]\)\);/, 'gone at once, by the moment of its @');
  assert.match(index, /const listedWork = useMemo\(\(\) => withoutDismissed\(work, dismissed\), \[work, dismissed\]\);/);
  assert.match(index, /needsYou\(needs, listedWork\)/);
  assert.match(index, /onDismiss=\{dismissNamed\}/);
  assert.match(index, /if \(messageId && slug\) \(window as any\)\.GroupChat\?\.revealInThread\?\.\(slug, messageId\);/);
  assert.equal(message('messages:ai.named.dismissFailed'), 'Couldn’t dismiss it. Try again.');
});

// The REAL public/js/group-chat.js in a vm, over a stand-in thread page whose
// rows move as it scrolls (tests/group-chat-reveal-message.test.js does the
// same for the app's discussion).
function threadSetup() {
  const patches = [];
  const frames = [];
  const timers = [];
  const rows = new Map();
  const scroll = {
    id: 'gc-thread-scroll',
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100, height: 600, bottom: 700 }),
  };
  const list = {
    querySelector(sel) {
      const m = /data-msg-id="(\d+)"/.exec(sel);
      return m ? rows.get(Number(m[1])) || null : null;
    },
  };
  const host = { querySelector: (sel) => (sel === '#gc-thread-scroll' ? scroll : sel === '#gc-thread-messages' ? list : null) };
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' }, Date, Number,
    App: { user: { id: 7, username: 'evan' } },
    document: { getElementById: () => null },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc._react = () => ({ patchTranscriptMessage: (id, patch) => patches.push([id, patch.flash]) });
  gc._threadHost = host;
  return {
    gc, scroll, patches, frames, timers,
    row(id, offset) { rows.set(id, { getBoundingClientRect: () => ({ top: 100 + offset - scroll.scrollTop, height: 40 }) }); },
    open(slug, type, ref, ids, loaded = true) {
      gc.appSlug = slug;
      gc.activeThread = { type, ref, language: 'request' };
      const st = gc._threadState(type, ref);
      st.messages = ids.map((id) => ({ id }));
      st.loaded = loaded;
    },
    center(id) { const box = rows.get(id).getBoundingClientRect(); return box.top + box.height / 2; },
  };
}

test('Reply: the thread\'s page opens at the message that named you, once it is drawn', () => {
  const h = threadSetup();
  h.gc.revealInThread('garden', 501);
  assert.deepEqual(h.patches, [], 'nothing open yet: the request waits');
  // Another thread of the app, or one still loading, does not take it.
  h.open('garden', 'issue', 12, [400, 401]);
  assert.equal(h.gc._applyPendingThreadReveal(), false);
  h.open('garden', 'issue', 6994, [500, 501, 502], false);
  assert.equal(h.gc._applyPendingThreadReveal(), false);
  assert.ok(h.gc._pendingThreadReveal, 'kept for the thread that holds it');
  // Its first page lands; the row is a frame behind the render.
  h.open('garden', 'issue', 6994, [500, 501, 502]);
  assert.equal(h.gc._applyPendingThreadReveal(), false);
  assert.equal(h.frames.length, 1, 'asks again next frame');
  h.row(501, 1400);
  h.frames.shift()();
  assert.equal(h.center(501), 400, 'brought to the middle of the page\'s scroller');
  assert.equal(h.gc._threadPinned, false, 'and off the newest line');
  assert.deepEqual(h.patches, [[501, true]], 'flashed, as a quote\'s jump-to-original is');
  assert.ok(h.timers.find(([, ms]) => ms === 1500));
  assert.equal(h.gc._pendingThreadReveal, null, 'and the request is spent');
});

test('Reply on a thread already open reveals at once; an old request lapses', () => {
  const h = threadSetup();
  h.open('garden', 'issue', 6994, [501]);
  h.row(501, 900);
  h.gc.revealInThread('garden', 501);
  assert.equal(h.center(501), 400);
  const late = threadSetup();
  late.gc.revealInThread('garden', 501);
  late.gc._pendingThreadReveal.at -= late.gc.REVEAL_TTL_MS + 1;
  late.open('garden', 'issue', 6994, [501]);
  late.row(501, 900);
  assert.equal(late.gc._applyPendingThreadReveal(), false);
  assert.equal(late.gc._pendingThreadReveal, null);
  // A request with no message does nothing.
  late.gc.revealInThread('garden', null);
  assert.equal(late.gc._pendingThreadReveal, null);
});

test('in the desktop column, the request goes to the column\'s own document, and its page leaves the top to it', () => {
  // The column is its own document (side-panel/embedded.ts): Reply hands the
  // message to its GroupChat once it is up (side-panel/controller.ts).
  const controller = read('frontend/src/features/side-panel/controller.ts');
  assert.match(controller, /export function revealMessage\(slug: string, messageId: number\): void \{/);
  assert.match(controller, /gc\.revealInThread\(want\.slug, want\.id\);/);
  assert.match(controller, /\/\/ Mobile 04: a message the page should open at, asked for while the\s+\/\/ panel's document was still booting\.\s+passReveal\(\);/);
  assert.match(controller, /close,\s+revealMessage,\s+showList,/, 'on the bridge');
  const index = read('frontend/src/features/ai/index.tsx');
  assert.match(index, /if \(openPage\(row\.href, row\.app, row\.title, aboutRow\(row\)\) && messageId && slug\) sidePanel\(\)\?\.revealMessage\?\.\(slug, messageId\);/);
  // A request's page holds its top while it settles (#6604), unless the
  // thread is bringing a message into view.
  const head = read('frontend/src/features/dev-board/topic/request-head.tsx');
  assert.match(head, /GroupChat\?\.threadRevealAsked\?\.\(\)\) return undefined;\s+return holdTopInView\(document\.getElementById\('gc-thread-scroll'\)\);/);
  const h = threadSetup();
  assert.equal(h.gc.threadRevealAsked(), false);
  h.gc.revealInThread('garden', 501);
  assert.equal(h.gc.threadRevealAsked(), true, 'asked');
  h.open('garden', 'issue', 6994, [501]);
  h.row(501, 1400);
  h.gc._applyPendingThreadReveal();
  assert.equal(h.gc._pendingThreadReveal, null);
  assert.equal(h.gc.threadRevealAsked(), true, 'and held in view a moment after');
  h.gc._threadRevealHeldUntil = Date.now() - 1;
  assert.equal(h.gc.threadRevealAsked(), false, 'then the page is the reader\'s');
});
