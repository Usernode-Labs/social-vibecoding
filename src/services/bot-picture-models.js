'use strict';

// #6205: the image models Homeroom bot may draw its pictures with
// (services/bot-pictures.js), as a short list an admin curates.
//
// Every model is an OpenRouter model, asked on the bot's own key through the
// same path as before: the same content rules first in every prompt, the
// same guard() before anything is called, the same no-training provider
// settings on every request. Nobody else holds a key or names an endpoint:
// a person picks one of the listed models by its key ("best"), never an id.
//
// Each entry:
//   key      what a person (and make_pictures' `model`) calls it: "best";
//   id       its OpenRouter model id: "google/gemini-3-pro-image";
//   label    its name on the gallery card: "Gemini 3 Pro Image";
//   note     what it is good at, for the bot to say;
//   weight   how many of the weekly pictures (pictureWeeklyCap) one picture
//            of it counts as: a costlier model uses more of the week;
//   enabled  whether it is offered;
//   edit     whether it draws from a picture it is sent, which a dark
//            variant (drawn from its light one) and "More like" need;
//   aspects  the shapes it is offered in.
//
// The setting `imageModel` stays the default model, so a stored one keeps
// working: the entry with its id comes first and is always offered, and an
// id that is on no entry is offered as the default on its own.
//
// Pure: no database, no network.

const { MODEL_ID_RE } = require('./default-model');

// The shapes a picture comes in (bot-pictures.js ASPECTS), here by name so
// this module needs nothing from that one.
const ASPECT_KEYS = Object.freeze(['square', 'wide', 'tall']);
const DEFAULT_MODEL_ID = 'google/gemini-2.5-flash-image';
const MAX_MODELS = 8;
const MAX_WEIGHT = 20;
const MAX_LABEL = 40;
const MAX_NOTE = 120;
const KEY_RE = /^[a-z][a-z0-9-]{0,23}$/;

// Checked against OpenRouter's model catalog (GET /api/v1/models) on
// 3 Nov 2026: each is listed there with image input and image output.
// Weights follow their price per picture against today's default (about 4
// US cents): Gemini 3 Pro Image is about 13 to 24 cents, GPT-5 Image Mini a
// few cents at most.
const DEFAULT_IMAGE_MODELS = Object.freeze([
  Object.freeze({
    key: 'standard', id: DEFAULT_MODEL_ID, label: 'Gemini 2.5 Flash Image',
    note: 'Good everyday pictures, quick, and strong at changing a picture it is given',
    weight: 1, enabled: true, edit: true, aspects: ASPECT_KEYS,
  }),
  Object.freeze({
    key: 'best', id: 'google/gemini-3-pro-image', label: 'Gemini 3 Pro Image',
    note: 'The best quality: more detail, and much clearer words inside a picture',
    weight: 4, enabled: true, edit: true, aspects: ASPECT_KEYS,
  }),
  Object.freeze({
    key: 'inexpensive', id: 'openai/gpt-5-image-mini', label: 'GPT-5 Image Mini',
    note: 'Inexpensive, and good at diagrams and simple pictures',
    weight: 1, enabled: true, edit: true, aspects: ASPECT_KEYS,
  }),
]);

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Pure: one entry checked. Resolves { entry } or { error } naming what is
 * wrong with entry `n` (from 1), in words an admin can act on.
 */
function checkEntry(raw, n) {
  const at = `imageModels[${n}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${at} must be an object` };
  const key = String(raw.key ?? '').trim();
  if (!KEY_RE.test(key)) return { error: `${at}.key must be a short name in lowercase letters, digits and hyphens, such as best` };
  const id = String(raw.id ?? '').trim();
  if (!MODEL_ID_RE.test(id)) return { error: `${at}.id must be an OpenRouter model id such as ${DEFAULT_MODEL_ID}` };
  const label = clean(raw.label, MAX_LABEL + 1);
  if (!label || label.length > MAX_LABEL) return { error: `${at}.label must be 1 to ${MAX_LABEL} characters` };
  const note = clean(raw.note, MAX_NOTE + 1);
  if (note.length > MAX_NOTE) return { error: `${at}.note must be at most ${MAX_NOTE} characters` };
  const weight = raw.weight == null ? 1 : Number(raw.weight);
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) {
    return { error: `${at}.weight must be a whole number from 1 to ${MAX_WEIGHT}: how many weekly pictures one of its pictures counts as` };
  }
  for (const flag of ['enabled', 'edit']) {
    if (raw[flag] != null && typeof raw[flag] !== 'boolean') return { error: `${at}.${flag} must be true or false` };
  }
  let aspects = ASPECT_KEYS;
  if (raw.aspects != null) {
    if (!Array.isArray(raw.aspects) || !raw.aspects.length) return { error: `${at}.aspects must be a list of square, wide and tall` };
    const asked = [...new Set(raw.aspects.map((a) => String(a)))];
    if (asked.some((a) => !ASPECT_KEYS.includes(a))) return { error: `${at}.aspects must be a list of square, wide and tall` };
    aspects = ASPECT_KEYS.filter((a) => asked.includes(a));
  }
  return {
    entry: Object.freeze({
      key, id, label, note, weight, enabled: raw.enabled !== false, edit: raw.edit !== false, aspects: Object.freeze(aspects),
    }),
  };
}

