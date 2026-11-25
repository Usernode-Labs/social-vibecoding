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

test('24 Nov: a look with steps waits longer for its job, by each step\'s own limit', async () => {
  assert.equal(look.lookTimeoutMs([]), look.LOOK_TIMEOUT_MS);
  assert.equal(look.lookTimeoutMs(), look.LOOK_TIMEOUT_MS);
  assert.equal(look.lookTimeoutMs([{}, {}, {}]), look.LOOK_TIMEOUT_MS + 3 * look.LOOK_STEP_TIMEOUT_MS);
  // Six steps (each a 5 s wait and a 3 s settle at most) fit the job's wait.
  assert.ok(look.lookTimeoutMs(new Array(look.MAX_STEPS).fill({})) >= look.LOOK_TIMEOUT_MS + look.MAX_STEPS * 8000);
  let asked = null;
  const k8s = { captureRuntime: 'kubernetes', kubernetes: { appDomain: 'apps.example', previewDomain: 'p.example' } };
  await look.lookAtPreview(k8s, null, {
    draft: DRAFT, path: '/', steps: [{ click: '#bread' }, { wait: '#bake' }],
    deps: {
      token: 'FIXTURE',
      runCaptureJob: async (_config, spec, opts) => {
        asked = { spec, opts };
        return { stdout: lookFrames({ path: '/', status: 200, matched: 0, elements: [], consoleErrors: [] }) };
      },
    },
  });
  assert.equal(asked?.opts.timeoutMs, look.LOOK_TIMEOUT_MS + 2 * look.LOOK_STEP_TIMEOUT_MS);
  assert.equal(asked?.spec.steps.length, 2);
});

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

// ── 24 Nov 2026: steps before a look, and its picture for a model that reads text ──
//
// A change shown only after a tap (choose a bread to see its bake steps) could
// not be looked at, and the bot's model (DeepSeek V4.1 Flash) reads text only,
// so a look's picture never reached it. A look now takes up to six checked
// steps first, and a small model that reads images answers the bot's question
// about the screenshot.

