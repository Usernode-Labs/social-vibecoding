'use strict';

// A phone push in its recipient's language.
//
// The translations are the language step's own (frontend/locales/README.md,
// "Translations"), and what wins is the same, message by message: a committed
// catalog entry still usable for the running English, then the cache's
// translation of exactly that English, then English. A counted message is used
// with every form its language needs, or not at all.
//
// Copy is built synchronously and is display-only, so the worker asks for a
// translator before it builds, and nothing here throws: a problem costs a push
// its translation, never its delivery. Nobody without a language, or in
// English, reads anything. Everyone else in a language shares one read of the
// cache per VERSION_TTL_MS, the same patience as the shell's packs.

const log = require('./logger');
const packs = require('../../scripts/language-packs');
const languageCache = require('./language-cache');
const { languageFor } = require('./admin-text-translations');
const { NAMESPACE, englishTexts, translatorFrom } = require('./push-text');

/** The translations usable for the running English (key -> text), from `source` and the cache's `cached`. */
function usableMessages(language, source, cached) {
  const english = englishTexts(source);
  const committed = source?.files?.[`${language}/${NAMESPACE}.json`] || {};
  const { required, groups } = packs.requiredMessages(english, language);
  const counted = new Set([...groups.values()].flat());
  const messages = {};
  for (const [key, text] of Object.entries(required)) {
    const isCounted = counted.has(key);
    if (!packs.translationProblem(committed[key], text, isCounted)) {
      messages[key] = committed[key].text;
      continue;
    }
    const digest = packs.hash(text);
    const hit = cached[key]?.[digest];
    if (typeof hit === 'string' && !packs.translationProblem({ text: hit, source: digest }, text, isCounted)) {
      messages[key] = hit;
    }
  }
  for (const keys of groups.values()) {
    if (keys.some((key) => !(key in messages))) for (const key of keys) delete messages[key];
  }
  return messages;
}

// language -> { source, at, cached, messages } and, during a read, `reading`.
const memo = new Map();

function messagesFor(pool, language, source, now) {
  const held = memo.get(language);
  if (held?.reading) return held.reading;
  if (held?.messages && held.source === source && now - held.at < languageCache.VERSION_TTL_MS) return held.messages;
  const reading = (async () => {
    // A failed read keeps what the last one found; each is kept by its
    // English, so what no longer applies is not used. It waits like a good
    // read before asking again, not one question per push.
    let cached = held?.cached || {};
    try {
      cached = await languageCache.cachedNamespace(pool, language, NAMESPACE);
    } catch (err) {
      log.warn('mobile-push', 'push translations could not be read', { language, code: typeof err?.code === 'string' ? err.code : 'unknown' });
    }
    let messages = {};
    try {
      messages = usableMessages(language, source, cached);
    } catch (err) {
      log.warn('mobile-push', 'push translations could not be used', { language, message: err.message });
    }
    memo.set(language, { source, at: now, cached, messages });
    return messages;
  })();
  memo.set(language, { ...held, reading });
  return reading;
}

/**
 * Resolves `t(id, values)` for `locale` (users.locale), or null where the
 * default English is right: no language, English, one Homeroom does not have,
 * or anything going wrong. Never rejects.
 */
async function pushTranslator(pool, locale, { source, now = Date.now() } = {}) {
  if (!locale) return null;
  try {
    const running = source === undefined ? languageCache.readSource() : source;
    const language = languageFor(locale, undefined, { source: running });
    if (!language) return null;
    const messages = await messagesFor(pool, language, running, now);
    return translatorFrom(language, messages, englishTexts(running));
  } catch (err) {
    log.warn('mobile-push', 'push language lookup failed', { message: err.message });
    return null;
  }
}

/** Forgets what this process read (tests). */
function reset() {
  memo.clear();
}

module.exports = { pushTranslator, reset, usableMessages };
