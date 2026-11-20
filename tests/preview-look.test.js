'use strict';

// 20 Nov 2026 (live-draft review, A): the draft bot's look at its preview
// (src/services/preview-look.js, capture/capture.js PREVIEW_LOOK), modelled
// on tests/design-capture.test.js. The address is the draft's own preview,
// built from its row; the model gives only a path inside the app, which is
// checked; the job is signed in as the capture fixture; and the job itself
// refuses to be taken to another origin. What comes back is facts a model
// that reads text can use, a picture only when asked, and never a token.

const test = require('node:test');
const assert = require('node:assert/strict');

const look = require('../src/services/preview-look');
const capture = require('../capture/capture');

const DRAFT = { id: 3, app_id: 21, app_slug: 'gym', session_id: 77, staging_runtime_name: 'usernode-staging-gym--77' };

function lookFrames(facts, png = null) {
  const json = JSON.stringify(facts);
  return `__USERNODE_LOOK__ bytes=${Buffer.byteLength(json)}\n${Buffer.from(json).toString('base64')}\n__USERNODE_LOOK_END__\n`
    + (png ? `__USERNODE_LOOK_SHOT__ bytes=${png.length}\n${png.toString('base64')}\n__USERNODE_LOOK_SHOT_END__\n` : '');
}

test('previewPath keeps a path inside the app and refuses any address', () => {
  assert.equal(look.previewPath('/'), '/');
  assert.equal(look.previewPath(undefined), '/', 'the app\'s first page when none is given');
  assert.equal(look.previewPath('/settings?tab=2#top'), '/settings?tab=2#top');
  assert.equal(look.previewPath(' /workouts/3 '), '/workouts/3');
  for (const bad of [
    'https://evil.example/', 'http://169.254.169.254/latest', '//evil.example/x', 'evil.example', 'settings',
    'javascript:alert(1)', '/../admin', '/a/../../b', '/%2e%2e/admin', '/a%2fb', '/\\evil', '/a\nb',
    '/x?token=mine', '/x?a=1&token=mine', `/${'a'.repeat(400)}`, 42, {},
  ]) {
    assert.equal(look.previewPath(bad), null, String(bad));
  }
  assert.equal(look.sizeOf('desktop'), 'desktop');
  assert.equal(look.sizeOf('tablet'), 'phone');
  assert.equal(look.selectorOf(` ${'a'.repeat(400)} `).length, 300);
});

test('the origin is the draft\'s own preview, from its row: its ingress on Kubernetes, its container on Docker', async () => {
  const k8s = { captureRuntime: 'kubernetes', kubernetes: { appDomain: 'apps.example', previewDomain: 'previews.example' } };
  assert.equal(await look.previewOrigin(k8s, DRAFT), 'https://gym--s77.previews.example');
  const docker = { ensureNetworkAlias: async () => false };
  assert.equal(await look.previewOrigin({}, DRAFT, { docker }), 'http://usernode-staging-gym--77:3000');
  // A preview not deployed has no origin to look at.
  assert.equal(await look.previewOrigin(k8s, { ...DRAFT, staging_runtime_name: null }), null);
  assert.equal(await look.previewOrigin(k8s, { ...DRAFT, session_id: null }), null);
});

