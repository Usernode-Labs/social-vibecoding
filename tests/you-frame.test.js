// The You tab in the one frame, version 2 (frontend/src/features/profile/
// frame/): the first tour's layout holding today's page. Your handle as the
// title, the line of facts, Edit profile, six tabs; the Overview's work
// column is the standard page's row groups in its order, and its side column
// the two figures and This week with its chart. Changes, Requests and Votes
// are the bot's History for that kind; Friends is the Friends card's content
// as a tab; Feedback opens the product's own card.
//
// Run with: node --test tests/you-frame.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const DIR = 'frontend/src/features/profile/frame';
const FRAME = `${DIR}/you-frame.tsx`;

const identity = {
  name: 'Salah', username: '@snait', displayName: null, about: 'Building since April 2026 · Changes live in 78 apps', bio: null,
  chips: [{ key: 'github', label: 'Verified GitHub · lingash25', href: 'https://github.com/lingash25', external: true }],
};
const shell = (over) => ({ identity, tab: 'overview', onTab() {}, onEdit() {}, onFeedback() {}, ...over });
const days = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'].map((label, i) => ({ key: `d${i}`, label, spoken: `${label}: 1m`, heightPct: i === 3 ? 100 : 10, zero: i === 2, today: i === 6, peakLabel: i === 3 ? '37m' : null }));
const base = {
  shell: shell(),
  stats: [{ key: 'merged', value: '974', label: 'live' }, { key: 'challenges', value: '8', label: 'challenges' }, { key: 'kudos', value: '0', label: 'kudos', zero: true }],
  activity: { empty: false, canShare: true, time: '1h 18m', apps: '8', appsLabel: 'apps opened', merged: '56', mergedLabel: 'changes live', challenges: '2', challengesLabel: 'challenges done', days },
  rows: { changes: '974 live · 13 in progress', requests: '51 open · 714 done', requestsPending: false, feedback: '150 sent · 24 counted', votes: 'Latest: Ask for your location', challenges: 'Season 2 · rank #16 · 8 of 11 done', kudos: null, friends: 'Only you can see your friends' },
  slots: '11 apps made · no limit', admin: false,
  onSlots() {}, onShareWeek() {},
};
const render = (over) => renderComponent(FRAME, 'YouFrame', { ...base, ...over }, { cache: false });
const columns = (html) => {
  const at = html.indexOf('<div class="fr-cols">');
  const side = html.lastIndexOf('<div class="fr-stack">');
  return { main: html.slice(at, side), side: html.slice(side) };
};

test('You is a page of the frame: the handle, the line of facts, Edit profile as the one quiet button', () => {
  const html = render();
  assert.match(html, /^<div class="fr" data-you-frame="" data-you-tab="overview"><div class="fr-inner"><div class="fr-head"><div class="fr-tx"><h1 class="fr-title">@snait<\/h1><p class="fr-purpose">Building since April 2026 · Changes live in 78 apps<\/p><\/div><div class="fr-acts"><button type="button" class="fr-btn fr-line">Edit profile<\/button><\/div><\/div>/);
  assert.doesNotMatch(html, /Open public page|Copy public link|Public profile/, 'the public page is in Edit profile, as on the standard page');
  const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
  for (const c of classes) assert.match(c, /^fr(-|$)/, `${c} is not a kit class`);
  assert.match(renderComponent(FRAME, 'YouFrame', { ...base, shell: shell({ identity: { ...identity, displayName: 'Salah N' } }) }, { cache: false }),
    /<h1 class="fr-title">@snait<\/h1><div class="fr-sub13">Salah N<\/div>/, 'a display name is said under the handle');
});

test('six tabs, each with an address; Feedback is the door to the product\'s own card', () => {
  const html = render();
  const tabs = [...html.slice(html.indexOf('<nav class="fr-tabs"'), html.indexOf('</nav>')).matchAll(/<a class="fr-tab( fr-on)?" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[3], m[2], !!m[1]]);
  assert.deepEqual(tabs, [
    ['Overview', '#profile', true],
    ['Changes', '#profile?tab=changes', false],
    ['Requests', '#profile?tab=requests', false],
    ['Feedback', '#profile?feedback', false],
    ['Votes', '#profile?tab=votes', false],
    ['Friends', '#profile?tab=friends', false],
  ]);
  const src = read(FRAME);
  assert.match(src, /key === 'feedback' \? onFeedback\(\) : onTab\(key as YouTab\)/);
});

