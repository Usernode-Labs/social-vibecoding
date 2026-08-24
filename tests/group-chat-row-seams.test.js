// The two contracts a group chat row hands back to public/js/group-chat.js:
// the vote-controls host and the quoted-reply block.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// Both are places where the React row and the module have to agree on an
// attribute, and both were silently wrong after the transcript's conversion:
//
//   * The vote row rendered `<span data-gc-vote-controls="5">` — but
//     `refreshVoteControls` selects `[data-vote-controls]` and reads
//     `data-session-id` / `data-pr-number` off the element it finds. The
//     selector matched nothing, so every vote row showed a plain activity
//     line with no tally pill and no Yes/No pair.
//   * The quoted reply rendered `ThreadReplySummary` — the widget language's
//     "N replies" control for a THREAD — so it read "1 reply alice", lost the
//     snippet and the source icon, and carried none of the `data-quote-*`
//     attributes `_handleQuotedClick` dispatches on. Its onClick called a
//     `scrollToMessage` that is not a method of the module.
//
// An attribute contract is exactly the kind of thing a renderer swap breaks
// without breaking anything that was being watched, so it gets watched here:
// the module's selectors are read out of group-chat.js and matched against
// what the component actually renders.
//
// Run with: node --test tests/group-chat-row-seams.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadTsx, renderComponent } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const gcJs = read('public/js/group-chat.js');
const stripped = gcJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const base = {
  id: 5, kind: 'system', username: '', time: '', bodyHtml: '', systemText: 'admin promoted PR #12 for a vote',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
  showEdit: false, showBookmark: true, showReact: true, quote: null, reactions: [],
  attachments: [], voteRowClass: '', voteRef: null, specShare: null,
};

// ── The vote-controls host ────────────────────────────────────────────

