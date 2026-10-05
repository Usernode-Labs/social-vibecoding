'use strict';
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(__dirname, '../../frontend/locales');
const languages = require('../../frontend/locales/config.json').languages;
const english = require('../../frontend/locales/en/server.json');
const cache = new Map([['en', english]]);

function languageFromCookie(header) {
  const part = String(header || '').split(';').map(value => value.trim())
    .find(value => value.startsWith('homeroom_language='));
  if (!part) return 'en';
  let language;
  try { language = decodeURIComponent(part.slice('homeroom_language='.length)); } catch { return 'en'; }
  return Object.hasOwn(languages, language) ? language : 'en';
}
function catalog(language) {
  if (!cache.has(language)) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(directory, language, 'server.json'), 'utf8'));
      cache.set(language, Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.text])));
    } catch { return english; }
  }
  return cache.get(language);
}
function createErrorTranslator(source, load = catalog) {
  const exact = new Map();
  const templates = [];
  for (const [key, text] of Object.entries(source)) {
    const names = [...text.matchAll(/{{(\w+)}}/g)].map(match => match[1]);
    if (!names.length) { exact.set(text, key); continue; }
    // Bound matching work and require real authored prose around values.
    if (names.length > 8 || text.replace(/{{\w+}}/g, '').length < 10) continue;
    const segments = text.split(/{{\w+}}/g);
    // Ambiguous adjacent parameters cannot be recovered from rendered text.
    // Walk literal boundaries instead of backtracking over arbitrary input.
    if (segments.slice(1, -1).some(segment => !segment)) continue;
    templates.push({ key, names, segments });
  }
  return (text, language) => {
    if (language === 'en' || typeof text !== 'string' || text.length > 4096) return text;
    const messages = load(language);
    const direct = exact.get(text);
    if (direct) return messages[direct] || text;
    for (const { key, names, segments } of templates) {
      if (!text.startsWith(segments[0]) || !messages[key]) continue;
      let cursor = segments[0].length;
      const values = {};
      let matched = true;
      for (let i = 0; i < names.length; i++) {
        const boundary = segments[i + 1];
        const last = i === names.length - 1;
        const end = last ? text.length - boundary.length : text.indexOf(boundary, cursor);
        if (end < cursor || (last && !text.endsWith(boundary))) { matched = false; break; }
        values[names[i]] = text.slice(cursor, end);
        cursor = end + boundary.length;
      }
      if (!matched) continue;
      // Values are inserted exactly once; user strings containing {{...}} do
      // not become a second template. res.json provides the output encoding.
      return messages[key].replace(/{{(\w+)}}/g, (_, name) => values[name] ?? '');
    }
    return text;
  };
}
const translate = createErrorTranslator(english);
function languageErrors(req, res, next) {
  if (/^\/(?:api\/(?:admin|v4\/admin|internal)(?:\/|$)|mcp(?:\/|$))/.test(req.path || '')) return next();
  const language = languageFromCookie(req.headers?.cookie);
  if (language === 'en') return next();
  const json = res.json;
  res.json = function localizedError(body) {
    if (this.statusCode >= 400 && body && typeof body.error === 'string') {
      const error = translate(body.error, language);
      if (error !== body.error) {
        this.setHeader('Content-Language', language);
        this.vary('Cookie');
        return json.call(this, { ...body, error });
      }
    }
    return json.call(this, body);
  };
  next();
}
module.exports = { languageErrors, languageFromCookie, createErrorTranslator };
