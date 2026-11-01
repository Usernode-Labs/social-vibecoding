'use strict';

// Threads, one loop (phase C1, 1 Nov 2026): a design in any private thread
// of the chat with Homeroom bot, without a database (the threads, the
// versions and Main Chat's hand-off run against PostgreSQL in
// design-threads-postgres.test.js).
//
// What this pins:
//   1. The design bot draws: write_screen (self-contained HTML for one
//      screen; the server puts the stylesheets in, an app's own from its
//      entry page on main, the model reading them as one empty block), the
//      project's code read with list_source/read_source, six rounds; its
//      prompt for a thread with no screen yet; the person's pictures as
//      pictures or in words.
//   2. Main Chat's turn has draw_screen in offer_design's place, and no
//      Pick the screen button.
//   3. A version said in a thread is drawn small with Open preview
//      (design-card.tsx), and Open preview opens the design pane as the bot
//      tab's own column: list | thread | preview from 1500px, halves below,
//      the whole screen on a phone (ai/preview.ts, ai/index.tsx, app.css).
//   4. A thread about a request is named by it ("#18 Dark mode"), in its
//      head and in the list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const designBot = require('../src/services/design-bot');

test('the design bot draws, reads the project\'s code and edits, in up to six rounds', () => {
  assert.deepEqual(designBot.TOOLS.slice(0, 5).map((t) => t.function.name), ['write_screen', 'edit_design', 'list_source', 'read_source', 'reply']);
  assert.equal(designBot.MAX_ROUNDS, 6);
  for (const t of designBot.TOOLS) {
    assert.equal(t.function.parameters.additionalProperties, false, t.function.name);
    assert.doesNotMatch(t.function.description, /—/);
  }
  const write = designBot.TOOLS[0].function.parameters;
  assert.deepEqual(write.required, ['title', 'size', 'html', 'note']);
  assert.deepEqual(write.properties.size.enum, ['phone', 'desktop']);
  assert.equal(designBot.TOOLS.find((t) => t.function.name === 'read_source').function.parameters.required.join(), 'path',
    'the design\'s own project unless it names another');
  assert.deepEqual(designBot.screenArgs({ title: '  Settings ', size: 'desktop', html: '<p>x</p>', note: '' }),
    { title: 'Settings', size: 'desktop', html: '<p>x</p>', note: 'Settings' });
  assert.equal(designBot.screenArgs({ title: 'X', size: 'tablet', html: '<p>x</p>' }).size, 'phone');
  assert.match(designBot.screenArgs({ title: 'X', html: ' ' }).error, /HTML/);
  assert.match(designBot.screenArgs({ title: '', html: '<p>x</p>' }).error, /Name the screen/);
});

test('the server supplies the stylesheets: what the entry page links, put in first, read by the model as one empty block', () => {
  const page = '<link rel="stylesheet" href="/scene.css?v=3"><link rel=stylesheet href=css/more.css><link rel="icon" href="/i.png">'
    + '<link rel="stylesheet" href="https://cdn.test/a.css"><link rel="stylesheet" href="//cdn.test/b.css"><link rel="stylesheet" href="/usernode-native/v1/native.css">';
  assert.deepEqual(designBot.linkedSheets(page), ['/scene.css?v=3', 'css/more.css', '/usernode-native/v1/native.css'], 'the project\'s own, never another site\'s');
  assert.equal(designBot.sheetPath('public/index.html', '/scene.css?v=3'), 'public/scene.css', 'an app\'s public/ is served at /');
  assert.equal(designBot.sheetPath('public/index.html', 'css/more.css'), 'public/css/more.css');
  assert.equal(designBot.sheetPath('index.html', './a/../b.css'), 'b.css');
  assert.equal(designBot.sheetPath('public/index.html', '../../etc/x.css'), null);
  assert.equal(designBot.sheetPath('public/index.html', '/app.js'), null, 'stylesheets only');

  const sheets = { links: ['/usernode-native/v1/native.css'], styles: [{ path: 'public/scene.css', css: '.a{color:red}</style><script>x()</script>' }] };
  const full = designBot.withSheets('<main class="a">Hi</main>', sheets);
  assert.equal(full, '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/usernode-native/v1/native.css">'
    + '<style data-design-sheet="public/scene.css">.a{color:red}<\\/style><script>x()</script></style></head><body><main class="a">Hi</main></body></html>',
  'first in the head, a sheet never closing its own block');
  const own = designBot.withSheets('<!doctype html><html><head><style>.mine{}</style></head><body>x</body></html>', sheets);
  assert.ok(own.indexOf('data-design-sheet') < own.indexOf('.mine'), 'the screen\'s own style comes after, and wins');
  const view = designBot.collapseSheets(full);
  assert.match(view, /<style data-design-sheet="public\/scene\.css"><\/style>/);
  assert.doesNotMatch(view, /color:red/);
  const edited = view.replace('Hi', 'Hello');
  assert.equal(designBot.fillSheets(edited, full), full.replace('Hi', 'Hello'), 'and the version keeps it');
});

