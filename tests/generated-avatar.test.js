'use strict';

// The generated profile picture (#7135), against the service and the route.
//
// A person who has not uploaded a photo gets a picture of shapes and colour
// blocks made from their account: the same account always yields the same
// bytes (so the year-long immutable cache is safe), two accounts do not share
// one, and the SVG can never carry text, a script or anything a person typed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const {
  generatedAvatarToken,
  isGeneratedAvatarToken,
  renderGeneratedAvatar,
} = require('../src/services/generated-avatar');
const { generatedAvatarUrl, avatarUrlFor } = require('../src/services/avatar-url');

test('the token is sha256 of the account, 20 hex characters', () => {
  const expected = crypto.createHash('sha256')
    .update('homeroom-avatar:v1:42')
    .digest('hex')
    .slice(0, 20);
  assert.equal(generatedAvatarToken(42), expected);
  assert.match(generatedAvatarToken(42), /^[a-f0-9]{20}$/);
  assert.ok(isGeneratedAvatarToken(generatedAvatarToken(42)));
  for (const bad of ['', 'nope', 'A'.repeat(20), 'a'.repeat(19), 'a'.repeat(21)]) {
    assert.equal(isGeneratedAvatarToken(bad), false, `${bad} is not a token`);
  }
});

test('the same token always draws the same bytes', () => {
  const token = generatedAvatarToken(7);
  assert.equal(renderGeneratedAvatar(token), renderGeneratedAvatar(token));
  assert.equal(renderGeneratedAvatar(token), renderGeneratedAvatar(generatedAvatarToken(7)));
  assert.equal(renderGeneratedAvatar('not-a-token'), null);
});

test('two accounts get visibly different pictures', () => {
  const seen = new Set();
  for (let id = 1; id <= 200; id += 1) seen.add(renderGeneratedAvatar(generatedAvatarToken(id)));
  assert.equal(seen.size, 200, 'no two of 200 accounts share a picture');
});

test('the picture is shapes only: allowed elements, no text or script', () => {
  for (let id = 1; id <= 25; id += 1) {
    const svg = renderGeneratedAvatar(generatedAvatarToken(id));
    const tags = [...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]);
    assert.ok(tags.length >= 5, 'a background and three shapes');
    for (const tag of tags) {
      assert.ok(['svg', 'rect', 'circle', 'path'].includes(tag), `${tag} is not an allowed element`);
    }
    assert.doesNotMatch(svg, /<(script|text|a|image|foreignObject)\b/i);
    assert.doesNotMatch(svg, /\bon\w+=|href=|xlink/i, 'nothing that could run or fetch');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/);
    assert.match(svg, /<rect width="64" height="64" fill="#[0-9a-f]{6}"\/>/, 'an opaque background');
    assert.ok(svg.length < 900, 'a small document');
  }
});

test('the address helper falls back to the generated picture for a known account', () => {
  assert.equal(generatedAvatarUrl(42), `/avatars/g/${generatedAvatarToken(42)}.svg`);
  assert.match(generatedAvatarUrl(42), /^\/avatars\/g\/[a-f0-9]{20}\.svg$/);
  assert.equal(avatarUrlFor('ab'.repeat(16), 42), `/avatars/${'ab'.repeat(16)}`,
    'an uploaded photo wins');
  assert.equal(avatarUrlFor(null, 42), generatedAvatarUrl(42));
  assert.equal(generatedAvatarUrl(null), null, 'no account known, no picture');
  assert.equal(avatarUrlFor(null, null), null);
});

// ─── The route ────────────────────────────────────────────────────────

async function startServer() {
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  let queries = 0;
  poolModule.getPool = () => ({
    query: async () => { queries += 1; throw new Error('the generated route must read no row'); },
  });
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/avatars')];
    routes = require('../src/routes/avatars').avatarRoutes();
  } finally {
    poolModule.getPool = original;
  }
  const app = express();
  app.use(routes);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    queries: () => queries,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('GET /avatars/g/:token.svg serves the picture with the photo cache headers', async () => {
  const srv = await startServer();
  try {
    const token = generatedAvatarToken(42);
    const res = await fetch(`${srv.baseUrl}/avatars/g/${token}.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^image\/svg\+xml/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(await res.text(), renderGeneratedAvatar(token));
    assert.equal(srv.queries(), 0, 'the picture is drawn from the token alone');
  } finally { await srv.close(); }
});

test('GET /avatars/g/:token.svg refuses anything that is not a token', async () => {
  const srv = await startServer();
  try {
    for (const bad of ['nope', 'A'.repeat(20), 'a'.repeat(19), 'a'.repeat(21), '..%2f..%2fetc']) {
      const res = await fetch(`${srv.baseUrl}/avatars/g/${bad}.svg`);
      assert.equal(res.status, 404, `${bad} must 404`);
    }
    assert.equal(srv.queries(), 0);
  } finally { await srv.close(); }
});
