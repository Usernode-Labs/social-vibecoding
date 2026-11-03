'use strict';

// #6205: the picture models Homeroom bot may draw with
// (services/bot-picture-models.js): the built-in list, an admin's own list
// and its checks, choosing one by its key in make_pictures
// (homeroom-bot-thread-tools/pictures.js, services/bot-pictures.js
// normalizeAsk and generate), a costlier model counting as more of the
// weekly pictures, and the gallery card naming the model
// (frontend/src/features/messages/bot-cards/gallery.tsx). Pure: the
// database and the model are stubs.
//
// Run with: node --test tests/bot-picture-models.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const models = require('../src/services/bot-picture-models');
const pictures = require('../src/services/bot-pictures');
const tool = require('../src/services/homeroom-bot-thread-tools/pictures');
const bot = require('../src/services/homeroom-bot');
const connectorData = require('../src/services/bench/connector-data');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ID = (n) => String(n).repeat(32).slice(0, 32);

const OWN_LIST = [
  { key: 'standard', id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', weight: 1 },
  { key: 'best', id: 'google/gemini-3-pro-image', label: 'Gemini 3 Pro Image', weight: 5, edit: true },
  { key: 'sketch', id: 'vendor/sketch-image', label: 'Sketch', weight: 2, edit: false, aspects: ['square'] },
  { key: 'old', id: 'vendor/old-image', label: 'Old', weight: 3, enabled: false },
];

test('the built-in list: three OpenRouter models, the default first, a costlier one counting as more', () => {
  const offered = models.modelsOf({});
  assert.deepEqual(offered.map((m) => [m.key, m.id, m.weight]), [
    ['standard', 'google/gemini-2.5-flash-image', 1],
    ['best', 'google/gemini-3-pro-image', 4],
    ['inexpensive', 'openai/gpt-5-image-mini', 1],
  ]);
  assert.equal(offered[0].isDefault, true);
  assert.ok(offered.slice(1).every((m) => !m.isDefault));
  assert.ok(offered.every((m) => models.validateImageModels([m]).ok), 'the built-in entries pass the admin\'s checks');
  assert.equal(models.DEFAULT_MODEL_ID, pictures.DEFAULT_IMAGE_MODEL);
  assert.equal(models.DEFAULT_MODEL_ID, bot.DEFAULT_IMAGE_MODEL);
  // The stored default model stays the default.
  assert.deepEqual(models.modelsOf({ imageModel: 'openai/gpt-5-image-mini' }).map((m) => m.key), ['inexpensive', 'standard', 'best']);
  // A default on no entry is offered on its own, named by its id.
  const odd = models.modelsOf({ imageModel: 'vendor/new-image-1' });
  assert.deepEqual(odd.map((m) => m.key), ['default', 'standard', 'best', 'inexpensive']);
  assert.deepEqual([odd[0].id, odd[0].label, odd[0].weight], ['vendor/new-image-1', 'new-image-1', 1]);
  assert.equal(models.modelsOf({ imageModel: 'rm -rf' })[0].id, 'google/gemini-2.5-flash-image', 'a bad id is the built-in default');
});

test('an admin\'s own list: what is offered, what is not, and what a picture of each counts as', () => {
  const s = { imageModel: 'google/gemini-2.5-flash-image', imageModels: models.parseImageModels(JSON.stringify(OWN_LIST)) };
  assert.deepEqual(models.modelsOf(s).map((m) => m.key), ['standard', 'best', 'sketch'], 'a model switched off is not offered');
  assert.equal(models.weightOfId(s, 'google/gemini-3-pro-image'), 5);
  assert.equal(models.weightOfId(s, 'vendor/old-image'), 3, 'one switched off still counts what it drew');
  assert.equal(models.weightOfId(s, 'vendor/gone'), 1, 'one on no entry counts as 1');
  assert.equal(models.weightOfId({}, 'google/gemini-3-pro-image'), 4, 'the built-in list with no settings');
  // The default is always offered, even when its entry is switched off.
  const off = { imageModel: 'vendor/old-image', imageModels: s.imageModels };
  assert.deepEqual(models.modelsOf(off).map((m) => [m.key, m.enabled]),
    [['old', true], ['standard', true], ['best', true], ['sketch', true]]);
});

test('the admin\'s list is checked whole before it is kept', () => {
  assert.deepEqual(models.validateImageModels(null), { ok: true, stored: '' }, 'null is the built-in list');
  const good = models.validateImageModels(OWN_LIST);
  assert.equal(good.ok, true);
  const kept = JSON.parse(good.stored);
  assert.deepEqual(kept.map((m) => m.key), ['standard', 'best', 'sketch', 'old']);
  assert.deepEqual(kept[0], {
    key: 'standard', id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', note: '', weight: 1,
    enabled: true, edit: true, aspects: ['square', 'wide', 'tall'],
  }, 'what is left out takes its default');
  assert.deepEqual(kept[2].aspects, ['square']);
  assert.deepEqual(models.parseImageModels(good.stored).map((m) => m.key), ['standard', 'best', 'sketch', 'old']);
  const refused = (list) => models.validateImageModels(list).error;
  assert.match(refused([]), /^imageModels must be a list of 1 to 8 models/);
  assert.match(refused(Array.from({ length: 9 }, (_, i) => ({ key: `m${i}`, id: `v/m${i}`, label: 'M' }))), /1 to 8/);
  assert.match(refused([{ key: 'Best!', id: 'a/b', label: 'B' }]), /^imageModels\[1\]\.key must be a short name/);
  assert.match(refused([{ key: 'best', id: 'https://evil.test/v1', label: 'B' }]), /^imageModels\[1\]\.id must be an OpenRouter model id/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: '' }]), /label must be 1 to 40 characters/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'x'.repeat(41) }]), /label must be 1 to 40 characters/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'B', note: 'x'.repeat(121) }]), /note must be at most 120/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'B', weight: 0 }]), /weight must be a whole number from 1 to 20/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'B', weight: 21 }]), /weight must be a whole number from 1 to 20/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'B', weight: 1.5 }]), /weight must be a whole number/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'B', enabled: 'yes' }]), /enabled must be true or false/);
  assert.match(refused([{ key: 'best', id: 'a/b', label: 'B', aspects: ['round'] }]), /aspects must be a list of square, wide and tall/);
  assert.match(refused([{ key: 'a', id: 'a/b', label: 'A' }, { key: 'a', id: 'a/c', label: 'C' }]), /the key "a" is used twice/);
  assert.match(refused([{ key: 'a', id: 'a/b', label: 'A' }, { key: 'b', id: 'a/b', label: 'B' }]), /the model a\/b is listed twice/);
  assert.match(refused([{ key: 'a', id: 'a/b', label: 'A', enabled: false }]), /at least one model must be enabled/);
  // What is stored and no longer reads is the built-in list, or drops alone.
  assert.equal(models.parseImageModels('not json'), null);
  assert.equal(models.parseImageModels('{"key":"a"}'), null);
  assert.deepEqual(models.parseImageModels(JSON.stringify([{ key: 'bad key', id: 'a/b', label: 'A' }, OWN_LIST[1]])).map((m) => m.key), ['best']);
});

