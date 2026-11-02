'use strict';

// One page per thread (1 Nov 2026): a change built for a request has no page
// of its own; the request's page is the thread's page. Without a database
// (the server's half runs against PostgreSQL in thread-one-page-postgres.test.js
// and app-chat-postgres.test.js), this pins:
//
//   D1. The change's section carries what its page had: its status pill and
//       its own ⋯ (its view's `detail:` rows), its summary, a small before
//       and after whose Expand opens its page's viewer, and the sheets its ⋯
//       and Testing card open. Its title is no door: this is its page.
//   D2. Its addresses land on the request's page at it, in place, with its
//       Votes card in view; a change with no request keeps its page.
//   D3. One discussion: a change's rows are in the request's stream, tagged
//       with the change, and of what happened only the lines worth keeping;
//       a live row of one of its changes reaches the open request page.
//   D4. A change for this request on another request's page is one line
//       that says where.
//   D5. Competing changes fold under their ballot, with no Vote of their own.
//
// Run with: node --test tests/thread-one-page.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { message, englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TOPIC = 'frontend/src/features/dev-board/topic';

const thread = (items, extra = {}) => ({
  thread: { id: 3, number: 10, kind: 'work', lead: 'request', title: null, state: 'open' },
  items,
  follow: null,
  ...extra,
});
const request = { type: 'request', id: 1, number: 10, title: 'Pin a message', status: 'open', replies: 2 };
const review = (id, number, closes = [10]) => ({
  type: 'change', id, number, title: `Change ${number}`, status: 'promoted', state: 'review', replies: 0, by: 'dewi', closes,
});

test('D3: a change\'s rows the request\'s page keeps: people, and only the events worth a line', () => {
  const { keptOnRequest } = loadTsx(`${TOPIC}/change-model.ts`);
  const row = (extra) => ({ id: 1, kind: 'system', systemText: '', specShare: null, ...extra });
  assert.equal(keptOnRequest(row({ kind: 'message' })), true, 'a reply');
  assert.equal(keptOnRequest(row({ kind: 'vote', event: { type: 'vote', actor: 'ana', vote: 'yes', reason: 'Small and right' } })), true, 'a vote with its reason');
  assert.equal(keptOnRequest(row({ kind: 'vote', event: { type: 'vote', actor: 'ana', vote: 'yes', reason: '' } })), false, 'a bare vote is the Votes card\'s');
  assert.equal(keptOnRequest(row({ kind: 'vote', event: { type: 'submitted', actor: 'dewi' } })), true, 'asked for approval');
  assert.equal(keptOnRequest(row({ stagingBuild: 'ready' })), true, 'the preview is ready');
  assert.equal(keptOnRequest(row({ stagingBuild: 'started' })), false, 'the build started is the Testing card\'s');
  assert.equal(keptOnRequest(row({ event: { type: 'merged', actor: '' }, systemText: 'Merged' })), true, 'it went live');
  assert.equal(keptOnRequest(row({ event: { type: 'notice', text: 'Checks passed.' } })), false, 'a notice is its cards\'');
  assert.equal(keptOnRequest(row({ kind: 'spec_share', specShare: { sharedBy: 'ana', version: 2, title: 'Pins' } })), true, 'a plan posted');
});

test('D3: the stream tags a change\'s rows with it, and keeps a reply on it apart from one on the request', () => {
  const src = read('frontend/src/features/group-chat/transcript.tsx');
  const rows = src.slice(src.indexOf('export function RequestRows('), src.indexOf('#4455: something that happened to a change'));
  assert.match(rows, /foldRepeats\(view\.messages\)\.filter\(\(m\) => !m\.changeOf \|\| keptOnRequest\(m\)\)/);
  assert.match(rows, /<ChangeEvent key=\{key\} msg=\{msg\} changeId=\{msg\.changeOf\.sessionId\} tag=\{tagOf\(msg\)\} \/>/);
  assert.match(rows, /<MessageRow key=\{key\} msg=\{msg\} grouped=\{grouped\} surface="thread" tag=\{tagOf\(msg\)\} \/>/);
  assert.match(rows, /\(previous\.changeOf\?\.sessionId \?\? null\) === \(msg\.changeOf\?\.sessionId \?\? null\)/);
  assert.equal(message('project:topic.request.stream.onChange', { number: 6063 }), 'on Change #6063');
  assert.equal(message('project:topic.request.stream.onChangeUnnumbered'), 'on a change');
  const { publishRequestChanges, requestChangesStore } = loadTsx(`${TOPIC}/request-model.ts`);
  publishRequestChanges(10, [{ id: 91, number: 6063 }, { id: 92, number: null }]);
  assert.deepEqual(JSON.parse(JSON.stringify(requestChangesStore.get())), { number: 10, numbers: { 91: 6063, 92: null } });
  const head = read(`${TOPIC}/request-head.tsx`);
  assert.match(head, /publishRequestChanges\(r\.number, layout\.changes\);/);
  assert.match(head, /GroupChat\?\.setThreadMembers\?\.\('issue', r\.number, layout\.changes\.map\(\(c\) => c\.id\)\)/);
});

