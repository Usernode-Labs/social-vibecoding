// src/middleware/auth.js — the platform-access gate (onboarding flow
// alignment). A session is no longer the whole story: users.has_platform_access
// gates the SV platform surfaces (SPA home / social / build). Since the
// fold-auth-pages-into-SPA migration the SPA shell itself serves
// anonymously (the client boots into in-SPA landing/login screens and a
// gated session is routed to the in-SPA #waiting room); the API 401/403
// remain the security boundary.
//
// Contracts guarded here:
//
//   1. Grandfathered / released users (has_platform_access TRUE) pass the
//      middleware exactly as before — no behavior change at deploy time.
//   2. A no-access session still gets the SPA shell for page loads (the
//      client routes it to #waiting) and a 403 with code
//      `platform_access_required` for /api/* calls.
//   3. GATE_OPEN_PATHS survive the gate: /api/auth/* (me / logout /
//      change-password) and /api/iframe-token — because login-required
//      CHILD APPS stay usable for any account per the onboarding doc's
//      ladder.
//   4. Admins bypass the gate even with has_platform_access FALSE.
//   5. Sessionless `/` serves the SPA shell; an address nothing knows is
//      "Page not found" (404), a moved one a 301 (request 7166); anonymous
//      /api/* stays a plain 401.
//   6. The legacy standalone pages (landing/login/register/waiting .html)
//      are PUBLIC_PATH redirect stubs (served pre-auth).
//
// HTTP-level tests against a throwaway express app + a substring-
// dispatching mock pool.
//
// Run with: node --test tests/platform-access-gate.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

// ─── Fixtures ─────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

const USERS = {
  1: { id: 1, username: 'released', is_admin: false, has_platform_access: true },
  2: { id: 2, username: 'waiting', is_admin: false, has_platform_access: false },
  3: { id: 3, username: 'admin', is_admin: true, has_platform_access: false },
  // A private member: an invite link let them into its community before
  // they were let in (users.private_member_since).
  4: { id: 4, username: 'invited', is_admin: false, has_platform_access: false, private_member_since: new Date() },
};

const SESSIONS = {
  'released-session': { user_id: 1, expires_at: new Date(Date.now() + DAY) },
  'waiting-session': { user_id: 2, expires_at: new Date(Date.now() + DAY) },
  'admin-session': { user_id: 3, expires_at: new Date(Date.now() + DAY) },
  'private-session': { user_id: 4, expires_at: new Date(Date.now() + DAY) },
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      const u = USERS[s.user_id];
      return {
        rows: [{
          user_id: u.id,
          expires_at: s.expires_at,
          username: u.username,
          is_admin: u.is_admin,
          admin_readonly: false,
          app_quota: 0,
          ai_progress_estimate: false,
          locale: null,
          has_platform_access: u.has_platform_access,
          private_member_since: u.private_member_since || null,
        }],
      };
    }

    if (sql.startsWith('DELETE FROM sessions')) return { rows: [] };

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

// ─── Test app wiring (require-cache swap, same idiom as sibling tests) ─

function withApp(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const authModulePath = require.resolve('../src/middleware/auth');
  delete require.cache[authModulePath];
  try {
    const { authMiddleware } = require('../src/middleware/auth');
    const app = express();
    app.use(cookieParser());
    app.use(authMiddleware({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    // Downstream stand-ins: reaching one of these means the gate let the
    // request through.
    app.get('/', (_req, res) => res.send('SPA'));
    app.get('/app/*', (_req, res) => res.send('SPA'));
    app.get('/invite/*', (_req, res) => res.send('SPA'));
    app.get('/social', (_req, res) => res.send('SPA'));
    app.get('/waiting.html', (_req, res) => res.send('WAITING'));
    app.get('/landing.html', (_req, res) => res.send('LANDING'));
    app.get('/api/apps', (_req, res) => res.json({ reached: 'apps' }));
    app.get('/api/auth/me', (_req, res) => res.json({ reached: 'me' }));
    app.get('/api/iframe-token', (_req, res) => res.json({ reached: 'iframe-token' }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[authModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  });
}

function get(base, path, session) {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: session ? { cookie: `session=${session}` } : {},
  });
}

// ─── 1. Released users are unaffected ─────────────────────────────────

test('a user WITH platform access reaches the SPA and APIs', async () => {
  await withServer(async (base) => {
    const spa = await get(base, '/', 'released-session');
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), 'SPA');

    const api = await get(base, '/api/apps', 'released-session');
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { reached: 'apps' });
  });
});

