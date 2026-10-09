// #4453: a request's page, drawn as a Messages reply thread.
//
// The request is the root post (features/dev-board/topic/request-head.tsx),
// its replies one stream in the order they were written, wherever they were
// written (features/group-chat/transcript.tsx `RequestRows`), and the rule
// for which rows are a spec and which are the same spec twice is
// features/dev-board/topic/request-model.ts. The issue row's half is
// AppView's (`_requestView`, `_requestStatusView`, `_requestMenuItems`,
// `_requestThreadRows`) and the merge by time is GroupChat's.
//
// Run with: node --test tests/request-thread-page.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const MODEL = 'frontend/src/features/dev-board/topic/request-model.ts';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';
const SHOTS = 'frontend/src/features/dev-board/topic/shot-comments.tsx';

const row = (patch) => ({
  id: null, kind: 'message', username: 'maya', time: '09:05 AM',
  timeTitle: 'Oct 8, 2026, 09:05 AM', at: '2026-10-08T09:05:00Z', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false,
  flash: false, showEdit: false, showBookmark: false, showReact: false, quote: null,
  reactions: [], attachments: [], voteRowClass: '', voteRef: null, specShare: null,
  event: null, eventHref: null,
  ...patch,
});

const specShare = (version, patch = {}) => ({
  title: 'Topics as channels', previewTitle: 'Topics as channels', sharedBy: 'evan', version,
  built: null, prNumber: null, sessionId: 7296, snippetHtml: null, snippetText: null, ...patch,
});

const botSpecComment = row({
  kind: 'github', key: 'g1', username: 'usernode-bot', bodyHtml: '', at: '2026-10-08T19:58:30Z',
  githubSpec: { title: 'Topics as channels', markdown: 'The spec', html: '<p>The spec</p>' },
});

test('the bot\'s GitHub copy of a spec posted here is the same posting twice, and leaves the stream', () => {
  const { requestStream } = loadTsx(MODEL);
  const rows = [
    row({ id: 1, kind: 'spec_share', specShare: specShare(1), at: '2026-10-08T19:58:25Z' }),
    botSpecComment,
    row({ id: 2, kind: 'spec_share', specShare: specShare(2), at: '2026-10-08T21:00:00Z' }),
  ];
  const out = requestStream(rows);
  assert.equal(out.rows.length, 2, 'the mirror is gone');
  assert.ok(!out.rows.some((m) => m.kind === 'github'));
  assert.equal(out.specs.length, 1, 'one card per spec');
  assert.equal(out.specs[0].version, 2, 'at its newest version');
  assert.equal(out.specs[0].read.kind, 'shared');
});

test('with no posting in the thread, the bot\'s spec comment is the spec: a card, by Homeroom bot', () => {
  const { requestStream } = loadTsx(MODEL);
  const out = requestStream([row({ id: 1 }), botSpecComment]);
  assert.equal(out.rows.length, 2);
  assert.equal(out.specs.length, 1);
  assert.equal(out.specs[0].by, 'Homeroom bot');
  assert.equal(out.specs[0].version, null);
  assert.equal(out.specs[0].read.kind, 'text');
});

test('the stage: no spec is Asked, a spec is Spec, and the row\'s Built or Voted in wins', () => {
  const { requestStage, replyCount, eventText } = loadTsx(MODEL);
  assert.equal(requestStage('asked', 0), 'asked');
  assert.equal(requestStage('asked', 1), 'spec');
  assert.equal(requestStage('built', 1), 'built');
  assert.equal(requestStage('voted', 0), 'voted');
  assert.equal(replyCount([row({}), row({ kind: 'github' }), row({ kind: 'system' }), botSpecComment]), 2,
    'people count, notices and specs do not');
  assert.equal(eventText(row({ kind: 'system', systemText: 'evan claimed this issue' })), 'evan started working on this');
});

