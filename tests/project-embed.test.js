'use strict';
// A public project inside a post on X (src/services/project-embed.js,
// src/routes/project-preview.js): the shared link of a project somebody with
// no account can use carries a player card, X frames `/embed/<slug>` inside
// the post, and that page frames the app as a guest under a Join bar.
//
// What it pins, by running the real code:
//   * which projects may be shown in a post, and the token their frame
//     carries (none, a guest token, or no page at all);
//   * the player card on `/app/<slug>`, only where there is a page to play;
//   * the page: framed by X alone, holding the app's own address alone, never
//     kept, every word a project chose escaped, and its inline style and
//     script allowed by hash;
//   * its Join sheet, opened by the app's own frame and nothing else;
//   * `/embed/` is a public path, and the service worker leaves it alone.
//
// Run with: node --test tests/project-embed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

process.env.EDGE_JWT_SECRET = 'project-embed-test-edge-secret';
delete process.env.APP_HOST_SIGNIN;
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');
const embed = require('../src/services/project-embed');
const preview = require('../src/services/project-preview');
const { productionHostname } = require('../src/services/caddy');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ORIGIN = 'https://app.example';

// The public directory's shape (public-app-directory.js shapeApp).
const OPEN = { id: 11, slug: 'open-game', name: 'Open Game', url: 'https://open-game.apps.example.invalid', guest_ready: true, requires_login: false, icon_emoji: '🎲', icon_url: null };
const GUESTS = { ...OPEN, id: 12, slug: 'guest-poll', name: 'Guest Poll', url: 'https://guest-poll.apps.example.invalid', requires_login: true };
const CLOSED = { ...OPEN, id: 13, slug: 'members-only', name: 'Members Only', url: 'https://members-only.apps.example.invalid', guest_ready: false, requires_login: true };

function withoutEdgeSecret(fn) {
  const saved = process.env.EDGE_JWT_SECRET;
  delete process.env.EDGE_JWT_SECRET;
  try { return fn(); } finally { process.env.EDGE_JWT_SECRET = saved; }
}

test('which projects a post may show, and what their frame carries', () => {
  assert.deepEqual(embed.embedFor(OPEN), { token: null }, 'needs no credential: none');
  const guest = embed.embedFor(GUESTS);
  const claims = platformJwt.verifyGuestToken(guest.token, { appId: 12 });
  assert.equal(claims.guest, true, 'answers guests: a guest token for that very app');
  assert.equal(claims.id, undefined, 'naming nobody');
  assert.throws(() => platformJwt.verifyGuestToken(guest.token, { appId: 11 }), 'and no other');
  assert.deepEqual(embed.embedFor(GUESTS, { sign: false }), { token: '' }, 'the question alone signs nothing');
  assert.equal(embed.embedFor(CLOSED), null, 'nobody with no account can use it');
  assert.equal(embed.embedFor(null), null);
  assert.equal(embed.embedFor({ ...OPEN, url: 'javascript:alert(1)' }), null, 'only a real web address is framed');
  assert.equal(embed.embedFor({ ...GUESTS, id: null }), null);
  // A staging copy has no guest key: a project that needs one has no page.
  withoutEdgeSecret(() => {
    assert.equal(embed.embedFor(GUESTS), null);
    assert.equal(embed.embedFor(GUESTS, { sign: false }), null);
    assert.deepEqual(embed.embedFor(OPEN), { token: null });
  });
});