test('a PRIVATE MEMBER passes the gate like a user with access: their apps, hubs and chats are behind it', async () => {
  await withServer(async (base) => {
    const spa = await get(base, '/social', 'private-session');
    assert.equal(spa.status, 200, 'not bounced to the shell');
    const api = await get(base, '/api/apps', 'private-session');
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { reached: 'apps' });
  });
});

// ─── 2. No-access sessions get the shell (client routes to #waiting) ──

test('a user WITHOUT access still gets the SPA shell on the front door', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/', 'waiting-session');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'SPA');

    // Clean app deep links must reach the same shell so the client can
    // remember the exact destination before presenting the waiting room.
    const app = await get(base, '/app/demo-app/dev/issues/7', 'waiting-session');
    assert.equal(app.status, 200);
    assert.equal(await app.text(), 'SPA');
  });
});

test('a user WITHOUT access is bounced to the shell from deeper pages', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/social', 'waiting-session');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });
});

test('a user WITHOUT access gets 403 platform_access_required on APIs', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/api/apps', 'waiting-session');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'platform_access_required');
  });
});

// ─── 3. The gate's allowlist ──────────────────────────────────────────

test('the waiting stub, auth APIs, and iframe-token stay open to a no-access session', async () => {
  await withServer(async (base) => {
    // The old standalone waiting page is a PUBLIC_PATHS redirect stub now.
    const waiting = await get(base, '/waiting.html', 'waiting-session');
    assert.equal(waiting.status, 200);
    assert.equal(await waiting.text(), 'WAITING');

    // Account basics — the waiting room polls /api/auth/me for release.
    const me = await get(base, '/api/auth/me', 'waiting-session');
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { reached: 'me' });

    // Login-required child apps stay usable for ANY account.
    const iframe = await get(base, '/api/iframe-token', 'waiting-session');
    assert.equal(iframe.status, 200);
    assert.deepEqual(await iframe.json(), { reached: 'iframe-token' });
  });
});

// ─── 4. Admin bypass ──────────────────────────────────────────────────

test('an admin bypasses the gate even without the access flag', async () => {
  await withServer(async (base) => {
    const spa = await get(base, '/', 'admin-session');
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), 'SPA');
  });
});

// ─── 5. Sessionless routing ───────────────────────────────────────────

test('sessionless / serves the SPA shell; deeper paths are not found; APIs 401', async () => {
  await withServer(async (base) => {
    // Anonymous SPA boot (fold-auth-pages-into-SPA): the shell serves
    // without a session and the client shows the in-SPA landing screen.
    const front = await get(base, '/');
    assert.equal(front.status, 200);
    assert.equal(await front.text(), 'SPA');

    // Anonymous clean app links stay in place; restoreFromHash reads the
    // pathname and preserves it through login rather than losing it to '/'.
    const app = await get(base, '/app/demo-app');
    assert.equal(app.status, 200);
    assert.equal(await app.text(), 'SPA');

    // An address nothing knows is "Page not found" (request 7166): it used
    // to bounce to the shell, which a search engine read as the home page.
    const deep = await get(base, '/social');
    assert.equal(deep.status, 404);
    assert.equal(deep.headers.get('location'), null);

    const api = await get(base, '/api/apps');
    assert.equal(api.status, 401);
  });
});

