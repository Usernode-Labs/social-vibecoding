// The waitlist connect callback's status page.
//
// The provider callback used to exchange the code and then 302 to the form.
// That took two provider calls — far past the service worker's 200ms
// navigation deadline — so a returning visitor saw the cached SPA home page
// until the redirect won, with no word about what was happening. The callback
// now answers at once with a standalone page that says it is connecting, and
// the page finishes the round trip through POST …/complete and says how it
// went.
//
// This file pins that page: what the GET returns (and that it does no work),
// the success path end to end with a stubbed provider, and the page script's
// rendering of every outcome. The outcome/replay contract of /complete
// itself lives in tests/waitlist-connect-config.test.js.
//
// Run with: node --test tests/waitlist-connect-status-page.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const express = require('express');

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({ query: async () => ({ rows: [] }) });

const waitlist = require('../src/services/waitlist');
const TOKEN = 'b'.repeat(48);
const written = [];
waitlist.getSignupByMoreToken = async (_pool, token) => (
  token === TOKEN ? { id: 1, email: 'x@example.com', answers: {} } : null
);
waitlist.setVerifiedHandle = async (_pool, token, provider, handle) => {
  written.push({ token, provider, handle });
  return token === TOKEN ? { verified: { [provider]: handle } } : null;
};

const { waitlistConnectRoutes } = require('../src/routes/waitlist-connect');

const CONFIG = {
  env: 'production',
  port: 3000,
  waitlistGithubClientId: 'gh-id',
  waitlistGithubClientSecret: 'gh-secret',
  waitlistXClientId: 'x-id',
  waitlistXClientSecret: 'x-secret',
  waitlistLinkedinClientId: 'li-id',
  waitlistLinkedinClientSecret: 'li-secret',
  waitlistOauthOrigin: '',
};

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(waitlistConnectRoutes(CONFIG));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

const realFetch = global.fetch;

async function mintState(provider) {
  const res = await realFetch(`${base}/waitlist/connect/${provider}?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')).searchParams.get('state');
}

function complete(provider, body) {
  return realFetch(`${base}/waitlist/connect/${provider}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

// ── the GET ────────────────────────────────────────────────────────────

test('the callback answers with a standalone status page, locked down', async () => {
  const res = await realFetch(`${base}/waitlist/connect/github/callback?code=c&state=s`, { redirect: 'manual' });
  assert.equal(res.status, 200, 'a page, not a redirect: it has to paint before the exchange finishes');
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer',
    'the URL carries the code and state; nothing may forward them');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');

  const csp = res.headers.get('content-security-policy');
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);

  const html = await res.text();
  const scripts = html.match(/<script[^>]*>/g);
  const styles = html.match(/<style[^>]*>/g);
  assert.deepEqual(scripts, [`<script nonce="${nonce}">`], 'one inline script, carrying this response\'s nonce');
  assert.deepEqual(styles, [`<style nonce="${nonce}">`]);
  assert.doesNotMatch(html, /<(link|img|iframe)\b|https?:\/\//,
    'no external resource that could receive a Referer or leak the URL');
  assert.match(html, /Connecting your GitHub account/);
});

test('each response gets a fresh nonce', async () => {
  const a = await realFetch(`${base}/waitlist/connect/x/callback`);
  const b = await realFetch(`${base}/waitlist/connect/x/callback`);
  assert.notEqual(a.headers.get('content-security-policy'), b.headers.get('content-security-policy'));
});

test('nothing from the request is reflected into the page', async () => {
  const res = await realFetch(
    `${base}/waitlist/connect/x/callback?state=%3Cscript%3Ealert(1)%3C/script%3E&code=%22%3E%3Cb%3E`
  );
  const html = await res.text();
  assert.doesNotMatch(html, /alert\(1\)|<b>/);
});

test('an unknown provider is a 404 on both halves', async () => {
  assert.equal((await realFetch(`${base}/waitlist/connect/facebook/callback?code=c&state=s`)).status, 404);
  const post = await realFetch(`${base}/waitlist/connect/facebook/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(post.status, 404);
});

test('loading the page spends nothing: the state survives the GET', async () => {
  // A link scanner or prefetch that fetches the callback URL must not consume
  // the single-use state (and with it the code) before the person's own page
  // can finish the round trip.
  const state = await mintState('linkedin');
  const page = await realFetch(`${base}/waitlist/connect/linkedin/callback?state=${state}`);
  assert.equal(page.status, 200);
  const out = await complete('linkedin', { state });
  assert.equal(out.status, 'denied', 'the state was still pending after the GET');
});

// ── the success path ───────────────────────────────────────────────────

test('a successful exchange stores the handle and reports it with the form route', async (t) => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url);
    if (u === 'https://github.com/login/oauth/access_token') {
      return new Response(JSON.stringify({ access_token: 'gho_test' }), { status: 200 });
    }
    if (u === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  t.after(() => { global.fetch = realFetch; });

  const state = await mintState('github');
  written.length = 0;
  const out = await complete('github', { state, code: 'real-code' });
  assert.deepEqual(out, {
    status: 'ok',
    provider: 'github',
    handle: 'octocat',
    redirect: `/#more/${TOKEN}?connect=ok`,
  });
  assert.deepEqual(written, [{ token: TOKEN, provider: 'github', handle: 'octocat' }]);

  // A reload replays the handle too, so the page can say who was verified.
  global.fetch = async () => { throw new Error('a replay must not reach the provider'); };
  const replay = await realFetch(`${base}/waitlist/connect/github/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, code: 'real-code' }),
  }).then((r) => r.json());
  assert.deepEqual(replay, out);
  assert.equal(written.length, 1, 'the handle is written once');
});

test('a provider failure reports failed with a way back to the form', async (t) => {
  global.fetch = async (url) => {
    if (String(url).startsWith(base)) return realFetch(url);
    return new Response('bad_verification_code', { status: 400 });
  };
  t.after(() => { global.fetch = realFetch; });
  const state = await mintState('github');
  const out = await complete('github', { state, code: 'stale' });
  assert.equal(out.status, 'failed');
  assert.equal(out.redirect, `/#more/${TOKEN}?connect=failed`);
});