function groupChat() {
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    window: {}, URLSearchParams, location: { search: '' },
    setTimeout, clearTimeout, AbortController,
    document: {
      getElementById: () => null,
      // escapeHtml's text node, enough for a message's words.
      createElement: () => {
        const el = { set textContent(v) { el.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } };
        return el;
      },
    },
    App: { user: { id: 7, username: 'ana' } },
    fetch: () => new Promise(() => {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/group-chat.js'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'club';
  gc.render = gc.renderThread = gc.scrollToBottom = () => {};
  return gc;
}

test('D3: a row of one of its changes reads as that change\'s, and a live one reaches the request\'s page', () => {
  const gc = groupChat();
  const loaded = gc._messageView({ id: 5, user_id: 3, username: 'maya', content: 'Works.', msg_type: 'message', thread_type: 'session', thread_ref: 91 }, { language: 'request' });
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.changeOf)), { sessionId: 91 });
  const own = gc._messageView({ id: 6, user_id: 3, username: 'maya', content: 'Hi', msg_type: 'message', thread_type: 'issue', thread_ref: 10 }, { language: 'request' });
  assert.equal(own.changeOf, undefined, 'the request\'s own reply is untagged');
  const vote = gc._messageView({ id: 8, content: 'dewi voted yes: “Small and right.”', msg_type: 'vote', metadata: { vote: { sessionId: 91, prNumber: 6063 } }, thread_type: 'session', thread_ref: 91 }, { language: 'request' });
  assert.equal(vote.event.type, 'vote', 'its vote reads as an event of the change, with its reason');
  assert.equal(vote.event.reason, 'Small and right.');
  assert.equal(gc._messageView({ id: 9, content: 'x', msg_type: 'message', thread_type: 'session', thread_ref: 91 }, { language: 'change' }).changeOf, undefined,
    'on a change\'s own page nothing is tagged');

  gc.setThreadMembers('issue', 10, [91, 92]);
  gc._intoRequestThreads({ type: 'chat', id: 40, userId: 3, username: 'maya', content: 'Live', msgType: 'message', thread: { type: 'session', ref: 91 } });
  gc._intoRequestThreads({ type: 'chat', id: 41, userId: 3, username: 'maya', content: 'Elsewhere', msgType: 'message', thread: { type: 'session', ref: 99 } });
  gc._intoRequestThreads({ type: 'chat', id: 42, userId: 3, username: 'maya', content: 'On the request', msgType: 'message', thread: { type: 'issue', ref: 10 } });
  const held = gc._threadState('issue', 10).messages;
  assert.deepEqual(JSON.parse(JSON.stringify(held.map((m) => m.id))), [40], 'only its own changes\' rows, once');
  assert.equal(held[0].thread_type, 'session');
  assert.equal(held[0].thread_ref, 91, 'the copy says where it was written');
  assert.equal(gc._messageView(held[0], { language: 'request' }).changeOf.sessionId, 91);
  gc._intoRequestThreads({ type: 'chat', id: 40, content: 'Live', msgType: 'message', thread: { type: 'session', ref: 91 } });
  assert.equal(gc._threadState('issue', 10).messages.length, 1, 'a row already held is not added twice');
  gc.setThreadMembers('issue', 10, []);
  assert.equal(gc._threadMembers.size, 0);
});

