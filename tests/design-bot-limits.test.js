'use strict';

// #6358: a design turn draws a whole screen. The design profile raises the
// room a step gets and its clock, and a draw cut off at its limit is asked
// again with twice the design allowance. This runs the real
// homeroom-bot-mayor askModel with a fake transport, so what is pinned is the
// engine's own behaviour: the second request carries the larger allowance,
// both carry the design clock, and retryOutputTokens is never sent to a model.
//
// Run with: node --test tests/design-bot-limits.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mayor = require('../src/services/homeroom-bot-mayor');
const designBot = require('../src/services/design-bot');
const profiles = require('../src/services/bot-profiles');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function turn(chat) {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    config: {},
    user: { id: 1 },
    message: { id: 2 },
    route: 1,
    avoid: [],
    failures: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    startedMs: Date.now(),
    sleep: async () => {},
    chat,
  };
}

test('#6358: a cut-off design draw is asked again with the design retry allowance', async () => {
  const sent = [];
  const chat = async (request) => {
    sent.push(request);
    if (sent.length === 1) throw Object.assign(new Error('cut off at its output limit'), { code: 'output_limit' });
    return { content: 'The whole page is here.', toolCalls: [], usage: {}, provider: 'test' };
  };
  const res = await mayor.askModel(turn(chat), {
    messages: [{ role: 'user', content: 'Draw the recipe home page' }],
    tools: [],
    toolChoice: 'auto',
    where: 'd1',
    maxOutputTokens: designBot.DESIGN_OUTPUT_TOKENS,
    retryOutputTokens: profiles.DESIGN_LIMITS.retryOutputTokens,
    timeoutMs: profiles.DESIGN_LIMITS.requestTimeoutMs,
  });

  assert.equal(res.content, 'The whole page is here.');
  assert.equal(sent.length, 2, 'the cut-off draw is asked again once');
  assert.equal(sent[0].maxOutputTokens, 16_000, 'a design step writes about four times what it did');
  assert.equal(sent[0].timeoutMs, 180_000, 'and may take three minutes');
  assert.equal(sent[1].maxOutputTokens, 32_000, 'a cut-off draw gets twice the design allowance');
  assert.equal(sent[1].timeoutMs, 180_000, 'and keeps the design clock');
  for (const request of sent) assert.equal('retryOutputTokens' in request, false, 'never sent to the model');
});

test('#6358: the design turn passes its profile\'s allowance, retry and clock to askModel', async () => {
  assert.equal(designBot.DESIGN_OUTPUT_TOKENS, 16_000);
  assert.deepEqual([profiles.DESIGN_LIMITS.retryOutputTokens, profiles.DESIGN_LIMITS.requestTimeoutMs], [32_000, 180_000]);
  // Step 6: the chat's own turn asks with them while the design is loaded.
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /maxOutputTokens: room\.outputTokens, retryOutputTokens: room\.retryOutputTokens, timeoutMs: room\.requestTimeoutMs,/);
  // The picture-look request keeps its own short allowance.
  assert.match(read('src/services/design-bot.js'), /maxOutputTokens: Math\.min\(PICTURE_TOKENS \* pictures\.length \+ 200, DESIGN_OUTPUT_TOKENS\)/);
  // And a whole turn shows it: a design thread's request has the design's
  // room and clock; an ordinary thread's has the chat's.
  const asked = [];
  const rooms = (req) => { asked.push([req.maxOutputTokens, req.timeoutMs]); return { content: '', toolCalls: [callOf('reply', { text: 'Fine.' })] }; };
  const design = { latest: 1, rootId: 500, threadId: 7, state: 'open', surface: 'app', title: 'Recipes', width: 390, height: 844, app: { slug: 'recipebot', name: 'RecipeBot' }, versions: [] };
  await appTurn([rooms], { design, current: { version: 1, html: '<main>Recipes</main>' }, handoff: false }).run;
  await designChatTurn([rooms]).run;
  assert.deepEqual(asked, [[16_000, 180_000], [8_000, 90_000]]);
});

// ── #6681: the check and the look before a version is shown ──────────────

const { designChatTurn } = require('./lib/design-chat-turn');

const callOf = (name, args, id = `c${name}`) => ({ id, function: { name, arguments: JSON.stringify(args) } });

/**
 * A design turn on an app surface, with a scripted model and no database:
 * step 6, the chat's own turn, which starts the design (start_design) as the
 * chat's hand-off once did, unless `design`/`current` are a later turn's
 * thread.
 */
