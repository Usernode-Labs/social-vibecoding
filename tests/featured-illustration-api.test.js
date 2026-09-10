const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const poolModule = require('../src/db/pool');
const access = require('../src/services/app-access');
const admins = require('../src/services/app-admins');
const state = { art: null, image: null, manager: true, visible: true, writes: 0 };
const original = [poolModule.getPool, access.getAppForUser, admins.canManageApp];
poolModule.getPool = () => ({ query: async (sql, p) => {
  if (sql.startsWith('SELECT content_type')) return { rows: state.image?.id === p[0] ? [state.image] : [] };
  state.writes++;
  if (sql.includes('WITH image')) { state.art = JSON.parse(p[4]); state.image = { id: p[1], content_type: p[2], data: p[3] }; }
  else if (sql.includes('WITH removed')) { state.art = null; state.image = null; }
  else if (state.art) state.art = { ...state.art, ...JSON.parse(p[1]) };
  return { rows: state.art ? [{ featured_illustration: state.art }] : [] };
} });
access.getAppForUser = async () => state.visible ? { id: 1, featured_illustration: state.art } : null;
admins.canManageApp = async () => state.manager;
delete require.cache[require.resolve('../src/routes/app-illustrations')];
const { illustrationRoutes, illustrationImageRoutes, parseFraming, validateImage } = require('../src/routes/app-illustrations');
const app = express();
app.use(express.json());
app.use(illustrationRoutes({}));
app.use(illustrationImageRoutes({}));
[poolModule.getPool, access.getAppForUser, admins.canManageApp] = original;
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const endpoint = '/api/apps/gym/featured-illustration';

test('framing and upload limits reject malformed values and active image formats', () => {
  assert.equal(parseFraming({ zoom: '1', x: 0, y: 0 }), null);
  for (const zoom of [NaN, Infinity, 0, 4]) assert.equal(parseFraming({ zoom, x: 0, y: 0 }), null);
  assert.equal(parseFraming({ zoom: 1, x: 101, y: 0 }), null);
  assert.equal(validateImage(Buffer.from('<svg/>')), null);
  assert.equal(validateImage(Buffer.alloc(1024 * 1024 + 1)), null);
  assert.equal(validateImage(png), 'image/png');
});
test('upload, read, reframe, replacement, permission denial and reset', async () => {
  const server = app.listen(0); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body, type = 'application/json') => fetch(origin + path, {
    method, headers: { 'Content-Type': type }, body: body == null ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
  });
  try {
    let response = await request(endpoint + '?zoom=1.2&x=-15&y=22', 'POST', png, 'application/octet-stream');
    assert.equal(response.status, 200);
    const first = (await response.json()).illustration;
    assert.equal(first.x, -15); assert.equal(first.zoom, 1.2);
    response = await request(first.url);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    response = await request(endpoint, 'PATCH', { zoom: 2, x: 0, y: -50 });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).illustration.url, first.url);
    response = await request(endpoint); assert.equal((await response.json()).illustration.y, -50);
    response = await request(endpoint + '?zoom=1&x=0&y=0', 'POST', png, 'application/octet-stream');
    assert.notEqual((await response.json()).illustration.url, first.url);
    assert.equal((await request(first.url)).status, 404);
    state.manager = false;
    const writes = state.writes;
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await request(endpoint, method, { zoom: 1, x: 0, y: 0 })).status, 403);
    assert.equal(state.writes, writes);
    state.visible = false; assert.equal((await request(endpoint)).status, 404);
    state.visible = true; state.manager = true;
    assert.equal((await request(endpoint, 'DELETE')).status, 200);
    assert.equal((await request(endpoint)).status, 200);
    assert.equal(state.art, null);
    assert.equal((await request(endpoint, 'PATCH', { zoom: 1, x: 0, y: 0 })).status, 409);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