test('D1: a change\'s line has its pill and its own ⋯, and its title is no door', () => {
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(src, /const key = view\?\.card\.rail\?\.menuKey \|\| '';/, 'its view\'s own rows (AppView._topicCard registers them)');
  assert.match(src, /<button type="button" className="dev-thread-change-menu" data-card-menu=\{key\} aria-haspopup="true"/);
  assert.match(src, /data-thread-change-status=\{status\.key\}><StatusPill s=\{status\} inline \/>/);
  assert.match(src, /<h3 [^>]*data-thread-change-title=\{item\.id\}>/);
  assert.doesNotMatch(src, /openTopic\('proposal'/, 'nothing here opens a change page any more');
  assert.doesNotMatch(src, /data-thread-earlier/, 'the fold of its earlier replies is gone: they are in the discussion');
  // Its summary, its before and after, and its sheets.
  assert.match(src, /<RequestWords html=\{summary\} \/>/);
  assert.match(src, /viewer\?\.showPopover\?\.\(\)/, 'Expand opens its page\'s own viewer');
  assert.match(src, /<ChangeSheets id=\{item\.id\} row=\{view\.row\} body=\{view\.body\} \/>/);
  const head = read(`${TOPIC}/topic-head.tsx`);
  const sheets = head.slice(head.indexOf('export function ChangeSheets('), head.indexOf('/** The same card on the owner session'));
  assert.match(sheets, /<DetailsSheet\s+id=\{id\}/, 'Details, Shot details and See what failed have their sheet here');
  assert.match(sheets, /<DescriptionEditor key=\{id\} id=\{id\} onSaved=\{\(data\) => av\._cacheDescription\(id, data\)\} \/>/);
  assert.match(sheets, /\{body\.canEditIssues \? \(\s+<IssueAssociations[\s\S]*?editorOnly/, 'and ⋯ Edit requests has its editor');
  assert.match(head, /if \(editorOnly\) \{\s+return editing \|\| notice \? \(/, 'nothing while it is shut');
  const view = read('public/js/app-view.js');
  assert.match(view, /viewer: `shots-\$\{Number\(item\.id\)\}-viewer`/, 'the thumbnails name the viewer their Expand opens');
  for (const id of ['more', 'moreNumbered', 'shotBefore', 'shotAfter', 'shotsOpen', 'shotsExpand']) {
    assert.ok(message(`project:topic.thread.page.${id}`, { number: 6063 }), id);
  }
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-thread-shots-viewer \.shots-viewer:not\(:popover-open\) \{ display: none; \}/, 'shut, the viewer takes no room');
});

test('D1: rendered, a change built for a request is a line with its title, and a ballot\'s folds start shut', () => {
  const html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, review(91, 6063)]), number: 10, changes: [review(91, 6063)], close: null, onChanged: () => {},
  });
  assert.match(html, /data-thread-change="91"/);
  assert.match(html, /<h3 [^>]*data-thread-change-title="91"[^>]*>Change 6063<\/h3>/);
  assert.doesNotMatch(html, /data-thread-change-open/);

  const options = [review(93, 6067), review(94, 6068)];
  const ballot = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, ...options]), number: 10, changes: options, close: null, onChanged: () => {},
  });
  assert.match(ballot, /data-thread-ballot="2"/);
  assert.match(ballot, /data-thread-folds="2"/);
  assert.equal((ballot.match(/data-thread-fold="shut"/g) || []).length, 2, 'D5: each change folds under the ballot');
  assert.equal((ballot.match(/aria-expanded="false"/g) || []).length, 2);
  assert.ok(ballot.indexOf('data-change-gate="ballot"') < ballot.indexOf('data-thread-folds'), 'the ballot stays first');
  assert.equal((ballot.match(/data-change-row-open=/g) || []).length, 2, 'a row\'s title opens its fold');
});

test('#6139: the line under a change says whether it is still being built or finished', () => {
  const underway = { ...review(91, 6063), status: 'active', state: 'underway' };
  const draw = (item) => renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([request, item]), number: 10, changes: [item], close: null, onChanged: () => {},
  });
  const built = draw({ ...underway, ready: true });
  assert.ok(built.includes('data-thread-change-waiting="ready"'));
  assert.ok(built.includes(message('project:topic.thread.page.ready')));
  assert.ok(!built.includes(message('project:topic.thread.page.underway')), 'it does not say it is being built');
  const still = draw(underway);
  assert.ok(still.includes('data-thread-change-waiting="building"'));
  assert.ok(still.includes(message('project:topic.thread.page.underway')));
  assert.equal(message('project:topic.thread.page.ready'), 'Built, and its checks pass. Its votes open once it is put up for a vote.');
});

