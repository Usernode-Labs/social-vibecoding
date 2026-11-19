'use strict';

// #6354: asked to show or change one of Homeroom's own pages, the bot copies
// it first (capture_page) and then edits that copy, so version 1 is the real
// page and version 2 is the change, in one answer. A thread that already has
// a version is never recaptured, and a page with no demo route answers with
// the fallback the prompt tells the bot to say. Step 6 (#6864): all of it in
// the chat's own turn, with the design capability (tests/lib/design-chat-turn.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const { designChatTurn, designSection, call } = require('./lib/design-chat-turn');

const HOMEROOM = { id: 3, slug: 'homeroom', name: 'Homeroom' };
const CONFIG = { port: 3000, selfAppSlug: 'homeroom' };
const START = { calls: [call('start_design', { what: 'The Homeroom bot page with a search box', title: 'Homeroom bot page' })] };

function captureTurn(steps, { design = null, current = null } = {}) {
  const designs = [];
  const captures = [];
  const turn = designChatTurn(design ? steps : [START, ...steps], {
    design, current, config: CONFIG,
    ask: 'Show me the Homeroom bot page with a search box',
    room: { rootId: 500, threadId: 7, conversationId: 41, kind: 'ask', app: HOMEROOM, about: null },
    mayorOverrides: {
      async findApp(_pool, name) { return String(name || '').toLowerCase() === HOMEROOM.slug ? HOMEROOM : null; },
      async canView() { return true; },
    },
    threads: {
      surfaceFor: (_config, app) => (app?.slug === 'homeroom' ? 'platform' : 'new'),
      async ensureDesign(_pool, _config, args) { designs.push(args); return { threadId: 7, rootId: 500, title: 'Homeroom bot page', app: HOMEROOM }; },
    },
    deps: {
      // The capture itself is design-capture.js's own suite; here it answers
      // the copy a page gives, so the turn's saving can be pinned.
      designCapture: {
        findPage(text) {
          const found = require('../src/services/design-capture').findPage(text);
          return found && found.key === 'homeroom-bot' ? found : null;
        },
        async capturePage(_config, _pool, { page, size }) {
          captures.push({ page: page.key, size });
          return {
            ok: true, html: '<html><body><div data-demo-rows>DEMO ROWS</div></body></html>',
            title: page.name, route: '/?demo=1#homeroom-bot', width: size === 'phone' ? 390 : 1280, height: 800,
          };
        },
        async renderDesign() { return { ok: false }; },
      },
    },
  });
  return { ...turn, designs, captures, versions: turn.versionArgs };
}

function toolResult(seen, id) {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const tool = [...seen[i]].reverse().find((m) => m.role === 'tool' && m.tool_call_id === id);
    if (tool) return JSON.parse(tool.content);
  }
  return null;
}

test('a capture then an edit saves version 1 as the copy and version 2 as the change', async () => {
  const turn = captureTurn([
    { calls: [call('capture_page', { page: 'Homeroom bot page', size: 'phone' })] },
    { calls: [call('edit_design', { edits: [{ find: 'DEMO ROWS', replace: 'DEMO ROWS <input placeholder="Search">' }] })] },
    { calls: [call('reply', { text: 'The search box sits over the list.', summary: 'a search box over the list' })] },
  ]);
  await turn.run;

  assert.deepEqual(turn.captures, [{ page: 'homeroom-bot', size: 'phone' }]);
  assert.equal(turn.versions.length, 2);
  assert.equal(turn.versions[0].author, 'capture');
  assert.equal(turn.versions[0].note, 'As it is now');
  assert.match(turn.versions[0].html, /DEMO ROWS/);
  assert.equal(turn.versions[1].author, 'bot');
  assert.equal(turn.versions[1].note, 'a search box over the list', 'the reply\'s one summary');
  assert.match(turn.versions[1].html, /placeholder="Search"/);

  const design = turn.designs[0];
  assert.equal(design.surface, 'platform', 'a captured Homeroom page is Homeroom\'s own');
  assert.equal(design.route, '/?demo=1#homeroom-bot');

  assert.equal(turn.sent.length, 1);
  assert.equal(turn.sent[0].content,
    'The search box sits over the list.\n\nVersion 1: As it is now.\n\nVersion 2: a search box over the list.');
  assert.equal(turn.sent[0].metadata.designVersion, 2);
  const captured = toolResult(turn.seen, 'ccapture_page');
  assert.deepEqual([captured.ok, captured.version], [true, 1]);
  assert.match(captured.next, /saved as version 2/, 'the edit is version 2, and it is told so');
  assert.ok(turn.doings.some((d) => d?.kind === 'capturing' && d.page === 'Homeroom bot page'));
  assert.ok(turn.doings.some((d) => d?.kind === 'drawing' && d.version === 2), '"Drawing version 2" for the edit of the copy');
});