test('the bot settings keep the list: read, saved by an admin, and read back by a connector', () => {
  assert.equal(bot.parseSettings([]).imageModels, null);
  const s = bot.parseSettings([{ key: bot.KEY_IMAGE_MODELS, value: JSON.stringify(OWN_LIST) }]);
  assert.deepEqual(s.imageModels.map((m) => m.key), ['standard', 'best', 'sketch', 'old']);
  const saved = bot.validateSettingsPatch({ imageModels: OWN_LIST });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.updates.map(([key]) => key), [bot.KEY_IMAGE_MODELS]);
  assert.deepEqual(JSON.parse(saved.updates[0][1]).map((m) => m.key), ['standard', 'best', 'sketch', 'old']);
  assert.deepEqual(bot.validateSettingsPatch({ imageModels: null }).updates, [[bot.KEY_IMAGE_MODELS, '']]);
  assert.match(bot.validateSettingsPatch({ imageModels: [{ key: 'x', id: 'nope', label: 'X' }] }).error, /^imageModels\[1\]\.id/);
  assert.ok(connectorData.SETTINGS_FIELDS.includes('imageModels'));
  const mcp = read('src/services/mcp-tools.js');
  assert.match(mcp, /imageModels: z\.array\(z\.object\(\{/, 'set_homeroom_bot_settings takes it');
});

test('make_pictures takes a model by its key; one that is not offered is refused, never passed through', () => {
  const offered = models.modelsOf({});
  assert.equal(pictures.normalizeAsk({ prompt: 'A pear' }).model, null, 'the default');
  assert.equal(pictures.normalizeAsk({ prompt: 'A pear', model: 'BEST' }, { models: offered }).model, 'best');
  assert.match(pictures.normalizeAsk({ prompt: 'A pear', model: 'midjourney' }, { models: offered }).error,
    /^model is one of: standard \(Gemini 2\.5 Flash Image\), best \(Gemini 3 Pro Image\), inexpensive \(GPT-5 Image Mini\)\.$/);
  assert.match(pictures.normalizeAsk({ prompt: 'A pear', model: 'openai/gpt-5-image' }).error, /^model is the key of one of the picture models/,
    'a model id is not a key');
  assert.deepEqual(models.pickModel({}, null).model.key, 'standard');
  assert.deepEqual(models.pickModel({}, 'best').model.id, 'google/gemini-3-pro-image');
  assert.match(models.pickModel({}, 'flux').error, /^There is no picture model called "flux" here\. The ones they can use are: standard/);
  // What a model cannot draw.
  const s = { imageModels: models.parseImageModels(JSON.stringify(OWN_LIST)) };
  const sketch = models.pickModel(s, 'sketch').model;
  const ask = (args) => pictures.normalizeAsk({ prompt: 'A pear', ...args });
  assert.equal(models.cannotDraw(sketch, ask({})), null);
  assert.match(models.cannotDraw(sketch, ask({ aspect: 'wide' })), /^Sketch does not draw wide pictures here\. It draws square\./);
  assert.match(models.cannotDraw(sketch, ask({ variants: ['light', 'dark'] })), /cannot draw from another picture/);
  assert.match(models.cannotDraw(sketch, ask({ like: 'A' })), /cannot draw from another picture/);
  assert.equal(models.cannotDraw(models.pickModel(s, 'best').model, ask({ variants: ['light', 'dark'], aspect: 'tall' })), null);
});

test('a costlier model counts as more of the week, and says so when the week has too few left', async () => {
  const s = { imageModels: models.parseImageModels(JSON.stringify(OWN_LIST)) };
  const pool = { query: async (sql) => {
    assert.match(sql, /GROUP BY model/);
    return { rows: [{ model: 'google/gemini-2.5-flash-image', n: 3 }, { model: 'google/gemini-3-pro-image', n: 2 }, { model: 'vendor/old-image', n: 1 }] };
  } };
  assert.equal(await pictures.picturesThisWeek(pool, 5, s), 3 + 2 * 5 + 3);
  assert.equal(await pictures.picturesThisWeek(pool, 5), 3 + 2 * 4 + 1, 'the built-in weights with no settings');
  const best = models.pickModel(s, 'best').model;
  assert.equal(pictures.allowanceText({ ok: false, left: 3, why: 'too_many' }, best),
    'You have 3 pictures left this week, and each picture from Gemini 3 Pro Image counts as 5 of them: ask for fewer, or use another model. Nothing was made.');
  assert.equal(pictures.allowanceText({ ok: false, left: 1, why: 'too_many' }, models.pickModel(s, 'standard').model),
    'You have 1 picture left this week: ask for that many or fewer. Nothing was made.');
});

test('generate refuses a model not offered, and a week too short for a costlier one, before anything is called or charged', async () => {
  let called = 0;
  const deps = { fetch: async () => { called += 1; throw new Error('not called'); }, dm: { overWeeklyAllowance: async () => false } };
  const pool = { query: async () => ({ rows: [{ model: 'google/gemini-2.5-flash-image', n: 20 }] }) };
  const settings = { mode: 'shadow', pictureWeeklyCap: 24 };
  const unknown = await pictures.generate(pool, {}, {
    payerId: 5, ask: pictures.normalizeAsk({ prompt: 'A pear', model: 'flux' }), settings, deps,
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.error, /^There is no picture model called "flux" here\..*Nothing was made\.$/);
  const short = await pictures.generate(pool, {}, {
    payerId: 5, ask: pictures.normalizeAsk({ prompt: 'A pear', model: 'best', count: 2 }), settings, deps,
  });
  assert.equal(short.status, 429);
  assert.match(short.error, /^You have 4 pictures left this week, and each picture from Gemini 3 Pro Image counts as 4 of them/);
  const cannot = await pictures.generate(pool, {}, {
    payerId: 5,
    ask: pictures.normalizeAsk({ prompt: 'A pear', model: 'sketch', variants: ['light', 'dark'] }),
    settings: { ...settings, imageModels: models.parseImageModels(JSON.stringify(OWN_LIST)) }, deps,
  });
  assert.equal(cannot.status, 400);
  assert.match(cannot.error, /^Sketch cannot draw from another picture/);
  assert.equal(called, 0);
});

test('make_pictures offers the models by key with what each counts as, and the card names the one that drew them', async () => {
  const on = { user: { id: 5, username: 'ada' }, settings: { mode: 'shadow', pictureWeeklyCap: 24 }, conversationId: 3 };
  const [offered] = tool.tools(on);
  const param = offered.function.parameters.properties.model;
  assert.deepEqual(param.enum, ['standard', 'best', 'inexpensive']);
  assert.match(param.description, /best: Gemini 3 Pro Image\. The best quality.*\(each picture counts as 4 of their weekly pictures\)/);
  assert.equal(offered.function.parameters.additionalProperties, false);
  assert.equal(tool.TOOL.function.parameters.properties.model.enum, undefined, 'the shared tool is not changed');
  const lines = tool.promptLines(on).join('\n');
  assert.match(lines, /The picture models they can choose \(make_pictures model\), the default first:/);
  assert.match(lines, /- standard: Gemini 2\.5 Flash Image, the default/);
  assert.match(lines, /Never name a model that is not listed here/);
  assert.match(lines, /picturesLeftThisWeek of weeklyPictures/);
  // One model: no choice to describe.
  const one = { ...on, settings: { ...on.settings, imageModels: models.parseImageModels(JSON.stringify([OWN_LIST[0]])) } };
  assert.doesNotMatch(tool.promptLines(one).join('\n'), /picture models they can choose/);

  let asked = null;
  const botPictures = {
    ...pictures,
    generate: async (_p, _c, opts) => {
      asked = opts.ask;
      return {
        ok: true, ms: 10, left: 16, cap: 24, failed: 0, picked: { key: 'best', label: 'Gemini 3 Pro Image', weight: 4 },
        images: [{ id: ID('c'), letter: 'A', variant: null, width: 512, height: 512 }, { id: ID('d'), letter: 'B', variant: null, width: 512, height: 512 }],
      };
    },
  };
  const ctx = { ...on, deps: { pictures: { botPictures } } };
  const out = await tool.run(null, ctx, 'make_pictures', { prompt: 'A pear', count: 2, model: 'best' });
  assert.equal(asked.model, 'best');
  assert.deepEqual([out.model, out.countedAs, out.picturesLeftThisWeek, out.weeklyPictures], ['Gemini 3 Pro Image', 4, 16, 24]);
  assert.deepEqual(ctx.card.model, { key: 'best', label: 'Gemini 3 Pro Image' });
  asked = null;
  const refused = await tool.run(null, { ...on, deps: { pictures: { botPictures } } }, 'make_pictures', { prompt: 'A pear', model: 'dall-e' });
  assert.match(refused.error, /^model is one of: standard/);
  assert.equal(asked, null, 'nothing was asked for');
});

test('the gallery card carries the model\'s name, only when it is given', () => {
  const images = [{ id: ID('a'), letter: 'A', variant: null, width: 512, height: 512 }];
  const named = pictures.galleryCard({ prompt: 'p', images, model: { key: 'best', label: 'Gemini 3 Pro Image', weight: 4 } });
  assert.deepEqual(named.model, { key: 'best', label: 'Gemini 3 Pro Image' }, 'its name and key, nothing else');
  assert.equal('model' in pictures.galleryCard({ prompt: 'p', images }), false);
  assert.equal(pictures.galleryCard({ prompt: 'p', images, model: { key: 'Bad Key!', label: 'X' } }).model.key, undefined);
});

test('the gallery card names the model that drew the pictures, above the paid line', () => {
  const mod = loadTsx('frontend/src/features/messages/bot-cards/gallery.tsx', {
    stubs: { './index': { sayAsMe: async () => {}, decideCard: async () => ({}) } },
  });
  const card = {
    type: 'gallery', v: 1, prompt: 'A pear', model: { key: 'best', label: 'Gemini 3 Pro Image' },
    images: [{ id: ID('a'), letter: 'A', width: 512, height: 512 }],
  };
  assert.equal(mod.galleryOf(card).model, 'Gemini 3 Pro Image');
  assert.equal(mod.galleryOf({ ...card, model: { label: 7 } }).model, null);
  assert.equal(mod.galleryOf({ ...card, model: undefined }).model, null);
  const html = renderToHtml(createElement(mod.GalleryCard, { message: { id: 1 }, conversationId: 3, card }));
  const line = message('messages:botCards.gallery.drawnWith', { model: 'Gemini 3 Pro Image' });
  assert.equal(line, 'Drawn with Gemini 3 Pro Image.');
  assert.match(html, new RegExp(`data-bot-gallery-model="">${line.replace(/\./g, '\\.')}</p><p class="messages-bot-note" data-bot-gallery-paid=""`));
  const plain = renderToHtml(createElement(mod.GalleryCard, { message: { id: 1 }, conversationId: 3, card: { ...card, model: undefined } }));
  assert.doesNotMatch(plain, /data-bot-gallery-model/, 'an older card says nothing');
});

test('no em dashes in what this adds', () => {
  for (const file of ['src/services/bot-picture-models.js', 'tests/bot-picture-models.test.js']) {
    assert.doesNotMatch(read(file), /\u2014/, file);
  }
});
