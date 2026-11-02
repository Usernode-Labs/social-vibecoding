'use strict';

// The words of a phone push, as the code asks for them: `t('push:area.element',
// values)`. The English is frontend/locales/en/push.json, like the rest of
// Homeroom's text (frontend/locales/README.md); mobile-push-policy.js builds
// its copy with one of these functions. english() needs no database and is the
// default, and push-language.js makes the one for a recipient's language.
//
// The runtime image carries no frontend/, so there the English is the running
// build's, in public/locales/.source.json. A checkout reads its own file, which
// is never older than the code beside it.

const packs = require('../../scripts/language-packs');
const languageCache = require('./language-cache');

const NAMESPACE = 'push';
const PREFIX = `${NAMESPACE}:`;
const SOURCE_FILE = `en/${NAMESPACE}.json`;
const ENGLISH_RULES = new Intl.PluralRules('en');
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function textsOf(entries) {
  if (!entries || typeof entries !== 'object') return null;
  return Object.fromEntries(Object.entries(entries)
    .filter(([, entry]) => typeof entry?.text === 'string')
    .map(([key, entry]) => [key, entry.text]));
}

let checkoutTexts;
function readCheckout() {
  if (checkoutTexts === undefined) {
    checkoutTexts = textsOf(packs.readCheckoutEnglish(NAMESPACE));
  }
  return checkoutTexts;
}

/**
 * The English of this namespace, by key: a given build's when `source` is
 * passed and has it, otherwise this checkout's, otherwise the running build's.
 * Empty when none can be read, and a push then says its generic words.
 */
function englishTexts(source) {
  const given = textsOf(source?.files?.[SOURCE_FILE]);
  if (given) return given;
  return readCheckout() || textsOf(languageCache.readSource()?.files?.[SOURCE_FILE]) || {};
}

/**
 * Parameters go in once, in one pass: what a name or a message holds is never
 * read as a parameter or a replacement pattern, whatever it looks like.
 */
function fill(text, values) {
  return text.replace(/{{\s*(\w+)\s*}}/g, (_, name) => (
    values && has(values, name) ? String(values[name]) : ''
  ));
}

/** The text of a message in `messages`, in the form its count takes, or undefined. */
function pick(messages, key, values, rules) {
  if (typeof values?.count === 'number') {
    const form = `${key}_${rules.select(values.count)}`;
    if (has(messages, form)) return messages[form];
  }
  return has(messages, key) ? messages[key] : undefined;
}

/** What the code asks with: `t(id, values)` in English. '' for an id the catalog does not have. */
function englishFrom(texts) {
  return (id, values) => {
    const text = pick(texts, id.slice(PREFIX.length), values, ENGLISH_RULES);
    return text === undefined ? '' : fill(text, values);
  };
}

function english(id, values) {
  return englishFrom(englishTexts())(id, values);
}

/** `t(id, values)` in `language` from its usable `messages` (key -> text), English for the rest. */
function translatorFrom(language, messages, texts) {
  const rules = new Intl.PluralRules(language);
  const inEnglish = englishFrom(texts);
  return (id, values) => {
    const text = pick(messages, id.slice(PREFIX.length), values, rules);
    return text === undefined ? inEnglish(id, values) : fill(text, values);
  };
}

module.exports = { NAMESPACE, english, englishTexts, translatorFrom };
