// A request's page and a change's page in the one frame: the first screen
// tour's layout (s32 to s35) holding what the standard page says today
// (version 2). The bar's trail is the project, the Workshop and the item;
// the page's head is a small line saying what it is over its full title;
// the words and where it stands are the look's cards, the second in a
// context column beside the words and the discussion. About and the Follow
// switch, which the first tour drew and the product does not have, are gone.
// The page is still the product's (features/dev-board/topic/request-head.tsx,
// change-head.tsx): what changes under a look is added beside its own lines,
// which many suites hold as written.
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
const CHANGE = 'frontend/src/features/dev-board/topic/change-head.tsx';

test('the page\'s head is the kit\'s: what it is in a small line over the full title, and the page\'s own menu', () => {
  const html = renderComponent(FRAME, 'TopicFrameHead', { title: 'Simplify the admin console', over: 'Request #5998 · Admin console', menu: { key: 'request:5998', label: 'More' } }, { cache: false });
  assert.equal(html.replace(/<svg.*?<\/svg>/s, '<svg/>'),
    '<div class="fr" data-topic-frame-head=""><div class="fr-head"><div class="fr-tx"><div class="fr-cap fr-over">Request #5998 · Admin console</div><h1 class="fr-title">Simplify the admin console</h1></div><div class="fr-acts"><button type="button" class="fr-ib dev-card-menu-btn" data-card-menu="request:5998" aria-haspopup="true" aria-label="More" title="More"><svg/></button></div></div></div>');
  assert.doesNotMatch(renderComponent(FRAME, 'TopicFrameHead', { title: 'A', over: null, menu: null }, { cache: false }), /fr-acts|fr-over|fr-purpose/);
  assert.match(read(HEAD), /if \(frame\) return <TopicFrameHead title=\{r\.title\} over=\{dotLine\(\[kicker, r\.category\]\)\}/, 'the kicker the standard bar says, with the topic that sits under its title');
});

test('About and the Follow switch are gone: the product\'s page has neither, and Follow stays a row of the page\'s menu', () => {
  const frame = read(FRAME);
  assert.doesNotMatch(frame, /TopicFrameAbout|FollowRow|fr-topicside/);
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/features/dev-board/topic/frame/topic-follow.ts')), false);
  for (const file of [HEAD, 'frontend/src/features/dev-board/topic/change-head.tsx']) {
    assert.doesNotMatch(read(file), /TopicFrameAbout|useFollowRow|fr-topicside|project:frame\.topic\.(about|asked|topic|follow|followLine)/, file);
  }
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  for (const id of ['about', 'asked', 'topic', 'follow', 'followLine']) assert.equal(catalog[`frame.topic.${id}`], undefined, id);
  assert.doesNotMatch(read('public/css/app.css'), /fr-topicside/);
  assert.match(read('frontend/src/features/dev-board/topic/thread-items.tsx'), /\/follow/, 'the menu\'s Notify me / Mute row is the product\'s way to follow');
});