function appTurn(steps, { deps: extra = {}, design = null, current = null, handoff = true, pictures = [] } = {}) {
  const app = { id: 5, slug: 'recipebot', name: 'RecipeBot' };
  const entry = {
    found: { app: { id: 5, slug: 'recipebot' }, repo: { owner: 'o', repo: 'recipebot' } },
    path: 'public/index.html',
    html: '<html><head><link rel="stylesheet" href="__USERNODE_PLATFORM_ORIGIN__/usernode-native/v1/native.css">'
      + '<script src="__USERNODE_PLATFORM_ORIGIN__/usernode-tailwind/v1/tailwind.js"></script>'
      + '<script>tailwind.config = { theme: { extend: { colors: { paper: "#f7f1e6" } } } }</script>'
      + '</head><body><main class="paper">Recipes</main></body></html>',
  };
  const start = { calls: [callOf('start_design', { what: 'The recipes home screen', title: 'Recipes' })] };
  const turn = designChatTurn(handoff && !design ? [start, ...steps] : steps, {
    design, current, surface: 'app', config: { selfAppSlug: 'homeroom' },
    ask: 'Draw the recipes home screen',
    room: { rootId: 500, threadId: 7, conversationId: 41, kind: 'ask', app, about: null },
    // The pictures they sent, as the design reads them (picturesOf).
    answer: (text) => (pictures.length && /FROM conversation_message_attachments/.test(text) && /kind = 'image'/.test(text)
      ? { rows: pictures } : undefined),
    mayorOverrides: {
      async sourceRepo() { return entry.found; },
      async findApp() { return entry.found.app; },
      async canView() { return true; },
    },
    threads: {
      async ensureDesign() { return { threadId: 7, rootId: 500, title: 'Recipes', app }; },
      async addVersion(_pool, args) { turn.versionArgs.push(args); return { version: turn.versionArgs.length }; },
    },
    deps: {
      linkedCss: '',
      github: { async getFileContent(_o, _r, p) { return p === 'public/index.html' ? entry.html : null; } },
      designCapture: { async renderDesign() { return { ok: false, reason: 'no_render' }; } },
      ...extra,
    },
  });
  return { ...turn, versions: turn.versionArgs };
}

test('#6681: a version whose classes mostly match nothing, or whose icon has no size, is sent back once', async () => {
  const gaps = designBot.styleGaps(
    '<body><div class="a b c d e f g h i"></div><svg viewBox="0 0 24 24"></svg></body>', { linkedCss: '' });
  assert.equal(gaps.total, 9);
  assert.equal(gaps.unmatched.length, 9);
  assert.equal(gaps.unsizedSvgs, 1);
  assert.equal(designBot.styleFails(gaps), true, 'more than half match nothing, and an icon has no size');

  assert.equal(designBot.styleFails({ unmatched: ['a', 'b', 'c', 'd', 'e'], total: 8, unsizedSvgs: 0 }), true, 'more than half of 8');
  assert.equal(designBot.styleFails({ unmatched: ['a', 'b', 'c', 'd'], total: 8, unsizedSvgs: 0 }), false, 'exactly half is shown');
  assert.equal(designBot.styleFails({ unmatched: [], total: 3, unsizedSvgs: 0 }), false, 'too few classes to judge');
  assert.equal(designBot.styleFails({ unmatched: [], total: 3, unsizedSvgs: 1 }), true, 'an unsized icon always fails');
  // A class that matches a rule, an explicit size, or a rule naming an svg sizes it.
  assert.equal(designBot.styleGaps('<svg class="icon"></svg>', { linkedCss: '.icon{width:1rem}' }).unsizedSvgs, 0);
  assert.equal(designBot.styleGaps('<svg width="20" height="20"></svg>', { linkedCss: '' }).unsizedSvgs, 0);
  assert.equal(designBot.styleGaps('<svg style="width:20px"></svg>', { linkedCss: '' }).unsizedSvgs, 0);
  assert.equal(designBot.styleGaps('<svg></svg>', { linkedCss: 'svg{width:20px}' }).unsizedSvgs, 0, 'a rule for svg with a size counts');
  assert.equal(designBot.styleGaps('<svg></svg>', { linkedCss: 'img, svg{height:1em}' }).unsizedSvgs, 0,
    'so does one of a selector list, as preflight writes them');
  assert.equal(designBot.styleGaps('<svg></svg>', { linkedCss: '.messages-send svg{width:20px}' }).unsizedSvgs, 1,
    'a rule for an svg inside one component does not size this icon, and app.css has many');
  assert.equal(designBot.styleGaps('<svg></svg>', { linkedCss: 'img,svg{display:block}' }).unsizedSvgs, 1,
    'a rule that only displays svg does not size it (Tailwind preflight has one, and the arrow still stretched)');
});

test('#6681: the end of a turn is held only with a changed version and a round left', () => {
  assert.equal(designBot.canHold({ rounds: 1, limit: 12, changed: true }), true);
  assert.equal(designBot.canHold({ rounds: 11, limit: 12, changed: true }), false, 'the last round only replies');
  assert.equal(designBot.canHold({ rounds: 1, limit: 12, changed: false }), false, 'nothing changed');
});

