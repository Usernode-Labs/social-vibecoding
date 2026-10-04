'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const parameters = value => [...value.matchAll(/{{\s*(-?\s*[\w.]+)(?:,[^}]*)?\s*}}/g)]
  .map(match => match[1].replace(/^-\s*/, '').trim()).sort();

/** English is the authoring source, never an implicit fill for an incomplete pack. */
function collectCatalogs(root) {
  const directory = path.join(root, 'frontend/locales');
  const config = read(path.join(directory, 'config.json'));
  const namespaces = fs.readdirSync(path.join(directory, 'en')).filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -5)).sort();
  const catalogs = {};
  const errors = [];
  for (const locale of Object.keys(config.languages)) {
    catalogs[locale] = {};
    for (const namespace of namespaces) {
      const source = read(path.join(directory, 'en', `${namespace}.json`));
      const file = path.join(directory, locale, `${namespace}.json`);
      let translation;
      try { translation = read(file); }
      catch { errors.push(`${locale}/${namespace}: missing or invalid catalog`); continue; }
      const messages = {};
      for (const [key, english] of Object.entries(source)) {
        if (typeof english !== 'string' || !english.trim()) {
          errors.push(`en/${namespace}:${key}: source text is empty`); continue;
        }
        const entry = translation[key];
        const text = locale === 'en' ? entry : entry?.text;
        if (typeof text !== 'string' || !text.trim()) {
          errors.push(`${locale}/${namespace}:${key}: missing translation`); continue;
        }
        if (locale !== 'en' && entry.source !== hash(english)) {
          errors.push(`${locale}/${namespace}:${key}: English changed; update the translation`);
        }
        if (JSON.stringify(parameters(text)) !== JSON.stringify(parameters(english))) {
          errors.push(`${locale}/${namespace}:${key}: interpolation parameters differ`);
        }
        // Unescaped interpolation is never needed: React escapes its children;
        // legacy HTML callers use the escaping adapter instead.
        if (/{{\s*-/.test(text)) errors.push(`${locale}/${namespace}:${key}: unescaped interpolation`);
        messages[key] = text;
      }
      for (const key of Object.keys(translation)) {
        if (!(key in source)) errors.push(`${locale}/${namespace}:${key}: unknown message`);
      }
      catalogs[locale][namespace] = messages;
    }
  }
  if (errors.length) throw new Error(`Language catalogs are incomplete:\n${errors.join('\n')}`);
  return { config, catalogs, namespaces };
}

function buildLanguagePacks(root) {
  const { config, catalogs, namespaces } = collectCatalogs(root);
  const output = path.join(root, 'public/locales');
  const manifest = {};
  fs.mkdirSync(output, { recursive: true });
  for (const [locale, packs] of Object.entries(catalogs)) {
    manifest[locale] = {};
    for (const [namespace, messages] of Object.entries(packs)) {
      const bytes = JSON.stringify(messages);
      const digest = hash(bytes);
      const name = `${locale}.${namespace}.${digest}.json`;
      fs.writeFileSync(path.join(output, name), bytes);
      manifest[locale][namespace] = { url: `/locales/${name}`, hash: digest };
    }
  }
  const generated = path.join(root, 'frontend/src/lib/i18n/catalogs.generated.json');
  fs.writeFileSync(generated, JSON.stringify({ languages: config.languages, namespaces, english: catalogs.en, manifest }));
  return manifest;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  if (process.argv.includes('--check')) {
    const { config, namespaces } = collectCatalogs(root);
    console.log(`Language catalogs: ${Object.keys(config.languages).length} languages, ${namespaces.length} namespaces`);
  } else buildLanguagePacks(root);
}
module.exports = { collectCatalogs, buildLanguagePacks, hash, parameters };