test('what the stylesheets are, by what the design is of', async () => {
  assert.deepEqual(await designBot.sheetsFor(null, { surface: 'platform' }), { links: [...designBot.PLATFORM_SHEETS], styles: [] });
  assert.deepEqual(await designBot.sheetsFor(null, { surface: 'new' }), { links: [designBot.KIT_SHEET], styles: [] });
  const files = {
    'public/index.html': '<link rel="stylesheet" href="/scene.css"><link rel="stylesheet" href="/.env.css"><link rel="stylesheet" href="/usernode-native/v1/native.css">',
    'public/scene.css': '.scene{}',
  };
  const reads = [];
  const deps = {
    mayor: {
      SECRET_PATH_RE: /(^|\/)\.env/,
      async sourceRepo(_pool, { project }) { return project === 'garden' ? { app: { slug: 'garden' }, repo: { owner: 'o', repo: 'garden' } } : { error: 'no' }; },
    },
    github: { async getFileContent(_o, _r, p) { reads.push(p); return files[p] ?? null; } },
  };
  assert.deepEqual(await designBot.sheetsFor(null, { surface: 'app', app: { slug: 'garden' }, deps }),
    { links: ['/usernode-native/v1/native.css'], styles: [{ path: 'public/scene.css', css: '.scene{}' }] });
  assert.ok(!reads.includes('public/.env.css'), 'a secret path is never read');
  assert.deepEqual(await designBot.sheetsFor(null, { surface: 'app', app: { slug: 'locked' }, deps }), { links: [designBot.KIT_SHEET], styles: [] },
    'the kit, for a project whose code they cannot read');
});

test('the prompt: a thread with no screen yet is drawn; one with a version is edited, its stylesheets left out', () => {
  const none = designBot.designPrompt({ username: 'ada', surface: 'new', brief: 'A seed calendar' });
  assert.match(none, /This thread has no screen yet\. It is for a screen of a new project, not made yet\. Draw it with write_screen/);
  assert.match(none, /the native kit \(native\.css\)/);
  assert.match(none, /WHAT MAIN CHAT ASKED YOU TO DRAW\nA seed calendar/);
  assert.match(none, /THERE IS NO SCREEN YET: draw it with write_screen\.$/);
  assert.match(none, /Content rules: nothing sexual, violent,\n  or about weapons or gambling/, 'its content rules kept');
  assert.doesNotMatch(none, /—/);
  const design = { surface: 'app', app: { slug: 'garden', name: 'Garden club' }, title: 'Plots', width: 390, height: 844 };
  const some = designBot.designPrompt({ username: 'ada', design, version: 3, html: '<p>x</p>' });
  assert.match(some, /The design is a screen of the app Garden club, "Plots", drawn at 390 by 844 pixels\./);
  assert.match(some, /THE CURRENT VERSION \(version 3\), its whole HTML:\n<p>x<\/p>$/);
});