test('under a look the request\'s page says its trail to the bar, wears the kit\'s head, and adds the context column', () => {
  const src = read(HEAD);
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /useFramePage\(frame \? \[placeName\('workshop'\), kicker\] : null, topicBack\);/, 'the Workshop, then the request; the arrow is the page\'s own way back');
  assert.match(src, /if \(frame\) return <TopicFrameHead /, 'in the bar\'s place');
  assert.match(src, /useSideStack\(frame, `\[data-request-root="\$\{r\.number\}"\] > \[data-image-viewer-scope\]`, \['\.dev-request-track', '\.dev-request-at'\]\);/, 'what stands in the context column (Status) is stacked beside the words by measured heights; the sentence and its action stay in the words');
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
  assert.match(stack, /const pull = Math\.max\(0, sideH - wordsH\);\s*scroller\?\.style\.setProperty\('--fr-side-pull', `\$\{pull\}px`\)/, 'the discussion is drawn up beside the column by what it stands taller than the words');
  assert.match(stack, /sheet\?\.style\.setProperty\('--fr-side-w', `\$\{top \? COLUMN : 0\}px`\)/, 'no part on the page, no column: the words take its room');
  assert.match(stack, /scroller\?\.style\.setProperty\('--fr-side-tail', `\$\{Math\.max\(0, pull - \(talk \? talk\.offsetHeight : 0\)\)\}px`\)/, 'the discussion keeps its own height; what it lacks of the column\'s foot is room under it');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request \{[^}]*max-width: 1136px;/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request-root > \[data-image-viewer-scope\] > :is\(\.dev-request-track, \.dev-request-at, \.dev-change-status, \.dev-change-pair\) \{[^}]*position: absolute; top: var\(--fr-side-top, 0px\); inset-inline-end: 0; width: 320px;/);
  assert.match(hand, /\.dev-request-root > \[data-image-viewer-scope\] \{ position: relative; min-height: var\(--fr-side-h, 0px\); padding-inline-end: var\(--fr-side-w, 352px\); \}/);
  assert.match(hand, /#gc-thread-messages \{ box-sizing: border-box; width: calc\(100% - var\(--fr-side-w, 352px\)\); max-width: calc\(100% - var\(--fr-side-w, 352px\)\); margin-inline: 0; margin-bottom: var\(--fr-side-tail, 0px\); \}/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) #gc-thread-back \{ display: none; \}/, 'the bar has the way back');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) #app-content > \.dc-lift-strip \{ background: none; backdrop-filter: none; -webkit-backdrop-filter: none; box-shadow: none; border-radius: 0; border-top: 0; \}/,
    'the board is the product\'s frosted strip (board-frame.tsx); the tour\'s pages sit flat under the header, so under a look the strip\'s fill, shoulders, shadow and hairline go');
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request > \.dev-request-sheet \{ background: none; box-shadow: none; border-radius: 0; border-top: 0; \}/,
    'the sheet rising on the board (dc-lift-session) is put away whole: its fill, its shadow, its corners and its top hairline, which alone drew a line across the page above the title');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.match(looks.wear.roots.card.to, /^:is\(\.dev-request-ask,/, 'with whatever else wears the card (a visitor\'s forms, tests/guest-chrome.test.js)');
  // The cards the product keeps in the context column wear it too: a
  // change's Votes and Tested. Homeroom bot's progress card is no longer
  // worn: under a look the page draws the kit's Status in its place.
  assert.ok(looks.wear.roots.card.to.includes('.dev-change-pair .dev-change-gate'));
  assert.doesNotMatch(looks.wear.roots.card.to, /dev-request-track/);
});

test('a change\'s page does the same: its title in the kit\'s head, its trail, its votes and checks in the context column', () => {
  const src = read('frontend/src/features/dev-board/topic/change-head.tsx');
  assert.match(src, /if \(frame\) return <TopicFrameHead title=\{name \|\| title\} over=\{dotLine\(\[title, v\.category\]\)\}/);
  assert.match(src, /useFramePage\(frame \? \[placeName\('workshop'\), trail\] : null, topicBack\);/);
  assert.match(src, /useSideStack\(frame, `\[data-change-root="\$\{id \?\? ''\}"\] > \[data-image-viewer-scope\]`, \['\.dev-change-status', '\.dev-change-pair'\]\);/);
  assert.match(src, /name=\{card\.title\.text \|\| card\.title\.title \|\| null\}/, 'the bar is handed the change\'s own title');
  assert.match(src, /<header className="messages-thread-header">/, 'the standard head stays as written');
});

