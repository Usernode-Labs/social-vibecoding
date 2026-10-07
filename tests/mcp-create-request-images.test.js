'use strict';

// Hosted MCP connector: create_request attaches screenshots.
//
// get_request already hands a request's screenshots to the model as images;
// this is the write half. A caller sends each image inline as base64 with the
// SHA-256 of its bytes, create_request uploads it through the feedback
// dialog's own route (POST /api/feedback/screenshot) and files the request
// with the ids, and the platform embeds them the way it embeds a person's.
//
// What these pin:
//   1. every image is checked BEFORE the first upload, and a copy whose bytes
//      do not match their checksum files nothing;
//   2. the bytes travel as an upload of raw bytes on the caller's own token,
//      in order, and only then is the request filed with their ids;
//   3. a request with no images is filed exactly as before;
//   4. only an external client is offered the field, and the one new route
//      is on the external allowlist and on no delegated list;
//   5. the size the tool description quotes is the parser's real limit.
//
// Run with: node --test tests/mcp-create-request-images.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const tools = require('../src/services/mcp-tools');
const policy = require('../src/services/cli-api-policy');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const ORIGIN = 'https://app.onhomeroom.com';

// Headers are enough: nothing here decodes pixels, it reads the size.
function pngBytes(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegBytes(width, height) {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'latin1');
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), app0, sof]);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const inline = (buf, extra = {}) => ({ data: buf.toString('base64'), sha256: sha256(buf), ...extra });

const PNG = pngBytes(1170, 2532);
const JPEG = jpegBytes(1280, 800);

// ── 1. The checks, before anything is sent ─────────────────────────────

test('checkRequestImages accepts PNG and JPEG with a matching checksum, in order', () => {
  const out = tools.checkRequestImages([inline(PNG), inline(JPEG, { mimeType: 'image/jpeg' })]);
  assert.equal(out.ok, true);
  assert.deepEqual(out.images.map((i) => [i.mimeType, i.width, i.height]), [
    ['image/png', 1170, 2532],
    ['image/jpeg', 1280, 800],
  ]);
  assert.ok(out.images[0].bytes.equals(PNG), 'the bytes are the ones that were encoded');
  assert.equal(out.images[1].sha256, sha256(JPEG));
});

test('checkRequestImages: no images is an empty list, not an error', () => {
  assert.deepEqual(tools.checkRequestImages(undefined), { ok: true, images: [] });
  assert.deepEqual(tools.checkRequestImages(null), { ok: true, images: [] });
  assert.deepEqual(tools.checkRequestImages([]), { ok: true, images: [] });
});

test('checkRequestImages ignores a data-URL prefix, line breaks and checksum case', () => {
  const wrapped = PNG.toString('base64').replace(/(.{20})/g, '$1\n');
  const out = tools.checkRequestImages([{
    data: `data:image/png;base64,${wrapped}`,
    sha256: sha256(PNG).toUpperCase(),
  }]);
  assert.equal(out.ok, true);
  assert.ok(out.images[0].bytes.equals(PNG));
});

test('checkRequestImages refuses a damaged copy: the checksum is the point', () => {
  const good = inline(PNG);
  // One character changed somewhere in the middle, as a transcription slip
  // would. It still decodes, still sniffs as a PNG.
  const chars = good.data.split('');
  const at = Math.floor(chars.length / 2);
  chars[at] = chars[at] === 'A' ? 'B' : 'A';
  const out = tools.checkRequestImages([{ ...good, data: chars.join('') }]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'invalid_images');
  assert.equal(out.index, 0);
  assert.match(out.message, /SHA-256/);
  assert.match(out.message, /lost or changed/);
  assert.match(out.message, /Nothing was uploaded or filed\./);
});

test('checkRequestImages refuses everything it cannot vouch for, naming the image', () => {
  const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 1)]);
  const huge = pngBytes(9000, 10);
  const headless = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]);
  const cases = [
    ['not a list', { a: 1 }, /must be a list/, undefined],
    ['too many', [inline(PNG), inline(PNG), inline(PNG), inline(PNG)], /at most 3 images; 4 were sent/, undefined],
    ['not an object', [inline(PNG), 'png'], /images\[1\] is not an object/, 1],
    ['no data', [{ sha256: sha256(PNG) }], /not base64/, 0],
    ['not base64', [{ data: 'this is not base64!', sha256: sha256(PNG) }], /not base64/, 0],
    ['bad padding', [{ data: 'iVBORw0', sha256: sha256(PNG) }], /not base64/, 0],
    ['no checksum', [{ data: PNG.toString('base64') }], /must be the 64-character hex SHA-256/, 0],
    ['short checksum', [{ data: PNG.toString('base64'), sha256: 'abc' }], /64-character hex/, 0],
    ['wrong file', [{ data: PNG.toString('base64'), sha256: sha256(JPEG) }], /lost or changed/, 0],
    ['a GIF', [inline(GIF)], /not a PNG or JPEG/, 0],
    ['type mismatch', [inline(PNG, { mimeType: 'image/jpeg' })], /says image\/jpeg, but the bytes are image\/png/, 0],
    ['unreadable header', [inline(headless)], /header could not be read/, 0],
    ['an edge over 8000', [inline(huge)], /9000x10 pixels; neither side may exceed 8000/, 0],
  ];
  for (const [name, input, pattern, index] of cases) {
    const out = tools.checkRequestImages(input);
    assert.equal(out.ok, false, name);
    assert.equal(out.code, 'invalid_images', name);
    assert.match(out.message, pattern, name);
    assert.equal(out.index, index, `${name}: index`);
  }
});