test('the work column: the verified accounts, then the standard page\'s groups in its order', () => {
  const { main } = columns(render({ admin: true }));
  assert.match(main, /<div class="fr-btnrow fr-chips"><a class="fr-pill" href="https:\/\/github\.com\/lingash25" target="_blank" rel="noopener noreferrer">Verified GitHub · lingash25<\/a><\/div>/);
  assert.deepEqual([...main.matchAll(/<h2 class="fr-cap">([^<]+)<\/h2>/g)].map((m) => m[1]), ['Your work', 'Rewards', 'Account', 'Settings', 'Admin']);
  const rows = [...main.matchAll(/<a class="fr-row" href="([^"]+)"[^>]*><span class="fr-lead" aria-hidden="true">.*?<\/span><span class="fr-tx"><span class="fr-t">([^<]+)<\/span><span class="fr-s">([^<]+)<\/span>/gs)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(rows, [
    ['#profile?tab=changes', 'Your changes', '974 live · 13 in progress'],
    ['#profile?tab=requests', 'Your requests', '51 open · 714 done'],
    ['#profile?feedback', 'Your feedback', '150 sent · 24 counted'],
    ['#profile?tab=votes', 'Your votes', 'Latest: Ask for your location'],
    ['#leaderboard/challenges', 'Challenges &amp; standings', 'Season 2 · rank #16 · 8 of 11 done'],
    ['#profile?tab=friends', 'Friends', 'Only you can see your friends'],
    ['#profile?slots', 'App slots', '11 apps made · no limit'],
    ['#profile?edit', 'Profile', 'Name, photo and bio'],
    ['#settings/alerts', 'Notifications', 'What you are told about, here and in each app'],
    ['#settings', 'Settings', 'Account, alerts, keys'],
    ['#admin', 'Admin &amp; moderation', 'Reports, people and platform settings'],
  ]);
  assert.doesNotMatch(columns(render()).main, /href="#admin"|>Admin</, 'Admin is an admin\'s');
  assert.match(columns(render({ wallet: true })).main, /Account, alerts, keys, wallet/, 'the native app\'s Settings line, as the standard row says it');
  assert.match(columns(renderComponent(FRAME, 'YouFrame', { ...base, shell: shell({ identity: { ...identity, bio: 'I build things.' } }) }, { cache: false })).main, /<p class="fr-sub15">I build things\.<\/p>/, 'the bio, when there is one');
});