/**
 * Pure: an admin's list, checked whole: { ok, stored } (the JSON the
 * setting keeps; '' for null, which is the built-in list) or { ok: false,
 * error }. Keys and ids are each used once, and at least one is offered.
 */
function validateImageModels(value) {
  if (value == null) return { ok: true, stored: '' };
  if (!Array.isArray(value) || !value.length || value.length > MAX_MODELS) {
    return { ok: false, error: `imageModels must be a list of 1 to ${MAX_MODELS} models, or null for the built-in list` };
  }
  const entries = [];
  for (const [i, raw] of value.entries()) {
    const checked = checkEntry(raw, i + 1);
    if (checked.error) return { ok: false, error: checked.error };
    if (entries.some((e) => e.key === checked.entry.key)) return { ok: false, error: `imageModels: the key "${checked.entry.key}" is used twice` };
    if (entries.some((e) => e.id === checked.entry.id)) return { ok: false, error: `imageModels: the model ${checked.entry.id} is listed twice` };
    entries.push(checked.entry);
  }
  if (!entries.some((e) => e.enabled)) return { ok: false, error: 'imageModels: at least one model must be enabled' };
  return { ok: true, stored: JSON.stringify(entries) };
}

/**
 * Pure: the stored list as the settings carry it, or null for the built-in
 * list (nothing stored, or nothing that reads). Lenient: an entry that does
 * not check is left out, never the whole list.
 */
function parseImageModels(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries = [];
  for (const [i, item] of parsed.slice(0, MAX_MODELS).entries()) {
    const checked = checkEntry(item, i + 1);
    if (checked.error) continue;
    if (entries.some((e) => e.key === checked.entry.key || e.id === checked.entry.id)) continue;
    entries.push(checked.entry);
  }
  return entries.length ? Object.freeze(entries) : null;
}

/** Pure: the whole list in force, offered or not: the admin's, else the built-in one. */
function allModels(settings) {
  const own = Array.isArray(settings?.imageModels) && settings.imageModels.length ? settings.imageModels : null;
  return own || DEFAULT_IMAGE_MODELS;
}

/**
 * Pure: the models a person may draw with now, the default first. The
 * default is `imageModel` (else the built-in default): its entry is always
 * offered, and an id on no entry is offered on its own, named by its id.
 */
function modelsOf(settings) {
  const defaultId = MODEL_ID_RE.test(String(settings?.imageModel || '')) ? String(settings.imageModel) : DEFAULT_MODEL_ID;
  const list = allModels(settings);
  const own = list.find((e) => e.id === defaultId);
  const first = own || Object.freeze({
    key: list.some((e) => e.key === 'standard') ? 'default' : 'standard',
    id: defaultId, label: clean(defaultId.split('/').pop(), MAX_LABEL), note: '',
    weight: 1, enabled: true, edit: true, aspects: ASPECT_KEYS,
  });
  const rest = list.filter((e) => e.enabled && e.id !== defaultId && e.key !== first.key);
  return Object.freeze([Object.freeze({ ...first, enabled: true, isDefault: true }), ...rest]);
}

/** Pure: the words that list the models a person may ask for, by key. */
function choicesText(models) {
  return models.map((m) => `${m.key} (${m.label})`).join(', ');
}

/**
 * Pure: the model `key` names, or the default with no key: { model } or {
 * error } in plain words. A key that is not offered is refused, never
 * passed through.
 */
function pickModel(settings, key = null) {
  const models = modelsOf(settings);
  if (key == null || key === '') return { model: models[0] };
  const want = String(key).trim().toLowerCase();
  const found = models.find((m) => m.key === want);
  if (found) return { model: found };
  return { error: `There is no picture model called "${clean(want, 24)}" here. The ones they can use are: ${choicesText(models)}.` };
}

/**
 * Pure: whether `model` can draw `ask` (bot-pictures.js normalizeAsk's):
 * null, or the words for why not.
 */
function cannotDraw(model, ask) {
  if (!model.aspects.includes(ask.aspect)) {
    return `${model.label} does not draw ${ask.aspect} pictures here. It draws ${model.aspects.join(', ')}.`;
  }
  if (!model.edit && (ask.like || (Array.isArray(ask.variants) && ask.variants.length > 1))) {
    return `${model.label} cannot draw from another picture, so it cannot make a dark version of a light one or more like a picture. Ask for one picture, or use another model.`;
  }
  return null;
}

/**
 * Pure: how many weekly pictures one picture of model `id` counts as, by the
 * list in force (an entry no longer offered keeps its weight; an id on no
 * entry counts as 1).
 */
function weightOfId(settings, id) {
  const found = allModels(settings).find((e) => e.id === id);
  return found ? found.weight : 1;
}

module.exports = {
  ASPECT_KEYS,
  DEFAULT_IMAGE_MODELS,
  DEFAULT_MODEL_ID,
  MAX_MODELS,
  MAX_WEIGHT,
  KEY_RE,
  validateImageModels,
  parseImageModels,
  allModels,
  modelsOf,
  choicesText,
  pickModel,
  cannotDraw,
  weightOfId,
};