test('checkRequestImages refuses an image over the per-image byte limit', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(tools.MAX_REQUEST_IMAGE_BYTES)]);
  const out = tools.checkRequestImages([inline(big)]);
  assert.equal(out.ok, false);
  assert.match(out.message, new RegExp(`over the ${tools.MAX_REQUEST_IMAGE_BYTES}-byte limit`));
});

// ── 2/3. Through the registered handler ────────────────────────────────

// registerTools against a recorder, with the loopback answered here. Each
// upload gets the next id; the issues route answers with the filed issue.
function connector({ delegation = null, uploadFails = null } = {}) {
  const handlers = new Map();
  const specs = new Map();
  const calls = [];
  let nextId = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const pathname = String(url).replace('http://platform.internal', '');
    const headers = init.headers || {};
    const raw = Buffer.isBuffer(init.body);
    calls.push({
      method: init.method || 'GET',
      pathname,
      headers,
      raw,
      body: raw ? init.body : (init.body ? JSON.parse(init.body) : null),
    });
    let status = 200;
    let body;
    if (pathname === '/api/feedback/screenshot') {
      if (uploadFails && nextId === uploadFails.at) {
        status = uploadFails.status;
        body = { error: uploadFails.error };
      } else {
        nextId += 1;
        body = { id: String(nextId).repeat(32).slice(0, 32) };
      }
    } else {
      body = { issue: { id: 5, github_issue_number: 88, title: 'Save button does nothing' } };
    }
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  };
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test',
    scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool: null, config: {}, tokenId: null, grantId: null, delegation,
  });
  return { handlers, specs, calls, restore: () => { globalThis.fetch = realFetch; } };
}

test('create_request uploads each image as raw bytes on the caller\'s token, then files with the ids', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('create_request')({
      slug: 'cool-app',
      title: 'Save button does nothing',
      description: 'Tap Save on the profile screen; nothing happens.',
      images: [inline(PNG), inline(JPEG)],
    });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    assert.deepEqual(c.calls.map((x) => `${x.method} ${x.pathname}`), [
      'POST /api/feedback/screenshot',
      'POST /api/feedback/screenshot',
      'POST /api/apps/cool-app/issues',
    ], 'uploads first, in order, then one filing');

    const [first, second, filing] = c.calls;
    for (const upload of [first, second]) {
      assert.equal(upload.raw, true, 'the image travels as bytes, not JSON');
      assert.equal(upload.headers['content-type'], 'application/octet-stream');
      assert.equal(upload.headers.authorization, 'Bearer svmcp_test', 'on the caller\'s own token');
    }
    assert.ok(first.body.equals(PNG));
    assert.ok(second.body.equals(JPEG));

    const ids = ['1'.repeat(32), '2'.repeat(32)];
    assert.deepEqual(filing.body, {
      title: 'Save button does nothing',
      description: 'Tap Save on the profile screen; nothing happens.',
      kind: 'general',
      screenshotIds: ids,
    });

    const s = out.structuredContent;
    assert.equal(s.number, 88);
    assert.equal(s.descriptionChars, 'Tap Save on the profile screen; nothing happens.'.length);
    assert.deepEqual(s.images, ids.map((id) => `${ORIGIN}/issue-images/${id}`));
    assert.equal(z.object(c.specs.get('create_request').outputSchema).safeParse(s).success, true,
      'the answer satisfies the tool\'s own outputSchema');
  } finally { c.restore(); }
});

test('create_request with no images files exactly as before', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('create_request')({ slug: 'cool-app', title: 'Dark mode' });
    assert.equal(out.isError, undefined);
    assert.equal(c.calls.length, 1);
    assert.deepEqual(c.calls[0].body, { title: 'Dark mode', description: null, kind: 'general' },
      'no screenshotIds key at all');
    assert.deepEqual(out.structuredContent.images, []);
    assert.equal(z.object(c.specs.get('create_request').outputSchema).safeParse(out.structuredContent).success, true);
  } finally { c.restore(); }
});

