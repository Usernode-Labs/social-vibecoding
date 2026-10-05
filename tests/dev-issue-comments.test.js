const { englishUiSource } = require("./lib/english-ui-source");
const { withLanguage } = require("./lib/platform-language");
// `#dev-issue-comments` — the GitHub thread under an issue's topic card.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// The thread had no test. It was one `innerHTML` string in
// public/js/app-view.js built from data that is entirely GitHub's — an author
// name, a timestamp, and a comment body that is arbitrary markdown — so the
// two properties worth pinning are the two the string version got right by
// hand and a conversion can lose silently:
//
//   1. The body goes through the SANITIZER and lands as markup; the author
//      name and the date do not, and land as text.
//   2. An empty thread draws nothing at all, not a bare "Discussion" heading.
//
// #1808 added a third: the row carries a real stamp. It used to print
// `createdAt.slice(0, 10)` — a UTC date, so a comment posted at 8pm in Sao
// Paulo was stamped with the next day, and no time at all — directly above a
// Discussion thread that got both right.
//
// Run with: node --test tests/dev-issue-comments.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const COMMENTS = 'frontend/src/features/dev-board/issue-comments.tsx';
const APP_VIEW = read('public/js/app-view.js');

const view = (over) => ({ comments: [], truncated: false, htmlUrl: null, ...over });
const comment = (over) => ({
  key: '1', author: 'evan', bot: false, createdAt: '2026-03-04T15:30:00Z',
  bodyHtml: '<p>hi</p>', ...over,
});
const render = (over) => renderComponent(COMMENTS, 'IssueCommentsView', view(over));

test('an empty thread draws nothing', () => {
  // Not an empty "Discussion" heading over a blank space — an issue with no
  // comments is the common case, and the card below it should close up.
  assert.equal(render(), '');
});