test('the stream: "N replies", a GitHub reply in the same row with "· on GitHub", events as lines', () => {
  const view = {
    lead: { earlier: false, placeholder: null, language: 'request', request: { loaded: true, githubMore: null } },
    messages: [
      row({ id: 1, username: 'jordan', bodyHtml: '<p>Would topics replace categories?</p>' }),
      row({ kind: 'github', key: 'c1', username: 'priya', bodyHtml: '<p>+1 for onboarding</p>' }),
      row({ id: 3, kind: 'system', systemText: 'evan claimed this issue' }),
      row({ id: 4, kind: 'spec_share', specShare: specShare(1) }),
      botSpecComment,
    ],
  };
  const html = renderComponent(TRANSCRIPT, 'RequestRows', { view });
  assert.match(html, /class="messages-reply-count"[^>]*><span>2 replies<\/span>/);
  assert.match(html, /gc-msg gc-msg-github[\s\S]*?priya[\s\S]*?· on GitHub/);
  assert.match(html, /data-request-event="claim"[\s\S]*?<b>evan<\/b> started working on this/);
  assert.match(html, /data-request-event="spec"[\s\S]*?<b>evan<\/b> posted plan v1[\s\S]*?>Read</);
  assert.doesNotMatch(html, /Homeroom bot/, 'the bot\'s copy of the posting is not drawn');
});

test('an empty stream says so once its history is in, and "Loading replies…" before', () => {
  const lead = (loaded) => ({ earlier: false, placeholder: null, language: 'request', request: { loaded } });
  assert.match(renderComponent(TRANSCRIPT, 'RequestRows', { view: { lead: lead(true), messages: [] } }), /No replies yet/);
  assert.match(renderComponent(TRANSCRIPT, 'RequestRows', { view: { lead: lead(false), messages: [] } }), /Loading replies…/);
});

const requestView = (status) => ({
  number: 4417, category: 'Communities & projects', menuKey: 'request:4417', asker: 'evan',
  askedAt: '2026-10-08T14:01:11Z', askedTime: '04:01 PM', askedTitle: 'Oct 8, 2026, 04:01 PM',
  title: 'Add topics as discussion containers', titleEditing: null,
  bodyHtml: '<div class="dev-issue-body"><p>Consider topics.</p></div>',
  editor: { issue: 4417, markdown: 'Consider topics.', source: '**Source:** Homeroom admin (evan)', canEdit: true },
  status: {
    stage: 'asked', lead: 'You’re working on this.', note: null,
    fine: 'If nothing moves by Oct 15, it opens up for someone else.',
    action: { label: 'Continue your work', act: { fn: 'openChangeWorkspace', args: [1] } }, closed: null,
    ...status,
  },
});