test('the player card: a frame around the embed page, with the cover as its still', () => {
  const tags = preview.previewTags(OPEN, ORIGIN, { cover: true, player: true });
  assert.match(tags, /<meta name="twitter:card" content="player">/);
  assert.match(tags, /<meta name="twitter:player" content="https:\/\/app\.example\/embed\/open-game">/);
  assert.match(tags, /<meta name="twitter:player:width" content="480">\n<meta name="twitter:player:height" content="480">/);
  assert.match(tags, /<meta name="twitter:image" content="https:\/\/app\.example\/api\/public\/apps\/open-game\/cover\.png">/);
  assert.match(tags, /<meta property="og:image" content="https:\/\/app\.example\/api\/public\/apps\/open-game\/cover\.png">/, 'every other unfurler keeps its picture');
  // X shows no player without a picture; nothing to play keeps today's card.
  const bare = preview.previewTags({ ...OPEN, icon_emoji: null }, ORIGIN, { cover: false, player: true });
  assert.match(bare, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(bare, /twitter:player/);
  const plain = preview.previewTags(OPEN, ORIGIN, { cover: true });
  assert.match(plain, /<meta name="twitter:card" content="summary_large_image">/);
  assert.doesNotMatch(plain, /twitter:player|twitter:image/);
  // The route asks the one rule, without signing anything for a crawler.
  assert.match(read('src/routes/project-preview.js'), /player: !!embed\.embedFor\(entry\.app, \{ sign: false \}\),/);
});

test('the page: the app as a guest under a Join bar, every word escaped', () => {
  const html = embed.embedPage({ ...GUESTS, name: 'Poll <img src=x onerror=alert(1)> "q"' }, ORIGIN, 'tok.en');
  assert.doesNotMatch(html, /<img src=x/, 'a project\'s name is text, never markup');
  assert.match(html, /<span class="name">Poll &lt;img src=x onerror=alert\(1\)&gt; &quot;q&quot;<\/span>/);
  const src = html.match(/<iframe class="app" id="app" src="([^"]+)"/)[1];
  assert.equal(src, 'https://guest-poll.apps.example.invalid/?token=tok.en&amp;un-embed=1');
  assert.match(html, /sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-pointer-lock allow-downloads" allow="clipboard-write"/);
  assert.equal(embed.FRAME_SANDBOX, read('frontend/src/features/app-frame/app-frame-policy.js').match(/APP_FRAME_SANDBOX =\s*'([^']+)'/)[1], 'the App tab\'s own sandbox');
  // Join opens the project's page on Homeroom in a tab of its own.
  const joins = [...html.matchAll(/<a class="([^"]+)"[^>]* href="([^"]+)" target="_blank" rel="noopener">/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(joins, [
    ['who', 'https://app.example/app/guest-poll'],
    ['join', 'https://app.example/app/guest-poll'],
    ['btn primary', 'https://app.example/app/guest-poll'],
  ]);
  assert.match(html, /<body data-app-origin="https:\/\/guest-poll\.apps\.example\.invalid"/);
  assert.match(html, /<span class="icon">🎲<\/span>/);
  assert.match(embed.embedPage({ ...OPEN, icon_url: '/app-icons/abc' }, ORIGIN, null), /<span class="icon"><img src="https:\/\/app\.example\/app-icons\/abc" alt=""><\/span>/);
  assert.match(embed.embedPage({ ...OPEN, icon_emoji: null, name: 'zed' }, ORIGIN, null), /<span class="icon">Z<\/span>/);
  assert.equal(embed.embedPage(OPEN, ORIGIN, null).match(/<iframe class="app" id="app" src="([^"]+)"/)[1], 'https://open-game.apps.example.invalid/?un-embed=1');
});

test('its headers: framed by X alone, holding the app alone, never kept, inline code allowed by hash', () => {
  const headers = embed.embedHeaders(GUESTS.url);
  const csp = headers['Content-Security-Policy'];
  assert.match(csp, /frame-ancestors 'self' https:\/\/x\.com https:\/\/\*\.x\.com https:\/\/twitter\.com https:\/\/\*\.twitter\.com/);
  assert.match(csp, /frame-src https:\/\/guest-poll\.apps\.example\.invalid(;|$)/);
  assert.match(csp, /default-src 'none'/);
  assert.equal(headers['Cache-Control'], 'no-store', 'a fresh guest token every load');
  assert.equal(headers['X-Frame-Options'], undefined, 'X-Frame-Options would refuse X outright');
  const html = embed.embedPage(GUESTS, ORIGIN, 't');
  const hash = (s) => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
  assert.ok(csp.includes(`style-src ${hash(html.match(/<style>([\s\S]*?)<\/style>/)[1])}`), 'the page\'s style');
  assert.ok(csp.includes(`script-src ${hash(html.match(/<script>([\s\S]*?)<\/script>/)[1])}`), 'the page\'s script');
  assert.doesNotMatch(html, / style="/, 'no inline style attribute, which the policy refuses');
  const refused = embed.embedHeaders(null)['Content-Security-Policy'];
  assert.doesNotMatch(refused, /frame-src/, 'a refusal frames nothing');
  assert.match(refused, /frame-ancestors 'self' https:\/\/x\.com/);
});

// The page's script, against a document with the page's own elements.
function runSheet() {
  const els = {};
  for (const id of ['app', 'join-scrim', 'join-sheet', 'join-title', 'join-go', 'join-keep']) {
    els[id] = { id, hidden: id === 'join-scrim' || id === 'join-sheet', textContent: '', listeners: {},
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      click() { for (const fn of this.listeners.click || []) fn({}); }, focus() {} };
  }
  const frameWindow = {};
  els.app.contentWindow = frameWindow;
  const listeners = {};
  const attrs = { 'data-app-origin': 'https://guest-poll.apps.example.invalid', 'data-name': 'Guest Poll' };
  const document = {
    body: { getAttribute: (n) => attrs[n] ?? null },
    getElementById: (id) => els[id] || null,
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };
  const window = { addEventListener(t, fn) { (listeners[`w:${t}`] = listeners[`w:${t}`] || []).push(fn); } };
  vm.runInNewContext(embed.SCRIPT, { window, document });
  const post = (data, { source = frameWindow, origin = attrs['data-app-origin'] } = {}) => {
    for (const fn of listeners['w:message'] || []) fn({ data, source, origin });
  };
  return { els, post, frameWindow };
}

test('the Join sheet opens when the app\'s own frame says a guest needs an account, and only then', () => {
  const { els, post } = runSheet();
  post({ __usernode_embed: 'account', action: 'vote' }, { origin: 'https://evil.example' });
  post({ __usernode_embed: 'account', action: 'vote' }, { source: {} });
  post({ __usernode_relay: 'discover' });
  assert.equal(els['join-sheet'].hidden, true, 'another origin, another window, another message: nothing');
  post({ __usernode_embed: 'account', action: '  cast   a vote ' });
  assert.equal(els['join-sheet'].hidden, false);
  assert.equal(els['join-scrim'].hidden, false);
  assert.equal(els['join-title'].textContent, 'Make an account to cast a vote');
  els['join-keep'].click();
  assert.equal(els['join-sheet'].hidden, true, 'and they can keep looking');
  post({ __usernode_embed: 'account', action: 'x'.repeat(61) });
  assert.equal(els['join-title'].textContent, 'Make an account to join Guest Poll', 'a long action is not repeated');
  els['join-go'].click();
  assert.equal(els['join-sheet'].hidden, true, 'Join on Homeroom opens its tab and closes the sheet');
});

// The routes, against a database that knows the three projects above.
function fakePool() {
  const base = {
    status: 'running', view_visibility: 'public', collab_visibility: 'public', icon_emoji: '🎲', icon_image_id: null,
    icon_color: null, description: 'A game.', member_count: 30, active_users: 3, created_at: '2026-06-19T00:00:00.000Z',
  };
  const rows = {
    'open-game': { ...base, id: 11, slug: 'open-game', name: 'Open Game', anon_shell: 'public', guest_shell: 'public' },
    'guest-poll': { ...base, id: 12, slug: 'guest-poll', name: 'Guest Poll', anon_shell: 'gated', guest_shell: 'public' },
    'members-only': { ...base, id: 13, slug: 'members-only', name: 'Members Only', anon_shell: 'gated', guest_shell: 'gated' },
  };
  return {
    async query(sql, params = []) {
      const s = String(sql);
      if (/SELECT 1 FROM apps WHERE slug = \$1/.test(s)) return { rows: rows[params[0]] ? [{}] : [] };
      if (/FROM apps a/.test(s) && /last_deploy_at DESC NULLS LAST/.test(s)) {
        return { rows: params[1] != null && rows[params[1]] ? [rows[params[1]]] : [] };
      }
      return { rows: [] };
    },
  };
}

async function startServer() {
  const poolPath = require.resolve('../src/db/pool');
  const routePath = require.resolve('../src/routes/project-preview');
  const original = require.cache[poolPath];
  require.cache[poolPath] = { exports: { getPool: () => fakePool() }, loaded: true, id: poolPath, filename: poolPath, paths: [] };
  delete require.cache[routePath];
  try {
    const routes = require('../src/routes/project-preview');
    const app = express();
    app.use(routes({}));
    app.use((req, res) => res.status(404).send('catch-all'));
    return await new Promise((resolve) => {
      const server = app.listen(0, () => resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }));
    });
  } finally {
    if (original) require.cache[poolPath] = original; else delete require.cache[poolPath];
    delete require.cache[routePath];
  }
}

test('GET /embed/<slug>: the page for a project a guest can use; a framed refusal for anything else', async () => {
  const srv = await startServer();
  try {
    const open = await fetch(`${srv.base}/embed/open-game`);
    assert.equal(open.status, 200);
    assert.match(open.headers.get('content-type'), /^text\/html/);
    assert.equal(open.headers.get('cache-control'), 'no-store');
    assert.equal(open.headers.get('x-frame-options'), null);
    // The app's own production address, as the public directory names it.
    const openHost = productionHostname('open-game');
    assert.ok(open.headers.get('content-security-policy').includes(`frame-src https://${openHost}; frame-ancestors 'self' https://x.com `));
    const openHtml = await open.text();
    assert.ok(openHtml.includes(`src="https://${openHost}/?un-embed=1"`));
    assert.match(openHtml, new RegExp(`class="join" id="join" href="${srv.base.replace(/[.]/g, '\\.')}/app/open-game"`));

    const guest = await (await fetch(`${srv.base}/embed/guest-poll`)).text();
    const pollHost = productionHostname('guest-poll').replace(/[.]/g, '\\.');
    const token = guest.match(new RegExp(`src="https://${pollHost}/\\?token=([^&"]+)&amp;un-embed=1"`))[1];
    assert.equal(platformJwt.verifyGuestToken(token, { appId: 12 }).guest, true);

    for (const p of ['/embed/members-only', '/embed/nobody-here', '/embed/Bad_Slug', '/embed/open-game/more', '/embed']) {
      const res = await fetch(`${srv.base}${p}`);
      assert.equal(res.status, 404, p);
      assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/x\.com/, `${p}: X may show the refusal`);
      const body = await res.text();
      assert.match(body, /This project can't be shown here/, p);
      assert.doesNotMatch(body, /<iframe/, p);
    }
  } finally { await srv.close(); }
});

test('GET /app/<slug> names the embed page as its player only where there is one', async (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))) { t.skip('no built shell'); return; }
  const srv = await startServer();
  try {
    const page = async (slug) => (await fetch(`${srv.base}/app/${slug}`, { headers: { accept: 'text/html' } })).text();
    assert.match(await page('open-game'), new RegExp(`<meta name="twitter:player" content="${srv.base.replace(/[.]/g, '\\.')}/embed/open-game">`));
    assert.match(await page('guest-poll'), /<meta name="twitter:card" content="player">/);
    const closed = await page('members-only');
    assert.match(closed, /<meta name="twitter:card" content="summary_large_image">/);
    assert.doesNotMatch(closed, /twitter:player/);
  } finally { await srv.close(); }
});

test('/embed/ is a public path, and the service worker never answers it with the shell', () => {
  const auth = read('src/middleware/auth.js');
  const publicPaths = auth.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/)[1];
  assert.match(publicPaths, /\n {2}'\/embed\/',\n/);
  const { classifyRequest } = require('../public/sw.js');
  assert.equal(classifyRequest('GET', 'https://example.test/embed/open-game', 'text/html', 'navigate', 'https://example.test'), 'bypass');
  assert.equal(classifyRequest('GET', 'https://example.test/app/open-game', 'text/html', 'navigate', 'https://example.test'), 'navigate');
});
