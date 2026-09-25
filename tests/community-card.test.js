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
  assert.equal(audienceLine({ audience: 'open', audience_label: 'Community', member_count: 12 }), 'Community · 12 members');
  assert.equal(audienceLine({ audience: 'invited', audience_label: 'Group', member_count: 1 }), 'Group · 1 member');
  assert.equal(audienceLine({ audience: 'solo', audience_label: 'Just you', member_count: 1 }), 'Just you');
});

test('the hero draws its identity before the read, and the rest only after it', () => {
  // No server render of it, so no hydration to mismatch. Before the read it
  // is the tile and name the page already knows (so the dashboard under it
  // does not jump), or nothing without a name; the fetch runs in an effect.
  const { CommunityCard } = loadTsx(CARD);
  assert.equal(renderToHtml(createElement(CommunityCard, { slug: 'notes' })), '');
  const pending = renderToHtml(createElement(CommunityCard, { slug: 'notes', name: 'Notes', iconEmoji: '📝' }));
  assert.match(pending, /class="dev-ws-hero" data-ws-community-pending=""/);
  assert.match(pending, /<h2 class="dev-ws-hero-name">Notes<\/h2>/);
  assert.doesNotMatch(pending, /data-ws-community=""|Join|data-ws-community-rule/,
    'nothing that depends on membership is drawn before it is known');
  const src = read(CARD);
  assert.match(src, /useEffect\(\(\) => \{\s*setData\(null\);\s*void load\(\);/);
});

test('the channel opens at its old address; Join asks under its button and joins through offerJoin', () => {
  const src = read(CARD);
  assert.match(src, /href=\{`#messages\/app\/\$\{encodeURIComponent\(slug\)\}`\}/,
    'the channel is the same room Messages lists, at the same address');
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
  assert.match(css, /\.dev-ws-hero \.dev-ws-join-pop \{ left: -6px; right: auto; \}/,
    'from its left edge in the hero, where Join leads the row');
  assert.match(src, /home\.setMembership\(slug, false\)/, 'Joined leaves through the same call Discover makes');
  assert.match(src, /data-ws-community-leave=""[\s\S]*Joined/, 'Joined is the leave control, as on Discover');
  assert.match(src, /\) : data\.is_creator \? null : \(/, 'the creator is never offered Leave');
  assert.match(src, /_plusMenuShowsMembers/,
    'Invite (Members & approvals) is offered to exactly whom the "+" menu offers it');
});

test('the hero leads the status tab, above where the app is', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const tab = lander.indexOf("{tab === 'status' ? (");
  const hero = lander.indexOf('<CommunityCard\n          slug={slug}');
  const dash = lander.indexOf('data-ws-dashboard=""');
  const mine = lander.indexOf('data-ws-mine=""');
  assert.ok(tab > 0 && hero > tab && dash > hero && mine > dash,
    'first on the status tab, then the dashboard, then your own work');
  assert.match(lander, /<CommunityCard\s+slug=\{slug\}\s+name=\{app\.name \|\| undefined\}\s+iconUrl=\{app\.iconUrl\}\s+iconEmoji=\{app\.iconEmoji\}/,
    'with the identity the header chip draws');
});