test('a thread that already has a version is not captured again', async () => {
  const turn = captureTurn([
    { calls: [call('capture_page', { page: 'Homeroom bot page' })] },
    { calls: [call('reply', { text: 'This design already has a version.' })] },
  ], {
    design: { latest: 1, state: 'open', threadId: 7, rootId: 500, surface: 'platform', title: 'Homeroom bot page', app: HOMEROOM, versions: [] },
    current: { version: 1, html: '<html><body>old</body></html>' },
  });
  await turn.run;
  assert.deepEqual(turn.captures, []);
  assert.match(toolResult(turn.seen, 'ccapture_page').error, /already has a version/);
  assert.equal(turn.versions.length, 0, 'nothing is saved');
});

test('a page with no demo route answers with the fallback, and the prompt says to say so', async () => {
  const turn = captureTurn([
    { calls: [call('capture_page', { page: 'Admin console' })] },
    { calls: [call('reply', { text: 'There is no live version of that page to copy, so I drew it from the code.' })] },
  ]);
  await turn.run;
  assert.deepEqual(turn.captures, []);
  assert.match(toolResult(turn.seen, 'ccapture_page').error, /No live version of that page/);
  assert.match(designSection(turn.seen[1]), /no live version of that page/);
});
test('the prompt lists the pages it can copy, and the working card names the page', () => {
  const prompt = designBot.designPrompt({ username: 'evan', homeroom: true });
  for (const name of ['Homeroom bot page', 'Messages', 'Communities', 'Workshop', 'project page', 'request page']) {
    assert.ok(prompt.includes(name), `the prompt lists ${name}`);
  }
  // 14 Nov 2026: Main Chat is gone, so it is no page to copy.
  assert.ok(!prompt.includes('Main Chat'));
  assert.match(prompt, /capture_page first/);
  assert.deepEqual(mayor.doingFor('capture_page', { page: 'Homeroom bot page' }), { kind: 'capturing', page: 'Homeroom bot page' });
  assert.deepEqual(mayor.doingFor('capture_page', {}), { kind: 'capturing' });
});

// ── #6681: a version rendered, and the bot looking at it ─────────────────