test('#5263: sessionless, any one segment after /invite/ reaches its page, so a mistyped link can say it does not work', async () => {
  await withServer(async (base) => {
    for (const path of ['/invite/YigKXxtTzBB_TFZVTkjEtg', '/invite/abc', '/invite/YigKXxtTzBB_TFZV']) {
      const res = await get(base, path);
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), 'SPA', path);
    }
    // Two segments are not an invite link, or any address: page not found.
    const deeper = await get(base, '/invite/abc/def');
    assert.equal(deeper.status, 404);
  });
});

// Request 7166, point 1 (the search check of 25 Nov 2026): a signed-out
// request for an address that does not exist was answered 302 to `/`, a soft
// 404 that listed the home page under every mistyped address.
test('#7166: sessionless, an unknown address answers 404 with a small page that links home', async () => {
  const lost = require('../src/services/lost-addresses');
  await withServer(async (base) => {
    for (const path of ['/nonexistent-page-xyz', '/u/snait', '/@snait', '/challenges', '/communities/x', '/app', '/thread/12']) {
      const res = await get(base, path);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('location'), null, path);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex', path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
      assert.match(res.headers.get('content-type'), /^text\/html/, path);
      assert.equal(await res.text(), lost.notFoundPage(), path);
    }
    // A HEAD (what `curl -I` sends) says the same with no body.
    const head = await fetch(`${base}/nonexistent-page-xyz`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 404);
    assert.equal(await head.text(), '');
    // A request that does not take HTML, and any other method, get JSON.
    const json = await fetch(`${base}/nonexistent-page-xyz`, { redirect: 'manual', headers: { accept: 'application/json' } });
    assert.equal(json.status, 404);
    assert.deepEqual(await json.json(), { error: 'Not found' });
    const post = await fetch(`${base}/nonexistent-page-xyz`, { method: 'POST', redirect: 'manual' });
    assert.equal(post.status, 404);
    assert.deepEqual(await post.json(), { error: 'Not found' });

    // What the shell's own router reads from the path is untouched.
    for (const path of ['/', '/app/demo-app', '/app/demo-app/workshop', '/invite/abc']) {
      const res = await get(base, path);
      assert.equal(res.status, 200, path);
      assert.equal(await res.text(), 'SPA', path);
    }
    // Real addresses behind sign-in still go to the front door.
    for (const path of ['/admin', '/admin.html', '/admin-features', '/dashboard', '/debug', '/gallery', '/get-app']) {
      const res = await get(base, path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), '/', path);
    }
    // An API is still refused, never "not found".
    assert.equal((await get(base, '/api/nope')).status, 401);
  });
});

test('#7166: a signed-in person at an unknown address still gets the app, not the 404 page', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/social', 'released-session');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'SPA');
  });
});