// ── the page script ────────────────────────────────────────────────────
//
// Run the real inline script against a minimal DOM stand-in, with the
// /complete answer stubbed, and read back what it shows.

function el() {
  return {
    textContent: '', className: '', attrs: {}, children: [], href: undefined, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
}

async function runPage(provider, answer, search = '?state=st&code=co') {
  const html = await realFetch(`${base}/waitlist/connect/${provider}/callback${search}`).then((r) => r.text());
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)[1];
  const nodes = {
    'waitlist-connect-status': el(),
    'waitlist-connect-mark': el(),
    'waitlist-connect-title': el(),
    'waitlist-connect-detail': el(),
    'waitlist-connect-actions': el(),
  };
  // `textContent = ''` on the actions row clears it, as in a browser.
  Object.defineProperty(nodes['waitlist-connect-actions'], 'textContent', {
    get() { return ''; }, set() { this.children = []; },
  });
  const calls = { posts: [], replaced: [], timers: [] };
  const ctx = {
    document: {
      getElementById: (id) => nodes[id],
      createElement: (tag) => Object.assign(el(), { tag }),
    },
    location: {
      search,
      replace: (u) => calls.replaced.push(u),
      reload: () => calls.replaced.push('reload'),
    },
    URLSearchParams,
    JSON,
    setTimeout: (fn, ms) => { calls.timers.push(ms); fn(); },
    fetch: async (url, opts) => {
      calls.posts.push({ url, opts, body: JSON.parse(opts.body) });
      if (answer instanceof Error) throw answer;
      return { ok: true, json: async () => answer };
    },
  };
  vm.runInNewContext(script, ctx);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const actions = nodes['waitlist-connect-actions'].children;
  return {
    calls,
    state: nodes['waitlist-connect-status'].attrs['data-state'],
    title: nodes['waitlist-connect-title'].textContent,
    detail: nodes['waitlist-connect-detail'].textContent,
    actions: actions.map((a) => ({ tag: a.tag, text: a.textContent, href: a.href })),
  };
}

test('the page posts its own state and code to the matching provider, without cookies', async () => {
  const r = await runPage('x', { status: 'expired', redirect: null }, '?state=abc&code=xyz');
  assert.equal(r.calls.posts.length, 1);
  assert.equal(r.calls.posts[0].url, '/waitlist/connect/x/complete');
  assert.equal(r.calls.posts[0].opts.method, 'POST');
  assert.equal(r.calls.posts[0].opts.credentials, 'omit');
  assert.deepEqual(r.calls.posts[0].body, { state: 'abc', code: 'xyz' });
});

test('ok: says who was verified and returns to the form', async () => {
  const form = `/#more/${TOKEN}?connect=ok`;
  const r = await runPage('github', { status: 'ok', handle: 'octocat', redirect: form });
  assert.equal(r.state, 'ok');
  assert.equal(r.title, 'GitHub account connected');
  assert.match(r.detail, /Verified as @octocat\./);
  assert.deepEqual(r.actions, [{ tag: 'a', text: 'Back to your form', href: form }]);
  assert.deepEqual(r.calls.replaced, [form], 'moves on by itself, replacing the callback in history');
});

test('ok on LinkedIn shows the name without an @', async () => {
  const r = await runPage('linkedin', { status: 'ok', handle: 'Ada Lovelace', redirect: `/#more/${TOKEN}?connect=ok` });
  assert.match(r.detail, /Verified as Ada Lovelace\./);
});

test('denied, failed and unavailable explain and offer the form without leaving on their own', async () => {
  for (const [status, title] of [
    ['denied', 'Connection cancelled'],
    ['failed', 'Couldn’t verify your account'],
    ['unavailable', 'X sign-in isn’t available yet'],
  ]) {
    const form = `/#more/${TOKEN}?connect=${status}`;
    const r = await runPage('x', { status, redirect: form });
    assert.equal(r.state, status);
    assert.equal(r.title, title);
    assert.deepEqual(r.actions, [{ tag: 'a', text: 'Back to your form', href: form }], status);
    assert.deepEqual(r.calls.replaced, [], `${status} waits for the person to read it`);
  }
});

test('expired says so and offers no dead link', async () => {
  const r = await runPage('github', { status: 'expired', redirect: null });
  assert.equal(r.title, 'This link has expired');
  assert.match(r.detail, /press Connect again/);
  assert.deepEqual(r.actions, []);
});

test('a network failure offers a retry instead of hanging on "Connecting"', async () => {
  const r = await runPage('github', new Error('offline'));
  assert.equal(r.state, 'error');
  assert.equal(r.title, 'Something went wrong');
  assert.deepEqual(r.actions.map((a) => a.text), ['Try again']);
});

test('a redirect that is not the form route is never followed', async () => {
  const r = await runPage('github', { status: 'ok', handle: 'octocat', redirect: 'https://evil.example/' });
  assert.deepEqual(r.calls.replaced, []);
  assert.deepEqual(r.actions, []);
});
