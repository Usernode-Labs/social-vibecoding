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

test('the card renders nothing until its read has answered', () => {
  // No server render of it, so no hydration to mismatch: the first render is
  // null and the fetch runs in an effect.
  const { CommunityCard } = loadTsx(CARD);
  assert.equal(renderToHtml(createElement(CommunityCard, { slug: 'notes' })), '');
  const src = read(CARD);
  assert.match(src, /useEffect\(\(\) => \{\s*setData\(null\);\s*void load\(\);/);
  assert.match(src, /if \(!data\) return null;/);
});

test('the channel opens at its old address, and Join goes through Home.setMembership', () => {
  const src = read(CARD);
  assert.match(src, /href=\{`#messages\/app\/\$\{encodeURIComponent\(slug\)\}`\}/,
    'the channel keeps its address: what moved is where you find it');
  assert.match(src, /home\.setMembership\(slug, joined\)/,
    'one request and one toast for Join, wherever it is pressed');
  assert.match(src, /_plusMenuShowsMembers/,
    'Members & approvals is offered to exactly whom the "+" menu offers it');
  assert.match(src, /data\.is_member && !data\.is_creator/, 'the creator is never offered Leave');
});

test('the card sits on the status tab between where the app is and your own work', () => {
  const lander = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  const dash = lander.indexOf('data-ws-dashboard=""');
  const card = lander.indexOf('<CommunityCard slug={slug} />');
  const mine = lander.indexOf('data-ws-mine=""');
  assert.ok(dash > 0 && card > dash && mine > card,
    'after the dashboard pane, before "What you are working on"');
});