test('a comment carries its author, its bot tag and its date', () => {
  const html = render({
    comments: [
      comment({ key: '1', author: 'evan' }),
      comment({ key: '2', author: 'github-actions[bot]', bot: true, createdAt: '' }),
    ],
  });
  // The sheet heading (round three): the same uppercase label every topic
  // sheet wears, and the one "Discussion" the page draws.
  assert.match(html, /<div class="dev-topic-h">Discussion<\/div>/);
  assert.equal((html.match(/class="dev-issue-comment/g) || []).length, 2);
  // A comment is a bubble: the swatch avatar outside, the author first in
  // the bubble's head, then the GitHub tag that says whose thread this is.
  assert.match(html, /<span class="dev-feed-msg-author">evan<\/span>(<span[^>]*>bot<\/span>)?<span class="dev-topic-gh-tag">GitHub<\/span>/);
  assert.match(html, /class="dev-feed-msg-avatar" aria-hidden="true" style="background-color:#[0-9a-f]{6}">E</);
  // The bot tag is a quiet word beside the name, not a different row.
  assert.equal((html.match(/>bot</g) || []).length, 1);
  assert.match(html, /github-actions\[bot\]<\/span><span class="text-\[0\.9375rem\] text-sky-700 dark:text-sky-400">bot<\/span>/);
  // A row with no timestamp omits the date rather than drawing an empty span.
  assert.equal((html.match(/dev-feed-msg-time/g) || []).length, 1);
  // #1808: a month and a day, then a time — not a bare `2026-03-04`, and not
  // a bare time either. The year is elided or not depending on when the suite
  // runs, so match the parts that are always there.
  // Case-insensitive on the attribute name: React 19 emits the JSX spelling
  // (`dateTime`) and HTML attribute names are case-insensitive.
  assert.match(html, /<time class="dev-feed-msg-time" datetime="2026-03-04T15:30:00Z" title="[^"]+">/i);
  assert.match(html, /Mar 4[^<]*\d\d?:\d\d/);
  // The title never elides: it always carries the year.
  assert.match(html, /title="[^"]*2026[^"]*"/);
});

test('an unparseable timestamp draws no stamp at all', () => {
  // Rather than "Invalid Date" or a 1970 stamp in front of a reader. The
  // shared helper decides this; the row only has to respect the empty text.
  const html = render({ comments: [comment({ createdAt: 'not a date' })] });
  assert.ok(!html.includes('dev-feed-msg-time'));
  assert.ok(!html.includes('Invalid'));
});

test('the body is markup and everything else is text', () => {
  // The body is markdown the module already ran through DevChat's sanitizer
  // (the same one the dev chat and the group chat's transcript use), so it
  // arrives as HTML and has to render as HTML.
  const html = render({
    comments: [comment({
      author: '<img src=x onerror=alert(1)>',
      createdAt: '<b>nope</b>',
      bodyHtml: '<p class="dc-p">Looks like a <strong>race</strong>.</p>',
    })],
  });
  assert.match(html, /<p class="dc-p">Looks like a <strong>race<\/strong>\.<\/p>/, 'the body is markup');
  assert.ok(!html.includes('<img'), 'the author name is not');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!html.includes('<b>nope'), 'nor is the date');
  assert.ok(!html.includes('&lt;b&gt;nope'), 'which is now dropped entirely');
});

test('a truncated thread says so, and links out when it can', () => {
  const linked = render({
    comments: [comment()],
    truncated: true,
    htmlUrl: 'https://github.com/example/app/issues/1',
  });
  assert.match(linked, /Earlier comments omitted\. /);
  assert.match(linked, /<a href="https:\/\/github.com\/example\/app\/issues\/1" target="_blank" rel="noopener"[^>]*>View the full thread on GitHub<\/a>/);

  // No URL: the same sentence, without a dead link.
  const bare = render({ comments: [comment()], truncated: true });
  assert.match(bare, /Earlier comments omitted\. View the full thread on GitHub\./);
  assert.ok(!bare.includes('<a '), 'nothing to link to, so no anchor');

  // Not truncated: no notice at all.
  assert.ok(!render({ comments: [comment()] }).includes('Earlier comments omitted'));
});

test('the module still decides who is a bot, and which sanitizer runs', () => {
  const code = APP_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.match(/_issueCommentsView\(comments, truncated, htmlUrl\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_issueCommentsView() found');
  assert.match(fn[1], /bot: AppView\._isBotCommentAuthor\(c\.author\)/);
  assert.match(fn[1], /DevChat\.renderMarkdown\(str, \{ images: true \}\)/);
  // The fallback for a page where dev-chat.js did not load escapes instead.
  assert.match(fn[1], /whitespace-pre-wrap font-sans">\$\{escapeHtml\(str\)\}/);
  assert.doesNotMatch(code, /_issueCommentsHtml/, 'the string renderer is gone, not spare');

  // The staleness check that drops a result for an issue the reader has left.
  const load = code.match(/_loadIssueComments\(item\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(load, '_loadIssueComments() found');
  assert.match(load[1], /if \(!t \|\| t\.kind !== 'issue' \|\| t\.id !== number\) return;/);
  assert.match(load[1], /mountIssueComments\(slot\)/);
});

test('the sanitized body keeps its wrapper identity across re-renders', () => {
  // React diffs host props by reference and re-assigns `innerHTML` whenever
  // the `{__html}` object is new — even for an identical string. On a thread
  // of long comments that is every body rewritten on every repaint, and the
  // group chat's transcript hit exactly this.
  assert.match(read(COMMENTS), /const wrapper = useMemo\(\(\) => \(\{ __html: html \}\), \[html\]\);/);
});

test('a long comment is clamped to four lines, with a control to expand it', () => {
  // #2556. A pasted stack trace in this thread used to run the sheet off
  // the bottom of the screen; it shows its first four lines now, and a
  // "Show more" under them.
  const html = render({ comments: [comment({ bodyHtml: `<p>${'word '.repeat(400)}</p>` })] });
  assert.match(html, /class="dev-feed-msg-text dev-issue-body line-clamp-4"/,
    'the clamp is a class on the body node itself, not a wrapper around it');
  // Whether THIS comment is long is a question about the rendered box, so
  // the control is revealed by an effect (see comment-clamp.tsx). The first
  // paint carries the same markup the prerendered shell does — which is the
  // rule for every island — and the effect adds the button.
  assert.doesNotMatch(html, /Show more|Show less/);

  // A short comment is unchanged apart from the clamp, which cuts nothing.
  const short = render({ comments: [comment({ bodyHtml: '<p>hi</p>' })] });
  assert.match(short, /<div class="dev-feed-msg-text dev-issue-body line-clamp-4"><p>hi<\/p><\/div>/);
  assert.doesNotMatch(short, /<button/);
});

test('#3490: Homeroom bot\'s spec comment splits into its sentence and the spec', () => {
  const code = APP_VIEW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = code.match(/\n {2}_botSpecOf\(c\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(fn, '_botSpecOf() found');
  const AppView = { _isBotCommentAuthor: (a) => a === 'usernode-bot' };
  const botSpecOf = (c) => vm.runInNewContext(`(function (c) {${fn[1]}})(c)`, withLanguage({ AppView, c }));
  // Exactly what the bot writes (services/homeroom-bot-live.js), not a copy.
  const live = require('../src/services/homeroom-bot-live');
  const body = live.specCommentText('# Fix the banner\n\n## User-facing changes\n\nIt blends in.\n\n## Design\n\nOne card.');
  const got = botSpecOf({ author: 'usernode-bot', body });
  assert.equal(got.title, 'Fix the banner');
  assert.match(englishUiSource(got.lead), /^Homeroom bot wrote a spec for this request and is building it now\./);
  assert.doesNotMatch(englishUiSource(got.lead), /details|summary/, 'the markers are gone, not shown as text');
  assert.equal(got.body, '## User-facing changes\n\nIt blends in.\n\n## Design\n\nOne card.');
  assert.equal(botSpecOf({ author: 'ada', body }), null, 'a person\'s comment stays as they wrote it');
  assert.equal(botSpecOf({ author: 'usernode-bot', body: 'Thanks for the report.' }), null);

  // Both renderers use it: the request page's thread renders the spec as a
  // spec (paragraph semantics), and the Workshop row's preview names it.
  const view = code.match(/_issueCommentsView\(comments, truncated, htmlUrl\) \{([\s\S]*?)\n {2}\},/)[1];
  assert.match(englishUiSource(view), /DevChat\.renderMarkdown\(str, \{ breaks: false \}\)/);
  assert.match(englishUiSource(view), /bodyHtml: renderMd\(spec \? spec\.lead : \(c\.body \|\| ''\)\),\n\s*spec: spec \? \{ title: spec\.title, html: renderSpec\(spec\.body\) \} : null,/);
  const feed = code.match(/_feedCommentsHtml\(comments\) \{([\s\S]*?)\n {2}\},/)[1];
  assert.match(englishUiSource(feed), /const spec = AppView\._botSpecOf\(c\);/);
  assert.match(englishUiSource(feed), /escapeHtml\(spec\.title \? `The spec: \$\{spec\.title\}` : 'The spec'\)/);
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
  const botSpecOf = (c) => vm.runInNewContext(`(function (c) {${fn[1]}})(c)`, withLanguage({ AppView, c }));
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

test('#3490: the spec is drawn as a spec, folded under its title, outside the comment\'s clamp', () => {
  const html = render({
    comments: [comment({
      author: 'usernode-bot', bot: true, bodyHtml: '<p class="dc-p">Homeroom bot wrote a spec.</p>',
      spec: { title: 'Fix the banner', html: '<h4 class="dc-h4">Design</h4><p class="dc-p">One card.</p>' },
    })],
  });
  assert.match(html, /<div class="dev-feed-msg-text dev-issue-body line-clamp-4"><p class="dc-p">Homeroom bot wrote a spec\.<\/p><\/div><details class="dev-issue-spec" data-issue-spec="">/,
    'the sentence is the comment, and the spec follows it, not inside its clamp');
  assert.match(html, /<summary class="dev-issue-spec-head"><span class="dev-issue-spec-text"><span class="dev-issue-spec-kicker">The spec<\/span><span class="dev-issue-spec-title">Fix the banner<\/span><\/span>/);
  assert.match(html, /<div class="dc-spec-viewer-body dev-issue-spec-body"><h4 class="dc-h4">Design<\/h4><p class="dc-p">One card\.<\/p><\/div><\/details>/,
    'the spec viewer\'s own typography');
  assert.doesNotMatch(html, /<details[^>]* open/, 'folded, as GitHub folds it');
  // An ordinary comment is unchanged.
  assert.doesNotMatch(render({ comments: [comment()] }), /dev-issue-spec/);
  const src = read(COMMENTS);
  assert.match(src, /const openSpecs = new Set<string>\(\);/, 'an opened spec survives the host\'s remount');
  assert.match(src, /useState\(\(\) => openSpecs\.has\(id\)\)/);
});