test('the host carries exactly what refreshVoteControls selects and reads', () => {
  const html = renderComponent(TRANSCRIPT, 'SystemRow', {
    msg: { ...base, kind: 'vote', voteRef: { sessionId: '9000401', prNumber: '12' } },
  });
  // Read the selector out of the module rather than restating it, so a change
  // at either end has to be a change at both.
  const selector = stripped.match(/document\.querySelectorAll\('([^']*data-vote-controls[^']*)'\)/);
  assert.ok(selector, 'located the refresh selector');
  assert.match(selector[1], /#gc-messages \[data-vote-controls\]/);
  assert.match(selector[1], /#gc-thread-messages \[data-vote-controls\]/);

  assert.match(html, /<span class="gc-vote-inline" data-vote-controls=""/);
  assert.match(html, /data-session-id="9000401"/);
  assert.match(html, /data-pr-number="12"/);
  // The two attributes it reads back, named in the module, present in the row.
  assert.match(stripped, /el\.getAttribute\('data-session-id'\)/);
  assert.match(stripped, /el\.getAttribute\('data-pr-number'\)/);
  // …and the row it walks up to for the tint.
  assert.match(html, /class="gc-msg-system gc-msg-vote[^"]*"/);
  assert.match(stripped, /el\.closest\('\.gc-msg-vote\[data-msg-id\]'\)/);
});

test('the host is emitted for vote rows and nothing else', () => {
  const plain = renderComponent(TRANSCRIPT, 'SystemRow', { msg: base });
  assert.ok(!plain.includes('data-vote-controls'), 'an ordinary system row has no host');
  // A vote row whose ref could not be derived draws no host either — the same
  // "nothing to resolve, fall back to a plain activity line" the module has.
  const unrefd = renderComponent(TRANSCRIPT, 'SystemRow', { msg: { ...base, kind: 'vote' } });
  assert.ok(!unrefd.includes('data-vote-controls'));
});

test('the module derives the ref from metadata, then from the row text', () => {
  const GroupChat = loadGroupChat();
  const view = (msg) => JSON.parse(JSON.stringify(GroupChat._messageView(msg)));
  const tagged = view({
    id: 5, userId: 2, username: 'admin', content: 'admin promoted PR #12 for a vote',
    msgType: 'vote', createdAt: '2026-07-20T12:00:00.000Z',
    metadata: { vote: { sessionId: 9000401 } },
  });
  assert.equal(tagged.kind, 'vote');
  assert.deepEqual(tagged.voteRef, { sessionId: '9000401', prNumber: '12' });

  // Older rows predate the metadata tag and carry only the parsed number.
  const parsed = view({
    id: 6, userId: 2, username: 'admin', content: 'admin promoted PR #7 for a vote',
    msgType: 'vote', createdAt: '2026-07-20T12:00:00.000Z', metadata: {},
  });
  assert.deepEqual(parsed.voteRef, { sessionId: '', prNumber: '7' });

  assert.equal(view({
    id: 7, userId: 2, username: 'bob', content: 'hi',
    msgType: 'message', createdAt: '2026-07-20T12:00:00.000Z',
  }).voteRef, null, 'ordinary rows carry none');
});

test('the tint goes through the model, and the fill does not', () => {
  const refresh = stripped.match(/refreshVoteControls\(\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(refresh, 'refreshVoteControls() found');
  // The host's contents stay the module's — this is AppView's markup.
  assert.match(refresh[1], /el\.innerHTML = GroupChat\._voteInnerHtml\(pr\)/);
  // The row's class is React's, so it is patched, not written.
  assert.doesNotMatch(refresh[1], /classList/,
    'no class is written onto a row the transcript renders');
  assert.match(refresh[1], /patchTranscriptMessage\(id, \{ voteRowClass: GroupChat\._rowVoteClass\(pr\) \}\)/);
  // And the component renders that class.
  const html = renderComponent(TRANSCRIPT, 'SystemRow', {
    msg: { ...base, kind: 'vote', voteRowClass: 'gc-vote-voted', voteRef: { sessionId: '1', prNumber: '' } },
  });
  assert.match(html, /class="gc-msg-system gc-msg-vote gc-vote-voted"/);
});

test('a patch that says nothing new is not a state change', () => {
  // The loop guard. `refreshVoteControls` runs from an effect after the
  // transcript renders, and it patches every vote row's tint — so a patch
  // that always produced a new object would render, patch, render, forever.
  const api = loadTsx('tests/fixtures/group-chat-transcript-api.ts');
  const row = { ...base, id: 11, kind: 'vote', voteRowClass: 'gc-vote-unvoted' };
  api.publishTranscript([row]);
  const before = api.transcriptStore.get();

  api.patchTranscriptMessage(11, { voteRowClass: 'gc-vote-unvoted' });
  assert.equal(api.transcriptStore.get(), before, 'an identical patch changes nothing at all');

  api.patchTranscriptMessage(11, { voteRowClass: 'gc-vote-voted' });
  const after = api.transcriptStore.get();
  assert.notEqual(after, before, 'a real one does');
  assert.equal(after.byKey.main.messages[0].voteRowClass, 'gc-vote-voted');

  // A patch for a row that is not there is a no-op, not an append.
  api.patchTranscriptMessage(999, { voteRowClass: 'gc-vote-voted' });
  assert.equal(api.transcriptStore.get(), after);
  assert.equal(api.transcriptStore.get().byKey.main.messages.length, 1);
});

test('the transcript fills new vote rows itself', () => {
  // `AppView.loadVotePanel` refreshes when the vote state moves, which does
  // not cover a vote row ARRIVING on a transcript that already rendered, nor
  // a first paint after the panel finished loading. The string renderer had
  // no such gap — it filled the wrapper as it built the row.
  const tsx = read(TRANSCRIPT);
  assert.match(tsx, /controller\(\)\?\.refreshVoteControls\?\.\(\)/);
  // Keyed on which vote rows are present, not on every render.
  assert.match(tsx, /\}, \[voteRows\]\)/);
  assert.match(tsx, /\.filter\(\(m\) => m\.kind === 'vote'\)/);
});

// ── The quoted reply ──────────────────────────────────────────────────

const quote = (over) => ({
  icon: '↩', username: 'alice', excerpt: 'the original message',
  source: 'message', href: null, targetId: 42, ...over,
});

const quoted = (over) => renderComponent(TRANSCRIPT, 'MessageRow', {
  msg: {
    ...base, kind: 'message', username: 'bob', time: '10:00', bodyHtml: 'hi',
    quote: quote(over),
  },
});

test('a quoted reply draws its icon, who, and the snippet', () => {
  const html = quoted();
  assert.match(html, /<span class="gc-quoted-author">↩ alice<\/span>/);
  assert.match(html, /<span class="gc-quoted-snippet">the original message<\/span>/);
  // Not "1 reply", which is the thread control and a different sentence.
  assert.ok(!/\breply\b/.test(html), 'no thread-reply wording');

  assert.match(quoted({ source: 'pr', username: 'PR #12', icon: '🔀', href: '/x' }),
    /class="gc-quoted-author">🔀 PR #12</);
  assert.match(quoted({ source: 'spec', icon: '📋' }), /class="gc-quoted-author">📋 alice</);
});

test('the block carries what _handleQuotedClick dispatches on', () => {
  const handler = stripped.match(/_handleQuotedClick\(quoted\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(handler, '_handleQuotedClick() found');
  assert.match(handler[1], /quoted\.dataset\.quoteSource === 'pr'/);
  assert.match(handler[1], /quoted\.dataset\.quoteHref/);
  assert.match(handler[1], /quoted\.dataset\.quoteRef/);
  // The delegated listener finds it by class, before its "real links and
  // buttons win" rule.
  assert.match(stripped, /const quoted = e\.target\.closest\('\.gc-quoted'\)/);

  const jump = quoted();
  assert.match(jump, /class="gc-quoted" data-quote-source="message" data-quote-ref="42"/);
  assert.ok(!jump.includes('data-quote-href'), 'a jump quote has no href');

  const pr = quoted({ source: 'pr', href: 'https://example.test/pr/12' });
  assert.match(pr, /data-quote-source="pr" data-quote-href="https:\/\/example.test\/pr\/12"/);
  assert.ok(!pr.includes('data-quote-ref'), 'a PR quote opens a link instead');
});

test('a hostile author or snippet reaches the DOM as text', () => {
  const html = quoted({ username: '<img src=x onerror=alert(1)>', excerpt: '</div><script>x</script>' });
  assert.ok(!html.includes('<img'), 'the tag never lands as markup');
  assert.ok(!html.includes('<script'), 'nor does the script');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the jump highlight is a field, not a class written onto the row', () => {
  const handler = stripped.match(/_handleQuotedClick\(quoted\) \{([\s\S]*?)\n {2}\},/)[1];
  assert.doesNotMatch(handler, /classList/, 'nothing writes a class onto a React-rendered row');
  assert.match(handler, /patchTranscriptMessage\(ref, \{ flash: true \}\)/);
  assert.match(handler, /setTimeout\(\(\) => [\s\S]{0,60}?patchTranscriptMessage\(ref, \{ flash: false \}\), 1500\)/);
  assert.match(handler, /scrollIntoView/, 'and the scroll is still a DOM call, which is fine');

  // Every row kind can be the target of a jump, so every row kind draws it.
  for (const [name, msg] of [
    ['MessageRow', { ...base, kind: 'message', username: 'bob', time: '1', bodyHtml: 'x' }],
    ['SystemRow', { ...base }],
  ]) {
    assert.ok(!renderComponent(TRANSCRIPT, name, { msg }).includes('gc-msg-flash'));
    assert.match(renderComponent(TRANSCRIPT, name, { msg: { ...msg, flash: true } }), /gc-msg-flash/);
  }
});

// group-chat.js is a classic script with no exports.
function loadGroupChat() {
  const document = {
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get innerHTML() { return this._t || ''; } }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    window: { matchMedia: () => ({ matches: false }) },
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  return sandbox.__M.GroupChat;
}