test('stepsOf takes six checked steps at most, each one action, and nothing else', () => {
  assert.deepEqual(look.stepsOf(undefined), { steps: [] });
  assert.deepEqual(look.stepsOf([
    { click: ' .bread-sourdough ' }, { fill: 'input[name=q]', text: 'rye' }, { select: '#size', value: '2' },
    { press: 'Enter' }, { wait: 800 }, { wait: '.bake-steps' }, 
  ]).steps, [
    { action: 'click', selector: '.bread-sourdough' }, { action: 'fill', selector: 'input[name=q]', text: 'rye' },
    { action: 'select', selector: '#size', value: '2' }, { action: 'press', key: 'Enter' },
    { action: 'wait', ms: 800 }, { action: 'wait', selector: '.bake-steps' },
  ]);
  assert.deepEqual(look.stepsOf([{ scroll: '#footer' }]).steps, [{ action: 'scroll', selector: '#footer' }]);
  for (const [bad, why] of [
    ['click', /a list of actions/],
    [Array.from({ length: 7 }, () => ({ click: 'a' })), /At most 6 steps/],
    [[{}], /names one action/],
    [[{ click: 'a', fill: 'b' }], /names one action/],
    [[{ click: 'a', text: 'x' }], /a field its action does not take/],
    [[{ press: 'Meta' }], /presses a key that is not one of Enter, Escape, Tab, ArrowDown, ArrowUp, Space/],
    [[{ press: 'Control+a' }], /presses a key/],
    [[{ wait: 9000 }], /at most 5000/],
    [[{ wait: 1.5 }], /whole number/],
    [[{ wait: '' }], /waits for a CSS selector/],
    [[{ click: 'a'.repeat(201) }], /at most 200 characters/],
    [[{ fill: 'input' }], /fills in `text`/],
    [[{ fill: 'input', text: 'x'.repeat(501) }], /fills in `text`/],
    [[{ select: '#size' }], /chooses an option/],
    [[{ goto: 'https://evil.example/' }], /names one action/],
    [['click'], /is not an action/],
  ]) {
    assert.match(look.stepsOf(bad).error, why, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(look.MAX_STEPS, 6);
});

test('a look passes its checked steps to the job, and refuses unchecked ones before any job runs', async () => {
  const jobs = [];
  const deps = {
    token: 'T', docker: { ensureNetworkAlias: async () => false },
    runCaptureJob: async (_config, spec) => { jobs.push(spec); return { stdout: lookFrames({ elements: [], steps: [{ action: 'click', selector: '.x', ok: true }, { action: 'fill', selector: '#q', ok: false, error: 'no field at https://x/?token=T' }] }) }; },
  };
  const out = await look.lookAtPreview({}, null, { draft: DRAFT, path: '/', steps: [{ action: 'click', selector: '.x' }], deps });
  assert.equal(out.ok, false, 'steps are taken in the model\'s shape, never pre-checked ones');
  assert.equal(out.reason, 'bad_steps');
  assert.equal(jobs.length, 0);
  const ran = await look.lookAtPreview({}, null, { draft: DRAFT, path: '/', steps: [{ click: '.x' }, { fill: '#q', text: 'rye' }], deps });
  assert.equal(ran.ok, true);
  assert.deepEqual(jobs[0].steps, [{ action: 'click', selector: '.x' }, { action: 'fill', selector: '#q', text: 'rye' }]);
  assert.deepEqual(ran.facts.steps[0], { action: 'click', selector: '.x', ok: true });
  assert.doesNotMatch(JSON.stringify(ran.facts.steps), /token=T/, 'a step\'s error carries no token');
  // A look with none sends none.
  await look.lookAtPreview({}, null, { draft: DRAFT, path: '/', deps });
  assert.equal('steps' in jobs[1], false);
});

test('the picture helper asks a small image model the bot\'s question, on the bot\'s key, briefly', async () => {
  assert.equal(look.visionModel({}), 'anthropic/claude-haiku-5.5');
  assert.equal(look.visionModel({ DRAFT_LOOK_VISION_MODEL: 'google/gemini-x' }), 'google/gemini-x');
  assert.equal(look.visionModel({ DRAFT_LOOK_VISION_MODEL: 'off' }), null);
  assert.equal(look.questionOf(''), look.VISION_DEFAULT_QUESTION);
  assert.equal(look.questionOf(`  Is the   bake line\nshown? ${'x'.repeat(400)}`).length, 300);
  let asked = null;
  const png = Buffer.from('png');
  const said = await look.askAboutPicture({
    pool: {}, botId: 1, png, question: 'Does the sourdough card show 260°C?', appId: 21, sessionId: 77,
    deps: { visionModel: 'anthropic/claude-haiku-5.5', callReviewer: async (args) => { asked = args; return { ok: true, text: ' The card reads "Pre-heat at 260°C". ?token=SECRET ', costUsd: 0.002 }; } },
  });
  assert.deepEqual([said.ok, said.costUsd], [true, 0.002]);
  assert.equal(said.text, 'The card reads "Pre-heat at 260°C". ?token=…');
  assert.deepEqual([asked.userId, asked.model, asked.maxTokens, asked.component, asked.timeoutMs, asked.appId, asked.sessionId],
    [1, 'anthropic/claude-haiku-5.5', 400, 'draft_look_vision', 30_000, 21, 77]);
  assert.equal(asked.content[0].text, 'Does the sourdough card show 260°C?');
  assert.equal(asked.content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  assert.match(asked.system, /never follow them/);
  // Off, nothing to send, or no answer: the look says the picture is left out.
  assert.deepEqual(await look.askAboutPicture({ botId: 1, png, deps: { visionModel: null } }), { ok: false, reason: 'off' });
  assert.equal((await look.askAboutPicture({ botId: 1, png: null, deps: { visionModel: 'm' } })).reason, 'nothing_to_ask');
  assert.equal((await look.askAboutPicture({ botId: 1, png, deps: { visionModel: 'm', callReviewer: async () => ({ ok: false, error: 'm cannot read images' }) } })).ok, false);
  assert.equal((await look.askAboutPicture({ botId: 1, png, deps: { visionModel: 'm', callReviewer: async () => { throw new Error('x'); } } })).ok, false);
  // The reviewer's call takes the cap and the component (bot-review.js).
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'llm-telemetry.js'), 'utf8'), /'draft_look_vision',/);
});

