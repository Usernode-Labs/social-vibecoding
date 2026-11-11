'use strict';

// Card stills, part 1 of "project cards show what using it is like": a
// project's card picture made from its REAL screen, at the card's own 16:10,
// that every card draws whole.
//
//   - the compositor (src/services/card-still.js): the screenshot's own
//     pixels in the panel, the card's colour around it, a light still and a
//     dark twin, under the card picture limit, PNG only;
//   - Homeroom bot's card-still mode (src/services/bot-pictures.js
//     makeCardStill, the chat's make_card_still): free without a scene, and
//     the screenshot NEVER sent to the image model, with or without one;
//   - the shape on the record (src/services/illustration-proposals.js): a
//     16:10 picture is a still however it arrives, and a still is never
//     framed;
//   - the cards (frontend/src/features/guest/guest-discover.tsx, the vote
//     card's preview in dev-card.tsx, the kit's PicCard, the editor's
//     preview): a still is drawn whole in light and dark; a square picture
//     and a card with no picture are drawn as before.
//
// Run with: node --test tests/card-still.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

const still = require('../src/services/card-still');
const pictures = require('../src/services/bot-pictures');
const proposals = require('../src/services/illustration-proposals');
const tool = require('../src/services/homeroom-bot-thread-tools/pictures');
const { renderComponent, renderToHtml, createElement, loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/**
 * A made-up "screenshot": every pixel a different colour from its x and y,
 * so a pixel on the still can be traced back to exactly one on the shot.
 */
function screenshot(width, height) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      png.data[o] = x % 256;
      png.data[o + 1] = y % 256;
      png.data[o + 2] = (x * 7 + y * 13) % 256;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const rgbAt = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

// ── The compositor ───────────────────────────────────────────────────────

test('a still is 16:10 and wide enough for a card at 2×; nothing else is', () => {
  assert.equal(still.isStillSize(1280, 800), true);
  assert.equal(still.isStillSize(1600, 1000), true);
  assert.equal(still.isStillSize(1280, 801), true, 'a pixel of rounding is still 16:10');
  assert.equal(still.isStillSize(1280, 780), false, 'a few percent off is not');
  assert.equal(still.isStillSize(1024, 1024), false, 'a square is the picture the card crops');
  assert.equal(still.isStillSize(1920, 1080), false, '16:9 is not the card\'s shape');
  assert.equal(still.isStillSize(608, 380), false, 'too small for 2×');
  assert.equal(still.isStillSize(NaN, 800), false);
});

test('the colour a still is laid on: the card colour picked, else a wash of the project\'s own, else grey', () => {
  assert.deepEqual(still.backdrop({ tone: 'yellow' }).light, [0xff, 0xf9, 0xde]);
  const own = still.backdrop({ color: '#e85d3a' });
  assert.ok(own.light.every((c) => c > 200), 'a pale wash in light');
  assert.ok(own.dark.every((c) => c < 80), 'a deep one in dark');
  assert.deepEqual(still.backdrop({}).light, [0xf4, 0xf3, 0xf1]);
  assert.deepEqual(still.backdrop({ tone: 'nope', color: 'red' }), still.backdrop({}));
  // Every tone the editor offers has its colour here.
  const { TONES } = require('../src/routes/app-illustrations');
  assert.deepEqual(Object.keys(still.TONE_HEX).sort(), [...TONES].sort());
  for (const tone of TONES) {
    assert.match(read('public/css/app.css'), new RegExp(`\\.home-tone-${tone} \\{ --tone-50: ${still.TONE_HEX[tone]};`));
  }
});

test('the part that matters: a focus inside the screenshot, never smaller than a sliver, the whole without one', () => {
  assert.deepEqual(still.focusBox(null, 1000, 600), { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(still.focusBox({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, 1000, 600), { x: 100, y: 120, width: 500, height: 300 });
  assert.deepEqual(still.focusBox({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 1000, 600), { x: 500, y: 300, width: 500, height: 300 }, 'pulled back inside');
  const tiny = still.focusBox({ x: 0, y: 0, width: 0.001, height: 0.001 }, 1000, 600);
  assert.ok(tiny.width >= 80 && tiny.height >= 48, 'never smaller than 8% of a side');
});

test('the screenshot is composited, not redrawn: the still\'s panel is its own pixels, on the card\'s colour', () => {
  // A shot exactly the panel's size is laid on at 1:1, so every pixel inside
  // the panel (clear of its rounded corners and hairline) is the shot's.
  const shot = screenshot(1050, 656);
  const pair = still.composePair({ screenshot: shot, tone: 'teal' });
  for (const side of ['light', 'dark']) {
    const made = pair[side];
    assert.equal(made.contentType, 'image/png');
    assert.equal(made.width, 1280);
    assert.equal(made.height, 800);
    assert.ok(made.data.length <= still.MAX_BYTES, `${side} fits a card picture`);
    assert.deepEqual(made.panel, { x: 115, y: 72, width: 1050, height: 656 });
    const img = PNG.sync.read(made.data);
    const src = PNG.sync.read(shot);
    for (const [px, py] of [[40, 40], [525, 328], [1000, 600], [300, 500], [900, 100]]) {
      assert.deepEqual(rgbAt(img, made.panel.x + px, made.panel.y + py), rgbAt(src, px, py), `${side} (${px}, ${py})`);
    }
    // Around it, the card's colour: teal in light, its deep twin in dark.
    const corner = rgbAt(img, 1270, 790);
    const ground = still.backdrop({ tone: 'teal' })[side];
    corner.forEach((c, i) => assert.ok(Math.abs(c - ground[i]) <= 3, `${side} ground ${corner} ~ ${ground}`));
  }
});

test('a dark screenshot of the same screen makes the dark twin; a focus zooms onto the part that matters', () => {
  const light = screenshot(1600, 1000);
  const dark = screenshot(1600, 1000);
  const pair = still.composePair({ screenshot: light, darkScreenshot: dark, focus: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
  // The 800×500 focus fills the panel's room at its own 16:10.
  assert.equal(pair.light.panel.width, 1050);
  assert.equal(pair.light.panel.height, 656);
  assert.deepEqual(pair.dark.panel, pair.light.panel);
  // A tall phone screenshot keeps its shape: nothing stretched, nothing cut.
  const phone = still.composePair({ screenshot: screenshot(390, 844) });
  assert.ok(Math.abs(phone.light.panel.width / phone.light.panel.height - 390 / 844) < 0.01);
  assert.ok(phone.light.panel.height <= 800 * still.LAYOUT.plain.height + 1);
});

test('a screenshot is a PNG of a screen: anything else is refused with a reason, and nothing is made', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  assert.throws(() => still.composePair({ screenshot: jpeg }), (err) => err.code === 'png_only' && /must be a PNG/.test(err.message));
  assert.throws(() => still.composePair({ screenshot: Buffer.alloc(0) }), (err) => err.code === 'empty');
  const huge = Buffer.from(screenshot(8, 8));
  huge.writeUInt32BE(9000, 16);
  assert.throws(() => still.decodePng(huge), (err) => err.code === 'too_big');
});

test('a pair is made off the platform\'s thread, and comes back the same', async () => {
  const shot = screenshot(400, 250);
  const inline = still.composePair({ screenshot: shot, tone: 'mint' });
  const worker = await still.composePairAsync({ screenshot: shot, tone: 'mint' });
  assert.ok(Buffer.isBuffer(worker.light.data));
  assert.ok(worker.light.data.equals(inline.light.data));
  assert.ok(worker.dark.data.equals(inline.dark.data));
  await assert.rejects(still.composePairAsync({ screenshot: Buffer.from('not a picture') }), (err) => err.code === 'png_only');
});

// ── Homeroom bot's card-still mode ───────────────────────────────────────

test('a still\'s scene is asked for in words alone: the moment of use, no screen and no words in it', () => {
  const prompt = pictures.promptFor({ prompt: 'hands on a kitchen counter', aspect: 'wide', variant: 'light', purpose: 'featured', still: true });
  assert.ok(prompt.startsWith(pictures.CONTENT_RULES), 'the content rules first, as always');
  assert.ok(prompt.includes(pictures.STILL_SCENE_LINE));
  assert.match(pictures.STILL_SCENE_LINE, /moment somebody uses the project/);
  assert.match(pictures.STILL_SCENE_LINE, /Draw no screen, no phone or laptop display, no interface, no buttons, and no words, letters or numbers/);
  assert.doesNotMatch(prompt, /one clear subject, centred/, 'not the object-on-a-card line');
  assert.match(prompt, /hands on a kitchen counter$/);
});

test('make_card_still\'s arguments are checked: a focus inside the shot, a known colour, a moment in words', () => {
  const tones = tool.STILL_TONES;
  assert.deepEqual(pictures.normalizeStillAsk({}, tones), { focus: null, moment: null, tone: null });
  assert.deepEqual(pictures.normalizeStillAsk({ focus: { x: 0, y: 0.1, width: 1, height: 0.5 }, tone: 'teal', moment: 'a desk by a window' }, tones),
    { focus: { x: 0, y: 0.1, width: 1, height: 0.5 }, moment: 'a desk by a window', tone: 'teal' });
  assert.match(pictures.normalizeStillAsk({ focus: { x: 0.8, y: 0, width: 0.5, height: 1 } }, tones).error, /inside the screenshot/);
  assert.match(pictures.normalizeStillAsk({ focus: [1, 2] }, tones).error, /focus is/);
  assert.match(pictures.normalizeStillAsk({ tone: 'neon' }, tones).error, /tone is one of/);
});

/** A database that keeps what the pictures' rows and the media store are told. */
function fakeStore() {
  const kept = { rows: [], images: [], objects: new Map() };
  const client = {
    async query(sql, params) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
      if (sql.includes('INSERT INTO homeroom_bot_pictures')) {
        kept.rows.push({ purpose: params[4], prompt: params[5], model: params[6], images: params[7] });
        return { rows: [{ id: kept.rows.length }] };
      }
      if (sql.includes('INSERT INTO media_objects')) return { rows: [] };
      if (sql.includes('INSERT INTO homeroom_bot_picture_images')) {
        kept.images.push({ id: params[0], letter: params[2], variant: params[3], width: params[5], height: params[6], key: params[8] });
        return { rows: [] };
      }
      if (sql.includes('FROM homeroom_bot_picture_images')) {
        const im = kept.images.find((i) => i.id === params[0]);
        return { rows: im ? [{ ...im, content_type: 'image/png', object_key: im.key }] : [] };
      }
      if (sql.includes('SUM(images)')) return { rows: [{ n: 0 }] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
    release() {},
  };
  const store = {
    async statObject(key) { return kept.objects.has(key) ? { size: kept.objects.get(key).length } : null; },
    async putObject(key, data) { kept.objects.set(key, data); },
    async getObjectStream(key) { return [kept.objects.get(key)]; },
  };
  return { pool: { ...client, connect: async () => client }, store, kept };
}

test('a still without a scene: composited, kept as a gallery\'s light and dark, and free', async () => {
  const { pool, store, kept } = fakeStore();
  let called = 0;
  const made = await pictures.makeCardStill(pool, {}, {
    payerId: 5, app: { id: 9, slug: 'pear', icon_color: '#2e6660' }, screenshot: screenshot(800, 500), conversationId: 3,
    deps: { store, fetch: async () => { called += 1; throw new Error('the model must not be asked'); } },
  });
  assert.equal(made.ok, true, made.error);
  assert.equal(called, 0, 'no model is asked without a scene');
  assert.equal(made.scene, false);
  assert.equal(made.costUsd, 0);
  assert.deepEqual(made.images.map((im) => [im.letter, im.variant, im.width, im.height]), [['A', 'light', 1280, 800], ['A', 'dark', 1280, 800]]);
  assert.equal(kept.rows.length, 1);
  assert.equal(kept.rows[0].images, 0, 'composites count nothing toward the weekly picture cap');
  assert.equal(kept.rows[0].purpose, 'featured');
  assert.equal(kept.rows[0].model, 'card-still');
});

test('a still with a scene: the model is asked for the scene in words, and never sent the screenshot', async () => {
  const { pool, store, kept } = fakeStore();
  const shot = screenshot(800, 500);
  const scene = screenshot(1344, 768);
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({
      id: 'gen', usage: { cost: 0.04 },
      choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${scene.toString('base64')}` } }] } }],
    }), { status: 200 });
  };
  const deps = {
    store, fetch: fetchImpl, apiKey: 'k', bot: { id: 1 },
    dm: { overWeeklyAllowance: async () => false, botAccount: async () => ({ id: 1 }) },
    limits: { checkBudget: async () => ({}), recordSpend: async () => {}, weekStartUtc: () => new Date(0) },
    managedKeys: { usesIncludedKey: async () => false },
  };
  const made = await pictures.makeCardStill(pool, { openrouterApiBase: 'https://or.example/api/v1' }, {
    payerId: 5, app: { id: 9, slug: 'pear' }, screenshot: shot, moment: 'hands on a kitchen counter',
    settings: { pictureWeeklyCap: 24 }, conversationId: 3, deps,
  });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.scene, true);
  assert.equal(bodies.length, 2, 'the scene, then its dark twin');
  const shotBase64 = shot.toString('base64');
  for (const body of bodies) {
    assert.ok(!body.includes(shotBase64.slice(0, 200)), 'the screenshot is never in a request');
    assert.ok(!body.includes(shotBase64.slice(-200)));
  }
  assert.equal(typeof JSON.parse(bodies[0]).messages[0].content, 'string', 'the scene: words only');
  assert.ok(bodies[0].includes('Draw no screen'));
  // Two rows: the scene, billed as two pictures; the still, as nothing.
  assert.deepEqual(kept.rows.map((r) => r.images), [2, 0]);
  assert.match(kept.rows[1].model, /^card-still on /);
});

test('make_card_still: offered in a conversation, reads only their own picture, leaves a gallery to propose from', async () => {
  const on = { user: { id: 5, username: 'ada' }, settings: { mode: 'shadow', pictureWeeklyCap: 24 }, conversationId: 3 };
  assert.deepEqual(tool.tools(on).map((t) => t.function.name), ['make_pictures', 'make_card_still']);
  assert.deepEqual(tool.tools({ ...on, settings: { mode: 'shadow', pictureWeeklyCap: 0 } }).map((t) => t.function.name), ['make_card_still'],
    'a still costs nothing, so a cap of 0 does not take it away');
  assert.deepEqual(tool.tools({ ...on, settings: { mode: 'off' } }), []);
  const params = tool.STILL_TOOL.function.parameters;
  assert.deepEqual(params.required, ['project', 'screenshot']);
  assert.equal(params.additionalProperties, false);
  for (const text of [tool.STILL_TOOL.function.description, ...Object.values(params.properties).map((p) => p.description || ''), ...tool.promptLines(on)]) {
    assert.doesNotMatch(text, /—/);
  }
  assert.match(tool.promptLines(on).join('\n'), /make_card_still/);
  assert.match(tool.promptLines(on).join('\n'), /demo content only, never a real person's messages or data/);

  const shot = screenshot(800, 500);
  const asked = [];
  const pool = {
    async query(sql, params) {
      asked.push(params);
      if (sql.includes('FROM conversation_message_attachments')) {
        return { rows: params[0] === 'a1' && params[1] === 3 && params[2] === 5 ? [{ content_type: 'image/png', data: shot }] : [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  const app = { id: 9, slug: 'pear', name: 'Pear', icon_color: '#2e6660', featured_illustration: { tint: 'mint' } };
  let opts = null;
  const ctx = {
    ...on,
    deps: {
      mayor: { findApp: async () => app, canView: async () => true },
      pictures: {
        appAdmins: { canManageApp: async () => true },
        botPictures: {
          ...pictures,
          makeCardStill: async (_p, _c, o) => {
            opts = o;
            return { ok: true, scene: false, costUsd: 0, left: null, images: [
              { id: 'c'.repeat(32), letter: 'A', variant: 'light', width: 1280, height: 800 },
              { id: 'd'.repeat(32), letter: 'A', variant: 'dark', width: 1280, height: 800 },
            ] };
          },
        },
      },
    },
  };
  const notTheirs = await tool.run(pool, ctx, 'make_card_still', { project: 'Pear', screenshot: 'zz' });
  assert.match(notTheirs.error, /not a picture they attached in this chat/);
  const out = await tool.run(pool, ctx, 'make_card_still', { project: 'Pear', screenshot: 'a1', focus: { x: 0, y: 0, width: 1, height: 0.6 } });
  assert.equal(out.ok, true, out.error);
  assert.ok(opts.screenshot.equals(shot));
  assert.deepEqual(opts.focus, { x: 0, y: 0, width: 1, height: 0.6 });
  assert.equal(opts.tone, 'mint', 'the colour its card already wears');
  assert.equal(opts.payerId, 5);
  assert.equal(ctx.card.type, 'gallery');
  assert.equal(ctx.card.purpose, 'featured');
  assert.equal(ctx.card.canFeature, true);
  assert.deepEqual(ctx.card.images.map((im) => im.label), ['A · light', 'A · dark']);
  assert.match(out.cost, /Nothing/);
});

// ── The shape on the record ──────────────────────────────────────────────

test('a 16:10 picture is a still whatever brought it; a still is never framed; a square carries no shape', () => {
  assert.equal(proposals.shapeOf(screenshot(1280, 800)), 'still');
  assert.equal(proposals.shapeOf(screenshot(640, 640)), null);
  assert.equal(proposals.shapeOf(Buffer.from('nope')), null);
  assert.deepEqual(proposals.withShape({ url: '/a', zoom: 1.4, x: 10, y: -4, tint: 'teal' }, 'still'),
    { url: '/a', zoom: 1, x: 0, y: 0, tint: 'teal', shape: 'still' });
  assert.deepEqual(proposals.withShape({ url: '/a', zoom: 1.4, x: 10, y: -4, shape: 'still' }, null), { url: '/a', zoom: 1.4, x: 10, y: -4 });
  assert.equal(proposals.recordShape({ shape: 'still' }), 'still');
  assert.equal(proposals.recordShape({ url: '/a' }), null);
  assert.equal(proposals.recordShape(null), null);
});

test('the public directory says which shape a card\'s picture is', () => {
  const src = read('src/services/public-app-directory.js');
  assert.match(src, /a\.featured_illustration->>'shape' AS illustration_shape/);
  assert.match(src, /illustration_shape: app\.illustration_id \? \(app\.illustration_shape === 'still' \? 'still' : 'square'\) : null/);
});

// ── The cards ────────────────────────────────────────────────────────────

const DISCOVER = 'frontend/src/features/guest/guest-discover.tsx';
const BASE = {
  slug: 'pear', name: 'Pear', description: 'Recipes from what is left.', active_users: 0, created_at: '2026-01-01T00:00:00.000Z',
  url: 'https://pear.example', requires_login: true, guest_ready: false,
};

test('a card with a still draws it whole at the card\'s size, in light and dark, with no zoom that would cut it', () => {
  const { Card } = loadTsx(DISCOVER);
  const html = renderToHtml(createElement(Card, {
    app: { ...BASE, illustration_url: '/app-illustrations/l', illustration_dark_url: '/app-illustrations/d', illustration_shape: 'still' },
    eager: false,
  }));
  assert.match(html, /data-guest-card-cover="" data-illustration-shape="still"[^>]*class="[^"]*aspect-\[16\/10\]/);
  const imgs = html.match(/<img[^>]*>/g) || [];
  assert.equal(imgs.length, 2);
  for (const img of imgs) {
    assert.match(img, /object-contain/);
    assert.doesNotMatch(img, /object-cover|scale-\[1\.04\]/);
  }
  assert.match(imgs[0], /src="\/app-illustrations\/l"[^>]*dark:hidden/);
  assert.match(imgs[1], /src="\/app-illustrations\/d"[^>]*hidden[^"]*dark:block/);
});

test('a card with a square picture is drawn as before, and a card with none shows its icon', () => {
  const { Card } = loadTsx(DISCOVER);
  const square = renderToHtml(createElement(Card, { app: { ...BASE, illustration_url: '/app-illustrations/l', illustration_shape: 'square' }, eager: false }));
  assert.match(square, /data-illustration-shape="square"/);
  const img = square.match(/<img[^>]*>/)[0];
  assert.match(img, /object-cover/);
  assert.match(img, /group-hover:scale-\[1\.04\]/);
  // A directory from before shapes (no field) reads as square too.
  const older = renderToHtml(createElement(Card, { app: { ...BASE, illustration_url: '/app-illustrations/l' }, eager: false }));
  assert.match(older, /data-illustration-shape="square"/);
  const none = renderToHtml(createElement(Card, { app: { ...BASE, icon_emoji: '🍐' }, eager: false }));
  assert.doesNotMatch(none, /data-illustration-shape/);
  assert.match(none, /🍐/);
});

test('the project page\'s band and Home\'s Featured row draw a still whole too', () => {
  const { GuestCover } = loadTsx(DISCOVER);
  const hero = renderToHtml(createElement(GuestCover, { app: { ...BASE, illustration_url: '/x', illustration_shape: 'still' }, hero: true }));
  assert.match(hero, /data-illustration-shape="still"/);
  assert.match(hero.match(/<img[^>]*>/)[0], /object-contain/);
  const kit = read('frontend/@/components/ui/kit.tsx');
  assert.match(kit, /<span className=\{k\('fcover', cover && still && 'still'\)\}>/);
  assert.match(read('public/css/app.css'), /html\[data-skin\] \.fr-fcover\.fr-still img\{object-fit:contain;object-position:center\}/);
  assert.match(read('frontend/src/features/home/frame/home-frame.tsx'), /still=\{a\.illustration_shape === 'still'\}/);
});

test('a card-picture vote shows both pictures at the card\'s 16:10: a still whole beside the square the card crops', () => {
  const { IllustrationPreviewRow } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx');
  const html = renderToHtml(createElement(IllustrationPreviewRow, { x: {
    t: 'illustration', key: 'k', remove: false,
    proposed: { url: '/illustrations/card-stills/sample.png', darkUrl: null, tint: 'yellow', shape: 'still' },
    current: { url: '/icons/v3/icon-192.png', darkUrl: null, tint: null },
  } }));
  const proposed = html.slice(html.indexOf('data-illustration-side="proposed"'));
  const current = html.slice(html.indexOf('data-illustration-side="current"'), html.indexOf('data-illustration-side="proposed"'));
  assert.match(proposed, /data-illustration-shape="still"[^>]*aspect-\[16\/10\]/);
  assert.match(proposed, /<img[^>]*object-contain/);
  assert.match(current, /data-illustration-shape="square"[^>]*aspect-\[16\/10\]/);
  assert.match(current, /<img[^>]*object-cover/);
  // The legacy card model carries the shape to it.
  assert.match(read('public/js/app-view.js'), /shape: rec\.shape === 'still' \? 'still' : null/);
  // The ?demo=1 vote proposes the shipped sample still, a real 16:10 picture.
  assert.match(read('src/routes/issues.js'), /proposed: \{ url: '\/illustrations\/card-stills\/sample\.png', darkUrl: null, zoom: 1, x: 0, y: 0, tint: 'yellow', shape: 'still' \}/);
  assert.equal(proposals.shapeOf(fs.readFileSync(path.join(ROOT, 'public/illustrations/card-stills/sample.png'))), 'still');
});

test('the editor previews a still whole and offers no framing for it', () => {
  const src = read('frontend/src/features/apps/featured-illustration-editor.tsx');
  assert.match(src, /const framable = interactive && !isStill\(art\);/);
  assert.match(src, /const still = isStillSize\(size\.width, size\.height\);/);
  assert.match(src, /isStill\(art\) \? null : <Button[^\n]*\{t\('discover:illustration\.resetPosition'\)\}/);
  assert.match(message('discover:illustration.stillNote'), /16:10 still/);
  const discover = read('frontend/src/features/home/panels/discover.tsx');
  assert.match(discover, /style=\{isStill\(tile\.illustration\) \? \{ height: 'auto', aspectRatio: '16 \/ 10' \} : undefined\}/);
  const shape = loadTsx('frontend/src/lib/illustration-shape.ts');
  assert.equal(shape.isStillSize(1280, 800), true);
  assert.equal(shape.isStillSize(1024, 1024), false);
  assert.equal(shape.STILL_TOLERANCE, 0.005);
  assert.match(read('src/services/card-still.js'), /const ASPECT_TOLERANCE = 0\.005;/);
  assert.equal(shape.isStill('still'), true);
  assert.equal(shape.isStill({ shape: 'still' }), true);
  assert.equal(shape.isStill({}), false);
});
