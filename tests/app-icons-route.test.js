// Route test for GET /app-icons/:id (src/routes/app-icons.js): the
// public homescreen-icon image endpoint. Contracts pinned here: a
// stored icon is served with its content type and the year-long
// immutable cache header; anything that isn't a 32-hex id (or doesn't
// exist) 404s without touching more than one query.
//
// Same harness shape as tests/home-app-activity-counts.test.js:
// override getPool BEFORE requiring the route module, mount the router
// on a real express app, and hit it over HTTP.
//
// Run with: node --test tests/app-icons-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

const { appIconRoutes } = require('../src/routes/app-icons');
const express = require('express');

function startServer() {
  const app = express();
  app.use(appIconRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const GOOD_ID = 'a'.repeat(32);

test('serves a stored icon with content type and immutable cache header', async () => {
  poolQueryHandler = async (sql, params) => {
    assert.deepEqual(params, [GOOD_ID]);
    return { rows: [{ content_type: 'image/png', data: PNG_BYTES }] };
  };
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-icons/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PNG_BYTES));
  } finally {
    server.close();
  }
});

test('unknown id 404s', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-icons/${'f'.repeat(32)}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('malformed ids 404 without querying the DB', async () => {
  let queried = false;
  poolQueryHandler = async () => { queried = true; return { rows: [] }; };
  const server = await startServer();
  try {
    for (const bad of ['short', 'Z'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/app-icons/${bad}`);
      assert.equal(res.status, 404, `expected 404 for ${bad}`);
    }
    assert.equal(queried, false);
  } finally {
    server.close();
  }
});

// ── An emoji app's home-screen icon (/app-icons/emoji/…) ────────────────

test('an emoji tile is drawn by its name alone, immutable, and reads no row', async () => {
  let reads = 0;
  poolQueryHandler = async () => { reads += 1; return { rows: [] }; };
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/app-icons/emoji`;
  try {
    const res = await fetch(`${base}/1f4ca-0ea5e9.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    assert.equal(png.width, 480);
    assert.deepEqual([...png.data.subarray(0, 4)], [0x0e, 0xa5, 0xe9, 255], 'on the colour it names');
    assert.equal((await fetch(`${base}/1f5f3.png`)).status, 200, 'no colour: the cream ground');
    // Only the one spelling of a committed picture.
    for (const bad of ['1f5f3_fe0f.png', '1F4CA.png', '1fa81.png', '1f4ca-0EA5E9.png', '1f4ca-fff.png',
      '1f4ca.svg', '110000.png', '..%2F1f4ca.png', 'x.png']) {
      assert.equal((await fetch(`${base}/${bad}`)).status, 404, bad);
    }
    assert.equal(reads, 0);
  } finally {
    server.close();
  }
});

test('the tile path the install page offers is the one this serves', () => {
  const tile = require('../src/services/emoji-tile');
  assert.equal(tile.tilePath('📊', '#0EA5E9'), '/app-icons/emoji/1f4ca-0ea5e9.png');
  assert.equal(tile.tilePath('🗳️'), '/app-icons/emoji/1f5f3.png', 'without the variation selector');
  assert.equal(tile.tilePath('📊', 'red'), '/app-icons/emoji/1f4ca.png', 'a colour that is not hex is no colour');
  assert.equal(tile.tilePath('🪁'), null, 'no picture, no path');
  const fs = require('node:fs');
  const route = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'app-icons.js'), 'utf8');
  assert.match(route, /router\.get\('\/app-icons\/emoji\/:file', emojiTileLimiter,/, 'rate limited: it draws on the server');
});

// ── A smaller copy for `?w=` (request #7165, point 5) ───────────────────
//
// Icons of 100 KB and more were sent for 48 to 64px tiles, and community
// pictures of up to 936 KB for cards about 110px wide. Either address takes
// `?w=` and answers with a WebP at one of a few widths, made once and kept;
// with no `w` the stored file is sent exactly as before.

const pictureSizes = require('../src/services/picture-sizes');

// A picture that compresses like one: soft gradients with some grain.
function picturePng(width, height) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  let seed = 7;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = seed % 24;
      const i = (y * width + x) << 2;
      png.data[i] = (x * 255 / width + grain) & 255;
      png.data[i + 1] = (y * 255 / height + grain) & 255;
      png.data[i + 2] = ((x + y) * 127 / width + grain) & 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
const isWebp = (body) => body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP';
async function widthOf(body) {
  return (await require('sharp')(body).metadata()).width;
}

test('only a few widths exist, and only a whole number asks for one', () => {
  assert.deepEqual([...pictureSizes.WIDTHS], [96, 192, 512, 1024]);
  assert.deepEqual(['96', '192', '512', '1024'].map(pictureSizes.widthFor), [96, 192, 512, 1024]);
  // Between two widths: the next one up, so twice a tile's size is never softer.
  assert.deepEqual(['1', '97', '128', '193', '600', '1025', '999999'].map(pictureSizes.widthFor),
    [96, 192, 192, 512, 1024, 1024, 1024]);
  for (const none of [undefined, null, '', '0', '-96', '96px', '1e2', '9.5', ' 96', '0096', '1234567', ['96', '192'], { a: '96' }, 96]) {
    assert.equal(pictureSizes.widthFor(none), null, JSON.stringify(none));
  }
});

test('an icon asked for with ?w= comes as a smaller WebP, made once; with no w it is the stored file', async () => {
  const big = picturePng(640, 640);
  const id = 'c'.repeat(32);
  let reads = 0;
  poolQueryHandler = async (sql, params) => {
    reads += 1;
    assert.deepEqual(params, [id]);
    return { rows: [{ content_type: 'image/png', data: big }] };
  };
  const server = await startServer();
  const at = `http://127.0.0.1:${server.address().port}/app-icons/${id}`;
  try {
    const sized = await fetch(`${at}?w=192`);
    assert.equal(sized.status, 200);
    assert.equal(sized.headers.get('content-type'), 'image/webp');
    assert.equal(sized.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(sized.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sized.headers.get('vary'), null, 'nothing is negotiated');
    const body = Buffer.from(await sized.arrayBuffer());
    assert.ok(isWebp(body));
    assert.equal(await widthOf(body), 192);
    assert.ok(body.length * 4 < big.length, `${body.length} bytes against ${big.length}`);
    assert.equal(reads, 1);

    // Kept: the same copy again, and a width that rounds up to it.
    const again = Buffer.from(await (await fetch(`${at}?w=192`)).arrayBuffer());
    const rounded = Buffer.from(await (await fetch(`${at}?w=130`)).arrayBuffer());
    assert.ok(again.equals(body) && rounded.equals(body));
    assert.equal(reads, 3, 'the stored row is still read on every request');

    // Deleted: a 404, though a copy of it was kept a moment ago.
    const keep = poolQueryHandler;
    poolQueryHandler = async () => ({ rows: [] });
    assert.equal((await fetch(`${at}?w=192`)).status, 404, 'a deleted picture is not answered from memory');
    assert.equal((await fetch(at)).status, 404);
    // Replaced under the same id: the new bytes' copy, never the old one.
    const other = picturePng(640, 320);
    poolQueryHandler = async () => ({ rows: [{ content_type: 'image/png', data: other }] });
    const fresh = Buffer.from(await (await fetch(`${at}?w=192`)).arrayBuffer());
    assert.ok(isWebp(fresh) && !fresh.equals(body));
    assert.equal((await require('sharp')(fresh).metadata()).height, 96);
    poolQueryHandler = keep;

    // No width, or one that is not a number: the stored file, as before.
    for (const plain of ['', '?w=', '?w=big', '?w=192&w=96', '?size=192']) {
      const res = await fetch(`${at}${plain}`);
      assert.equal(res.headers.get('content-type'), 'image/png', plain);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(big), plain);
    }

    // Never enlarged: a width past the picture's own sends the stored file.
    const wide = await fetch(`${at}?w=1024`);
    assert.equal(wide.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await wide.arrayBuffer()).equals(big));
  } finally {
    server.close();
  }
});

test('a picture that cannot be sized is sent as stored, and a missing one is still a 404', async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/app-icons`;
  try {
    // Bytes no image library reads (the existing fixture: a PNG signature and four bytes).
    poolQueryHandler = async () => ({ rows: [{ content_type: 'image/png', data: PNG_BYTES }] });
    const broken = await fetch(`${base}/${'d'.repeat(32)}?w=96`);
    assert.equal(broken.status, 200);
    assert.equal(broken.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await broken.arrayBuffer()).equals(PNG_BYTES));

    // A type that is not sized at all.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"/>');
    poolQueryHandler = async () => ({ rows: [{ content_type: 'image/svg+xml', data: svg }] });
    const drawn = await fetch(`${base}/${'e'.repeat(32)}?w=96`);
    assert.equal(drawn.headers.get('content-type'), 'image/svg+xml');
    assert.ok(Buffer.from(await drawn.arrayBuffer()).equals(svg));

    poolQueryHandler = async () => ({ rows: [] });
    assert.equal((await fetch(`${base}/${'9'.repeat(32)}?w=96`)).status, 404);
    // Not remembered: the picture is served once it exists.
    const big = picturePng(400, 400);
    poolQueryHandler = async () => ({ rows: [{ content_type: 'image/png', data: big }] });
    assert.equal((await fetch(`${base}/${'9'.repeat(32)}?w=96`)).headers.get('content-type'), 'image/webp');
    let queried = false;
    poolQueryHandler = async () => { queried = true; return { rows: [] }; };
    assert.equal((await fetch(`${base}/nope?w=96`)).status, 404);
    assert.equal(queried, false);
  } finally {
    server.close();
  }
});

test('a community picture takes ?w= the same way', async () => {
  const { illustrationImageRoutes } = require('../src/routes/app-illustrations');
  const app = express();
  app.use(illustrationImageRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const big = picturePng(1400, 800);
  const id = '1'.repeat(32);
  let reads = 0;
  poolQueryHandler = async (sql, params) => {
    reads += 1;
    assert.match(sql, /FROM app_illustrations WHERE id = \$1/);
    assert.deepEqual(params, [id]);
    return { rows: [{ content_type: 'image/png', data: big }] };
  };
  const at = `http://127.0.0.1:${server.address().port}/app-illustrations/${id}`;
  try {
    const whole = await fetch(at);
    assert.equal(whole.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(big), 'no width: the whole picture');
    const sizes = {};
    for (const width of [512, 1024]) {
      const res = await fetch(`${at}?w=${width}`);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(await widthOf(body), width);
      sizes[width] = body.length;
    }
    assert.ok(sizes[512] < sizes[1024] && sizes[1024] < big.length);
    assert.equal(reads, 3);
    poolQueryHandler = async () => ({ rows: [] });
    assert.equal((await fetch(`${at}?w=512`)).status, 404, 'deleted: not answered from the kept copy');
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/app-illustrations/${'2'.repeat(32)}?w=512`)).status, 404);
  } finally {
    server.close();
  }
});

test('copies are kept within a bound, one resize is shared, and a full queue sends the stored file', async () => {
  const source = (seed) => ({ contentType: 'image/png', data: picturePng(600, 600 + seed) });
  const one = source(1);
  const sizer = pictureSizes.createSizer();
  const [a, b] = await Promise.all([sizer.sized('k', 96, one), sizer.sized('k', 96, one)]);
  assert.ok(a && a === b, 'one resize for two askers at once');
  assert.equal(sizer.stats().entries, 1);
  assert.equal(await sizer.sized('k', 96, one), a, 'kept');
  // Other bytes under the same key are another copy.
  const changed = await sizer.sized('k', 96, source(2));
  assert.ok(changed && changed !== a);
  assert.equal(sizer.stats().entries, 2);
  // Forgetting a picture drops its copies and no other's.
  await sizer.sized('k2', 96, one);
  sizer.forget('k');
  assert.deepEqual(sizer.stats(), { entries: 1, bytes: a.data.length, running: 0, waiting: 0 });
  assert.equal(await sizer.sized('k', 96, null), null, 'nothing stored, nothing sized');

  // A small bound drops the least recently used copy.
  const small = pictureSizes.createSizer({ cacheBytes: a.data.length * 2 + 10 });
  const first = await small.sized('one', 96, one);
  const second = await small.sized('two', 96, one);
  assert.equal(await small.sized('one', 96, one), first);
  await small.sized('three', 96, one);
  assert.equal(small.stats().entries, 2);
  assert.ok(small.stats().bytes <= a.data.length * 2 + 10);
  assert.equal(await small.sized('one', 96, one), first, 'the one just used was kept');
  assert.notEqual(await small.sized('two', 96, one), second, 'the oldest was dropped and made again');

  // One at a time and nobody waiting: the second asker gets the stored file.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = (buffer) => ({ metadata: async () => { await held; return require('sharp')(buffer).metadata(); } });
  const real = require('sharp');
  let calls = 0;
  const busy = pictureSizes.createSizer({
    concurrent: 1,
    queue: 0,
    sharp: (buffer, options) => { calls += 1; return calls === 1 ? slow(buffer) : real(buffer, options); },
  });
  const waiting = busy.sized('slow', 96, one);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await busy.sized('other', 96, one), null);
  release();
  assert.ok(await waiting);
  assert.ok(await busy.sized('other', 96, one), 'and is served once there is room');

  // No library: the stored file.
  assert.equal(await pictureSizes.createSizer({ sharp: null }).sized('k', 96, one), null);
});
