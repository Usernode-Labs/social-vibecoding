// A request's page in the one frame, as the 2026-11-06 screen tour draws it
// (s32, s33): the bar's trail is the project, the Workshop and the request;
// the page's head is its title and one line; the request's words and its
// status are the look's cards; status, progress and who asked sit in the
// context column beside the words and the discussion. The page is still the
// product's (features/dev-board/topic/request-head.tsx): what changes under
// a look is added beside its own lines, which many suites hold as written.
//
// Run with: node --test tests/request-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const FRAME = 'frontend/src/features/dev-board/topic/frame/topic-frame.tsx';
const HEAD = 'frontend/src/features/dev-board/topic/request-head.tsx';

test('the page\'s head is the kit\'s: the title, one line saying what it is, and the page\'s own menu', () => {
  const html = renderComponent(FRAME, 'TopicFrameHead', { title: 'Simplify the admin console', purpose: 'Request #5998 · Admin console', menu: { key: 'request:5998', label: 'More' } }, { cache: false });
  assert.equal(html.replace(/<svg.*?<\/svg>/s, '<svg/>'),
    '<div class="fr" data-topic-frame-head=""><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">Simplify the admin console</h1><p class="fr-purpose">Request #5998 · Admin console</p></div><div class="fr-acts"><button type="button" class="fr-ib dev-card-menu-btn" data-card-menu="request:5998" aria-haspopup="true" aria-label="More" title="More"><svg/></button></div></div></div>');
  assert.doesNotMatch(renderComponent(FRAME, 'TopicFrameHead', { title: 'A', purpose: null, menu: null }, { cache: false }), /fr-acts|fr-purpose/);
});

test('who asked, and under which topic, are rows of the context column', () => {
  const html = renderComponent(FRAME, 'TopicFrameAbout', { label: 'About', asker: 'snait', color: '#5b7553', line: 'Asked 28 Oct, 10:24', topic: 'Admin console', topicLine: 'Topic' }, { cache: false });
  assert.match(html, /^<aside class="fr fr-topicside" data-topic-side=""><section class="fr-sec"><div class="fr-sechead"><h2 class="fr-cap">About<\/h2><\/div><div class="fr-card"><div class="fr-row"><span class="fr-av" style="--fr-as:40px;--fr-ac:#5b7553" aria-hidden="true">s<\/span><span class="fr-tx"><span class="fr-t">snait<\/span><span class="fr-s">Asked 28 Oct, 10:24<\/span><\/span><\/div><div class="fr-row"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Admin console<\/span><span class="fr-s">Topic<\/span><\/span><\/div><\/div><\/section><\/aside>$/s);
  assert.doesNotMatch(renderComponent(FRAME, 'TopicFrameAbout', { label: 'About', asker: 'snait', color: null, line: null, topic: null, topicLine: 'Topic' }, { cache: false }), />Topic</);
});

