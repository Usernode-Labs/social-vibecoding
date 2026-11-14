'use strict';

// #6354: `capture_page` starts a design from one of Homeroom's own pages.
// The page table can only name demo routes (so a copy never holds a real
// account's rows), the job is signed in as the fixture, and the one demo
// copy is shared by concurrent captures and stopped when it goes idle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capture = require('../src/services/design-capture');

const SELF = 'usernode-x';
const CONFIG = { selfAppSlug: SELF, captureRuntime: 'docker' };

function frames(html) {
  const b64 = Buffer.from(html, 'utf8').toString('base64');
  return `__USERNODE_PAGE__ bytes=${Buffer.byteLength(html)}\n${b64}\n__USERNODE_PAGE_END__\n`;
}

/** A pool that answers the two lookups capturePage makes. */
function fakePool() {
  return {
    async query(sql) {
      if (/FROM apps\b/.test(sql)) return { rows: [{ id: 3, slug: SELF, name: 'Homeroom' }] };
      if (/FROM users\b/.test(sql)) return { rows: [{ id: 9, username: 'usernode-capture', usernode_pubkey: null }] };
      return { rows: [] };
    },
  };
}

test('findPage matches a key, a name and a demo route, with any app slug', () => {
  assert.equal(capture.findPage('Homeroom bot page').key, 'homeroom-bot');
  assert.equal(capture.findPage('homeroom-bot').key, 'homeroom-bot');
  // 14 Nov 2026: Main Chat is gone; there is no such page to copy.
  assert.equal(capture.findPage('main chat'), null);
  assert.equal(capture.findPage('Main Chat'), null);
  assert.equal(capture.findPage('/?demo=1#homeroom-bot').key, 'homeroom-bot');
  assert.equal(capture.findPage('#homeroom-bot/main'), null);
  assert.equal(capture.findPage('messages').key, 'messages');
  assert.equal(capture.findPage('/?demo=1#app/some-other-slug/dev').key, 'project');
  assert.equal(capture.findPage('/app/some-other-slug/workshop?demo=1').key, 'workshop');
  assert.equal(capture.findPage('/?demo=1#app/x/dev/issues/900003').key, 'request');
  assert.equal(capture.findPage('/admin'), null);
  assert.equal(capture.findPage('/?demo=1#somewhere-else'), null);
  assert.equal(capture.findPage(''), null);
});