test('the side column: the figures (a zero says nothing), then This week with its figures, bars, note and Share', () => {
  const { side } = columns(render());
  assert.match(side, /<h2 class="fr-cap">In numbers<\/h2><\/div><div class="fr-card"><div class="fr-facts fr-f2"><div class="fr-fact"><div class="fr-v">974<\/div><div class="fr-l">live<\/div><\/div><div class="fr-fact"><div class="fr-v">8<\/div><div class="fr-l">challenges<\/div><\/div><\/div><\/div>/);
  assert.doesNotMatch(side, />kudos</);
  assert.match(side, /<h2 class="fr-cap">This week<\/h2><button type="button" class="fr-link">Share<\/button><\/div><div class="fr-card"><div class="fr-facts fr-f2 fr-inset">.*?1h 18m.*?time in apps.*?8.*?apps opened.*?<\/div><div class="fr-facts fr-f2 fr-inset">.*?56.*?changes live.*?2.*?challenges done.*?<\/div><div class="fr-bars" role="img" aria-label="Time in apps each day">/s);
  assert.equal((side.match(/class="fr-bcol/g) || []).length, 7, 'one bar a day');
  assert.match(side, /<div class="fr-bcol" aria-hidden="true"><span class="fr-bv">37m<\/span><i style="height:100%"><\/i><span class="fr-bl">Sun<\/span><\/div>/, 'the busiest day says its time');
  assert.match(side, /<div class="fr-bcol fr-now" aria-hidden="true">.*?<span class="fr-bl">Wed<\/span>/s, 'today is marked');
  assert.match(side, /<div class="fr-foot fr-left">Last 7 days, by UTC day\. Only time inside apps counts\.<\/div><\/div>/);
  assert.doesNotMatch(columns(render({ stats: [{ key: 'merged', value: '0', label: 'live', zero: true }] })).side, /In numbers/);
  const empty = columns(render({ activity: { empty: true } })).side;
  assert.match(empty, /<h2 class="fr-cap">This week<\/h2><\/div><div class="fr-card fr-pad">No time in apps this week yet\. Open an app and your days show here\.<\/div>/, 'an empty week says so, as the standard card does');
  assert.doesNotMatch(columns(render({ activity: null })).side, /This week/, 'a read that failed draws no card');
  assert.doesNotMatch(columns(render({ activity: { ...base.activity, canShare: false } })).side, /fr-cap">This week<\/h2><button/, 'nothing to share: no link');
});

test('what the first tour invented is gone', () => {
  const src = read(FRAME);
  assert.doesNotMatch(src, /publicPage|profile:frame\.week|profile:frame\.copy|profile:frame\.pair|profile:edit\.public/);
  const catalog = JSON.parse(read('frontend/locales/en/profile.json'));
  for (const id of ['frame.pair', 'frame.week.time', 'frame.week.apps', 'frame.copy']) assert.equal(catalog[id], undefined, `${id} is removed`);
});

test('Changes, Requests and Votes are History for that kind, read with History\'s own hook', () => {
  const src = read(`${DIR}/you-history.tsx`);
  assert.match(src, /import \{ monthName, useHistory, type HistoryRow \} from '\.\.\/\.\.\/ai\/history';/);
  assert.match(src, /const history = useHistory\(\{\s+showing,\s+signedIn: [^\n]+\n\s+projects: one,\s+kind,\s+demo: isDemo\(\),\s+\}\);/);
  // What today's History holds for the kind: its rows are the bot's lists' own
  // lines, drawn by the rows its page draws under a look, so a project folds
  // after its first rows ("Show N more") and a row says its project and number
  // (its tooltip; its second line on a phone).
  assert.match(src, /const \{ historyMonths: months \} = useAiLines\(\{\s+ready: history\.ready, rows: NO_ROWS, owed: 0, progress: NO_ROWS, waiting: NO_ROWS, live: NO_ROWS,\s+openRow: nothing, openThread: nothing, history: \{ \.\.\.history, rows \}, openHistory,\s+\}\);/, 'by month, as the bot\'s lists build them');
  assert.match(src, /<Groups lines=\{month\.rows\} heads=\{!picked\} first=\{GROUP_FIRST\.live\} where \/>/, 'by project, folded as History folds');
  assert.doesNotMatch(src, /byProject|historyWords|historyGlyph|numberPr/, 'no second copy of the rows\' words');
  const list = read('frontend/src/features/ai/frame-list.tsx');
  assert.match(list, /export function Groups\(/);
  assert.match(list, /: where && line\.tooltip \? <span className=\{k\('s p'\)\} aria-hidden="true" data-ai-line-where="">\{line\.tooltip\}<\/span> : null\}/, 'the row\'s own line, on a phone');
  assert.match(list, /t\('messages:ai\.work\.showMore', \{ count: hidden \}\)/);
  assert.equal(JSON.parse(read('frontend/locales/en/profile.json'))['frame.projectLeft'], undefined, 'a project left is said in History\'s own words');
  assert.match(src, /<ShowAll onClick=\{history\.more\}>\{history\.loading \? t\('messages:ai\.history\.loading'\) : t\('messages:ai\.history\.earlier'\)\}<\/ShowAll>/);
  assert.doesNotMatch(src, /HISTORY_KINDS|ai\.history\.kind\.|Track\b/, 'the tab is the kind: no kind buttons, no five-stop line');
  const html = renderComponent(`${DIR}/you-history.tsx`, 'YouHistory', { shell: shell({ tab: 'changes' }), kind: 'change' }, { cache: false });
  assert.match(html, /^<div class="fr" data-you-frame="" data-you-tab="changes">/);
  assert.match(html, /<a class="fr-tab fr-on" href="#profile\?tab=changes" aria-current="page">Changes<\/a>/);
  assert.match(html, /<div class="fr-card fr-pad">Loading your history<\/div>/, 'until the first read answers');
  const view = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(view, /if \(tab === 'changes' \|\| tab === 'requests' \|\| tab === 'votes'\) return <YouHistory shell=\{shell\} kind=\{HISTORY_KIND\[tab\]\} \/>;/);
  assert.match(view, /const HISTORY_KIND = \{ changes: 'change', requests: 'request', votes: 'vote' \} as const;/);
});

test('Friends is a tab: the search, who asked and your friends in one group, sent requests beside it', () => {
  const person = (id, username, meta) => ({ key: String(id), id, username, href: `#profile/${username}`, avatarUrl: null, initial: username[0].toUpperCase(), meta });
  const view = { loaded: true, incoming: [person(1, 'kempis', 'Asked yesterday')], friends: [person(2, 'evan', 'Friends since September 2026')], outgoing: [person(3, 'nisarena1', 'Requested 2 days ago')] };
  const html = renderComponent(`${DIR}/you-friends.tsx`, 'YouFriends', { shell: shell({ tab: 'friends' }), view, pendingId: null, status: '' }, { cache: false });
  const { main, side } = columns(html);
  assert.match(main, /<div data-you-friends-search=""><div id="profile-friend-search"/, 'the product\'s own search');
  assert.match(main, /<h2 class="fr-cap">Friends<\/h2><\/div><div class="fr-card"><div class="fr-row fr-wrap"><span class="fr-av"[^>]*>k<\/span><span class="fr-tx"><span class="fr-t"><a href="#profile\/kempis">@kempis<\/a><\/span><span class="fr-s">Asked yesterday<\/span><\/span><button type="button" class="fr-btn fr-quiet fr-sm" data-friend-request-decline="kempis">Decline<\/button><button type="button" class="fr-btn fr-sm" data-friend-request-accept="kempis">Accept<\/button><\/div><a class="fr-row" href="#profile\/evan"><span class="fr-av"[^>]*>e<\/span><span class="fr-tx"><span class="fr-t">@evan<\/span><span class="fr-s">Friends since September 2026<\/span><\/span><\/a><\/div>/);
  assert.match(main, /<p class="fr-secnote">Only you can see your friends\. Nobody else sees this list or how long it is\.<\/p>/);
  assert.match(side, /<h2 class="fr-cap">Sent requests<\/h2><\/div><div class="fr-card"><div class="fr-row fr-wrap">.*?<a href="#profile\/nisarena1">@nisarena1<\/a>.*?Requested 2 days ago.*?<button type="button" class="fr-btn fr-quiet fr-sm" data-friend-sent-cancel="nisarena1">Cancel<\/button>/s);
  const busy = renderComponent(`${DIR}/you-friends.tsx`, 'YouFriends', { shell: shell({ tab: 'friends' }), view, pendingId: 1, status: 'Could not answer.' }, { cache: false });
  assert.match(busy, /class="fr-btn fr-sm fr-off" data-friend-request-accept="kempis" disabled=""/, 'off while it is answered');
  assert.match(busy, /<div role="alert"><div class="fr-note fr-bad">.*?Could not answer\./s);
  const none = renderComponent(`${DIR}/you-friends.tsx`, 'YouFriends', { shell: shell({ tab: 'friends' }), view: { loaded: true, incoming: [], friends: [], outgoing: [] }, pendingId: null, status: '' }, { cache: false });
  assert.match(none, /<div class="fr-card fr-pad">No friends yet\. Find someone by username above\.<\/div>/);
  assert.doesNotMatch(none, /Sent requests/);
  assert.match(renderComponent(`${DIR}/you-friends.tsx`, 'YouFriends', { shell: shell({ tab: 'friends' }), view: { loaded: false, incoming: [], friends: [] }, pendingId: null, status: '' }, { cache: false }), /Your friends could not be loaded/);
  assert.doesNotMatch(html, /Add a friend|Message</, 'what the first tour added is not there');
});

test('the tab is the store\'s, the address says it, and under a look Friends opens the tab, not the card', () => {
  const tabs = read(`${DIR}/you-tabs.ts`);
  assert.match(tabs, /export const YOU_TABS = \['overview', 'changes', 'requests', 'votes', 'friends'\] as const;/);
  assert.match(tabs, /return tab === 'overview' \? '#profile' : `#profile\?tab=\$\{tab\}`;/);
  const js = read('frontend/src/features/profile/profile.js');
  assert.match(js, /showFriends\(\) \{\n\s+\/\/ Under a look Friends is a tab of You[^\n]*\n\s+if \(isFrameSkin\(currentSkin\(\)\)\) \{ Profile\.showTab\('friends'\); return; \}/);
  assert.match(js, /Profile\._readTab\(targetUsername\);/);
  assert.match(js, /history\.replaceState\(history\.state, '', `\$\{location\.pathname\}\$\{location\.search\}\$\{tabAddress\(tab\)\}`\);/, 'a tab replaces the address: Back leaves the page');
  assert.match(read('frontend/src/features/profile/profile-store.js'), /tab: 'overview',/);
});

test('the profile draws the kit\'s page under a look, from its own view, with its sheets', () => {
  const src = read('frontend/src/features/profile/profile-view.tsx');
  assert.match(src, /const frame = isFrameSkin\(useLiveSkin\(\)\);/);
  assert.match(src, /\{frame \? <YouInFrame view=\{view\} tab=\{\(state\.tab \|\| 'overview'\) as YouTab\} friendsPending=\{state\.friendsPending \?\? null\} friendsStatus=\{state\.friendsStatus \|\| ''\} \/> : \(/);
  assert.match(src, /onEdit: \(\) => Profile\.showEditSheet\(\),\n\s+onFeedback: \(\) => Profile\.showFeedback\(\),/);
  assert.match(src, /useFramePage\(here \? \[tc\('core:tabs\.me'\), here\] : \[tc\('core:tabs\.me'\)\], here \? toOverview : null\);/, 'the bar says You, then the tab, with the way back');
  assert.match(src, /\{state\.feedbackOpen \? <FeedbackSheet view=\{view\.feedback\} \/> : null\}/, 'Feedback is the product\'s card');
  assert.match(src, /<div className="lg:grid lg:grid-cols-\[minmax\(0,22rem\)_minmax\(0,1fr\)\]/, 'the standard page stays as written');
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-skin\]\[data-you-frame\] #profile-screen \{ padding-inline-start: var\(--platform-rail-w, 0px\) !important; padding-inline-end: 0 !important; \}/, 'the page has the frame\'s page area');
  assert.match(css, /html\[data-skin\] \[data-you-frame\] \.fr-tabs \{ overflow-x: auto; scrollbar-width: none; \}/, 'six tabs scroll on a phone');
});

test('Edit profile is the product\'s dialog wearing the look: nothing rebuilt, its parts worn through the wear map', () => {
  const looks = JSON.parse(read('frontend/looks/looks.json')).wear.roots;
  assert.ok(looks.card.to.includes('.un-group:where(#profile-edit-sheet *)'), 'a group is the kit\'s card');
  assert.ok([looks.cap.to, ...(looks.cap.also || []).map((w) => w.to)].includes('.un-group-header:where(#profile-edit-sheet *)'), 'a group\'s label is the kit\'s (a wearer of its own, so another page\'s ids do not lift it)');
  assert.ok(looks.title.to.includes('#profile-edit-sheet > div:first-child'), 'the title is the kit\'s');
  assert.ok(looks.btn.to.includes('#profile-edit-save'), 'Save is the kit\'s button');
  const css = read('public/css/app.css');
  const hand = css.slice(css.indexOf('/* EDIT PROFILE (features/profile/profile-edit-sheet.tsx'), css.indexOf('/* A REQUEST\'S PAGE'));
  assert.ok(hand.length > 0);
  for (const line of hand.split('\n').filter((l) => l.startsWith('html'))) {
    assert.match(line, /^html\[data-skin\]:not\(\[data-skin="brand"\]\) #profile-edit-sheet/, 'only under a look of the frame, only inside the dialog');
    assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'kit tokens only');
  }
  assert.match(hand, /:is\(a, button\)\.text-violet-700 \{ color: var\(--fr-acc\); font-weight: 600; \}/, 'an action row is in the accent');
  const sheet = read('frontend/src/features/profile/profile-edit-sheet.tsx');
  assert.doesNotMatch(sheet, /isFrameSkin|useLiveSkin|components\/ui\/kit/, 'the dialog does not branch on the look');
  for (const id of ['profile-edit-sheet', 'profile-edit-save', 'profile-edit-name', 'profile-edit-bio', 'public-profile-publish', 'profile-edit-remove']) assert.ok(sheet.includes(`id="${id}"`), `${id} stays`);
});
