// A request's GitHub comments, in its page's one stream (#4453).
//
// ── Why this file exists ──────────────────────────────────────────────
//
// The comments are data that is entirely GitHub's: an author name, a
// timestamp, and a body that is arbitrary markdown. They were their own
// thread under the request's card (`#dev-issue-comments`); since #4453 they
// are rows of the request page's Messages thread, merged with its Homeroom
// replies by time (public/js/app-view.js `_requestThreadRows`,
// features/group-chat/transcript.tsx `RequestRows`). The properties worth
// pinning are the same ones, and a conversion can lose any of them silently:
//
//   1. The body goes through the SANITIZER and lands as markup; the author
//      name and the date do not, and land as text.
//   2. The row carries a real stamp (#1808): a day and a time in the
//      reader's zone, never a sliced UTC date.
//   3. A thread GitHub cut short says so, and links out when it can.
//   4. Homeroom bot's spec comment is a spec, not its own markers (#3490).
//
// Run with: node --test tests/dev-issue-comments.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const APP_VIEW = read('public/js/app-view.js');

const github = (over) => ({
  id: null, key: '1', kind: 'github', username: 'evan', time: 'Mar 4, 03:30 PM',
  timeTitle: 'Mar 4, 2026, 03:30 PM', at: '2026-03-04T15:30:00Z', bodyHtml: '<p>hi</p>', systemText: '',
  mine: false, editedTitle: null, unread: false, bookmarked: false, canEdit: false, flash: false,
  showEdit: false, showBookmark: false, showReact: false, quote: null, reactions: [], attachments: [],
  voteRowClass: '', voteRef: null, specShare: null, githubSpec: null, ...over,
});
const render = (messages, request = { loaded: true, githubMore: null }) => renderComponent(TRANSCRIPT, 'RequestRows', {
  view: { lead: { earlier: false, placeholder: null, language: 'request', request }, messages },
});