test('every page the bot can copy is a demo route', () => {
  for (const page of capture.PAGES) {
    assert.match(page.route(SELF), /(\?|&)demo=1(&|#|$)/, `${page.key} opens its demo route`);
  }
  assert.equal(capture.routeOf(capture.findPage('workshop'), SELF), `/app/${SELF}/workshop?demo=1`);
});

test('the bot page and Main Chat routes are ones the platform already checks', () => {
  const dapp = fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8');
  assert.ok(dapp.includes('"/?demo=1#homeroom-bot"'), 'the bot page demo route is a declared check');
  assert.ok(dapp.includes('"/?demo=1#homeroom-bot/main"'), 'Main Chat\'s demo route is a declared check');
});

test('a stylesheet named by the copy\'s own origin comes back as this site\'s path', () => {
  const html = '<html><head><link rel="stylesheet" href="http://copy:3000/css/app.css">'
    + '<link rel="stylesheet" href="http://copy:3000/css/tailwind.css"></head></html>';
  const out = capture.rewriteSheets(html);
  assert.match(out, /href="\/css\/app\.css"/);
  assert.match(out, /href="\/css\/tailwind\.css"/);
  assert.doesNotMatch(out, /http:\/\/copy:3000/);
});

test('a capture job\'s frames are read, and its failure reason too', () => {
  assert.equal(capture.readPageFrame(frames('<html>hi</html>')), '<html>hi</html>');
  assert.equal(capture.readPageFrame('__USERNODE_PAGE_FAIL__ reason=no_page\n'), null);
  assert.equal(capture.readPageFailure('__USERNODE_PAGE_FAIL__ reason=no_page\n'), 'no_page');
  assert.equal(capture.readPageFailure(''), null);
});

test('capturePage copies the demo route at the asked size, signed in as the fixture', async () => {
  let payload = null;
  let minted = null;
  const result = await capture.capturePage(CONFIG, fakePool(), {
    page: capture.findPage('Homeroom bot page'),
    size: 'phone',
    deps: {
      copy: { url: 'http://copy:3000' },
      mintCaptureToken(user, appId, options) { minted = { user, appId, options }; return 'FIXTURE'; },
      runJob: async (job) => { payload = job; return { stdout: frames('<html><link rel="stylesheet" href="http://copy:3000/css/app.css"></html>') }; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Homeroom bot page');
  assert.equal(result.width, 390);
  assert.equal(result.height, 844);
  assert.match(result.html, /href="\/css\/app\.css"/);
  const spec = JSON.parse(payload.env.PAGE_CAPTURE);
  assert.equal(spec.url, 'http://copy:3000/?demo=1&token=FIXTURE#homeroom-bot');
  assert.deepEqual(spec.viewport, { width: 390, height: 844 });
  assert.equal(minted.user.username, 'usernode-capture', 'always the seeded fixture');
  assert.equal(minted.appId, 3);
  assert.deepEqual(minted.options, { previewOnly: true });
});

test('a desktop capture is 1280 wide when they do not say', async () => {
  let payload = null;
  await capture.capturePage(CONFIG, fakePool(), {
    page: 'homeroom-bot',
    deps: {
      copy: { url: 'http://copy:3000' }, token: 'T',
      runJob: async (job) => { payload = job; return { stdout: frames('<html>ok</html>') }; },
    },
  });
  assert.deepEqual(JSON.parse(payload.env.PAGE_CAPTURE).viewport, { width: 1280, height: 800 });
});

test('an over-cap page and a failed job give a fallback, not a design', async () => {
  const huge = await capture.capturePage(CONFIG, fakePool(), {
    page: 'messages',
    deps: {
      copy: { url: 'http://copy:3000' }, token: 'T',
      runJob: async () => ({ stdout: frames(`<html>${'x'.repeat(capture.MAX_DESIGN_CHARS + 10)}</html>`) }),
    },
  });
  assert.deepEqual(huge, { ok: false, reason: 'too_big' });

  const failed = await capture.capturePage(CONFIG, fakePool(), {
    page: 'messages',
    deps: {
      copy: { url: 'http://copy:3000' }, token: 'T',
      runJob: async () => ({ stdout: '__USERNODE_PAGE_FAIL__ reason=no_page\n' }),
    },
  });
  assert.deepEqual(failed, { ok: false, reason: 'no_page' });

  const unknown = await capture.capturePage(CONFIG, fakePool(), { page: '/admin' });
  assert.deepEqual(unknown, { ok: false, reason: 'unknown_page' });
});

test('one demo copy is shared by concurrent captures and is stopped when it goes idle', async () => {
  capture._reset();
  let deploys = 0;
  let removed = null;
  let dropped = null;
  const pool = {
    ...fakePool(),
    async connect() {
      return { async query() { return { rows: [] }; }, release() {} };
    },
  };
  const deps = {
    servingImage: async () => 'platform@sha256:abc',
    createDatabase: async () => ({ password: 'pw' }),
    connectionUrl: (name) => `postgres://x/${name}`,
    deploy: async (_config, params) => { deploys += 1; return { url: 'http://copy' }; },
    remove: async (_config, ref) => { removed = ref; },
    dropDatabase: async (name) => { dropped = name; },
  };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true });
  try {
    const [a, b] = await Promise.all([
      capture.ensureCopy(CONFIG, pool, { deps }),
      capture.ensureCopy(CONFIG, pool, { deps }),
    ]);
    const again = await capture.ensureCopy(CONFIG, pool, { deps });
    assert.equal(deploys, 1, 'one start for two concurrent captures and a later one');
    assert.equal(a, b);
    assert.equal(a, again);
    assert.equal(capture.IDLE_MS, 30 * 60 * 1000);
    assert.ok(a.timer, 'the copy is stopped after its idle time');
    await capture.stopCopy(CONFIG, a, { deps });
    assert.equal(removed.runtimeName, a.runtimeName);
    assert.equal(dropped, a.dbName);
  } finally {
    global.fetch = realFetch;
    capture._reset();
  }
});