test('a look opens the draft\'s preview at the path and size asked, signed in as the fixture, and reads its facts', async () => {
  let job = null;
  let minted = null;
  const pool = {
    async query(sql, params) {
      assert.match(sql, /FROM users WHERE username = \$1/);
      assert.deepEqual(params, ['usernode-capture'], 'always the seeded fixture');
      return { rows: [{ id: 9, username: 'usernode-capture', usernode_pubkey: null }] };
    },
  };
  const png = Buffer.from('png-bytes');
  const out = await look.lookAtPreview({ captureRuntime: 'kubernetes', kubernetes: { appDomain: 'apps.example', previewDomain: 'p.example' } }, pool, {
    draft: DRAFT, path: '/settings', size: 'desktop', selector: '.delete', screenshot: true,
    deps: {
      mintCaptureToken(user, appId, options) { minted = { user, appId, options }; return 'FIXTURE'; },
      runCaptureJob: async (_config, spec, opts) => {
        job = { spec, opts };
        return {
          stdout: lookFrames({
            path: '/settings?token=FIXTURE', status: 200, matched: 1, elements: [{ tag: 'button', box: { x: 1, y: 2, width: 3, height: 4 } }],
            consoleErrors: [{ kind: 'console', message: 'GET https://gym--s77.p.example/api?token=FIXTURE 500' }],
          }, png),
        };
      },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(job.opts.kind, 'PREVIEW_LOOK');
  assert.equal(job.spec.url, 'https://gym--s77.p.example/settings?token=FIXTURE');
  assert.deepEqual(job.spec.viewport, { width: 1280, height: 800 });
  assert.equal(job.spec.selector, '.delete');
  assert.equal(job.spec.screenshot, true);
  assert.equal(job.spec.sessionId, 77);
  assert.deepEqual([minted.user.username, minted.appId, minted.options], ['usernode-capture', 21, { previewOnly: false }]);
  assert.equal(out.facts.matched, 1);
  assert.equal(out.png.toString(), 'png-bytes');
  // The fixture's token never reaches the model.
  assert.doesNotMatch(JSON.stringify(out.facts), /FIXTURE/);
});

test('a look refuses an address before any job runs, and a job that fails or is not up says why', async () => {
  let ran = 0;
  const deps = { token: 'T', docker: { ensureNetworkAlias: async () => false }, runCaptureJob: async () => { ran += 1; return { stdout: '__USERNODE_LOOK_FAIL__ reason=left_preview\n' }; } };
  assert.deepEqual(await look.lookAtPreview({}, null, { draft: DRAFT, path: 'https://evil.example/', deps }), { ok: false, reason: 'bad_path' });
  assert.equal(ran, 0);
  assert.deepEqual(await look.lookAtPreview({}, null, { draft: { ...DRAFT, staging_runtime_name: null }, path: '/', deps }), { ok: false, reason: 'not_up' });
  assert.equal(ran, 0);
  assert.deepEqual(await look.lookAtPreview({}, null, { draft: DRAFT, path: '/', deps }), { ok: false, reason: 'left_preview' });
  // A picture not asked for is never handed on.
  const quiet = await look.lookAtPreview({}, null, {
    draft: DRAFT, path: '/', deps: { ...deps, runCaptureJob: async () => ({ stdout: lookFrames({ elements: [] }, Buffer.from('x')) }) },
  });
  assert.equal(quiet.ok, true);
  assert.equal(quiet.png, undefined);
  // A capture image from before this mode emits nothing for it.
  assert.deepEqual(look.readLook('capture: no usable TARGETS\n'), { reason: 'no_look' });
});

// ── The job's own mode (capture/capture.js PREVIEW_LOOK) ────────────────

function stubBrowser({ facts = {}, finalUrl = null, navigateTo = null } = {}) {
  const calls = { viewport: null, url: null, evaluated: null, shot: false };
  const handlers = {};
  let current = null;
  const page = {
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    async setRequestInterception() {},
    async setViewport(viewport) { calls.viewport = viewport; },
    async goto(url) {
      calls.url = url;
      current = finalUrl || url;
      // The page's own script sends the top frame elsewhere.
      if (navigateTo) {
        let aborted = false;
        const request = {
          frame: () => ({ parentFrame: () => null }), isNavigationRequest: () => true, url: () => navigateTo,
          abort: async () => { aborted = true; }, continue: async () => {},
        };
        for (const fn of handlers.request || []) fn(request);
        calls.aborted = aborted;
      }
      return { status: () => 200 };
    },
    url() { return current; },
    async evaluate(_fn, args) { calls.evaluated = args; return { badSelector: false, matched: 1, main: !args.selector, title: 'Gym', page: { width: 390, height: 900 }, elements: [], ...facts }; },
    async screenshot() { calls.shot = true; return Buffer.from('png'); },
  };
  const browser = { async newPage() { return page; }, async close() {} };
  return { browser, calls };
}

function collect() {
  const out = [];
  capture.setFrameSink((line) => out.push(line));
  return out;
}

test('PREVIEW_LOOK is parsed, and a malformed or non-http spec is refused', () => {
  assert.deepEqual(capture.parsePreviewLook({ PREVIEW_LOOK: JSON.stringify({ url: 'https://gym--s77.p.example/?token=T', viewport: { width: 390, height: 844 }, selector: '.x', screenshot: true }) }), {
    url: 'https://gym--s77.p.example/?token=T', viewport: { width: 390, height: 844 }, selector: '.x', screenshot: true,
  });
  assert.equal(capture.parsePreviewLook({ PREVIEW_LOOK: JSON.stringify({ url: 'https://x/' }) }).screenshot, false);
  assert.equal(capture.parsePreviewLook({ PREVIEW_LOOK: JSON.stringify({ url: 'file:///etc/passwd' }) }), null);
  assert.equal(capture.parsePreviewLook({ PREVIEW_LOOK: '{' }), null);
  assert.equal(capture.parsePreviewLook({}), null);
});

test('one look is emitted as one frame, with its picture only when asked, and no token in it', async () => {
  const out = collect();
  const { browser, calls } = stubBrowser({ facts: { elements: [{ tag: 'button', text: 'Delete' }] } });
  const spec = { url: 'https://gym--s77.p.example/settings?token=SECRET', viewport: { width: 390, height: 844 }, selector: '.delete', screenshot: true };
  const result = await capture.runPreviewLook(spec, { launch: async () => browser, delayMs: 0 });
  const text = out.join('');
  assert.equal(calls.url, spec.url);
  assert.deepEqual(calls.viewport, { width: 390, height: 844, deviceScaleFactor: 1 });
  assert.equal(calls.evaluated.selector, '.delete');
  assert.deepEqual(calls.evaluated.styles, ['display', 'position', 'backgroundColor', 'color', 'borderRadius', 'margin', 'padding', 'overflow']);
  assert.equal(result.path, '/settings?token=…');
  assert.match(text, /__USERNODE_LOOK__ bytes=\d+\n[A-Za-z0-9+/=]+\n__USERNODE_LOOK_END__\n/);
  assert.match(text, /__USERNODE_LOOK_SHOT__ bytes=3\n/);
  assert.doesNotMatch(text, /__USERNODE_SHOT__|__USERNODE_TEST__|__USERNODE_PAGE__/);
  const facts = look.readLook(text);
  assert.doesNotMatch(JSON.stringify(facts.facts), /SECRET/);
  assert.equal(facts.png.toString(), 'png');

  out.length = 0;
  const plain = stubBrowser();
  await capture.runPreviewLook({ ...spec, screenshot: false }, { launch: async () => plain.browser, delayMs: 0 });
  assert.equal(plain.calls.shot, false);
  assert.doesNotMatch(out.join(''), /__USERNODE_LOOK_SHOT__/);
});

test('a page that takes the look to another origin gives a FAIL frame, never what is there', async () => {
  const out = collect();
  const away = stubBrowser({ navigateTo: 'https://evil.example/' });
  await capture.runPreviewLook({ url: 'https://gym--s77.p.example/', viewport: { width: 390, height: 844 }, selector: '', screenshot: false }, {
    launch: async () => away.browser, delayMs: 0,
  });
  assert.equal(away.calls.aborted, true, 'the navigation is stopped');
  assert.match(out.join(''), /__USERNODE_LOOK_FAIL__ reason=left_preview/);
  assert.doesNotMatch(out.join(''), /__USERNODE_LOOK__ /);

  out.length = 0;
  const landed = stubBrowser({ finalUrl: 'https://evil.example/' });
  await capture.runPreviewLook({ url: 'https://gym--s77.p.example/', viewport: { width: 390, height: 844 }, selector: '', screenshot: false }, {
    launch: async () => landed.browser, delayMs: 0,
  });
  assert.match(out.join(''), /__USERNODE_LOOK_FAIL__ reason=left_preview/);
});