const capture = require('../capture/capture');
const designCapture = require('../src/services/design-capture');
const designThreads = require('../src/services/design-threads');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('#6681: DESIGN_RENDER renders with JavaScript off and every request aborted', async () => {
  const out = [];
  capture.setFrameSink((line) => out.push(line));
  try {
    const seen = { js: null, intercept: null, viewport: null, content: null, aborted: 0 };
    const page = {
      async setJavaScriptEnabled(value) { seen.js = value; },
      async setRequestInterception(value) { seen.intercept = value; },
      on(event, fn) { if (event === 'request') seen.request = fn; },
      async setViewport(viewport) { seen.viewport = viewport; },
      async setContent(html) { seen.content = html; },
      async screenshot() { return Buffer.from('png-main'); },
      async close() {},
    };
    const browser = { async newPage() { return page; }, async close() {} };
    const spec = capture.parseDesignRender({
      DESIGN_RENDER: JSON.stringify({
        html: b64('<p>the version</p>'),
        viewport: { width: 390, height: 900 },
        compare: b64('<p>as it is now</p>'),
      }),
    });
    assert.ok(spec, 'the spec parses');
    await capture.runDesignRender(spec, { launch: async () => browser });

    assert.equal(seen.js, false, 'JavaScript is off');
    assert.equal(seen.intercept, true, 'requests are intercepted');
    const aborted = [];
    seen.request({ abort: async () => { aborted.push('abort'); } });
    assert.deepEqual(aborted, ['abort'], 'every request is aborted');
    assert.deepEqual(seen.viewport, { width: 390, height: 900, deviceScaleFactor: 1 });
    assert.equal(seen.content, '<p>as it is now</p>', 'the last document rendered is the comparison');
    const frames = designCapture.readRenderFrames(out.join(''));
    assert.equal(frames.length, 2, 'one picture per image');
    assert.deepEqual(frames.map((f) => f.toString()), ['png-main', 'png-main']);

    // A render that never starts fails without throwing.
    assert.equal(capture.parseDesignRender({ DESIGN_RENDER: JSON.stringify({ html: '' }) }), null);
    assert.equal(capture.parseDesignRender({}), null);
  } finally {
    capture.setFrameSink(null);
  }
});

test('#6681: a design render inlines the kit, drops scripts, and refuses a document too big', async () => {
  const inlined = designCapture.inlineSheets(
    '<html><head><link rel="stylesheet" href="/usernode-native/v1/native.css"><link rel="stylesheet" href="/css/app.css">'
    + '<script src="/app.js"></script></head><body><main class="x">Hi</main></body></html>');
  assert.doesNotMatch(inlined, /<script/i, 'scripts are dropped, as the plan drops them');
  assert.match(inlined, /<style>/, 'the kit is inlined');
  assert.match(inlined, /--un-/, 'and it is the kit\'s own CSS');
  assert.match(inlined, /class="x"/, 'the markup stays');

  const job = async ({ env }) => {
    const spec = JSON.parse(env.DESIGN_RENDER);
    assert.ok(spec.html, 'the document is sent base64');
    assert.equal(spec.viewport.width, 390);
    return `${'__USERNODE_RENDER__ bytes=8\n'}${b64('png!')}\n__USERNODE_RENDER_END__\n`;
  };
  const done = await designCapture.renderDesign({}, { html: '<p>x</p>', width: 390, height: 844, deps: { runJob: job } });
  assert.equal(done.ok, true);
  assert.equal(done.png.toString(), 'png!');

  const tooBig = await designCapture.renderDesign({}, { html: 'x'.repeat(designCapture.RENDER_MAX_CHARS + 1), width: 390, height: 844 });
  assert.deepEqual(tooBig, { ok: false, reason: 'too_big' }, 'too big is not sent to the job');

  assert.match(designCapture.readRenderFailure('__USERNODE_RENDER_FAIL__ reason=no_render'), /no_render/);
  assert.deepEqual(designCapture.readRenderFrames('nothing'), []);
});