test('D5: a change folded under its ballot has no Vote of its own', () => {
  const head = read(`${TOPIC}/change-head.tsx`);
  assert.match(head, /<GateCard which="votes" g=\{v\.votes\} action=\{ballot \? null : voteAction\} id=\{id\} \/>/);
  const src = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(src, /<ChangeBody item=\{item\} view=\{view\} plan=\{plan\} ballot \/>/);
  assert.match(src, /<ChangeGates id=\{item\.id\} card=\{view\.card\} v=\{view\.v\} ballot=\{ballot\} \/>/);
  assert.match(src, /querySelector<HTMLElement>\('\[data-change-gate="ballot"\]'\)/, 'a door to one of them lands on the ballot');
});

test('D4: a change for this request on another request\'s page is one line that says where', () => {
  const { elsewhereFor } = loadTsx(`${TOPIC}/thread-model.ts`);
  const elsewhere = [{ id: 91, number: 12, title: 'Pin it', on: 10, request: 11 }, { id: 92, number: 13, title: 'x', on: 11, request: 11 }];
  assert.deepEqual(JSON.parse(JSON.stringify(elsewhereFor(thread([], { elsewhere }), 11))), [elsewhere[0]], 'not one on this very page');
  assert.deepEqual(JSON.parse(JSON.stringify(elsewhereFor(thread([]), 11))), []);
  const html = renderComponent(`${TOPIC}/thread-changes.tsx`, 'ThreadChanges', {
    slug: 'club', data: thread([{ ...request, number: 11 }], { elsewhere }), number: 11, changes: [], close: null, onChanged: () => {},
  });
  assert.match(html, /data-thread-elsewhere="1"/);
  assert.match(html, /Change #12 for this request is on <a [^>]*data-thread-elsewhere-on="10"[^>]*>#10<\/a>/);
  assert.equal(message('project:topic.thread.page.elsewhereUnnumbered', { on: 10 }), 'A change for this request is on <0>#10</0>');
});

test('D2: a change built for a request lands on the request\'s page, at it; one with no request keeps its page', () => {
  const view = read('public/js/app-view.js');
  const sub = view.slice(view.indexOf('  async _renderTopicSubView(content, ref) {'), view.indexOf('    AppView._devTopic = ref.pr\n'));
  assert.match(sub, /if \(\(ref\.kind === 'proposal' \|\| ref\.kind === 'session'\) && ref\.id\) \{/, 'changes, proposals and shared addresses alike');
  assert.match(sub, /const home = await AppView\._requestHomeOf\(ref\.id\);\s+if \(AppView\._devTopic !== asked\) return;\s+if \(home\) \{\s+AppView\._openChangeOnRequest\(home, ref\.id, \{ replaceRoute: true \}\);\s+return;/);
  assert.match(view, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/threads\/change\/\$\{n\}\$\{AppView\._demoQS\(\)\}`\)/);
  const open = view.slice(view.indexOf('  _openChangeOnRequest(number, sessionId, options = {}) {'));
  assert.match(open, /window\.UsernodeReact\?\.devBoard\?\.showVotes\?\.\(sessionId\);/, 'with its Votes card in view');
  assert.match(open, /return AppView\.openTopic\('issue', Number\(number\), options\.replaceRoute \? \{ replaceRoute: true \} : undefined\);/);
  assert.match(view, /if \(options && options\.replaceRoute\) return App\.switchTab\('dev', ref, 'topic', \{ replaceRoute: true \}\);/,
    'in place of the change\'s address, so Back does not bounce');
  const panel = view.slice(view.indexOf('  async openTopicInPanel(kind, id) {'), view.indexOf('  async openTopicInPanel(kind, id) {') + 900);
  assert.match(panel, /if \(home\) return AppView\._openChangeOnRequest\(home, id, \{ panel: true \}\);/, 'the Workshop\'s side panel too');
  const changes = read(`${TOPIC}/thread-changes.tsx`);
  assert.match(changes, /if \(!card \|\| !takeVotesInView\(id\)\) return;/, 'the change\'s section takes the ask');
});