test('under a look the request\'s page says its trail to the bar, wears the kit\'s head, and adds the context column', () => {
  const src = read(HEAD);
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /useFramePage\(frame \? \[placeName\('workshop'\), kicker\] : null, topicBack\);/, 'the Workshop, then the request; the arrow is the page\'s own way back');
  assert.match(src, /if \(frame\) return <TopicFrameHead /, 'in the bar\'s place');
  assert.match(src, /\{frame \? \(\s*<TopicFrameAbout/);
  assert.match(src, /useSideStack\(frame, `\[data-request-root="\$\{r\.number\}"\] > \[data-image-viewer-scope\]`/, 'status, progress and About are stacked beside the words by their measured heights');
  // The page's own lines stay as written.
  assert.match(src, /<div className="dev-request-track" data-request-track=\{r\.trackPending \? 'pending' : track\.work\.stage\} inert=\{!!r\.trackPending\}>/);
  assert.match(src, /<header className="messages-thread-header">/);
});

test('the bar puts the project first on a page that says its own trail inside a project', () => {
  const src = read('frontend', 'src', 'features', 'frame', 'frame-app.tsx');
  assert.match(src, /\? \[\.\.\.\(inCommunity \? \[projectCrumb\] : \[\]\), \.\.\.page\.crumb\.map\(\(word\) => \(\{ word \}\)\)\]/);
});

test('the side column is laid beside the words from measured heights, a look\'s cards dress the words and the status', () => {
  const stack = read('frontend/src/features/dev-board/topic/frame/side-stack.ts');
  assert.match(stack, /new ResizeObserver\(place\)/);
  assert.match(stack, /el\.style\.setProperty\('--fr-side-top', `\$\{top\}px`\)/);
  assert.match(stack, /host\.style\.setProperty\('--fr-side-h', /);
  assert.match(stack, /scroller\?\.style\.setProperty\('--fr-side-pull', `\$\{Math\.max\(0, sideH - wordsH\)\}px`\)/, 'the discussion is drawn up beside the column by what it stands taller than the words');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request \{[^}]*max-width: 1136px;/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request-root > \[data-image-viewer-scope\] > :is\(\.dev-request-status, \.dev-request-track, \.dev-change-pair, \.fr-topicside\) \{[^}]*position: absolute; top: var\(--fr-side-top, 0px\); inset-inline-end: 0; width: 320px;/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) #gc-thread-back \{ display: none; \}/, 'the bar has the way back');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.card.to, /^:is\(\.dev-request-ask,/, 'with whatever else wears the card (a visitor\'s forms, tests/guest-chrome.test.js)');
});

test('a change\'s page does the same: its title in the kit\'s head, its trail, its votes and checks in the context column', () => {
  const src = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(src, /if \(frame\) return <TopicFrameHead title=\{name \|\| title\} purpose=\{dotLine\(\[title, v\.category\]\)\}/);
  assert.match(src, /useFramePage\(frame \? \[placeName\('workshop'\), trail\] : null, topicBack\);/);
  assert.match(src, /useSideStack\(frame, `\[data-change-root="\$\{id \?\? ''\}"\] > \[data-image-viewer-scope\]`, \['\.dev-change-pair', '\.fr-topicside'\]\);/);
  assert.match(src, /name=\{card\.title\.text \|\| card\.title\.title \|\| null\}/, 'the bar is handed the change\'s own title');
  assert.match(src, /<header className="messages-thread-header">/, 'the standard head stays as written');
});

test('under a look the status is the kit\'s card: the stage as a pill, the five-stop line, one sentence, the one action', () => {
  const words = ['Plan', 'Build', 'Checks', 'Vote', 'Live'];
  const html = renderComponent(FRAME, 'TopicFrameStatus', {
    label: 'Where this request is', pill: { word: 'Asked', kind: 'act' }, at: 0, state: 'now', words,
    say: 'Nobody is on this yet.', fine: 'Claimed 3 days ago; the claim lapses tomorrow.', action: { label: 'Work on this with Homeroom bot', onClick() {} },
  }, { cache: false });
  assert.match(html, /^<section class="fr-sec" data-topic-status=""><div class="fr-sechead"><h2 class="fr-cap">Where this request is<\/h2><\/div><div class="fr-card"><div class="fr-status"><div class="fr-btnrow"><span class="fr-pill fr-act" data-kind="act">Asked<\/span><\/div><span class="fr-track" role="img" aria-label="Plan"><span class="fr-st fr-now" aria-hidden="true">Plan<\/span><span class="fr-st" aria-hidden="true">Build<\/span>/);
  assert.match(html, /<p class="fr-txt">Nobody is on this yet\.<\/p><p class="fr-fine">Claimed 3 days ago; the claim lapses tomorrow\.<\/p><div class="fr-btnrow"><button type="button" class="fr-btn dev-request-primary">Work on this with Homeroom bot<\/button><\/div><\/div><\/div><\/section>$/);
  const closed = renderComponent(FRAME, 'TopicFrameStatus', { pill: null, at: null, words, say: 'Closed as done.', fine: null, action: null }, { cache: false });
  assert.doesNotMatch(closed, /fr-track|fr-pill|fr-btn|fr-sechead/, 'closed: the sentence alone; and no label on the page, where the card stands at the words\' top');
  assert.match(closed, /^<section class="fr-sec" data-topic-status=""><div class="fr-card">/);
  assert.match(renderComponent(FRAME, 'TopicFrameStatus', { label: 'L', pill: null, at: 1, state: 'wait', words, say: null, fine: null, action: { label: 'Open', href: '#x' } }, { cache: false }),
    /<span class="fr-st fr-done" aria-hidden="true">Plan<\/span><span class="fr-st fr-wait" aria-hidden="true">Build<\/span>.*<a class="fr-btn dev-request-primary" href="#x">Open<\/a>/s);
});

test('the request page hands its status to the kit\'s card, and the stage lands on the five stops', () => {
  const src = read(HEAD);
  assert.match(src, /function RequestStatus\(\{ s, specs, tracked = false, frame = false \}/);
  assert.match(src, /<RequestStatus s=\{r\.status\} specs=\{specs\} tracked=\{!!track\} frame=\{frame\} \/>/);
  assert.match(src, /if \(frame\) \{\s*const stop = s\.closed \|\| tracked \? null : frameStop\(stage\);\s*return \(\s*<div className="dev-request-status" role="group" aria-label=\{t\('project:topic\.request\.status\.label'\)\} data-request-stage=\{stage\}>\s*<TopicFrameStatus/, 'the same host, so the side column measures it as before; no line while the bot\'s track card says the steps');
  const { loadTsx } = require('./lib/render-tsx');
  const { frameStop } = loadTsx('frontend/src/features/dev-board/topic/frame/topic-page.ts', { cache: false });
  assert.deepEqual(frameStop('asked'), { at: 0, state: 'now' }, 'asked: the plan is being made');
  assert.deepEqual(frameStop('spec'), { at: 1, state: 'wait' }, 'a plan is ready: the build waits');
  assert.deepEqual(frameStop('built'), { at: 1, state: 'now' });
  assert.deepEqual(frameStop('voted'), { at: 5, state: 'now' }, 'live: every stop done');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.doesNotMatch(looks.wear.roots.card.to, /dev-request-status/, 'the card inside wears the look; the host is bare');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request-status \{ margin-top: 0; max-width: none; padding: 0; background: none; border-radius: 0; \}/);
});

test('Follow this request is a row of About under a look, its state a switch', () => {
  const on = renderComponent(FRAME, 'TopicFrameAbout', { label: 'About', asker: 'snait', color: null, line: null, topic: null, topicLine: 'Topic', follow: { title: 'Follow this request', line: 'Replies and status changes', on: true, busy: false, onToggle() {} } }, { cache: false });
  assert.match(on, /<div class="fr-row"><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">Follow this request<\/span><span class="fr-s">Replies and status changes<\/span><\/span><button type="button" role="switch" aria-checked="true" aria-label="Follow this request" class="fr-tog fr-on" data-thread-follow="following"><\/button><\/div><\/div><\/section><\/aside>$/s);
  const off = renderComponent(FRAME, 'TopicFrameAbout', { label: 'About', asker: 'snait', color: null, line: null, topic: null, topicLine: 'Topic', follow: { title: 'Follow this request', line: 'Replies and status changes', on: false, busy: true, onToggle() {} } }, { cache: false });
  assert.match(off, /role="switch" aria-checked="false" aria-label="Follow this request" class="fr-tog" disabled="" data-thread-follow=""/);
  const src = read(HEAD);
  assert.match(src, /const followRow = useFollowRow\(threadRead\.data \|\| null, threadRead\.reread\);/);
  assert.match(src, /follow=\{followRow \? \{ title: t\('project:frame\.topic\.follow'\), line: t\('project:frame\.topic\.followLine'\), \.\.\.followRow \} : null\}/);
  const hook = read('frontend/src/features/dev-board/topic/frame/topic-follow.ts');
  assert.match(hook, /fetch\(`\/api\/threads\/\$\{data\.thread\.id\}\/follow`, \{\s*method: 'PUT',/);
  assert.match(hook, /notify: state === 'following' \? false : state === 'muted' \? null : true/, 'on → mute; muted → back to the rule, as the ⋯ row does; else notify me');
});