test('their pictures: as pictures for a model that reads them, else in the words a cheap one said', () => {
  const pictures = [{ id: 'p1', messageId: 7, filename: 'sketch.png', mimeType: 'image/png', data: 'AAAA' }];
  const history = [{ role: 'assistant', content: 'Hi' }, { role: 'user', content: 'like this' }];
  const seen = designBot.withPictures(history, [6, 7], pictures, { seen: true });
  assert.deepEqual(seen[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  assert.match(seen[1].content[0].text, /^like this\n\[Homeroom: they attached the picture sketch\.png, shown below\.\]$/);
  const told = designBot.withPictures(history, [6, 7], pictures, { described: new Map([['p1', 'A map with three pins.']]) });
  assert.equal(told[1].content, 'like this\n[Homeroom: they attached the picture sketch.png, which you cannot see. A model that reads pictures says it shows: A map with three pins.]');
  const blind = designBot.withPictures(history, [6, 7], pictures, {});
  assert.match(blind[1].content, /which you cannot see: your model reads text only\.\]$/);
  assert.equal(designBot.withPictures(history, [6, 7], []), history);
});

test('Main Chat draws a screen in place of the screen picker: draw_screen, no Pick the screen', () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const draw = mayor.TOOLS.find((t) => t.function.name === 'draw_screen');
  assert.ok(draw, 'draw_screen');
  assert.deepEqual(draw.function.parameters.required, ['what', 'title']);
  assert.equal(mayor.TOOLS.some((t) => t.function.name === 'offer_design'), false);
  assert.equal(mayor.PICK_SCREEN, undefined);
  const prompt = mayor.systemPrompt({ username: 'ada', thread: { draft: { kind: 'ask', changeKind: 'design', appSlug: null } } });
  assert.match(prompt, /When they want to see how a\n  screen could look, call draw_screen: it is drawn here, in this thread/);
  assert.match(prompt, /\(draw_screen\): your designer draws it from their words/);
  assert.doesNotMatch(prompt, /offer_design|Pick the screen/);
  const src = read('src/services/homeroom-bot-mayor.js');
  assert.match(src, /while \(rounds < limit && !ctx\.reply && !ctx\.drawScreen\) \{/, 'the turn ends with it');
  assert.match(src, /if \(ctx\.drawScreen\) \{\n\s+return \(deps\.designBot \|\| require\('\.\/design-bot'\)\)\.draw\(pool, config, \{/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /const design = await \(deps\.designThreads \|\| require\('\.\/design-threads'\)\)\.threadOf\(/,
    'a thread that holds a design is the design bot\'s');
  assert.doesNotMatch(read('src/services/design-threads.js'), /p\.kind = 'design'/, 'any private thread can hold one');
  assert.match(read('src/db/migrations/0004-design-anywhere.sql'), /CHECK \(surface IN \('platform', 'app', 'new'\)\)/);
});

test('the preview: its own column beside the thread, three where they fit, halves where not, the screen on a phone', () => {
  const preview = loadTsx('frontend/src/features/ai/preview.ts');
  assert.equal(preview.previewLayout({ phone: true, three: true }), 'full');
  assert.equal(preview.previewLayout({ phone: false, three: true }), 'three');
  assert.equal(preview.previewLayout({ phone: false, three: false }), 'halves');
  assert.equal(preview.THREE_COLUMNS, '(min-width: 1500px)');
  const ai = read('frontend/src/features/ai/index.tsx');
  assert.match(ai, /data-ai-preview=\{previewUp \? layout : undefined\}/);
  assert.match(ai, /<aside className="ai-preview-pane" data-ai-preview-pane=\{layout\} aria-label=\{t\('messages:design\.pane\.label'\)\}>\n\s+<DesignPane/);
  assert.match(ai, /onClose=\{closePreview\}\n\s+closeAs=\{layout === 'full' \? 'back' : 'close'\}/);
  assert.match(ai, /const previewUp = mounted && !!preview && !!botId && preview\.conversationId === botId && openRoot === preview\.rootId/,
    'only beside the thread it is the design of');
  assert.match(ai, /if \(preview && openRoot && openRoot !== preview\.rootId\) closePreview\(\);/, 'another thread in the column closes it');
  assert.match(ai, /const back = \(\) => \{ if \(window\.location\.hash === BOT_TAB\) closePreview\(\); \};/, 'the tab brings the list back');
  const css = read('public/css/app.css');
  assert.match(css, /#ai-screen\[data-ai-preview="three"\] \{\n\s+--ai-col-w: min\(var\(--ai-main-w\), 440px\);/);
  assert.match(css, /#ai-screen\[data-ai-preview="halves"\] \.ai-screen-body \{ display: none; \}/, 'the list steps aside');
  assert.match(css, /#ai-screen\[data-ai-preview="full"\] \.ai-preview-pane \{\n\s+position: absolute;\n\s+inset: 0;/);
});

test('the pane as the tab\'s column: × beside the thread, a back arrow where it is the whole screen, no Chat switch', () => {
  const api = new Proxy({}, { get: () => () => new Promise(() => {}) });
  const { DesignPane } = loadTsx('frontend/src/features/messages/design-pane.tsx', {
    stubs: { './api': api, './store': { loadReplyThread: () => Promise.resolve(), useMessagesSnapshot: () => ({ thread: null }) } },
  });
  const side = renderToHtml(createElement(DesignPane, { conversationId: 4, rootId: 9, view: 'preview', onView: () => {}, onClose: () => {} }));
  assert.match(side, new RegExp(`aria-label="${message('messages:design.pane.close')}"[^>]*data-design-close="close"`));
  assert.doesNotMatch(side, /messages-design-view-switch/);
  const phone = renderToHtml(createElement(DesignPane, { conversationId: 4, rootId: 9, view: 'preview', onView: () => {}, onClose: () => {}, closeAs: 'back' }));
  assert.ok(phone.indexOf('data-design-close="back"') < phone.indexOf(message('messages:design.pane.loading')), 'the arrow leads its head');
  const messages = renderToHtml(createElement(DesignPane, { conversationId: 4, rootId: 9, view: 'preview', onView: () => {} }));
  assert.doesNotMatch(messages, /data-design-close/);
  assert.match(messages, /messages-design-view-switch/);
});

test('a version said in a thread is drawn small, with Open preview; nothing is read in its first render', () => {
  const calls = [];
  const api = new Proxy({}, { get: (_t, name) => (...args) => { calls.push(name); return new Promise(() => {}); } });
  const opened = [];
  const card = loadTsx('frontend/src/features/messages/design-card.tsx', {
    stubs: { './api': api, '../ai/preview': { openPreview: (at) => opened.push(at) } },
  });
  assert.deepEqual(card.cardBox({ width: 390, height: 844 }), { width: 180, height: 260, scale: 180 / 390 });
  assert.deepEqual(card.cardBox({ width: 1280, height: 800 }), { width: 320, height: 200, scale: 0.25 });
  assert.equal(card.designVersionOf({ sender: { bot: true }, metadata: { homeroomBot: { designVersion: 2 } } }), 2);
  assert.equal(card.designVersionOf({ sender: { bot: false }, metadata: { homeroomBot: { designVersion: 2 } } }), null);
  const html = renderToHtml(createElement(card.DesignVersionCard, { conversationId: 4, rootId: 9, version: 2, title: 'Swap list' }));
  assert.deepEqual(calls, [], 'read in effects');
  assert.match(html, /^<div class="messages-design-card mt-2 flex w-fit max-w-full flex-col gap-2" data-design-card="2">/);
  assert.doesNotMatch(html, /<iframe/, 'the frame waits for the version');
  assert.match(html, new RegExp(`aria-label="${message('messages:design.card.openVersion', { version: 2 })}" data-design-card-picture=""`));
  assert.match(html, new RegExp(`<button type="button" data-design-card-open="" class="[^"]*">${message('messages:design.card.open')}</button>`));
  assert.equal(message('messages:design.card.open'), 'Open preview');
  assert.match(html, />Swap list · version 2</);
  const src = read('frontend/src/features/messages/design-card.tsx');
  assert.match(src, /sandbox=\{DESIGN_SANDBOX\}/, 'sandboxed as the pane\'s frame is');
  assert.match(src, /tabIndex=\{-1\}\n\s+aria-hidden="true"/, 'a picture, not something to use');
  assert.match(src, /const open = \(\) => openPreview\(\{ conversationId, rootId, version \}\);/);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const designVersion = inThread && message\.threadRootId && !message\.deleted \? designVersionOf\(message\) : null;/);
  assert.match(row, /<DesignVersionCard conversationId=\{conversationId\} rootId=\{message\.threadRootId\} version=\{designVersion\}/);
  // And the thread's head opens it at the newest, while it is not open.
  const index = read('frontend/src/features/messages/index.tsx');
  assert.match(index, /\{inMain && preview\?\.rootId !== rootId && isDesignThread\(root, replies\) \? \(/);
});

test('a thread about a request is named by it, in its head and in the list', () => {
  const bar = loadTsx('frontend/src/features/messages/private-thread-bar.tsx');
  const about = { sender: { id: 1, bot: true }, content: 'New thread about #18 Dark mode. Only you can see it.', metadata: { homeroomBot: { kind: 'opened_about', aboutKind: 'request', aboutNumber: 18, aboutTitle: 'Dark mode' } } };
  assert.equal(bar.privateThreadTitle(about, [], 5), '#18 Dark mode');
  assert.equal(bar.aboutThreadTitle('change', 406, 'Night mode'), 'Change #406 Night mode');
  assert.equal(bar.aboutThreadTitle('request', 7, null), 'Request #7');
  const drawn = { sender: { id: 1, bot: true }, content: 'I\'m drawing "Seed calendar" in a new thread.', metadata: { homeroomBot: { kind: 'opened_thread', designTitle: 'Seed calendar' } } };
  assert.equal(bar.privateThreadTitle(drawn, [], 5), 'Seed calendar', 'a thread the bot opened to draw, by its screen');
  assert.match(read('frontend/src/features/messages/api.ts'), /aboutKind: String\(pick\(bot, 'aboutKind'\)\) as 'request' \| 'change', aboutNumber:/, 'the client keeps what it is about');

  const { needsYou } = loadTsx('frontend/src/features/ai/model.ts');
  const app = { slug: 'garden', name: 'Garden club', icon_url: null, icon_emoji: null };
  const rows = needsYou([], { private: [{ rootId: 91, title: 'Dark mode', kind: 'ask', app, at: null, about: { kind: 'request', number: 18 } }], next: [], waiting: [], live: [] });
  assert.deepEqual([rows[0].title, rows[0].sub], ['Dark mode', { id: 'messages:ai.row.privateAbout', values: { project: 'Garden club', number: 18 } }],
    'its number before its title, as a request\'s row has it');
  assert.equal(message('messages:ai.row.privateAbout', { project: 'Garden club', number: 18 }), 'Only you · Garden club · About #18');

  const { shapePrivate } = require('../src/services/ai-work');
  const row = (extra) => shapePrivate({ root_id: 3, content: 'New thread about #18 Dark mode. Only you can see it.', kind: 'ask', created_at: null, ...extra });
  assert.deepEqual([row({ about_kind: 'request', about_number: 18, about_title: 'Dark mode' }).title, row({ about_kind: 'request', about_number: 18, about_title: 'Dark mode' }).about],
    ['Dark mode', { kind: 'request', number: 18 }]);
  assert.equal(row({ first_own: 'a seed calendar' }).title, 'a seed calendar');
  assert.equal(row({ kind: 'design', content: 'I opened a design thread for Plots…', design_title: 'Plots' }).title, 'Plots', 'a design by its screen');
});