/** A design turn whose render succeeds, so the look can be pinned (step 6: the chat's own turn). */
function lookTurn({ seesImages = true, compare = null } = {}) {
  const seen = [];
  const steps = [
    ...(compare ? [] : [{ calls: [call('start_design', { what: 'The recipes home screen', title: 'Recipes' })] }]),
    { calls: [{ id: 'cwrite_screen', function: { name: 'write_screen', arguments: JSON.stringify({
      title: 'Recipes', size: 'phone', html: '<main class="bg-paper"><svg width="20" height="20"></svg>Recipes</main>',
    }) } }] },
    { calls: [{ id: 'creply', function: { name: 'reply', arguments: JSON.stringify({ text: 'Here is the recipe list.', summary: 'The home list' }) } }] },
  ];
  let i = 0;
  const chat = async (req) => {
    seen.push(structuredClone(req));
    // The cheap model's description of the pictures, when it is asked.
    if (req.tools?.some((t) => t.function?.name === 'describe_pictures')) {
      return { content: '', toolCalls: [{ id: 'cd', function: { name: 'describe_pictures', arguments: JSON.stringify({
        pictures: ['a recipe list with a small tile beside each title'],
      }) } }] };
    }
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return { content: step.content || '', toolCalls: step.calls };
  };
  const app = { id: 5, slug: 'recipebot', name: 'RecipeBot' };
  const entry = {
    found: { app, repo: { owner: 'o', repo: 'recipebot' } },
    path: 'public/index.html',
    html: '<html><head><script src="__USERNODE_PLATFORM_ORIGIN__/usernode-tailwind/v1/tailwind.js"></script>'
      + '<script>tailwind.config = { theme: { extend: { colors: { paper: "#f7f1e6" } } } }</script></head>'
      + '<body><main class="bg-paper">Recipes</main></body></html>',
  };
  const design = compare
    ? { threadId: 7, rootId: 500, state: 'open', title: 'Recipes', surface: 'app', app: { slug: 'recipebot', name: 'RecipeBot' },
      width: 390, height: 844, latest: 2, versions: [{ version: 1, author: 'capture' }, { version: 2, author: 'bot' }] }
    : null;
  const current = compare ? { version: 2, html: '<main class="bg-paper">Old</main>' } : null;
  const turn = designChatTurn(steps, {
    design, current, seesImages, config: { selfAppSlug: 'homeroom' }, surface: 'app',
    ask: 'Draw the recipes home screen',
    room: { rootId: 500, threadId: 7, conversationId: 41, kind: 'ask', app, about: null },
    mayorOverrides: {
      async sourceRepo() { return entry.found; },
      async findApp() { return app; }, async canView() { return true; },
      async modelSeesImages() { return seesImages; },
    },
    threads: {
      async versionOf(_pool, { version }) { return version === 1 ? { version: 1, html: '<main class="bg-paper">As it is now</main>' } : current; },
      async ensureDesign() { return { threadId: 7, rootId: 500, title: 'Recipes', app }; },
    },
    deps: {
      chat, linkedCss: '', pictureModelSeesImages: true,
      github: { async getFileContent(_o, _r, p) { return p === 'public/index.html' ? entry.html : null; } },
      designCapture: {
        async renderDesign(_config, { compare: html }) {
          return { ok: true, png: Buffer.from('png-main'), comparePng: html ? Buffer.from('png-now') : null };
        },
      },
    },
  });
  return { ...turn, seen };
}

test('#6681: the bot is given its own render, and the screen as it is now beside it', async () => {
  const turn = lookTurn({ seesImages: true, compare: true });
  await turn.run;
  const look = turn.seen.flatMap((r) => r.messages).find((m) => Array.isArray(m.content)
    && m.content.some((part) => part.type === 'text' && /this is your version as the preview/.test(part.text)));
  assert.ok(look, 'the look message is sent');
  assert.match(look.content[0].text, /Compare it with the screen as it is now, shown second/);
  const images = look.content.filter((part) => part.type === 'image_url');
  assert.equal(images.length, 2, 'the version and the comparison as pictures');
  assert.match(images[0].image_url.url, /^data:image\/png;base64,/);
  assert.ok(turn.recorded.flatMap((r) => r.failures || []).some((f) => /looked$/.test(f)), 'recorded as looked');
  assert.equal(turn.versions.length, 1, 'the version is still saved once');
});

test('#6681: a model that reads text gets the render in words', async () => {
  const turn = lookTurn({ seesImages: false });
  await turn.run;
  const text = turn.seen.flatMap((r) => r.messages)
    .filter((m) => typeof m.content === 'string' && /this is your version as the preview/.test(m.content));
  assert.ok(text.length, 'the look is sent');
  assert.match(text[text.length - 1].content, /a model that reads pictures says it shows: a recipe list/);
  assert.doesNotMatch(text[text.length - 1].content, /Compare it with the screen/);
});
