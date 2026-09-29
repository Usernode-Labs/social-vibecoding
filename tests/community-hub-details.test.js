'use strict';

// The hub's details and the loose ends around it (communities, after #3261):
//
//   - who a project is for can grow from its page: "Open it up" / "Make it a
//     group" on the hero opens the visibility proposal
//     (dev-board/workshop/community-card.tsx);
//   - the hub's channel card posts from its own composer, Members & activity
//     draws fourteen days, Needs you counts the votes you owe, and a person
//     who has not joined sees "Recently" (dev-board/workshop/);
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

const days = (counts) => counts.map((n, i) => ({ day: `2026-09-${String(10 + i).padStart(2, '0')}`, n }));

test('#3268: the hero carries who is here and the fortnight, with the actions at the row\'s end', () => {
  const { HeroPeople, HeroActivity, HERO_FACES } = loadTsx(CARD);
  const members = ['ada', 'lin', 'kai', 'mia', 'sam', 'zoe', 'raj'].map((u, i) => ({ id: i + 1, username: u }));
  const people = renderToHtml(createElement(HeroPeople, { members, count: 19 },
    createElement('span', { className: 'dev-ws-hero-actions' }, 'Joined')));
  assert.equal(HERO_FACES, 5);
  assert.equal([...people.matchAll(/class="dev-ws-hero-face"/g)].length, 5, 'five faces, then the count says the rest');
  assert.match(people, /<span class="dev-ws-hero-count" data-ws-members-cell="members">19 members<\/span><span class="dev-ws-hero-actions">Joined<\/span>/,
    'the count, then the actions at the far end of the same row');

  const counts = [0, 1, 2, 0, 0, 3, 4, 0, 1, 0, 0, 2, 0, 4];
  const html = renderToHtml(createElement(HeroActivity, { activity: { active_week: 4, shipped_month: 3, daily: days(counts) } }));
  assert.match(html, /<span data-ws-members-cell="active"><b>4<\/b> active this week<\/span> · <span data-ws-members-cell="shipped"><b>3<\/b> shipped this month<\/span>/);
  assert.match(html, /Who took part, last 14 days/);
  const bars = [...html.matchAll(/<span class="(dev-ws-hero-spark-bar[^"]*)" style="height:(\d+)%" title="([^"]+)"/g)];
  assert.equal(bars.length, 14);
  assert.deepEqual(bars.map((b) => Number(b[2])), counts.map((n) => (n ? Math.max(12, Math.round((n / 4) * 100)) : 8)));
  assert.ok(bars.every((b, i) => counts[i] ? !/quiet/.test(b[1]) : /quiet/.test(b[1])), 'a quiet day is a sliver in the rule colour');
  assert.match(bars[1][3], /: 1 person$/);
  assert.match(bars[13][3], /: 4 people$/);
  assert.match(html, /data-ws-members-trend="" role="img" aria-label="People taking part each day, last 14 days: 0, 1, 2/);

  // A zero says nothing; a silent fortnight is one sentence.
  const shippedOnly = renderToHtml(createElement(HeroActivity, { activity: { active_week: 0, shipped_month: 2, daily: days(counts) } }));
  assert.doesNotMatch(shippedOnly, /active this week/);
  assert.match(shippedOnly, /<b>2<\/b> shipped this month/);
  const quiet = renderToHtml(createElement(HeroActivity, { activity: { active_week: 0, shipped_month: 0, daily: days(Array(14).fill(0)) } }));
  assert.match(quiet, /data-ws-members-trend="" data-ws-trend-empty="">Nobody has been around in the last 14 days\./);

  // Just you: the hero stays as it was; a Community or a Group gets both rows.
  const src = CARD_SRC;
  assert.match(src, /\{solo \? actions : \(\s*<HeroPeople members=\{data\.members\} count=\{Number\(data\.member_count\) \|\| 0\}>\s*\{actions\}\s*<\/HeroPeople>\s*\)\}\s*\{solo \? null : <HeroActivity activity=\{data\.activity\} \/>\}/);
  assert.ok(src.indexOf('data-ws-community-description') < src.indexOf('<HeroPeople members'), 'what it is, then who is here');
  assert.ok(src.indexOf('<HeroActivity activity') < src.indexOf('data-ws-community-rule=""'), 'and how a change gets in last');
  assert.doesNotMatch(read(HUB), /export function MembersCard/, 'the hub has no Members & activity card any more');
});

test('#3276: the people row wraps its actions instead of running past a phone\'s edge', () => {
  // Five faces, "13 members", Joined and Invite came to 364px in a 359px
  // row on a 375px phone, and the hub scrolled sideways. Nothing in the row
  // can shrink, so it has to wrap: the row, and the actions among themselves.
  const rule = (sel) => {
    const m = CSS.match(new RegExp(`^${sel.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`, 'm'));
    assert.ok(m, `${sel} has a rule`);
    return m[1];
  };
  assert.match(rule('.dev-ws-hero-people'), /display: flex; flex-wrap: wrap;/);
  const actions = rule('.dev-ws-hero-people > .dev-ws-hero-actions');
  assert.match(actions, /flex-wrap: wrap;/);
  // Still at the row's far end when they wrap: the Join and "Open it up"
  // popups hang from the right of their button.
  assert.match(actions, /margin-left: auto;/);
  assert.match(actions, /justify-content: flex-end;/);
  assert.match(CSS, /\.dev-ws-hero \.dev-ws-hero-people \.dev-ws-join-pop \{ left: auto; right: -6px; \}/);
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
  const claimsOnly = renderToHtml(createElement(NeedsCard, {
    queue: [row('c1', 'Fix login', 'claim'), row('c2', 'Tags', 'claim')],
    canPost: true,
    onOpen: () => {},
  }));
  assert.doesNotMatch(claimsOnly, /dev-ws-head-n/, 'no votes owed, no count');
  assert.match(claimsOnly, /No votes owed\. 2 requests nobody has picked up\./);
  assert.doesNotMatch(claimsOnly, /data-ws-hub-needs-open="" disabled/, 'the queue still opens');
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
  assert.match(LANDER, /<span className="dev-ws-since-label">\{outsider \? 'Recently' : 'Since your last visit'\}<\/span>/);
  // The rows and Clear are the same for everyone (declared checks select on
  // Clear on Homeroom's page); only the heading's words change.
  assert.doesNotMatch(LANDER, /outsider \? null/);
});

test('the hero offers Open it up or Make it private, as a proposal, to whoever may open one', () => {
  const { audienceChangeLine } = loadTsx(CARD);
  assert.equal(audienceChangeLine('Make this app public'), 'Making it a public community is up for a vote');
  assert.equal(audienceChangeLine('Make this app private (collaborators only)'), 'Making it a private community is up for a vote');
  assert.equal(audienceChangeLine('Make this app invite-only build, public to view'), 'A change to who it is for is up for a vote');
  assert.equal(audienceChangeLine(null), 'A change to who it is for is up for a vote');

  const change = CARD_SRC.slice(CARD_SRC.indexOf('function AudienceChange('), CARD_SRC.indexOf('export function CommunityCard('));
  assert.match(change, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/visibility-pr`/);
  assert.match(change, /\? \{ collabVisibility: 'private', viewVisibility: 'private' \}\s*: \{ collabVisibility: 'public', viewVisibility: 'public' \}/,
    'a public community is public to use and to build; a private community is private to both, as the create dialog maps them');
  assert.match(change, /if \(!res\.ok && res\.status !== 409\)/, 'one already up is not an error: the hero shows it');
  assert.match(change, /Members vote on this first, and it applies once it merges\./, 'it says it is a proposal, not a switch');
  assert.match(CARD_SRC, /\{data\.can_manage && !data\.audience_change \? \(\s*<AudienceChange /);
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

test('the Communities toggle is the project page\'s strip, not the black pill', () => {
  const screen = read('frontend/src/features/workshop/index.tsx');
  assert.doesNotMatch(screen, /SECTION_TAB_ACTIVE/);
  assert.match(screen, /<TabsList className="workshop-scope-tabs" aria-label="Communities sections">/);
  // Three since #3204: My proposals joins Current status and Needs you on
  // the same strip, drawn by the same two class tables.
  assert.equal((screen.match(/className="workshop-scope-tab"\s*activeClassName="workshop-scope-tab-on"/g) || []).length, 3);
  assert.match(CSS, /\.workshop-scope-tabs \{[^}]*background-color: var\(--dc-sheet-raise\);/);
  assert.match(CSS, /\.workshop-scope-tab-on \{\s*background: var\(--lit-tint\); color: var\(--lit-ink\);\s*box-shadow: inset 0 0 0 1px var\(--lit-line\);/);
});

test('Home\'s Browse all links carry the accent, not the header\'s periwinkle', () => {
  const ui = read('frontend/src/features/home/panels/ui.tsx');
  for (const cls of ['home-panel-browse', 'home-panel-lb-browse']) {
    const tag = ui.slice(ui.indexOf(`className="${cls} `), ui.indexOf('"', ui.indexOf(`className="${cls} `) + 12));
    assert.match(tag, /text-\[color:var\(--accent\)\]/, `${cls} is the accent`);
    assert.doesNotMatch(tag, /brand-ink/);
  }
});
