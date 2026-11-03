'use strict';

// A server error people commonly see, in their language.
//
// `error` is a contract: the web client compares it against fixed values, and
// the phone app, the connector and the CLI read it. So it is never translated.
// A response whose `error` is exactly a sentence in frontend/locales/en/errors.json
// gets `error_message` beside it, in the reader's language, for the client to
// show (frontend/src/lib/i18n/server-error.ts). Any other response goes out as
// the handler wrote it, with no extra key. frontend/locales/README.md, "A
// server's error", has the rest.
//
// RES.JSON STAYS SYNCHRONOUS. translatedReads, in admin-text-translations.js,
// waits for a read before it sends; that is right for one route, and wrong for
// every error of every route. Handlers go on after res.json (`headersSent`
// checks, a second answer from a catch, res.end), and a response held for a
// moment would change what those do. Most 500s also happen when the database is
// in trouble, the one time waiting on it costs most. So this looks up only what
// is already in hand, and starts a read behind it when one is due: the first
// such error in a language after a process starts is in English, and costs
// nobody anything.
//
// The same goes for the language: Settings when req.user carries it (auth reads
// it with the session), else Accept-Language, never a read of users. A route
// that signs in with less (the optional session of the topochain reads) follows
// the browser. Auth runs after this is mounted; req.user is read when res.json
// is called, by which time it has been set.
//
// A response bypassing res.json (a stream, res.end, res.jsonp) stays English.
// res.send(object) comes through here, because Express sends it through res.json.

const log = require('../services/logger');
const languageCache = require('../services/language-cache');
const { languageFor } = require('../services/admin-text-translations');
const { messagesInHand } = require('../services/push-language');
const { englishTexts } = require('../services/push-text');

const NAMESPACE = 'errors';
const RETRY_EMPTY_MS = 60 * 1000;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Middleware for every response. `pool` is a function, asked only when a read
 * is due, so nothing connects for a response that needs none.
 */
function errorLanguage(pool, { readSource = languageCache.readSource, now = Date.now } = {}) {
  // English sentence -> key. A build's English does not change while it runs,
  // so this is read once, at the first error, and a miss costs one Map lookup.
  let keys = null;
  let keysAt = 0;
  const keyOf = (english) => {
    if (!keys || (!keys.size && now() - keysAt >= RETRY_EMPTY_MS)) {
      keysAt = now();
      keys = new Map(Object.entries(englishTexts(readSource(), NAMESPACE)).map(([key, text]) => [text, key]));
    }
    return keys.get(english);
  };

  const withMessage = (req, res, body) => {
    try {
      if (!(res.statusCode >= 400) || !isPlainObject(body)) return body;
      const english = body.error;
      if (typeof english !== 'string') return body;
      const key = keyOf(english);
      if (key === undefined || hasOwn(body, 'error_message')) return body;
      const source = readSource();
      const language = languageFor(req.user?.locale || undefined, req.get('accept-language'), { source });
      if (!language) return body;
      const text = messagesInHand(pool(), language, source, now(), NAMESPACE)[key];
      if (typeof text !== 'string' || !text) return body;
      const translated = { ...body, error_message: text };
      res.vary('Accept-Language');
      return translated;
    } catch (err) {
      log.warn('error-language', 'Sent the error as it was', { message: err?.message });
      return body;
    }
  };

  return (req, res, next) => {
    const send = res.json;
    res.json = function json(body) {
      return send.call(res, withMessage(req, res, body));
    };
    next();
  };
}

module.exports = { errorLanguage };
