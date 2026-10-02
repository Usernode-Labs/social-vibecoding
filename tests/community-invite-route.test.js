'use strict';

// GET /api/apps/:slug/community answers `?invite=<token>` (#3700): a live
// link whose address is now the project page's own carries its token on the
// page's fetch, and the payload names who invited this viewer — but only
// for that viewer, only while they are outside the project and the link is
// still live. Exercises the route end-to-end (express + mocked pool), the
// way tests/visibility-pr-route.test.js does; the invite rules themselves
// are pinned against a real database in tests/community-invites-postgres.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Override the pool BEFORE requiring the route module: apps.js destructures
// getPool at require time. The handler below answers the three queries the
// community route's invite read touches; everything else is empty rows.
const poolMod = require('../src/db/pool');
let inviteRow = null;
let viewerIsMember = false;
let viewerFollowed = false;
poolMod.getPool = () => ({
  query: async (sql) => {
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      return {
        rows: [{
          id: 11, slug: 'demo', created_by: 1, self_hosted: false,
          collab_visibility: 'public', view_visibility: 'public',
          moderation_suspended_at: null, name: 'Demo',
          repo_url: 'https://github.com/o/r', description: 'A demo app.',
        }],
      };
    }
    if (/EXISTS \(SELECT 1 FROM community_members/.test(sql)) {
      return { rows: [{ community_id: 7, member_count: 3, is_member: viewerIsMember, audience: 'open', is_creator: false }] };
    }
    // communities.isMember — alreadyHasGrant's read for a member grant.
    if (/JOIN community_members m ON m\.community_id = a\.community_id\s+WHERE a\.id = \$1 AND m\.user_id = \$2/.test(sql)) {
      return { rows: viewerIsMember ? [{ '?column?': 1 }] : [] };
    }
    // standing()'s read of this viewer's own redemption row.
    if (/FROM community_invite_redemptions WHERE invite_id = \$1 AND user_id = \$2/.test(sql)) {
      return { rows: viewerFollowed ? [{ status: 'queued' }] : [] };
    }
    if (/FROM community_invites i\s+JOIN apps a ON a\.id = i\.app_id/.test(sql)) {
      return { rows: inviteRow ? [inviteRow] : [] };
    }
    // activeUsers().getAppMeta and .getActiveUserStats — the route's
    // electorate read.
    if (/SELECT self_hosted, collab_visibility FROM apps WHERE id = \$1/.test(sql)) {
      return { rows: [{ self_hosted: false, collab_visibility: 'public' }] };
    }
    if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) return { rows: [{ cnt: 3 }] };
    return { rows: [] };
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const TOKEN = 'YigKXxtTzBB_TFZVTkjEtg';

function liveInviteRow() {
  return {
    id: 3, token: TOKEN, community_id: 7, app_id: 11, created_by: 1,
    max_uses: 25, uses: 0, expires_at: new Date('2030-01-01T00:00:00Z'), revoked_at: null,
    slug: 'demo', name: 'Demo', icon_emoji: '🎯', icon_image_id: null,
    app_created_by: 1, description: 'A demo app.',
    self_hosted: false, collab_visibility: 'public', view_visibility: 'public',
    app_community_id: 7, inviter: 'ada', maker_holds: true,
  };
}

let currentUser;
let server;
let base;

test.before(async () => {
  const app = express();
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ selfAppSlug: 'platform', selfAppPublicVoting: false }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  currentUser = { id: 2, username: 'nia', isAdmin: false, hasPlatformAccess: true };
  inviteRow = liveInviteRow();
  viewerIsMember = false;
  viewerFollowed = false;
});

test('a live invite on the address names the inviter, to the viewer it is for', async () => {
  const res = await fetch(`${base}/api/apps/demo/community?invite=${TOKEN}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.invite, { inviter: 'ada' });
});

test('without the token, or for a member, there is no invite on the payload', async () => {
  const bare = await (await fetch(`${base}/api/apps/demo/community`)).json();
  assert.equal(bare.invite, null);
  viewerFollowed = true;
  const joined = await (await fetch(`${base}/api/apps/demo/community?invite=${TOKEN}`)).json();
  assert.equal(joined.invite, null, 'nia has followed the link: no banner, no second ask');
  currentUser = { id: 1, username: 'ada', isAdmin: false, hasPlatformAccess: true };
  viewerIsMember = true;
  const member = await (await fetch(`${base}/api/apps/demo/community?invite=${TOKEN}`)).json();
  assert.equal(member.invite, null, 'ada is in the project already: her landing is the hub, not a banner');
});

test('a dead link adds nothing', async () => {
  inviteRow = { ...liveInviteRow(), revoked_at: new Date('2026-01-01T00:00:00Z') };
  const body = await (await fetch(`${base}/api/apps/demo/community?invite=${TOKEN}`)).json();
  assert.equal(body.invite, null);
});

test('a token that is not shaped like one never reaches the database', async () => {
  const res = await fetch(`${base}/api/apps/demo/community?invite=nope`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).invite, null);
});
