'use strict';

// Staging's demo invite link (src/services/staging-demo-invite.js): the
// signed-out invite page is reachable at /invite/stagingdemoinvite00001 on a
// staging preview for before/after shots, and nowhere else, and following it
// grants nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const demo = require('../src/services/staging-demo-invite');
const invites = require('../src/services/community-invites');
const { inviteTokenFrom } = require('./lib/render-tsx').loadTsx('frontend/src/features/auth/invite-card.tsx');

function withEnv(value, fn) {
  const before = process.env.USERNODE_ENV;
  if (value == null) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = value;
  try { return fn(); } finally {
    if (before == null) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = before;
  }
}

function handlerOf(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.json = (body) => { res.body = body; return res; };
  res.cookie = () => { throw new Error('the demo link sets no cookie'); };
  return res;
}

test('the demo token has the real token shape, so the page routes it', () => {
  assert.equal(demo.DEMO_INVITE_TOKEN, 'stagingdemoinvite00001');
  assert.ok(invites.isToken(demo.DEMO_INVITE_TOKEN));
  assert.equal(inviteTokenFrom(`/invite/${demo.DEMO_INVITE_TOKEN}`), demo.DEMO_INVITE_TOKEN);
});

test('the demo link is staging-only', () => {
  assert.equal(demo.isDemoInvite(demo.DEMO_INVITE_TOKEN, 'staging'), true);
  for (const env of ['production', 'development', 'test', '', undefined]) {
    assert.equal(demo.isDemoInvite(demo.DEMO_INVITE_TOKEN, env), false, String(env));
  }
  withEnv('production', () => assert.equal(demo.isDemoInvite(demo.DEMO_INVITE_TOKEN), false));
  withEnv(null, () => assert.equal(demo.isDemoInvite(demo.DEMO_INVITE_TOKEN), false));
  withEnv('staging', () => {
    assert.equal(demo.isDemoInvite(demo.DEMO_INVITE_TOKEN), true);
    assert.equal(demo.isDemoInvite('YigKXxtTzBB_TFZVTkjEtg'), false, 'only the one token');
  });
});

test('its preview is an obviously pretend project the page can draw', () => {
  const p = demo.demoInvitePreview();
  assert.equal(p.live, true);
  assert.equal(p.project.name, 'Staging demo community');
  assert.equal(p.inviterName, 'Dana Demo');
  assert.equal(p.memberCount, 26);
  assert.equal(p.project.picture, null, 'no picture route to fetch');
  const card = require('./lib/render-tsx').loadTsx('frontend/src/features/auth/invite-card.tsx');
  assert.equal(card.inviteLine(p), 'Dana Demo invited you to Staging demo community · 26 people are in it');
});

test('on staging the routes answer it without the database, and never follow it', async () => {
  const routes = require('../src/routes/community-invites');
  const before = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    const router = routes({ databaseUrl: 'postgres://unused@127.0.0.1:1/none' });
    const token = demo.DEMO_INVITE_TOKEN;

    const previewRes = fakeRes();
    await handlerOf(router, 'get', '/api/public/invites/:token')({ params: { token }, headers: {}, cookies: {} }, previewRes);
    assert.equal(previewRes.statusCode, 200);
    assert.equal(previewRes.body.project.name, 'Staging demo community');

    const user = { id: 1, isAdmin: false, hasPlatformAccess: true };
    const standingRes = fakeRes();
    await handlerOf(router, 'get', '/api/invite-links/by-token/:token')({ params: { token }, user, headers: {} }, standingRes);
    assert.equal(standingRes.statusCode, 200, 'no error status for the shell to log');
    assert.equal(standingRes.body.live, false);

    const redeemRes = fakeRes();
    await handlerOf(router, 'post', '/api/invite-links/by-token/:token/redeem')({ params: { token }, user, headers: {} }, redeemRes);
    assert.equal(redeemRes.statusCode, 410);
    assert.equal(redeemRes.body.ok, undefined);
    assert.equal(redeemRes.body.reason, 'unknown');
  } finally {
    if (before == null) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = before;
  }
});

test('the page sets no invite cookie for it, so a sign-in from it follows nothing', () => {
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/community-invites.js'), 'utf8');
  assert.match(route, /const demo = stagingDemoInvite\.isDemoInvite\(token\);/);
  assert.match(route, /if \(preview\.live && !demo\) \{\s+invites\.setInviteCookie\(req, res, token\);/);
});