test('the root post: who asked and when, the title in bold, the words as a quote, then where it stands', () => {
  const html = renderComponent(HEAD, 'RequestHead', { r: requestView() });
  assert.match(html, /<article class="messages-message dev-request-root" data-ref-issue="4417"/);
  assert.match(html, /messages-message-author">evan<\/span><time[^>]*>04:01 PM<\/time>/);
  assert.match(html, /<h1 class="dev-request-title" data-issue-title="4417">Add topics as discussion containers<\/h1>/);
  assert.match(html, /class="dev-request-ask"><div class="dev-request-ask-text line-clamp-4"/);
  assert.match(html, /data-request-stage="asked"/);
  // The stepper: Asked is where it is, the rest still to come.
  assert.match(html, /data-state="now" aria-current="step"><span class="dev-request-step-mark"><\/span><span class="dev-request-step-label">Asked/);
  assert.equal((html.match(/data-state="next"/g) || []).length, 3);
  assert.match(html, /dev-request-say">You’re working on this\.<\/p><p class="dev-request-fine">If nothing moves by Oct 15/);
  assert.match(html, /data-act="openChangeWorkspace"[^>]*>Continue your work</);
});

test('voted in: every step is done, with no fill; a closed request says so instead of the stepper', () => {
  const voted = renderComponent(HEAD, 'RequestHead', { r: requestView({ stage: 'voted', lead: 'Voted in.', action: null }) });
  assert.equal((voted.match(/data-state="done"/g) || []).length, 4);
  const closed = renderComponent(HEAD, 'RequestHead', { r: requestView({ closed: 'This request was closed by vote.', action: null }) });
  assert.doesNotMatch(closed, /dev-request-steps/);
  assert.match(closed, /This request was closed by vote\./);
});

// ── #4482: the pinned comment as an overlay ───────────────────────────

const PIN_BODY = '<div class="dev-issue-body"><p>Look at this.</p>'
  + '<a class="dc-inline-img-link" href="https://app.example/issue-images/ab12cd34ab12cd34ab12cd34ab12cd34" target="_blank">'
  + '<img class="dc-inline-img" src="https://app.example/issue-images/ab12cd34ab12cd34ab12cd34ab12cd34" alt="Screenshot"></a></div>';

test('the overlay: pin, bubble and toggle over the measured image, hidden together', () => {
  const { ShotCommentOverlay } = loadTsx(SHOTS);
  const box = { left: 4, top: 6, width: 400, height: 225 };
  const props = (shown) => ({
    pin: { id: 'ab12cd34ab12cd34ab12cd34ab12cd34', pinX: 100, pinY: 50, comment: 'This drifts on mobile' },
    box,
    natural: { w: 800, h: 450 },
    shown,
    onToggle: () => {},
  });
  const html = renderToHtml(createElement(ShotCommentOverlay, props(true)));
  // The layer takes no taps, so the picture's own link underneath still opens the viewer.
  assert.match(html, /data-shot-comment-overlay=""/);
  assert.match(html, /data-shot-comment-pin=""/);
  // The pin by fraction: 100/800 of 400 = 50 across, 50/450 of 225 = 25
  // down, from the image's own box at (4, 6) inside the container.
  assert.match(html, /left:54px;top:31px/);
  // The bubble with the stored words, as React text children.
  assert.match(html, /data-shot-comment-bubble=""/);
  assert.match(html, /This drifts on mobile/);
  // The pill in the picture's corner, pressed while the comment shows.
  assert.match(html, /data-shot-comment-toggle=""[^>]*aria-pressed="true"/);
  assert.match(html, /Hide comment/);

  const hidden = renderToHtml(createElement(ShotCommentOverlay, props(false)));
  assert.doesNotMatch(hidden, /data-shot-comment-pin/);
  assert.doesNotMatch(hidden, /data-shot-comment-bubble/);
  assert.match(hidden, /data-shot-comment-toggle=""[^>]*aria-pressed="false"/);
  assert.match(hidden, /Show comment/);
});

test('the overlay lands the pin right at any display size, by the image\'s fractions', () => {
  const { ShotCommentOverlay } = loadTsx(SHOTS);
  const render = (box) => renderToHtml(createElement(ShotCommentOverlay, {
    pin: { id: 'x'.repeat(32), pinX: 320, pinY: 180, comment: '' },
    box,
    natural: { w: 640, h: 360 },
    shown: true,
    onToggle: () => {},
  }));
  // Half across, half down: the same fractions at any rendered size.
  assert.match(render({ left: 0, top: 0, width: 400, height: 225 }), /left:200px;top:112.5px/);
  assert.match(render({ left: 12, top: 9, width: 320, height: 180 }), /left:172px;top:99px/);
});

test('an unmeasured image draws nothing; a screenshot without words draws only the pin and the pill', () => {
  const { ShotCommentOverlay } = loadTsx(SHOTS);
  const nothing = renderToHtml(createElement(ShotCommentOverlay, {
    pin: { id: 'x'.repeat(32), pinX: 1, pinY: 1, comment: 'words' },
    box: null,
    natural: null,
    shown: true,
    onToggle: () => {},
  }));
  assert.equal(nothing, '');
  const pinOnly = renderToHtml(createElement(ShotCommentOverlay, {
    pin: { id: 'x'.repeat(32), pinX: 10, pinY: 10, comment: null },
    box: { left: 0, top: 0, width: 300, height: 169 },
    natural: { w: 600, h: 338 },
    shown: true,
    onToggle: () => {},
  }));
  assert.match(pinOnly, /data-shot-comment-pin/);
  assert.doesNotMatch(pinOnly, /data-shot-comment-bubble/);
});

test('the hook reads only the body\'s own /issue-images/ ids, deduped', () => {
  const { shotIdsIn } = loadTsx(SHOTS);
  const html = '<a href="https://app.example/issue-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"><img src="/issue-images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"></a>'
    + '<img src="https://github.com/user-attachments/assets/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">';
  assert.deepEqual(shotIdsIn(html), ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'], 'a GitHub-hosted image is never looked up');
  assert.deepEqual(shotIdsIn('<p>no pictures</p>'), []);
  assert.deepEqual(shotIdsIn('/issue-images/cccccccccccccccccccccccccccccccc /issue-images/cccccccccccccccccccccccccccccccc'),
    ['cccccccccccccccccccccccccccccccc'], 'one pin per picture, however often the id appears');
});

test('a request without a pinned screenshot renders exactly as it did', () => {
  // renderToStaticMarkup runs no effects, so the pins map is empty here —
  // which is precisely the unpinned state: no relative container, no overlay.
  const withShot = { ...requestView(), bodyHtml: PIN_BODY };
  const html = renderComponent(HEAD, 'RequestHead', { r: withShot });
  assert.match(html, /class="dev-request-ask">/, 'no positioning class when nothing is pinned');
  assert.doesNotMatch(html, /data-shot-comment-overlay/);
  assert.match(html, /dc-inline-img-link/, 'the picture itself is untouched');
  const plain = renderComponent(HEAD, 'RequestHead', { r: requestView() });
  assert.match(plain, /class="dev-request-ask">/);
});

function appView(username = 'evan', globals = {}) {
  const c = {
    ...globals,
    console,
    App: { user: { id: 42, username, canAdminWrite: !!globals.admin }, currentApp: 'example', currentTab: 'dev' },
    relTime: () => 'just now',
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener() {},
    dispatchEvent() {},
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  c.av.appData = { slug: 'example', can_collaborate: true };
  c.av._govProposals = [];
  return c.av;
}

const issue = (patch = {}) => ({
  number: 4417, state: 'open', title: 'Add topics', created_by_username: 'evan',
  body: '**Source:** Homeroom admin (evan)\n\nConsider "topics" as other channels.',
  createdAt: '2026-10-08T14:01:11Z', bounty_count: 0, chatCount: 0, in_progress: null,
  category: { top: null }, priority: { top: null }, assignee: { top: null },
  ...patch,
});

test('the page leaves the Source line out of the words, and the editor puts it back', () => {
  const av = appView();
  const row = issue();
  av._ghIssues = [row];
  const r = av._topicViewFor('issue', row).body.request;
  assert.doesNotMatch(r.bodyHtml, /Source/);
  assert.match(r.bodyHtml, /Consider/);
  assert.equal(r.editor.source, '**Source:** Homeroom admin (evan)');
  assert.equal(r.editor.markdown, 'Consider "topics" as other channels.');
  assert.equal(r.asker, 'evan');
  assert.equal(r.askedAt, '2026-10-08T14:01:11Z');
});

test('the status sentence says who is on it once, and when the claim lapses', () => {
  const av = appView();
  const expiresAt = '2026-10-15T13:00:00Z';
  const mine = av._requestStatusView(issue({
    in_progress: { claims: [{ username: 'evan', mine: true, claimedAt: '2026-10-08T13:00:00Z', expiresAt }], sessions: [], users: [], count: 0 },
  }));
  assert.equal(mine.stage, 'asked');
  assert.equal(mine.lead, 'You’re working on this.');
  assert.match(mine.fine, /^If nothing moves by .+, it opens up for someone else\.$/);
  const nobody = av._requestStatusView(issue());
  assert.equal(nobody.lead, 'Nobody is working on this yet.');
  const merged = av._requestStatusView(issue({ addressed_by: { sessionId: 9, state: 'merged', prNumber: 12, title: 'Topics' } }));
  assert.equal(merged.stage, 'voted');
  assert.equal(merged.action.label, 'See the change');
  const underway = av._requestStatusView(issue({ myPrSessionId: 77, addressed_by: { sessionId: 77, state: 'underway', title: 'Topics' } }));
  assert.equal(underway.stage, 'built');
  assert.equal(underway.action.label, 'Continue your work');
  assert.deepEqual(JSON.parse(JSON.stringify(underway.action.act)), { fn: 'openChangeWorkspace', args: [77] });
});

test('⋯ holds the work rows first, then the author\'s edits and the tags', () => {
  const av = appView();
  const row = issue({ myPrSessionId: 77 });
  av._ghIssues = [row];
  const labels = JSON.parse(JSON.stringify(av._requestMenuItems(row).map((item) => item.label)));
  assert.deepEqual(labels.slice(0, 4), ['Start more work', 'Claim it', 'Edit title', 'Edit request']);
  assert.ok(labels.includes('Set priority…') && labels.includes('Set category…') && labels.includes('Assign someone…'));
  assert.ok(labels.indexOf('Assign someone…') < labels.indexOf('Open on GitHub') || !labels.includes('Open on GitHub'));
});

test('an admin can release somebody else\'s claim from ⋯, and nobody else is offered it', () => {
  const claimed = issue({
    in_progress: { claims: [{ username: 'maya', userId: 7, mine: false, claimedAt: '2026-10-08T13:00:00Z' }], sessions: [], users: [], count: 0 },
  });
  const admin = appView('evan', { admin: true });
  admin._ghIssues = [claimed];
  assert.ok(admin._requestMenuItems(claimed).some((item) => item.label === 'Release maya’s claim'));
  const member = appView('evan');
  member._ghIssues = [claimed];
  assert.ok(!member._requestMenuItems(claimed).some((item) => /^Release/.test(item.label)));
});

test('GitHub comments become stream rows; Homeroom bot\'s spec rides as githubSpec, not as words', () => {
  const av = appView();
  const row = issue({ htmlUrl: 'https://github.com/o/r/issues/4417' });
  av._ghIssues = [row];
  av._ghComments.set(av._ghCommentsKey('example', 4417), {
    truncated: true,
    comments: [
      { id: 5, author: 'priya', body: '+1', createdAt: '2026-10-08T20:11:00Z' },
      { id: 6, author: 'usernode-bot', body: 'evan posted a spec.\n\n<details><summary>The spec</summary>\n\n# Topics\n\nThe body\n\n</details>', createdAt: '2026-10-08T19:58:25Z' },
    ],
  });
  const out = av._requestThreadRows(4417);
  assert.equal(out.truncated, true);
  assert.equal(out.htmlUrl, 'https://github.com/o/r/issues/4417');
  assert.equal(out.rows[0].kind, 'github');
  assert.equal(out.rows[0].key, '5');
  assert.equal(out.rows[0].githubSpec, null);
  assert.equal(out.rows[1].githubSpec.title, 'Topics');
  assert.equal(out.rows[1].bodyHtml, '');
  assert.equal(av._requestThreadRows(1), null, 'nothing until the comments are in hand');
});

function groupChat() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' }, URLSearchParams,
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({ style: {} }) },
    window: { matchMedia: () => ({ matches: false }) }, navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } }, console,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}

test('GitHub comments are slotted into the thread by time, and the thread\'s own order is kept', () => {
  const GroupChat = groupChat();
  const hr = [
    { id: 1, at: '2026-10-08T09:00:00Z' },
    { id: 2, at: '2026-10-08T11:00:00Z' },
    // Same instant as the one before it, and then an older one: a run the
    // repeat fold reads in the server's order.
    { id: 3, at: '2026-10-08T11:00:00Z' },
    { id: 4, at: '2026-10-08T10:59:00Z' },
  ];
  const gh = [{ key: 'b', at: '2026-10-08T12:00:00Z' }, { key: 'a', at: '2026-10-08T10:00:00Z' }];
  const merged = JSON.parse(JSON.stringify(GroupChat._mergeByTime(hr, gh).map((r) => r.id || r.key)));
  assert.deepEqual(merged, [1, 'a', 2, 3, 4, 'b']);
});
