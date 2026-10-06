'use strict';

// The hub's details and the loose ends around it (communities, after #3261):
//
//   - who a project is for can grow from its page: "Make it public" on the
//     hero, or "Make it private" in its ⋯, opens the visibility proposal
//     (dev-board/workshop/community-card.tsx);
//   - the hub's channel card posts from its own composer, Needs you counts
//     the votes you owe, and a person who has not joined sees "Recently"
//     (dev-board/workshop/);
//   - a Mayor card refused for membership offers Join (features/agent-session);
//   - a Homeroom line kept in #general is drawn as Homeroom's (Homeroom
//     writes none into a channel now: tests/channel-activity.test.js);
//   - Discover's rows open the hub, its controls sit over the list's card,
//     the Communities toggle is the project page's strip, and Home's Browse
//     all links carry the accent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HUB = 'frontend/src/features/dev-board/workshop/hub-cards.tsx';
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';
const CARD_SRC = read(CARD);
const LANDER = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const CSS = read('public/css/app.css');

const community = (over = {}) => ({
  slug: 'garden',
  name: 'Garden',
  member_count: 12,
  is_member: true,
  is_creator: false,
  audience: 'open',
  audience_label: 'Public community',
  members: [{ id: 1, username: 'ada' }, { id: 2, username: 'lin' }],
  channel: null,
  activity: { active_week: 4, shipped_month: 3 },
  approval: { policy: 'anyone', approvals_required: null, electorate: 12, required: 5 },
  ...over,
});

