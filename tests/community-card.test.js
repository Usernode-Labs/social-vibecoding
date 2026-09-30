'use strict';

// The community card on a project's Workshop page
// (frontend/src/features/dev-board/workshop/community-card.tsx): who the
// project is for, who is in it, the approval rule, the channel, and Join.
// The server half — GET /api/apps/:slug/community and POST .../membership —
// is pinned against a real database in tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';

test('the approval rule is one sentence per regime, read from the server', () => {
  const { approvalLine } = loadTsx(CARD);
  assert.equal(approvalLine({ policy: 'anyone', approvals_required: null, electorate: 12, required: 5 }),
    'Members vote: a change merges at 5 yes votes (12 active members), or unopposed after a wait.');
  assert.equal(approvalLine({ policy: 'anyone', approvals_required: null, electorate: 1, required: 1 }),
    'Members vote: a change merges at 1 yes vote (1 active member), or unopposed after a wait.');
  assert.equal(approvalLine({ policy: 'anyone', approvals_required: 2, electorate: 30, required: 2 }),
    'A change needs 2 yes votes from members to merge.',
    'a fixed count from dapp.json says the count, not the electorate');
  assert.equal(approvalLine({ policy: 'invited', approvals_required: null, electorate: 3, required: 2 }),
    'Approvers decide: 2 yes votes from 3 approvers to merge a change.');
  assert.equal(approvalLine(null), '');
});

test('the audience line uses the words on screen, and "Just you" counts nobody', () => {
  const { audienceLine } = loadTsx(CARD);
  assert.equal(audienceLine({ audience: 'open', audience_label: 'Public community', member_count: 12 }), 'Public community · 12 members');
  assert.equal(audienceLine({ audience: 'invited', audience_label: 'Private community', member_count: 1 }), 'Private community · 1 member');
  assert.equal(audienceLine({ audience: 'solo', audience_label: 'Just you', member_count: 1 }), 'Just you');
});

test('before the read the hero draws only what needs none: Open app and the ⋯', () => {
  // No server render of it, so no hydration to mismatch. The tile and the
  // name are the coloured header's now (#852), so before the read the hero
  // is the actions that depend on nothing it says, or nothing at all; the
  // fetch runs in an effect.
  const { CommunityCard } = loadTsx(CARD);
  assert.equal(renderToHtml(createElement(CommunityCard, { slug: 'notes' })), '');
  const pending = renderToHtml(createElement(CommunityCard, { slug: 'notes', name: 'Notes', canOpenApp: true, color: '#2e6660' }));
  assert.match(pending, /class="dev-ws-hero" data-ws-community-pending=""/);
  assert.match(pending, /<button type="button" class="dev-ws-open-app" style="background:#2e6660" data-ws-community-open-app="">/,
    'Open app wears the community\'s colour');
  assert.doesNotMatch(pending, /dev-ws-hero-name|data-ws-community=""|Join|data-ws-community-rule/,
    'no second name under the header\'s, and nothing that depends on membership before it is known');
  const src = read(CARD);
  // ONE READ FOR THE HUB: the hero and the hub's cards share the community
  // record, and each mount asks for a fresh copy unless one is on its way.
  assert.match(src, /const data = useCommunity\(slug\);/);
  assert.match(src, /if \(slug && !inflight\.has\(slug\)\) void reloadCommunity\(slug\);/);
});

test('the channel is a hub card at its old address; Join asks under its button and joins through offerJoin', () => {
  const src = read(CARD);
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.doesNotMatch(src, /#messages\/app\//, 'the hero no longer carries a channel row');
  assert.match(hub, /const href = channel\.href \|\| `#messages\/app\/\$\{encodeURIComponent\(slug\)\}`;/,
    'the hub\'s channel card opens the same room, at the same address');
  assert.match(src, /await offerJoin\(\{ code: 'join_required', app: \{ slug, name: name \|\| data\.name \|\| slug \} \}\)/,
    'the button asks the question every refusal asks, through the same function');
  assert.match(src, /registerJoinAnchor\(slug, \{/,
    'and while it shows, the hero is where that question is asked');
  assert.match(src, /getClientRects\(\)\.length > 0/,
    'but only while it is actually on screen');
  assert.match(src, /className="dev-ws-join-pop"[\s\S]*className="dev-ws-ask-q"[\s\S]*className="dev-ws-vote-sub"[\s\S]*dev-ws-answer-btn dev-ws-answer-join[\s\S]*className="dev-ws-vote-later"/,
    'the popup wears the vote popover\'s question, line, answer and "later"');
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ws-join-pop \{\s*position: absolute; top: calc\(100% \+ 12px\)/,
    'it hangs from the button');
  assert.match(css, /\.dev-ws-hero \.dev-ws-hero-member \.dev-ws-join-pop \{ left: auto; right: -6px; \}/,
    'from its right edge in the hero, where Join ends the actions row (#852)');
  assert.match(src, /home\.setMembership\(slug, false\)/, 'Joined leaves through the same call Discover makes');
  assert.match(src, /data-ws-community-leave=""[\s\S]*Joined/, 'Joined is the leave control, as on Discover');
  assert.match(src, /\) : data\.is_creator \? null : \(/, 'the creator is never offered Leave');
  // #3362: Invite is invite LINKS, which any member can make
  // (services/community-invites.js); Members & approvals stays the ⋯'s, behind
  // its own gate.
  assert.match(src, /\{data\.is_member && !solo \? \(\s*<Button[\s\S]{0,160}data-ws-community-invite=""/,
    'Invite is offered to members');
  assert.doesNotMatch(src, /_plusMenuShowsMembers/, 'not by the members dialog\'s gate');
});

test('the hero leads the hub, above what needs you and its chat; who is here is the hero\'s (#3268)', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const tab = lander.indexOf("{tab === 'status' ? (");
  const hero = lander.indexOf('<CommunityCard\n          slug={slug}');
  const needs = lander.indexOf('<NeedsCard');
  const channel = lander.indexOf('<ChannelCard');
  assert.ok(tab > 0 && hero > tab && needs > hero && channel > needs,
    'first on the hub, then the votes you owe and the chat');
  assert.doesNotMatch(lander, /<MembersCard/, 'no separate Members & activity card');
  assert.match(lander, /<CommunityCard\s+slug=\{slug\}\s+name=\{app\.name \|\| undefined\}\s+canOpenApp=\{!actions\.selfHosted\}\s+color=\{color\}/,
    'with the community\'s colour; its tile and name are the coloured header\'s (#852)');
});