test('#7166: the not-found page is one heading, one line and a link home, with nothing loaded', () => {
  const lost = require('../src/services/lost-addresses');
  const page = lost.notFoundPage();
  assert.match(page, /<title>Page not found · Homeroom<\/title>/);
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.equal((page.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(page, /<h1>Page not found<\/h1>/);
  assert.match(page, /<a class="btn" href="\/">Go to Home<\/a>/);
  assert.ok(!/<script|<link|<img|src=|url\(/.test(page), 'no script and no file from anywhere');
  assert.ok(!page.includes('\u2014'), 'no em dash in the copy');
  const csp = lost.notFoundHeaders()['Content-Security-Policy'];
  const hash = require('crypto').createHash('sha256').update(lost.STYLE).digest('base64');
  assert.ok(csp.includes(`style-src 'sha256-${hash}'`), 'the one inline style is allowed by its hash');
  assert.ok(page.includes(`<style>${lost.STYLE}</style>`));
});

test('#7166: moved addresses answer 301 to their new place, signed in or not', async () => {
  const lost = require('../src/services/lost-addresses');
  const { termsUrl, privacyNoticeUrl } = require('../src/services/marketing-links');
  assert.equal(termsUrl({}), 'https://onhomeroom.com/legal/terms-of-service');
  assert.equal(termsUrl({ marketingBaseUrl: 'https://example.test/' }), 'https://example.test/legal/terms-of-service');
  // The published terms row names the same address.
  const migrate = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  assert.ok(migrate.includes(`link: '${termsUrl({})}'`));

  const config = {};
  assert.equal(lost.movedAddress('/terms', config), termsUrl(config));
  assert.equal(lost.movedAddress('/terms.html', config), termsUrl(config));
  assert.equal(lost.movedAddress('/privacy', config), privacyNoticeUrl(config));
  assert.equal(lost.movedAddress('/privacy/', config), 'https://onhomeroom.com/legal/privacy-notice');
  assert.equal(lost.movedAddress('/apps', config), '/');
  assert.equal(lost.movedAddress('/apps/', config, '?q=1'), '/?q=1');
  assert.equal(lost.movedAddress('/private-communities', config), '/communities');
  // A legal page never carries the link's query to another site.
  assert.equal(lost.movedAddress('/terms', config, '?next=//evil.test'), termsUrl(config));
  for (const not of ['/', '/termsx', '/apps/foo', '/app', '/communities', '/privacy/x', '/Terms', '', null]) {
    assert.equal(lost.movedAddress(not, config), null, String(not));
  }

  const app = express();
  app.use(lost.movedAddressRedirect({ marketingBaseUrl: 'https://example.test' }));
  app.use((_req, res) => res.send('NEXT'));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const expected = {
      '/terms': 'https://example.test/legal/terms-of-service',
      '/privacy': 'https://example.test/legal/privacy-notice',
      '/apps': '/',
      '/apps?report=app': '/?report=app',
      '/private-communities': '/communities',
    };
    for (const [from, to] of Object.entries(expected)) {
      const res = await get(base, from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get('location'), to, from);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600', from);
    }
    for (const through of ['/', '/apps/foo', '/communities', '/app/demo-app']) {
      const res = await get(base, through);
      assert.equal(res.status, 200, through);
      assert.equal(await res.text(), 'NEXT', through);
    }
    const post = await fetch(`${base}/terms`, { method: 'POST', redirect: 'manual' });
    assert.equal(post.status, 200, 'only a GET or a HEAD is forwarded');
  } finally {
    server.close();
  }

  // It is mounted before the session is read, so the answer is one for all.
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const moved = serverSource.indexOf("require('./src/services/lost-addresses').movedAddressRedirect(config)");
  assert.ok(moved > 0 && moved < serverSource.indexOf('app.use(authMiddleware(config));'));
});

// ─── 6. The legacy standalone pages are public redirect stubs ─────────

test('the landing/waiting stubs are served without a session', async () => {
  await withServer(async (base) => {
    const landing = await get(base, '/landing.html');
    assert.equal(landing.status, 200);
    assert.equal(await landing.text(), 'LANDING');

    const waiting = await get(base, '/waiting.html');
    assert.equal(waiting.status, 200);
    assert.equal(await waiting.text(), 'WAITING');
  });
});

// ─── 7. The on-disk stubs carry the right SPA hash routes ─────────────

test('the four standalone pages are redirect stubs into SPA hash routes', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

  assert.match(read('landing.html'), /location\.replace\('\/#landing'\)/);
  assert.match(read('waiting.html'), /location\.replace\('\/#waiting'\)/);

  // login stub: #login base route, #signup for ?signup=1, and it carries
  // a deep-link fragment + remaining query (return_to) through.
  const login = read('login.html');
  assert.match(login, /#signup/);
  assert.match(login, /#login/);
  assert.match(login, /deepLink/);
  assert.match(login, /location\.replace\(/);

  // register stub: #register[/<code>] with the ?code= prefill preserved.
  const register = read('register.html');
  assert.match(register, /#register\/'\s*\+\s*encodeURIComponent\(code\)/);
  assert.match(register, /location\.replace\(/);
});