test('where a request stands is said in two places, each once: the sentence and its action after the request, the pill and five stops in the context column', () => {
  const words = ['Plan', 'Build', 'Checks', 'Vote', 'Live'];
  // In the words' column: the sentence with its first sentence in bold, the
  // claim's small words, the one action. No label, no pill, no line.
  const main = renderComponent(FRAME, 'TopicFrameStatus', {
    big: true, say: 'Waiting for you to decide. It is a product decision.', lead: 'Waiting for you to decide.',
    fine: 'Claimed 3 days ago; the claim lapses tomorrow.', action: { label: 'Go ahead', act: 'workOnIssueWithBot', onClick() {} },
  }, { cache: false });
  assert.equal(main, '<section class="fr-sec" data-topic-status=""><div class="fr-card"><div class="fr-status"><p class="fr-sub15"><b>Waiting for you to decide.</b> It is a product decision.</p><p class="fr-fine">Claimed 3 days ago; the claim lapses tomorrow.</p><div class="fr-btnrow"><button type="button" class="fr-btn dev-request-primary" data-act="workOnIssueWithBot">Go ahead</button></div></div></div></section>');
  assert.match(renderComponent(FRAME, 'TopicFrameStatus', { big: true, say: 'Closed as done.', lead: 'Something else.' }, { cache: false }), /<p class="fr-sub15">Closed as done\.<\/p>/, 'a lead that does not start the line is not said in bold');
  assert.match(renderComponent(FRAME, 'TopicFrameStatus', { big: true, say: 'Open it.', action: { label: 'Open', href: '#x' } }, { cache: false }), /<a class="fr-btn dev-request-primary" href="#x">Open<\/a>/);
  // In the context column: the label, the pill, the five stops, one grey line.
  const side = renderComponent(FRAME, 'TopicFrameStatus', { label: 'Status', pill: { word: 'Asked', kind: 'act' }, at: 1, state: 'wait', words }, { cache: false });
  assert.equal(side, '<section class="fr-sec" data-topic-status=""><div class="fr-sechead"><h2 class="fr-cap">Status</h2></div><div class="fr-card"><div class="fr-status"><div class="fr-btnrow"><span class="fr-pill fr-act" data-kind="act">Asked</span></div><span class="fr-track" role="img" aria-label="Build"><span class="fr-st fr-done" aria-hidden="true">Plan</span><span class="fr-st fr-wait" aria-hidden="true">Build</span><span class="fr-st" aria-hidden="true">Checks</span><span class="fr-st" aria-hidden="true">Vote</span><span class="fr-st" aria-hidden="true">Live</span></span></div></div></section>');
  const stops = renderComponent(FRAME, 'TopicFrameStatus', { label: 'Status', pill: { word: 'Waiting for you to decide', kind: 'wait' }, stops: ['wait', '', '', '', ''], words, say: 'Homeroom bot: it is a product decision.' }, { cache: false });
  assert.match(stops, /<span class="fr-pill fr-wait" data-kind="wait">Waiting for you to decide<\/span><\/div><span class="fr-track" role="img" aria-label="Plan"><span class="fr-st fr-wait" aria-hidden="true">Plan<\/span><span class="fr-st" aria-hidden="true">Build<\/span>.*<p class="fr-txt">Homeroom bot: it is a product decision\.<\/p>/s);
});

