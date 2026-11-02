'use strict';

// Which language an email goes out in, and the words for it. The lookup is the
// phone push's (../push-language.js): committed, then cached for the current
// English, then English, message by message, read at most once a minute per
// language. Nobody without a language, or in English, reads anything.
//
// A mail waits for its translation only briefly. A login code matters more
// than its wording: a read that has not answered in READ_PATIENCE_MS costs this
// mail its translation and carries on for the next one.

const READ_PATIENCE_MS = 250;

/** `t(id, values)` for `locale`, or null where English is right. Never rejects. */
async function translatorFor(pool, locale) {
  if (!locale || typeof locale !== 'string') return null;
  let timer;
  const patience = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), READ_PATIENCE_MS);
    timer.unref?.();
  });
  try {
    const { translator } = require('../push-language');
    return await Promise.race([translator(pool, locale, { namespace: 'email' }), patience]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The language of the browser request behind a mail, for an address with no
 * account behind it: the first of its Accept-Language that Homeroom has. Null
 * for English, or for anything else. Never throws.
 */
function requestLanguage(req) {
  try {
    const { languageFor } = require('../admin-text-translations');
    return languageFor(undefined, req?.headers?.['accept-language']) || null;
  } catch {
    return null;
  }
}

module.exports = { READ_PATIENCE_MS, translatorFor, requestLanguage };