test('a refused image means no upload and no filing', async () => {
  const c = connector();
  try {
    const damaged = { ...inline(JPEG), sha256: sha256(PNG) };
    const out = await c.handlers.get('create_request')({
      slug: 'cool-app', title: 'Broken', images: [inline(PNG), damaged],
    });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.code, 'invalid_images');
    assert.equal(out.structuredContent.index, 1);
    assert.equal(c.calls.length, 0, 'not even the first, good image was uploaded');
  } finally { c.restore(); }
});

test('the length checks still come first, and the scope guard before them', async () => {
  const c = connector();
  try {
    const over = 'x'.repeat(tools.MAX_REQUEST_BODY_CHARS + 1);
    const out = await c.handlers.get('create_request')({
      slug: 'cool-app', title: 'Long', description: over, images: [inline(PNG)],
    });
    assert.equal(out.structuredContent.code, 'description_too_long');
    assert.equal(c.calls.length, 0);
  } finally { c.restore(); }
  const src = fs.readFileSync(path.join(__dirname, '../src/services/mcp-tools.js'), 'utf8');
  const start = src.indexOf("server.registerTool('create_request'");
  const body = src.slice(start, src.indexOf('server.registerTool(', start + 10));
  assert.ok(body.indexOf('scopeGuard(WRITE_SCOPE)') < body.indexOf('checkRequestImages('));
  assert.ok(body.indexOf('checkRequestImages(') < body.indexOf("'/api/feedback/screenshot'"),
    'every image is checked before the first upload');
});

test('a failed upload stops before the request is filed, in the platform\'s words', async () => {
  const c = connector({
    uploadFails: { at: 1, status: 429, error: 'Too many screenshot uploads. Slow down for a few minutes.' },
  });
  try {
    const out = await c.handlers.get('create_request')({
      slug: 'cool-app', title: 'Broken', images: [inline(PNG), inline(JPEG)],
    });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.code, 'at_capacity');
    assert.match(out.structuredContent.message, /Too many screenshot uploads/);
    assert.deepEqual(c.calls.map((x) => x.pathname), ['/api/feedback/screenshot', '/api/feedback/screenshot'],
      'nothing was filed after the second upload failed');
  } finally { c.restore(); }
});

// ── 4. Who is offered it, and where it may go ──────────────────────────

test('an external client is told about images; the Mayor is not offered them', async () => {
  const external = connector();
  const mayor = connector({ delegation: { kind: 'agent_mayor' } });
  try {
    const ext = external.specs.get('create_request');
    assert.ok(ext.inputSchema.images, 'external clients get the field');
    assert.match(ext.description, /images/);
    assert.match(ext.description, /SHA-256/);
    assert.match(ext.description, new RegExp(`${tools.MCP_REQUEST_BODY_KB} KB`));

    const own = mayor.specs.get('create_request');
    assert.ok(own, 'the Mayor still files requests');
    assert.equal(own.inputSchema.images, undefined, 'but is not offered images');
    assert.doesNotMatch(own.description, /SHA-256/);
    const out = await mayor.handlers.get('create_request')({
      slug: 'cool-app', title: 'Broken', images: [inline(PNG)],
    });
    assert.equal(out.isError, true, 'images reaching the Mayor\'s handler are refused, not dropped');
    assert.equal(mayor.calls.length, 0);
  } finally { external.restore(); mayor.restore(); }
});

test('the upload route is on the external allowlist, exactly, and on no delegated list', () => {
  assert.equal(policy.isConnectorApiRequest('POST', '/api/feedback/screenshot'), true);
  for (const [method, target] of [
    ['GET', '/api/feedback/screenshot'],
    ['PUT', '/api/feedback/screenshot'],
    ['POST', '/api/feedback/screenshot/extra'],
    // Filing feedback directly, or reading the caller's own list, stays off.
    ['POST', '/api/feedback'],
    ['GET', '/api/feedback/mine'],
    ['POST', '/api/feedback/title'],
  ]) {
    assert.equal(policy.isConnectorApiRequest(method, target), false, `${method} ${target} is refused`);
  }
  for (const kind of ['agent_mayor', 'worker_read']) {
    assert.equal(policy.isDelegatedApiRequest(kind, 'POST', '/api/feedback/screenshot'), false,
      `${kind} cannot upload`);
  }
});

// ── 5. The limit the description quotes is the real one ────────────────

test('MCP_REQUEST_BODY_KB is the /mcp parser\'s own limit', () => {
  const remote = fs.readFileSync(path.join(__dirname, '../src/routes/mcp-remote.js'), 'utf8');
  assert.match(remote, new RegExp(`router\\.post\\(MCP_PATH, jsonBody\\('${tools.MCP_REQUEST_BODY_KB}kb'\\)`),
    'if the /mcp body limit changes, the size create_request quotes must change with it');
});