test('the request page: the status host keeps its place in the words with the kit\'s card inside; the stage lands on the five stops', () => {
  const src = read(HEAD);
  assert.match(src, /function RequestStatus\(\{ s, specs, tracked = false, frame = false \}/);
  assert.match(src, /<RequestStatus s=\{r\.status\} specs=\{specs\} tracked=\{!!track\} frame=\{frame\} \/>/);
  assert.match(src, /if \(frame\) \{[^}]*const words = s\.closed \|\| say \|\| null;\s*return \(\s*<div className="dev-request-status" role="group" aria-label=\{t\('project:topic\.request\.status\.label'\)\} data-request-stage=\{stage\}>\s*\{words \|\| s\.fine \|\| a \? \(\s*<TopicFrameStatus\s+big\s+say=\{words\}\s+lead=\{s\.closed \? null : firstSentence\(s\.lead\)\}/, 'the same host and the same sentence the standard card says');
  assert.match(src, /action=\{a \? \{ label: a\.label, title: a\.title, disabled: a\.disabled, href: a\.href, act: a\.act\?\.fn, onClick: \(\) => \{ if \(a\.act\) call\(a\.act\.fn, a\.act\.args \|\| \[\]\); \} \} : null\}/, 'the same action, pressed the same way');
  const { loadTsx } = require('./lib/render-tsx');
  const page = loadTsx('frontend/src/features/dev-board/topic/frame/topic-page.ts', { cache: false });
  assert.deepEqual(page.frameStop('asked'), { at: 0, state: 'now' }, 'asked: the plan is being made');
  assert.deepEqual(page.frameStop('spec'), { at: 1, state: 'wait' }, 'a plan is ready: the build waits');
  assert.deepEqual(page.frameStop('built'), { at: 1, state: 'now' });
  assert.deepEqual(page.frameStop('voted'), { at: 5, state: 'now' }, 'live: every stop done');
  assert.equal(page.firstSentence('Waiting for you to decide. It is a product decision.'), 'Waiting for you to decide.');
  assert.equal(page.firstSentence('Nobody is working on this yet.'), 'Nobody is working on this yet.', 'one sentence: all of it');
  assert.equal(page.firstSentence('Plan v1.2 is ready! Build it below.'), 'Plan v1.2 is ready!');
  assert.equal(page.firstSentence(null), '');
  assert.equal(page.threadPillKind({ key: 'live', tone: 'ok' }), 'ok');
  assert.equal(page.threadPillKind({ key: 'vote', tone: 'neutral' }), 'act', 'a vote asks for you');
  assert.equal(page.threadPillKind({ key: 'building', tone: 'progress' }), 'wait');
  assert.equal(page.threadPillKind({ key: 'ready', tone: 'neutral' }), '');
  const looks = JSON.parse(read('frontend/looks/looks.json'));
  assert.doesNotMatch(looks.wear.roots.card.to, /dev-request-status/, 'the card inside wears the look; the host is bare');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-request-status \{ margin-top: 16px; max-width: none; padding: 0; background: none; border-radius: 0; \}/);
});

test('the context column\'s Status: Homeroom bot\'s track drawn as the kit\'s card in the progress card\'s own host; else the stage; else the pill the standard bar wears', () => {
  const src = read(HEAD);
  assert.match(src, /\{track && !working && frame \? \(\s*<div className="dev-request-track" data-request-track=\{r\.trackPending \? 'pending' : track\.work\.stage\} inert=\{!!r\.trackPending\}>\s*<TopicTrackStatus track=\{track\} label=\{t\('project:frame\.topic\.status'\)\} links=\{trackLinks\(track, \{ request: false \}\)\} \/>/,
    'the same host, holding its place the same way (trackPending, the board\'s row)');
  assert.match(src, /\{track && !working && !frame \? \(/, 'the standard look keeps the product\'s card, as written');
  assert.match(src, /\{frame && !\(track && !working\) && !r\.status\.closed && \(!working \|\| pill\) \? \(\s*<div className="dev-request-at" data-request-at=/);
  assert.match(src, /\? <TopicFrameStatus label=\{t\('project:frame\.topic\.status'\)\} pill=\{pill \? \{ word: pill\.label, kind: threadPillKind\(pill\) \} : null\} \/>\s*: <RequestAt s=\{r\.status\} specs=\{specs\} label=\{t\('project:frame\.topic\.status'\)\} \/>/);
  const TRACK = 'frontend/src/features/dev-board/topic/frame/topic-track.tsx';
  const track = read(TRACK);
  assert.match(track, /import \{ TrackPictures, stepLooks, trackClock, trackDetail, trackEyebrow, trackLook, trackPlace \} from '\.\.\/\.\.\/\.\.\/messages\/bot-track';/, 'read through the product card\'s own helpers, not worded anew');
  const { loadTsx } = require('./lib/render-tsx');
  const { trackPillKind, trackStops } = loadTsx(TRACK, { cache: false });
  const need = { work: { stage: 'waiting_for_you', why: 'decision' }, step: 'plan', busy: false, doneBy: null };
  assert.equal(trackPillKind(need), 'wait');
  assert.deepEqual(trackStops(need), ['wait', '', '', '', ''], 'the step it is on is amber while the work waits');
  const live = { work: { stage: 'live' }, step: 'live', busy: false, doneBy: null };
  assert.equal(trackPillKind(live), 'ok');
  assert.deepEqual(trackStops(live), ['live', 'live', 'live', 'live', 'live']);
  const vote = { work: { stage: 'up_for_vote' }, step: 'vote', busy: false, doneBy: null };
  assert.equal(trackPillKind(vote), 'act');
  assert.deepEqual(trackStops(vote), ['done', 'done', 'done', 'now', '']);
});

test('"The request" is a labelled card that starts with who asked and when', () => {
  const src = read(HEAD);
  assert.match(src, /\{frame \? <TopicFrameLabel>\{t\('project:frame\.topic\.theRequest'\)\}<\/TopicFrameLabel> : null\}\s*\{frame \? <TopicFrameBy name=\{r\.asker\} color=\{swatchFor\(r\.asker\)\} line=\{r\.askedTime \|\| null\} title=\{r\.askedTitle\} at=\{r\.askedAt\} \/> : null\}\s*\{editing \? <RequestEditor r=\{r\} onClose=\{\(\) => setEditing\(false\)\} \/> : \(/,
    'the asker and the time the standard head says, which the kit\'s page puts away with the title');
  assert.equal(JSON.parse(read('frontend/locales/en/project.json'))['frame.topic.theRequest'].text, 'The request');
});

test('a change\'s page: Status is a pill under its label, with no five-stop line, and leads the context column over Votes and Tested', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const page = loadTsx('frontend/src/features/dev-board/topic/frame/topic-page.ts', { cache: false });
  assert.equal(page.changeStop, undefined, 'the five stops are the request page\'s; the standard change page has none');
  const src = read(CHANGE);
  assert.doesNotMatch(src, /changeStop|changes:track\./);
  assert.match(src, /\{frame && v\.status \? \(\s*<div className="dev-change-status">\s*<TopicFrameStatus label=\{t\('project:frame\.topic\.status'\)\} pill=\{\{ word: dotLine\(\[v\.status\.label, liveTally\(v\.status\)\?\.text\]\), kind: pillKind\(v\.status, v\.votes\) \}\} \/>/, 'the word and, once live, its final counted vote: what the standard bar\'s pill says');
  assert.match(src, /useSideStack\(frame, `\[data-change-root="\$\{id \?\? ''\}"\] > \[data-image-viewer-scope\]`, \['\.dev-change-status', '\.dev-change-pair'\]\);/);
  const html = renderComponent(FRAME, 'TopicFrameStatus', { label: 'Status', pill: { word: '✓ Live', kind: 'ok' } }, { cache: false });
  assert.equal(html, '<section class="fr-sec" data-topic-status=""><div class="fr-sechead"><h2 class="fr-cap">Status</h2></div><div class="fr-card"><div class="fr-status"><div class="fr-btnrow"><span class="fr-pill fr-ok" data-kind="ok">✓ Live</span></div></div></div></section>');
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-request-root > \[data-image-viewer-scope\] > :is\(\.dev-request-track, \.dev-request-at, \.dev-change-status, \.dev-change-pair\) \{[^}]*position: absolute;/);
  // In the 320px context column the Votes and Tested cards lay out as they
  // do on a phone: the figure on one line, the card's buttons on a row of
  // their own under the bar.
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-change-pair \.dev-change-gate \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-change-pair \.dev-change-gate-act \{ order: 1; flex-wrap: wrap; margin-top: 10px; \}/);
  assert.match(hand, /html\[data-skin\]:where\(:not\(\[data-skin="brand"\]\)\) \.dev-change-pair \.dev-change-gate-figure \{ white-space: nowrap; \}/);
});

test('Votes and Tested are small groups: each card\'s name is the label over it, its figure the card\'s first line', () => {
  const src = read(CHANGE);
  assert.match(src, /\{frame && stick \? <TopicFrameLabel>\{v\.votes\.name\}<\/TopicFrameLabel> : null\}\s*<GateCard which="votes" g=\{v\.votes\} action=\{ballot \? null : voteAction\} id=\{id\} closes=\{closes\} \/>\s*\{frame && stick \? <TopicFrameLabel>\{v\.testing\.name\}<\/TopicFrameLabel> : null\}\s*<GateCard which="testing"/,
    'the product\'s own cards, as written; only the change\'s own page (stick) gets the labels, a change section on a request\'s page keeps the standard pair');
  assert.match(src, /\{frame && stick && v\.merge \? <TopicFrameLabel>\{v\.merge\.name\}<\/TopicFrameLabel> : null\}/);
  assert.equal(renderComponent(FRAME, 'TopicFrameLabel', { children: 'Votes' }, { cache: false }),
    '<div class="fr fr-topiclabel" data-topic-label=""><div class="fr-sechead"><h2 class="fr-cap">Votes</h2></div></div>');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const P = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\) ';
  assert.match(hand, new RegExp(`${P}\\.dev-change-root \\.dev-change-pair:not\\(\\[data-stuck\\]\\) \\.dev-change-gate-name \\{ display: none; \\}`), 'the name inside is put away; the card keeps it as its accessible name');
  assert.match(read(CHANGE), /role="group"\s+aria-label=\{shown\.name\}/);
  assert.match(hand, new RegExp(`${P}\\.dev-change-root \\.dev-change-pair:not\\(\\[data-stuck\\]\\) \\.dev-change-gate\\[data-done="true"\\] \\.dev-change-gate-figure \\{ display: inline-flex; align-items: center; gap: 8px; color: var\\(--fr-ok\\); \\}`), 'done: green, with a check');
  assert.match(hand, new RegExp(`${P}\\.dev-change-root \\.dev-change-pair\\[data-stuck\\] > \\.fr-topiclabel \\{ display: none; \\}`), 'stuck under the head on a phone it is the standard compact pair');
});

test('"The change" is a labelled card that starts with who put it up and what built it', () => {
  const src = read(CHANGE);
  assert.match(src, /\{frame \? <TopicFrameLabel>\{t\('project:frame\.topic\.theChange'\)\}<\/TopicFrameLabel> : null\}\s*\{frame \? <TopicFrameBy name=\{v\.author\} color=\{swatchFor\(v\.author\)\} line=\{dotLine\(\[v\.time, v\.via\]\)\} title=\{v\.timeTitle\} at=\{v\.at\} \/> : null\}\s*<ChangeDiagram value=\{body\.diagram\} \/>\s*<RequestWords html=\{body\.summaryHtml \|\| ''\} \/>/,
    'the same author, time and maker the standard head says, which the kit\'s page puts away with the title');
  const by = renderComponent(FRAME, 'TopicFrameBy', { name: 'snait', color: '#5b7553', line: '10:10 · via Claude Code', title: '6 Nov 2026, 10:10', at: '2026-11-06T10:10:00Z' }, { cache: false });
  assert.equal(by, '<div class="fr fr-topicby" data-topic-by=""><div class="fr-byline"><span class="fr-av" style="--fr-as:28px;--fr-ac:#5b7553" aria-hidden="true">s</span><b>snait</b><time dateTime="2026-11-06T10:10:00Z" title="6 Nov 2026, 10:10">10:10 · via Claude Code</time></div></div>');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const P = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\) ';
  assert.match(hand, new RegExp(`${P}\\.fr-topicby:has\\(\\+ \\.dev-request-ask\\) \\{ position: relative; z-index: 1; height: 44px; margin-bottom: -44px; \\}`), 'drawn inside the top of the card that follows it');
  assert.match(hand, new RegExp(`${P}\\.fr-topicby \\+ \\.dev-request-ask \\{ padding-top: 56px; \\}`));
  const catalog = JSON.parse(read('frontend/locales/en/project.json'));
  assert.equal(catalog['frame.topic.theChange'].text, 'The change');
  assert.equal(catalog['frame.topic.status'].text, 'Status');
});

test('"Ask Homeroom bot privately" is the kit\'s quiet small button under a look, with the product\'s words and press', () => {
  const src = read('frontend/src/features/dev-board/topic/work-with-bot.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);\s*if \(!slug \|\| !number \|\| number <= 0 \|\| !canWork\(\) \|\| botAtWork\) return null;\s*if \(frame\) \{/, 'the look is read before the early return');
  assert.match(src, /<Frame className="fr-topicask" data-work-with-bot=\{number\}>\s*<Btn kind="quiet" small disabled=\{busy\}/);
  assert.equal((src.match(/openThreadAbout\(slug, number, kind, \{ failed: t\('project:topic\.workWithBot\.failed'\) \}\)/g) || []).length, 2, 'the same press');
  assert.equal((src.match(/voting \? t\('project:topic\.workWithBot\.suggest'\) : t\('project:topic\.workWithBot\.ask'\)/g) || []).length, 2, 'the same words');
});

test('the discussion is the product\'s stream in one card under its count, what happened as quiet lines; on a phone where it stands leads the page', () => {
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('THE FRAME IN THE SHELL'), css.indexOf('/* looks:begin'));
  const P = 'html\\[data-skin\\]:where\\(:not\\(\\[data-skin="brand"\\]\\)\\) ';
  const STREAM = '#dev-topic-thread \\.dev-request > \\.dev-request-sheet #gc-thread-messages:is\\(\\[data-language="request"\\], \\[data-language="change"\\]\\)';
  assert.match(hand, new RegExp(`${P}${STREAM} \\{ position: relative; margin-top: 56px; padding: 8px 0; overflow: visible; backdrop-filter: none; -webkit-backdrop-filter: none; \\}`), 'room over the card for its label, which the card must not clip; and no blur on a plane that scrolls under the frosted composer');
  assert.match(hand, new RegExp(`${P}${STREAM}:not\\(:has\\(> :not\\(\\.messages-reply-count\\)\\)\\) \\{ padding: 0; background: none; box-shadow: none;`), 'nothing but the count: no empty card');
  assert.match(hand, new RegExp(`${P}#dev-topic-thread \\.dev-request #gc-thread-messages > \\.messages-reply-count \\{ position: absolute; inset-block-end: 100%; inset-inline-start: 0;`));
  assert.match(hand, new RegExp(`${P}#dev-topic-thread \\.dev-request #gc-thread-messages > \\.messages-reply-count::after \\{ content: none; \\}`), 'a label has no rule after it');
  const phone = hand.slice(hand.indexOf('[data-topic-frame-head] > .fr-head { flex-direction: row;'));
  assert.match(phone, new RegExp(`${P}\\.dev-request-root > \\[data-image-viewer-scope\\] \\{ display: flex; flex-direction: column; \\}`));
  assert.match(phone, new RegExp(`${P}\\.dev-request-root > \\[data-image-viewer-scope\\] > :is\\(\\.dev-change-status, \\.dev-request-track, \\.dev-request-at\\) \\{ order: -2; margin: 0 0 24px; \\}`));
  assert.match(phone, new RegExp(`${P}\\.dev-request-root > \\[data-image-viewer-scope\\] > :is\\(\\.dev-change-pair-mark, \\.dev-change-pair\\) \\{ order: -1; \\}`), 'the mark stays just before the pair: it is what says the pair has stuck');
  // The stream is the product's: transcript.tsx draws what it drew, but for a line's glyph, which under a look is the kit's icon.
  const stream = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(stream, /<div className="gc-msg-system dev-request-event" data-msg-id=\{msg\.id \?\? ''\} data-request-event=/);
  assert.match(stream, /<span className="dev-request-event-glyph" aria-hidden="true">\{drawn\(glyph\)\}<\/span>/);
  assert.match(stream, /<span className="dev-request-event-glyph" aria-hidden="true">\{drawn\(line\.glyph\)\}<\/span>/);
  assert.match(stream, /const EVENT_ICONS: Record<string, string> = \{ '📋': 'file', '✋': 'hand', '👀': 'eye', '✅': 'check', '🗳️': 'vote', '🎉': 'rocket' \};/, 'each emoji a line names has an icon of the kit\'s');
  assert.match(stream, /return \(glyph\) => \(frame && EVENT_ICONS\[glyph\] \? <KitIcon name=\{EVENT_ICONS\[glyph\]\} size=\{16\} \/> : glyph\);/, 'the standard look, and a glyph with no icon, keep the emoji');
  assert.equal((stream.match(/const drawn = useEventGlyph\(\);/g) || []).length, 2, 'the look is read once per line, at the top of each of the two lines');
  assert.ok(stream.indexOf('const drawn = useEventGlyph();\n  const line = changeLine(msg);\n  if (!line) return null;') > 0, 'before the line a change\'s event may return on');
  assert.match(hand, new RegExp(`${P}#dev-topic-thread #gc-thread-messages \\.dev-request-event \\.dev-request-event-glyph:not\\(:has\\(> svg\\)\\) \\{ font-size: 14px; filter: grayscale\\(1\\); opacity: \\.7; \\}`), 'only an emoji is drawn small and grey');
  assert.match(stream, /<div className="messages-reply-count" data-request-replies=\{count\}>/);
});