test('#6681: a turn whose styling does not fit is held with a note once, then shown', async () => {
  const bad = '<main class="a b c d e f g h i"><svg viewBox="0 0 24 24"></svg></main>';
  const fixed = '<main class="bg-paper"><svg width="20" height="20" viewBox="0 0 24 24"></svg>Recipes</main>';
  const turn = appTurn([
    { calls: [callOf('write_screen', { title: 'Recipes', size: 'phone', html: bad, note: 'the home list' })] },
    { calls: [callOf('reply', { text: 'Here is the recipe list.' })] },
    { calls: [callOf('edit_design', { edits: [{ find: '<main class="a b c d e f g h i"><svg viewBox="0 0 24 24"></svg></main>', replace: fixed }], note: 'the app\'s own classes' })] },
    { calls: [callOf('reply', { text: 'Here is the recipe list.' })] },
  ]);
  await turn.run;

  const notes = turn.seen.flat().filter((m) => /Homeroom check, not from them/.test(typeof m.content === 'string' ? m.content : ''));
  assert.ok(notes.some((m) => /These classes match no rule/.test(m.content)), 'the unmatched classes go back');
  assert.ok(notes.some((m) => /icon in it has no size/.test(m.content)), 'and the unsized icon');
  const failures = turn.recorded.flatMap((r) => r.failures || []);
  assert.ok(failures.some((f) => /^d\d+:unstyled$/.test(f)), 'recorded as unstyled');
  assert.equal(turn.versions.length, 1, 'one version, the fixed one');
  assert.match(turn.versions[0].html, /class="bg-paper"/, 'the fixed markup is what is saved');
  assert.match(turn.versions[0].html, /data-design-sheet="tailwind"/, 'with its utilities compiled in');
  assert.match(turn.versions[0].html, /\.bg-paper\s*\{/, 'the app\'s own colour reaches the version');
});

test('#6681: the look is held once and skipped when no render can be made', async () => {
  const clean = '<main class="paper"><svg width="20" height="20" viewBox="0 0 24 24"></svg>Recipes</main>';
  const turn = appTurn([
    { calls: [callOf('write_screen', { title: 'Recipes', size: 'phone', html: clean, note: 'the home list' })] },
    { calls: [callOf('reply', { text: 'Here is the recipe list.' })] },
  ]);
  await turn.run;
  const failures = turn.recorded.flatMap((r) => r.failures || []);
  assert.ok(failures.includes('d3:look_skipped'), 'the failed render is recorded (its reply is the turn\'s third round, after start_design)');
  assert.equal(failures.filter((f) => /look_skipped$/.test(f)).length, 1, 'the look is tried once');
  assert.equal(turn.versions.length, 1, 'the version is shown without the look');
});

test('#6681: the look renders a first drawing at the size it was drawn for', async () => {
  const clean = '<main class="paper"><svg width="20" height="20" viewBox="0 0 24 24"></svg>Recipes</main>';
  const sizes = [];
  const turn = appTurn([
    { calls: [callOf('write_screen', { title: 'Recipes', size: 'desktop', html: clean, note: 'the home list' })] },
    { calls: [callOf('reply', { text: 'Here is the recipe list.' })] },
  ], {
    deps: {
      designCapture: {
        async renderDesign(_config, args) { sizes.push([args.width, args.height]); return { ok: false, reason: 'no_render' }; },
      },
    },
  });
  await turn.run;
  assert.deepEqual(sizes, [[1280, 800]], 'a desktop first drawing is looked at at 1280 by 800, not the phone default');
});

test('#6681: the markup an app\'s scripts build is pulled out, and its own file comes first', async () => {
  const js = 'const a = "<div class=\\"card\\">x</div>"; const b = \'<p>no class</p>\';'
    + ' const c = `<span class="tile">${name}</span>`; const d = "<div class=\\"card\\">x</div>";'
    + ' // "<div class=\\"commented\\"></div>"\n';
  assert.deepEqual(designBot.scriptMarkup(js), ['<div class="card">x</div>', '<span class="tile">'],
    'only literals with a class attribute, in order, deduplicated, never a comment');

  const reads = [];
  const entry = {
    found: { app: { slug: 'recipebot' }, repo: { owner: 'o', repo: 'recipebot' } },
    path: 'public/index.html',
    html: '<script src="/js/home.js"></script><script src="/js/recipe.js"></script>',
  };
  const deps = {
    mayor: { SECRET_PATH_RE: /(^|\/)\.env/ },
    github: {
      async getFileContent(_o, _r, p) {
        reads.push(p);
        return p === 'public/js/recipe.js' ? 'const r = "<div class=\\"recipe\\">Lemon pasta</div>";' : 'const h = "<div class=\\"row\\">Recipes</div>";';
      },
    },
  };
  const got = await designBot.entryScripts(null, { user: { id: 1 }, entry, words: 'show the recipe list', deps });
  assert.deepEqual(got.map((f) => f.path), ['public/js/recipe.js', 'public/js/home.js'],
    'the file whose name matches what they asked for comes first');
  assert.deepEqual(got[0].markup, ['<div class="recipe">Lemon pasta</div>']);

  // The prompt gives at most SCRIPT_MARKUP_CHARS of it.
  const huge = ['<div class="' + 'x'.repeat(30_000) + '"></div>'];
  const prompt = designBot.designPrompt({
    username: 'ada', surface: 'app',
    design: { surface: 'app', app: { slug: 'recipebot', name: 'RecipeBot' }, title: 'Recipes', width: 390, height: 844 },
    version: 1, html: '<p>x</p>',
    scripts: [{ path: 'public/js/home.js', size: 30_000, markup: huge }],
  });
  const at = prompt.indexOf('THE MARKUP ITS SCRIPTS BUILD');
  assert.ok(at > 0, 'the block is there');
  assert.ok(prompt.length - at < 26_000, 'capped to SCRIPT_MARKUP_CHARS, with a line after it');
  assert.match(prompt.slice(at), /…/);
});

test('#6681: a later turn compiles the classes its edit adds, not only the first drawing\'s', async () => {
  const first = '<main class="bg-paper p-2">Recipes</main>';
  const turn1 = appTurn([
    { calls: [callOf('write_screen', { title: 'Recipes', size: 'phone', html: first, note: 'the home list' })] },
    { calls: [callOf('reply', { text: 'Here is the recipe list.' })] },
  ]);
  await turn1.run;
  const saved = turn1.versions[0].html;
  assert.match(saved, /\.p-2\s*\{/, 'the first drawing carries its own utilities');
  assert.doesNotMatch(saved, /\.mt-6\s*\{/, 'and nothing it does not use yet');

  const design = {
    latest: 1, rootId: 500, threadId: 7, state: 'open', surface: 'app', title: 'Recipes', width: 390, height: 844,
    app: { id: 5, slug: 'recipebot', name: 'RecipeBot' }, versions: [],
  };
  const card = '<p class="mt-6 flex items-center gap-3 rounded-xl p-4 text-lg shadow">Lemon pasta</p>';
  const turn2 = appTurn([
    { calls: [callOf('edit_design', { edits: [{ find: 'Recipes</main>', replace: `Recipes</main>${card}` }] })] },
    { calls: [callOf('reply', { text: 'Added the recipe.' })] },
  ], { design, current: { version: 1, html: saved }, handoff: false });
  await turn2.run;
  assert.equal(turn2.versions.length, 1);
  const notes = turn2.seen.flat()
    .filter((m) => /Homeroom check, not from them/.test(typeof m.content === 'string' ? m.content : ''));
  assert.equal(notes.length, 0, 'the new classes are compiled before the check, so the version is not sent back');
  assert.match(turn2.versions[0].html, /\.mt-6\s*\{/, 'the class the edit added is compiled on the later turn too');
  assert.match(turn2.versions[0].html, /\.rounded-xl\s*\{/, 'and each of the others');
  assert.match(turn2.versions[0].html, /\.p-2\s*\{/, 'and the version it had still carries its own');
});

test('#6681: the look compares the version with the newest picture they sent', async () => {
  const clean = '<main class="bg-paper p-2"><svg width="20" height="20" viewBox="0 0 24 24"></svg>Recipes</main>';
  const turn = appTurn([
    { calls: [callOf('write_screen', { title: 'Recipes', size: 'phone', html: clean, note: 'the home list' })] },
    { calls: [callOf('reply', { text: 'Here is the recipe list.' })] },
  ], {
    pictures: [
      { id: 'pnew', message_id: 12, filename: 'later.png', content_type: 'image/png', data: Buffer.from('NEW') },
      { id: 'pold', message_id: 9, filename: 'earlier.png', content_type: 'image/png', data: Buffer.from('OLD') },
    ],
    deps: {
      seesImages: true,
      designCapture: { async renderDesign() { return { ok: true, png: Buffer.from('PNGDATA'), comparePng: null }; } },
    },
  });
  await turn.run;
  const note = turn.seen.flat().find((m) => Array.isArray(m.content)
    && m.content.some((part) => part.type === 'text' && /this is your version as the preview/.test(part.text)));
  assert.ok(note, 'the look\'s picture reaches a model that reads pictures');
  const urls = note.content.filter((part) => part.type === 'image_url').map((part) => part.image_url.url);
  assert.equal(urls.length, 2, 'the version and the screen as it is now');
  assert.ok(urls[1].endsWith(Buffer.from('NEW').toString('base64')), 'the newest picture is the comparison, not an older one');
});