test('a GitHub comment is the stream\'s named row: avatar, author, its stamp, then "· on GitHub"', () => {
  const html = render([github({}), github({ key: '2', username: 'usernode-bot', time: '', timeTitle: '' })]);
  assert.equal((html.match(/class="[^"]*gc-msg gc-msg-github"/g) || []).length, 2);
  assert.match(html, /data-github-comment="1" data-username="evan"/);
  assert.match(html, /<span class="gc-msg-time" title="Mar 4, 2026, 03:30 PM">Mar 4, 03:30 PM<\/span><span class="gc-msg-via"> · on GitHub<\/span>/);
  // GitHub's bot account is the bot on screen, by its name.
  assert.match(html, />Homeroom bot</);
  // A row with no timestamp omits the stamp rather than drawing an empty span.
  assert.equal((html.match(/class="gc-msg-time"/g) || []).length, 1);
  assert.match(html, /<span class="gc-msg-via">on GitHub<\/span>/);
});

test('the body is markup and everything else is text', () => {
  const html = render([github({
    username: '<img src=x onerror=alert(1)>',
    time: '<b>nope</b>',
    bodyHtml: '<p class="dc-p">Looks like a <strong>race</strong>.</p>',
  })]);
  assert.match(html, /<p class="dc-p">Looks like a <strong>race<\/strong>\.<\/p>/, 'the body is markup');
  assert.ok(!html.includes('<img'), 'the author name is not');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<b>nope'), 'nor is the date');
});

test('a truncated thread says so, and links out when it can', () => {
  const linked = render([github({})], { loaded: true, githubMore: { url: 'https://github.com/example/app/issues/1' } });
  assert.match(linked, /Earlier GitHub comments aren’t shown here\. /);
  assert.match(linked, /<a href="https:\/\/github.com\/example\/app\/issues\/1" target="_blank" rel="noopener"[^>]*>Read them on GitHub<\/a>/);
  const bare = render([github({})], { loaded: true, githubMore: { url: null } });
  assert.match(bare, /Earlier GitHub comments aren’t shown here\./);
  assert.ok(!bare.includes('<a '), 'nothing to link to, so no anchor');
  assert.ok(!render([github({})]).includes('Earlier GitHub comments'));
});

test('the module still decides the stamp and which sanitizer runs, and drops a stale result', () => {
  const code = APP_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.match(/_requestThreadRows\(number\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_requestThreadRows() found');
  assert.match(fn[1], /DevChat\.renderMarkdown\(str, \{ images: true \}\)/);
  // The fallback for a page where dev-chat.js did not load escapes instead.
  assert.match(fn[1], /whitespace-pre-wrap font-sans">\$\{escapeHtml\(str\)\}/);
  // #1808: the thread's own stamp, never a slice of GitHub's UTC string.
  assert.match(fn[1], /GroupChat\._stamp\(iso\)/);
  assert.doesNotMatch(fn[1], /slice\(0, 10\)/);
  assert.doesNotMatch(code, /_issueCommentsView|_issueCommentsHtml|mountIssueComments/, 'the old thread is gone, not spare');

  // The staleness check that drops a result for an issue the reader has left.
  const load = code.match(/_loadIssueComments\(item\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(load, '_loadIssueComments() found');
  assert.match(load[1], /if \(!t \|\| t\.kind !== 'issue' \|\| t\.id !== number\) return;/);
  assert.match(load[1], /GroupChat\.renderThread\(\{ keepScroll: true \}\)/);
});

test('#3490: Homeroom bot\'s spec comment splits into its sentence and the spec', () => {
  const code = APP_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.match(/\n {2}_botSpecOf\(c\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_botSpecOf() found');
  const AppView = { _isBotCommentAuthor: (a) => a === 'usernode-bot' };
  const botSpecOf = (c) => vm.runInNewContext(`(function (c) {${fn[1]}})(c)`, { AppView, c });
  // Exactly what the bot writes (services/homeroom-bot-live.js), not a copy.
  const live = require('../src/services/homeroom-bot-live');
  const body = live.specCommentText('# Fix the banner\n\n## User-facing changes\n\nIt blends in.\n\n## Design\n\nOne card.');
  const got = botSpecOf({ author: 'usernode-bot', body });
  assert.equal(got.title, 'Fix the banner');
  assert.match(got.lead, /^Homeroom bot wrote a spec for this request and is building it now\./);
  assert.doesNotMatch(got.lead, /details|summary/, 'the markers are gone, not shown as text');
  assert.equal(got.body, '## User-facing changes\n\nIt blends in.\n\n## Design\n\nOne card.');
  assert.equal(botSpecOf({ author: 'ada', body }), null, 'a person\'s comment stays as they wrote it');
  assert.equal(botSpecOf({ author: 'usernode-bot', body: 'Thanks for the report.' }), null);

  // Both renderers use it: a request's page draws the spec as the spec
  // reader would (paragraph semantics), and the Workshop row's preview
  // names it.
  const rows = code.match(/_requestThreadRows\(number\) \{([\s\S]*?)\n {2}\},/)[1];
  assert.match(rows, /DevChat\.renderMarkdown\(str, \{ breaks: false \}\)/);
  assert.match(rows, /githubSpec: spec \? \{ title: spec\.title, markdown: spec\.body, html: renderSpec\(spec\.body\) \} : null,/);
  const feed = code.match(/_feedCommentsHtml\(comments\) \{([\s\S]*?)\n {2}\},/)[1];
  assert.match(feed, /const spec = AppView\._botSpecOf\(c\);/);
  // htmlText escapes the whole line, the title included.
  assert.match(feed, /spec\.title \? PlatformI18n\.htmlText\('changes:feed\.comment\.specTitled', \{ title: spec\.title \}\) : PlatformI18n\.htmlText\('changes:feed\.comment\.spec'\)/);
  assert.equal(message('changes:feed.comment.specTitled', { title: 'Fix the banner' }), 'The spec: Fix the banner');
  assert.equal(message('changes:feed.comment.spec'), 'The spec');
});

test('#3693: a spec the comments route clipped is still a spec, not raw markers', () => {
  // A real spec runs past the 2,000 characters the comments route keeps of
  // each body (github.clipIssueComments), so the page never saw the closing
  // `</details>`, the split matched nothing, and the request page showed
  // `<details><summary>The spec</summary>` as text. Through the real clip.
  const code = APP_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.match(/\n {2}_botSpecOf\(c\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_botSpecOf() found');
  const AppView = { _isBotCommentAuthor: (a) => a === 'usernode-bot' };
  const botSpecOf = (c) => vm.runInNewContext(`(function (c) {${fn[1]}})(c)`, { AppView, c });
  const live = require('../src/services/homeroom-bot-live');
  const github = require('../src/services/github');
  const spec = [
    '# Add a light and dark mode toggle',
    '',
    '## User-facing changes',
    '',
    'The app gains a light mode and a dark mode, with a toggle on the home screen.',
    '',
    '## Design',
    '',
    ...Array.from({ length: 60 }, (_, k) => `- Detail ${k}: the toggle remembers the choice on this device.`),
  ].join('\n');
  const full = live.specCommentText(spec);
  assert.ok(full.length > 2000, 'the fixture is longer than the clip, like a real spec');
  const { comments: [clipped] } = github.clipIssueComments([{ author: 'usernode-bot', body: full, createdAt: '' }]);
  assert.doesNotMatch(clipped.body, /<\/details>/, 'the clip cut the close off');

  const got = botSpecOf(clipped);
  assert.ok(got, 'the clipped comment is still recognised as the spec');
  assert.equal(got.title, 'Add a light and dark mode toggle');
  assert.match(got.lead, /^Homeroom bot wrote a spec for this request and is building it now\./);
  for (const part of [got.lead, got.body]) {
    assert.doesNotMatch(part, /<\/?(details|summary)>/, 'no marker is left to show as text');
  }
  assert.match(got.body, /^## User-facing changes\n/);
  assert.match(got.body, /… \[truncated\]$/, 'and it says it was cut short, as any clipped comment does');

  // The whole comment still splits exactly as before.
  assert.equal(botSpecOf({ author: 'usernode-bot', body: full }).body.endsWith('this device.'), true);
});