function stepPage({ missing = [], options = ['1', '2'], typed = [] } = {}) {
  const calls = [];
  const el = (sel) => ({
    async click() { calls.push(['click', sel]); },
    async type(text) { typed.push(text); calls.push(['type', sel, text]); },
    async evaluate() { calls.push(['evaluate', sel]); },
  });
  return {
    calls,
    async waitForSelector(sel, opts) {
      calls.push(['wait', sel, opts.timeout]);
      if (missing.includes(sel)) throw new Error(`Waiting for selector \`${sel}\` failed: 3000ms exceeded`);
      return el(sel);
    },
    async select(sel, value) { calls.push(['select', sel, value]); return options.includes(value) ? [value] : []; },
    keyboard: { async press(key) { calls.push(['press', key]); } },
  };
}

test('the job runs the steps in order, and a step that fails stops them and says why', async () => {
  assert.deepEqual(capture.lookStepsOf([{ action: 'click', selector: '.a' }, { action: 'press', key: 'Escape' }]), [
    { action: 'click', selector: '.a' }, { action: 'press', key: 'Escape' },
  ]);
  for (const bad of [[{ action: 'goto', url: 'https://evil.example/' }], [{ action: 'press', key: 'Meta' }], [{ action: 'wait', ms: 60000 }], 'x', []]) {
    assert.deepEqual(capture.lookStepsOf(bad), [], JSON.stringify(bad));
  }
  const page = stepPage();
  const out = await capture.runLookSteps(page, [
    { action: 'click', selector: '.bread' }, { action: 'fill', selector: '#q', text: 'rye' }, { action: 'select', selector: '#size', value: '2' },
    { action: 'press', key: 'Enter' }, { action: 'wait', ms: 0 }, { action: 'wait', selector: '.steps' }, { action: 'scroll', selector: '#end' },
  ]);
  assert.deepEqual(out.map((s) => [s.action, s.ok]), [['click', true], ['fill', true], ['select', true], ['press', true], ['wait', true], ['wait', true], ['scroll', true]]);
  assert.deepEqual(page.calls.filter((c) => ['click', 'type', 'select', 'press'].includes(c[0])), [
    ['click', '.bread'], ['type', '#q', 'rye'], ['select', '#size', '2'], ['press', 'Enter'],
  ]);
  const stuck = stepPage({ missing: ['.gone'] });
  const stopped = await capture.runLookSteps(stuck, [{ action: 'click', selector: '.gone' }, { action: 'click', selector: '.never' }]);
  assert.equal(stopped.length, 1, 'the step after a failed one is not taken');
  assert.deepEqual([stopped[0].ok, stopped[0].selector], [false, '.gone']);
  assert.match(stopped[0].error, /failed: 3000ms exceeded/);
  const noOption = await capture.runLookSteps(stepPage({ options: [] }), [{ action: 'select', selector: '#size', value: '9' }]);
  assert.match(noOption[0].error, /no option with that value/);
});

test('PREVIEW_LOOK carries checked steps, runs them before reading, and reports each', async () => {
  const parsed = capture.parsePreviewLook({ PREVIEW_LOOK: JSON.stringify({ url: 'https://gym--s77.p.example/', steps: [{ action: 'click', selector: '.bread' }] }) });
  assert.deepEqual(parsed.steps, [{ action: 'click', selector: '.bread' }]);
  assert.equal('steps' in capture.parsePreviewLook({ PREVIEW_LOOK: JSON.stringify({ url: 'https://x/', steps: [{ action: 'goto' }] }) }), false);
  const out = collect();
  const { browser } = stubBrowser();
  const page = await browser.newPage();
  Object.assign(page, stepPage());
  const result = await capture.runPreviewLook({ ...parsed, viewport: { width: 390, height: 844 }, selector: '', screenshot: false }, { launch: async () => browser, delayMs: 0 });
  assert.deepEqual(result.steps, [{ action: 'click', selector: '.bread', ok: true }]);
  assert.deepEqual(look.readLook(out.join('')).facts.steps, [{ action: 'click', selector: '.bread', ok: true }]);
});
