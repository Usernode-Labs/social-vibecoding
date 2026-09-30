'use strict';

// Invite redemption, friend writes and the other one-click signed-in actions
// (leaving a conversation, accepting an invite, archiving or sharing a
// proposal, revoking a grant, ...) answer only the Homeroom page itself: a
// browser request marked by Sec-Fetch-Site as coming from anywhere else —
// including an app on a sibling subdomain, which the Lax session cookie
// does not stop — is refused. Clients that send no such header pass.
//
// Run with: node --test tests/same-site-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { sameOriginBrowserOnly } = require('../src/middleware/same-site-browser');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function withApp(fn) {
  const app = express();
  app.post('/write', sameOriginBrowserOnly, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/write`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a browser request from another site or origin is refused with 403', async () => {
  await withApp(async (url) => {
    for (const site of ['same-site', 'cross-site', 'none']) {
      const res = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': site } });
      assert.equal(res.status, 403, site);
      assert.deepEqual(await res.json(), { error: 'forbidden' });
    }
  });
});

test('the Homeroom page itself, and a client that sends no header, pass', async () => {
  await withApp(async (url) => {
    const same = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(same.status, 200);
    const bare = await fetch(url, { method: 'POST' });
    assert.equal(bare.status, 200, 'native app, CLI and tests send no Sec-Fetch-Site');
  });
});

test('invite redemption is guarded, after its rate limiter', () => {
  const src = read('src/routes/community-invites.js');
  assert.ok(src.includes(
    "router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter, sameOriginBrowserOnly, async",
  ));
});

test('every friend write is guarded', () => {
  const src = read('src/routes/friends.js');
  for (const route of [
    "router.post('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('request',",
    "router.delete('/api/friends/:userId/request', friendshipLimiter, sameOriginBrowserOnly, write('cancel',",
    "router.post('/api/friends/:userId/accept', friendshipLimiter, sameOriginBrowserOnly, write('accept',",
    "router.post('/api/friends/:userId/decline', friendshipLimiter, sameOriginBrowserOnly, write('decline',",
    "router.delete('/api/friends/:userId', friendshipLimiter, sameOriginBrowserOnly, write('unfriend',",
  ]) assert.ok(src.includes(route), route);
  assert.doesNotMatch(src, /router\.(post|delete)\([^\n]*friendshipLimiter, write\(/, 'no unguarded write');
});

// One-click actions that need nothing but the URL: a request with a JSON body
// already needs a CORS preflight, these do not. Each one carries the guard
// after any rate limiter (and before the one raw body parser, so a refused
// upload is never read).
const GUARDED = [
  ['src/routes/conversations.js', [
    ['delete', '/api/conversations/:id/members/:userId'],
    ['post', '/api/conversations/:id/leave'],
    ['delete', '/api/conversations/:id/messages/:messageId'],
    ['put', '/api/me/blocks/:userId'],
    ['delete', '/api/me/blocks/:userId'],
    ['put', '/api/conversations/:id/messages/:messageId/bookmark'],
    ['delete', '/api/conversations/:id/messages/:messageId/bookmark'],
    ['post', '/api/conversations/:id/attachments'],
  ]],
  ['src/routes/app-blocks.js', [
    ['put', '/api/me/app-blocks/:slug'],
    ['delete', '/api/me/app-blocks/:slug'],
  ]],
  ['src/routes/chat.js', [
    ['put', '/api/apps/:slug/messages/:id/bookmark'],
    ['delete', '/api/apps/:slug/messages/:id/bookmark'],
    ['post', '/api/apps/:slug/messages/read'],
    ['post', '/api/apps/:slug/messages/unread'],
  ]],
  ['src/routes/approvers.js', [
    ['post', '/api/approver-invites/:appId/accept'],
    ['post', '/api/approver-invites/:appId/decline'],
    ['delete', '/api/apps/:slug/approvers/:userId'],
  ]],
  ['src/routes/collaborators.js', [
    ['post', '/api/invites/:appId/accept'],
    ['post', '/api/invites/:appId/decline'],
    ['delete', '/api/apps/:slug/collaborators/:userId'],
  ]],
  ['src/routes/community-invites.js', [
    ['delete', '/api/invite-links/:id'],
  ]],
  ['src/routes/kudos.js', [
    ['post', '/api/sessions/:id/kudos'],
    ['delete', '/api/sessions/:id/kudos'],
  ]],
  ['src/routes/votes.js', [
    ['post', '/api/sessions/:id/promote'],
    ['post', '/api/sessions/:id/undo'],
    ['post', '/api/sessions/:id/admin-merge'],
  ]],
  ['src/routes/proposal-handoff.js', [
    ['post', '/api/sessions/:id/promote'],
  ]],
  ['src/routes/sessions.js', [
    ['post', '/api/apps/:slug/issues/:number/headless-session'],
    ['post', '/api/sessions/:id/clone-headless'],
    ['post', '/api/sessions/:id/platform-issue/:msgId/confirm'],
    ['post', '/api/sessions/:id/platform-issue/:msgId/dismiss'],
    ['post', '/api/sessions/:id/archive'],
    ['post', '/api/sessions/:id/unpromote'],
    ['post', '/api/sessions/:id/reset-agent-context'],
    ['post', '/api/sessions/:id/unarchive'],
    ['post', '/api/sessions/:id/share'],
    ['post', '/api/sessions/:id/unshare'],
    ['post', '/api/sessions/:id/share-transcript'],
    ['post', '/api/sessions/:id/unshare-transcript'],
    ['post', '/api/sessions/:id/fork'],
    ['post', '/api/sessions/:id/pause'],
    ['post', '/api/sessions/:id/resume'],
    ['post', '/api/sessions/:id/sync-main'],
    ['post', '/api/sessions/:id/specs/:version/share'],
    ['post', '/api/sessions/:id/stop'],
    ['post', '/api/sessions/:id/deploy-staging'],
    ['post', '/api/sessions/:id/ensure-staging'],
    ['post', '/api/sessions/:id/recheck'],
  ]],
  ['src/routes/agent-sessions.js', [
    ['post', '/api/agent-sessions/:id/archive'],
    ['post', '/api/agent-sessions/:id/unarchive'],
    ['post', '/api/agent-sessions/:id/stop'],
    ['post', '/api/agent-sessions/:id/actions/:actionId/confirm'],
    ['post', '/api/agent-sessions/:id/actions/:actionId/dismiss'],
  ]],
  ['src/routes/agent-session-drafts.js', [
    ['delete', '/api/agent-sessions/:id/drafts/:draftId'],
  ]],
  ['src/routes/chat-drafts.js', [
    ['delete', '/api/sessions/:id/drafts/:draftId'],
  ]],
  ['src/routes/apps.js', [
    ['post', '/api/me/app-allowance/request'],
    ['delete', '/api/apps/:slug/secrets/:key'],
    ['post', '/api/apps/:slug/redeploy'],
    ['post', '/api/apps/:slug/check-updates'],
    ['post', '/api/apps/:slug/main-check/resume'],
    ['post', '/api/apps/:slug/retry'],
  ]],
  ['src/routes/auth.js', [
    ['delete', '/api/me/api-key'],
    ['post', '/api/me/wallet-link'],
    ['delete', '/api/me/wallet-link'],
  ]],
  ['src/routes/credentials.js', [
    ['post', '/api/me/credentials/openrouter/managed'],
    ['delete', '/api/me/credentials/openrouter'],
  ]],
  ['src/routes/llm-grants.js', [
    ['delete', '/api/me/llm-grants/:appId'],
  ]],
  ['src/routes/app-permissions.js', [
    ['delete', '/api/me/permission-grants/:appId/:capability'],
  ]],
  ['src/routes/global-chat.js', [
    ['post', '/api/global-chat/threads/:id/cancel'],
    ['delete', '/api/global-chat/threads/:id'],
  ]],
  ['src/routes/issues.js', [
    ['post', '/api/apps/:slug/issues/:number/bounty'],
    ['post', '/api/apps/:slug/github-issues/:number/claim'],
    ['delete', '/api/apps/:slug/github-issues/:number/claim'],
    ['post', '/api/issues/:id/admin-apply'],
    ['post', '/api/issues/:id/close'],
  ]],
  ['src/routes/demo-mode.js', [
    ['post', '/api/apps/:slug/demo/vote'],
    ['post', '/api/apps/:slug/demo/reset'],
  ]],
  ['src/routes/notifications.js', [
    ['delete', '/api/apps/:slug/notification-preferences'],
    ['post', '/api/notifications/read'],
  ]],
  ['src/routes/shots.js', [
    ['post', '/api/apps/:slug/proposals/:sessionId/shots/stop'],
  ]],
  ['src/routes/topic-attributes.js', [
    ['delete', '/api/apps/:slug/topics/:targetType/:targetRef/attributes'],
  ]],
  ['src/routes/report-ai.js', [
    ['post', '/api/apps/:slug/report-ai/generate'],
  ]],
  ['src/routes/campaigns.js', [
    ['post', '/api/campaigns/:id/merge-green'],
    ['post', '/api/campaigns/:id/apps/:appId/retry'],
  ]],
  ['src/routes/profile.js', [
    ['delete', '/api/me/avatar'],
  ]],
  ['src/routes/report-snapshots.js', [
    ['post', '/api/apps/:slug/report-snapshots/:id/share'],
    ['post', '/api/apps/:slug/report-snapshots/:id/unshare'],
  ]],
];

function declaration(src, method, route) {
  const re = new RegExp(`router\\.${method}\\(\\s*'${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',`, 'g');
  const starts = [...src.matchAll(re)].map((m) => m.index);
  assert.equal(starts.length, 1, `${method.toUpperCase()} ${route} is declared once`);
  const rest = src.slice(starts[0]);
  const end = rest.search(/async \(req, res|\(req, res\) =>|update\(/);
  assert.ok(end > 0, `${method.toUpperCase()} ${route} has a handler`);
  return rest.slice(0, end);
}

test('the other one-click signed-in actions are guarded, after their limiters', () => {
  for (const [file, routes] of GUARDED) {
    const src = read(file);
    assert.match(src, /const \{ sameOriginBrowserOnly \} = require\('\.\.\/middleware\/same-site-browser'\);/, file);
    for (const [method, route] of routes) {
      const decl = declaration(src, method, route);
      const at = decl.indexOf('sameOriginBrowserOnly,');
      assert.ok(at > 0, `${file}: ${method.toUpperCase()} ${route} is guarded`);
      assert.doesNotMatch(decl.slice(at), /Limiter/, `${file}: ${method.toUpperCase()} ${route} guard follows its limiter`);
    }
  }
});