test('#3268, then #4045: who it is for rides the count, with no faces and no trend on the hero', () => {
  const { HeroPeople } = loadTsx(CARD);
  const people = renderToHtml(createElement(HeroPeople, { count: 19 },
    createElement('span', { className: 'dev-ws-hero-actions' }, 'Invite')));
  assert.match(people, /<span class="dev-ws-hero-count" data-ws-members-cell="members">19 members<\/span><span class="dev-ws-hero-actions">Invite<\/span>/,
    'the count, then the actions at the far end of the same row');

  // WHO IT IS FOR rides the count: "Public community · 19 members", its
  // glyph leading, and Just you is the label alone (#852: the label was a
  // chip under the name, and the name is the coloured header's now).
  const labelled = renderToHtml(createElement(HeroPeople, { count: 19, audience: 'open', audienceLabel: 'Public community' }));
  assert.match(labelled, /<span class="dev-ws-hero-count" data-ws-members-cell="members"><span class="dev-ws-hero-audience" data-ws-community-audience=""><svg[^>]*>[\s\S]*?<\/svg><b>Public community<\/b><\/span> · 19 members<\/span>/);
  const alone = renderToHtml(createElement(HeroPeople, { count: 1, audience: 'solo', audienceLabel: 'Just you' }));
  assert.match(alone, /<b>Just you<\/b><\/span><\/span>/);
  assert.doesNotMatch(alone, /\d+ members?/, 'Just you counts nobody');

  // #4045: who it is for, then what it is, then one row of what you can do.
  // The faces that repeated the count and the activity line with its
  // fourteen-day chart are gone from the hero and from app.css.
  const src = CARD_SRC;
  assert.doesNotMatch(src, /HERO_FACES|HeroActivity|dev-ws-hero-face|dev-ws-hero-activity|dev-ws-hero-spark|data-ws-members-trend|data-ws-members-stats/);
  assert.match(src, /<HeroPeople\s+count=\{Number\(data\.member_count\) \|\| 0\}\s+audience=\{data\.audience\}\s+audienceLabel=\{data\.audience_label\}\s+\/>/);
  assert.ok(src.indexOf('<HeroPeople\n') < src.indexOf('data-ws-community-description=""'), 'who it is for, then what it is');
  // Open app, Invite, Make it public and the ⋯ lead the row; Join or Joined
  // is across from them at its far end.
  assert.match(src, /<div className="dev-ws-hero-row">\s*<div className="dev-ws-hero-actions">\s*\{openApp\}[\s\S]*?data-ws-community-invite=""[\s\S]*?<MakePublic[\s\S]*?\{menu\}\s*<\/div>\s*\{membership \? <span className="dev-ws-hero-member">\{membership\}<\/span> : null\}/);
  // How a change gets in is the Workshop page's Approval rules card now.
  const hero = src.slice(src.indexOf('export function CommunityCard('), src.indexOf('export function ApprovalRules('));
  assert.doesNotMatch(hero, /data-ws-community-rule/);
  assert.match(src, /export function ApprovalRules\([\s\S]*?data-ws-approval-rules=""[\s\S]*?data-ws-community-rule="">\{approvalLine\(data\.approval\)\}/);
  assert.doesNotMatch(read(HUB), /export function MembersCard/, 'the hub has no Members & activity card any more');
});

test('#3276: the hero\'s rows wrap instead of running past a phone\'s edge', () => {
  // Five faces, "13 members", Joined and Invite came to 364px in a 359px
  // row on a 375px phone, and the hub scrolled sideways. Nothing in a row
  // can shrink, so it has to wrap: the people row, and the actions among
  // themselves, with Join or Joined held at the actions row's far end.
  const rule = (sel) => {
    const m = CSS.match(new RegExp(`^${sel.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`, 'm'));
    assert.ok(m, `${sel} has a rule`);
    return m[1];
  };
  assert.match(rule('.dev-ws-hero-people'), /display: flex; flex-wrap: wrap;/);
  assert.match(rule('.dev-ws-hero-row > .dev-ws-hero-actions'), /min-width: 0; flex-wrap: wrap;/);
  assert.match(rule('.dev-ws-hero-member'), /margin-left: auto; flex: none;/);
  // The Join popup hangs from the right of its button, which ends the row.
  assert.match(CSS, /\.dev-ws-hero \.dev-ws-hero-member \.dev-ws-join-pop \{ left: auto; right: -6px; \}/);
});

test('Needs you counts the votes you owe, not the requests nobody has claimed', () => {
  const { NeedsCard } = loadTsx(HUB);
  const row = (key, title, kind) => ({ t: 'card', key, card: { title: { text: title } }, who: 'ada', kind });
  const mixed = renderToHtml(createElement(NeedsCard, {
    queue: [row('c1', 'Fix login', 'claim'), row('v1', 'Dark mode', 'vote'), row('c2', 'Tags', 'claim')],
    canPost: true,
    onOpen: () => {},
  }));
  assert.match(mixed, /data-ws-hub-needs-votes="1"/);
  assert.match(mixed, /<span class="dev-ws-head-n">1 to vote<\/span>/);
  assert.match(mixed, /<span class="dev-ws-hub-needs-title">Dark mode<\/span>/, 'the first VOTE leads, not the first row');
  assert.doesNotMatch(mixed, /Fix login/);
  // #3408: requests alone owe no vote, so the hub draws no card, only the
  // line, and its count of requests is the way into the queue. #4045: the
  // door is the whole line — no "Nothing more to vote on ·" before it.
  const { NothingToVote, owesVote } = loadTsx(HUB);
  const claims = [row('c1', 'Fix login', 'claim'), row('c2', 'Tags', 'claim')];
  assert.equal(owesVote(claims), false, 'requests alone owe no vote');
  assert.equal(owesVote([...claims, row('v1', 'Dark mode', 'vote')]), true);
  const claimsOnly = renderToHtml(createElement(NothingToVote, { queue: claims, onOpen: () => {} }));
  assert.match(claimsOnly, /^<p class="dev-ws-week-note" data-ws-hub-needs-none=""><button type="button" class="dev-ws-link un-touch-target" data-ws-hub-needs-requests="">2 requests nobody has picked up<\/button><\/p>$/);
  assert.doesNotMatch(claimsOnly, /dev-ws-head-n|Needs you/, 'no card, no count');
  const one = renderToHtml(createElement(NothingToVote, { queue: [claims[0]], onOpen: () => {} }));
  assert.match(one, />1 request nobody has picked up</);
});

test('#3489: Your work stays on the hub with nothing in progress, and says so', () => {
  const { YourWorkCard } = loadTsx(HUB);
  const props = { slug: 'garden', canPost: true, openKey: null, onToggleRow: () => {}, all: false, onAll: () => {} };
  const empty = renderToHtml(createElement(YourWorkCard, { ...props, rows: [] }));
  assert.match(empty, /^<section class="dev-ws-strip dev-ws-hub-work" data-ws-mine-card="">/);
  assert.match(empty, /<span class="dev-ws-head-title">Your work<\/span>/);
  assert.match(empty, /<p class="text-xs text-zinc-500 dark:text-zinc-400" data-ws-mine-empty="">No work in progress\.<\/p>/);
  assert.doesNotMatch(empty, /dev-ws-head-n|data-ws-lane|data-ws-mine-more/, 'no count of zero, no empty lane, no reveal');
  // Only a signed-in viewer's hub draws it: a visitor has no work to list.
  // A project nobody else is in may leave it out (tests/hub-just-you.test.js).
  assert.match(LANDER, /\{v\.mine && \(v\.mine\.rows\.length \|\| \(v\.mine\.viewer && workEmpty\)\) \? \(\s*<YourWorkCard/);
});

test('the channel card\'s composer sends to the room and re-reads the hub', () => {
  const src = read(HUB);
  const composer = src.slice(src.indexOf('function HubComposer('), src.indexOf('export function NeedsCard('));
  assert.match(composer, /await fetch\(url, \{\s*method: 'POST',\s*headers: \{ 'Content-Type': 'application\/json' \},\s*body: JSON\.stringify\(\{ content \}\),/);
  assert.match(composer, /if \(body && body\.code === 'join_required'\) return;/,
    'a membership refusal is the fetch wrapper\'s question, and the draft stays');
  assert.match(composer, /setText\(''\);\s*await reloadCommunity\(slug\);/);
  // #general's placeholder names the channel.
  const { ChannelCard } = loadTsx(HUB);
  const html = renderToHtml(createElement(ChannelCard, {
    slug: 'homeroom', name: 'Homeroom',
    data: community({ channel: { last_message: null, last_at: null, last_by: null, unread_count: 0, recent: [], href: '#messages/1', handle: 'general', post_url: '/api/conversations/1/messages' } }),
  }));
  assert.match(html, /placeholder="Message #general…"/);
  // The server hands the composer each room's own write route.
  const route = read('src/routes/apps.js');
  assert.match(route, /post_url: `\/api\/conversations\/\$\{conversationId\}\/messages`,/);
  assert.match(route, /post_url: `\/api\/apps\/\$\{encodeURIComponent\(app\.slug\)\}\/messages`,/);
});

test('a person who has not joined sees "Recently" over the same rows', () => {
  assert.match(LANDER, /const outsider = !!community && !community\.is_member;/);
  // A first visit, with no last visit to be since, reads "Recently" too.
  assert.match(LANDER, /<span className="dev-ws-since-label">\{v\.since && !outsider \? 'Since your last visit' : 'Recently'\}<\/span>/);
  // The rows and Clear are the same for everyone (declared checks select on
  // Clear on Homeroom's page); only the heading's words change.
  assert.doesNotMatch(LANDER, /outsider \? null/);
});

test('Make it public is the hero\'s, Make it private is the ⋯\'s, and both are a proposal', () => {
  const { audienceChangeLine, canMakePrivate, MAKE_PRIVATE_LINE } = loadTsx(CARD);
  assert.equal(audienceChangeLine('Make this app public'), 'Making it a public community is waiting for approval');
  assert.equal(audienceChangeLine('Make this app private (collaborators only)'), 'Making it a private community is waiting for approval');
  assert.equal(audienceChangeLine('Make this app invite-only build, public to view'), 'A change to who it is for is waiting for approval');
  assert.equal(audienceChangeLine(null), 'A change to who it is for is waiting for approval');

  // One proposal for both directions.
  const propose = CARD_SRC.slice(CARD_SRC.indexOf('export async function proposeAudience('), CARD_SRC.indexOf('export const MAKE_PRIVATE_LINE'));
  assert.match(propose, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/visibility-pr`/);
  assert.match(propose, /to === 'private'\s*\? \{ collabVisibility: 'private', viewVisibility: 'private' \}\s*: \{ collabVisibility: 'public', viewVisibility: 'public' \}/,
    'a public community is public to use and to build; a private community is private to both, as the create dialog maps them');
  assert.match(propose, /if \(!res\.ok && res\.status !== 409\)/, 'one already up is not an error: the hero shows it');

  // MAKE IT PUBLIC (it was "Open it up"): a button, on a private community's
  // hero and a just-yours project's Share it card, asking under itself.
  const pub = CARD_SRC.slice(CARD_SRC.indexOf('function MakePublic('), CARD_SRC.indexOf('export function canMakePrivate('));
  assert.match(pub, />\s*Make it public\s*</);
  assert.match(pub, /await proposeAudience\(slug, 'public'\);/);
  assert.match(pub, /Members vote on this first, and it applies once it merges\./, 'it says it is a proposal, not a switch');
  assert.doesNotMatch(CARD_SRC, /Open it up'|>Open it up<|opening it up/i, 'the old words are gone from what is drawn');
  assert.match(CARD_SRC, /\{data\.can_manage && !data\.audience_change && data\.audience === 'invited' \? \(\s*<MakePublic /);
  assert.match(CARD_SRC, /\{canOpenUp \? \(\s*<MakePublic /);
  assert.match(CARD_SRC, /or make it public so anyone can join\./);

  // MAKE IT PRIVATE: not a hero button, a row of the ⋯, for a public
  // community, to whoever may open the proposal, while none is up.
  assert.equal(canMakePrivate({ audience: 'open', can_manage: true, audience_change: null }), true);
  assert.equal(canMakePrivate({ audience: 'invited', can_manage: true, audience_change: null }), false);
  assert.equal(canMakePrivate({ audience: 'open', can_manage: false, audience_change: null }), false);
  assert.equal(canMakePrivate({ audience: 'open', can_manage: true, audience_change: { session_id: 4 } }), false);
  assert.equal(canMakePrivate(null), false);
  const priv = CARD_SRC.slice(CARD_SRC.indexOf('export async function confirmMakePrivate('), CARD_SRC.indexOf('function MakePublic('));
  assert.match(priv, /ui\.confirm\(\{\s*title: `Make \$\{name\} a private community\?`,\s*message: MAKE_PRIVATE_LINE,\s*confirmLabel: 'Propose making it private',/);
  assert.match(priv, /if \(!ok\) return;\s*try \{\s*await proposeAudience\(slug, 'private'\);/);
  assert.match(priv, /await reloadCommunity\(slug\);/, 'and the hero shows it up for a vote');
  const menu = read('frontend/src/features/dev-board/actions-row.tsx');
  assert.match(menu, /\{onMakePrivate \? \(\s*<PlusRow\s+data-plus="make-private"[\s\S]{0,120}title="Make it private"[\s\S]{0,300}onClick=\{\(\) => \{ callAppView\('_closePlusMenu'\); onMakePrivate\(\); \}\}/);
  assert.ok(menu.indexOf('data-plus="make-private"') > menu.indexOf('label="Settings &amp; rules"'), 'the first of Settings & rules');
  // Private decides who can OPEN it. Every repository is public on GitHub
  // (services/github.js createRepo), so both say the code stays public.
  assert.equal(MAKE_PRIVATE_LINE, 'Only people who are invited can open it and build it. '
    + 'Its code stays public on GitHub. Members vote on this first, and it applies once it merges.');
  assert.match(menu, /data-plus="make-private"[\s\S]{0,200}sub="Only invited people can open and build it\. Code stays public on GitHub\."/);
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /onMakePrivate=\{canMakePrivate\(community\)\s*\? \(\) => \{ void confirmMakePrivate\(slug, app\.name \|\| community\?\.name \|\| slug\); \}\s*: null\}/);
  // The row appears once the read answers, after the menu was wired, so it
  // closes the menu through the close the wiring publishes.
  assert.match(read('public/js/app-view.js'), /AppView\._closePlusMenu = close;/);
  assert.match(CARD_SRC, /href=\{`#app\/\$\{encodeURIComponent\(slug\)\}\/dev\/proposals\/\$\{data\.audience_change\.session_id\}`\}/);
  // The server offers it to exactly whom POST /visibility-pr accepts.
  const route = read('src/routes/apps.js');
  assert.match(route, /const canManage = !app\.self_hosted && !!app\.repo_url\s*&& await appAdmins\.canManageApp\(pool, app, req\.user\);/);
  assert.match(route, /await renamePr\.findVisibilityPr\(pool, app\.id\)/);
});

test('a Mayor card refused for membership offers Join, then asks the Mayor to try again', () => {
  const tools = require('../src/services/mcp-tools');
  const refused = tools.platformError({ ok: false, status: 403, body: { code: 'join_required', error: 'Join Garden to take part.', app: { slug: 'garden', name: 'Garden' } } });
  assert.equal(refused.structuredContent.code, 'join_required');

  const transcript = loadTsx('frontend/src/features/agent-session/transcript.ts');
  const action = (status, result) => ({ id: 'a1', toolName: 'start_change', title: 'Start a change', status, result, expiresAt: '2099-01-01T00:00:00Z' });
  const failed = action('failed', { ok: false, code: 'join_required', structured: { code: 'join_required', message: 'Join Garden to take part.', app: { slug: 'garden', name: 'Garden' } }, text: '' });
  assert.deepEqual(transcript.joinFor(failed), { slug: 'garden', name: 'Garden' });
  const card = { id: 'a1', toolName: 'start_change', title: 'Start a change', input: {}, expiresAt: '2099-01-01T00:00:00Z' };
  assert.deepEqual(transcript.cardView(card, new Map([['a1', failed]])).join, { slug: 'garden', name: 'Garden' });
  assert.equal(transcript.joinFor(action('failed', { ok: false, code: 'no_access', structured: { code: 'no_access' } })), null);
  assert.equal(transcript.cardView(card, new Map([['a1', action('done', failed.result)]])).join, null, 'only a failed card asks');

  const screen = read('frontend/src/features/agent-session/index.tsx');
  const join = screen.slice(screen.indexOf('function JoinToRetry('), screen.indexOf('function Card('));
  assert.match(join, /home\.setMembership\(join\.slug, true, undefined, \{ name: join\.name \}\)/, 'the one join path');
  assert.match(join, /void sendAgentMessage\(`I joined \$\{join\.name\}\. Please try "\$\{card\.title\}" again\.`\);/);
  assert.match(screen, /\{card\.status === 'failed' && card\.join \? \(\s*<JoinToRetry card=\{card\} join=\{card\.join\} \/>/);
  // No prose from the Mayor under the Join button: the card asks.
  const routes = read('src/routes/agent-sessions.js');
  assert.match(routes, /const joinRequired = outcome && outcome\.result && outcome\.result\.code === 'join_required';\s*const followUp = joinRequired \? null : await startFollowUp\(/);
});

test('a Homeroom line kept in #general, as the root of somebody\'s thread, is drawn as Homeroom\'s', () => {
  const conv = read('src/services/conversations.js');
  assert.match(conv, /username: system \? 'Homeroom' : \(row\.sender_username \|\| 'Deleted user'\),/);
  assert.match(conv.slice(conv.indexOf('async function countUnread(')), /AND m\.msg_type = 'message'/);
  const rows = read('frontend/src/features/messages/index.tsx');
  assert.match(rows, /&& !previous\.system && !message\.system/, 'an event never joins the row above it');
  assert.match(CSS, /\.messages-message-system \.messages-message-author \{ color: var\(--text-muted\); \}/);
});

test('Discover rows open the hub; the controls sit over the list\'s card', () => {
  const browse = read('frontend/src/features/apps/browse.js');
  assert.match(browse, /rowHref\(view\) \{\s*if \(!view \|\| view\.demo \|\| !view\.slug\) return null;\s*return `#app\/\$\{encodeURIComponent\(view\.slug\)\}\/workshop`;/);
  assert.match(read('public/js/app.js'), /return slug \? `#app\/\$\{encodeURIComponent\(slug\)\}\/workshop` : '#communities';/,
    'the same address App._hubHref builds');
});

test('the Communities screen has no toggle: Needs you is a row that opens a page', () => {
  // It had two tabs, Current status and Needs you, drawn as the project
  // page's strip. The UI overhaul made the list the page and Needs you a
  // row at its top ("3 votes waiting on you"), which opens the feed with a
  // way back; the strip and its CSS went with the tabs.
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.doesNotMatch(screen, /SECTION_TAB_ACTIVE|<TabsList|workshop-scope-tab/);
  assert.doesNotMatch(CSS, /\.workshop-scope-tabs? \{/);
  assert.match(screen, /<ListRow\s+as="button"\s+data-workshop-needs-open=""/);
  assert.match(screen, /className="dev-ws-page-back un-touch-target"\s+data-workshop-needs-back=""/,
    'the way back is the project page\'s own back disc');
});

test('Home\'s Browse all links carry the accent, not the header\'s periwinkle', () => {
  const ui = read('frontend/src/features/home/panels/ui.tsx');
  for (const cls of ['home-panel-browse', 'home-panel-lb-browse']) {
    const tag = ui.slice(ui.indexOf(`className="${cls} `), ui.indexOf('"', ui.indexOf(`className="${cls} `) + 12));
    assert.match(tag, /text-\[color:var\(--accent\)\]/, `${cls} is the accent`);
    assert.doesNotMatch(tag, /brand-ink/);
  }
});
