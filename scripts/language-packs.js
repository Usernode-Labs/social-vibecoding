'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const parameters = value => [...value.matchAll(/{{\s*(-?\s*[\w.]+)(?:,[^}]*)?\s*}}/g)]
  .map(match => match[1].replace(/^-\s*/, '').trim()).sort();
const pluralSuffix = /_(zero|one|two|few|many|other)$/;

function componentTags(text) {
  const stack = [], tags = [];
  for (const match of text.matchAll(/<\/?\d+>|<[^>]*>/g)) {
    const token = match[0];
    if (!/^<\/?\d+>$/.test(token)) throw new Error('only numbered component tags are allowed');
    if (token.startsWith('</')) {
      if (stack.pop() !== token.slice(2, -1)) throw new Error('unbalanced component tags');
    } else {
      const index = token.slice(1, -1);
      stack.push(index); tags.push(index);
    }
  }
  if (stack.length) throw new Error('unclosed component tags');
  return tags.sort();
}

function requiredMessages(source, locale) {
  const result = {};
  const groups = new Set(Object.keys(source).filter(key => key.endsWith('_other') && `${key.slice(0, -6)}_one` in source)
    .map(key => key.slice(0, -6)));
  for (const [key, text] of Object.entries(source)) {
    if (!groups.has(key.replace(pluralSuffix, ''))) result[key] = text;
  }
  for (const group of groups) {
    for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
      result[`${group}_${category}`] = source[`${group}_${category}`] || source[`${group}_${category === 'one' ? 'one' : 'other'}`];
    }
    if (`${group}_zero` in source) result[`${group}_zero`] = source[`${group}_zero`];
  }
  return { result, groups };
}

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
      const { result: required, groups } = requiredMessages(source, locale);
      // Permit optional English plural categories in a target catalog, while
      // requiring every category that this language actually uses.
      for (const key of Object.keys(translation)) {
        if (required[key]) continue;
        const group = key.replace(pluralSuffix, '');
        if (groups.has(group) && pluralSuffix.test(key)) {
          required[key] = source[key] || source[`${group}_other`];
        }
      }
      for (const [key, english] of Object.entries(required)) {
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
        try {
          if (/<\/?\d+>/.test(text + english)
              && JSON.stringify(componentTags(text)) !== JSON.stringify(componentTags(english))) {
            errors.push(`${locale}/${namespace}:${key}: component tags differ`);
          }
        } catch (error) { errors.push(`${locale}/${namespace}:${key}: ${error.message}`); }
        // Unescaped interpolation is never needed: React escapes its children;
        // legacy HTML callers use the escaping adapter instead.
        if (/{{\s*-/.test(text)) errors.push(`${locale}/${namespace}:${key}: unescaped interpolation`);
        messages[key] = text;
      }
      for (const key of Object.keys(translation)) {
        if (!(key in required)) errors.push(`${locale}/${namespace}:${key}: unknown message`);
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
  const currentFiles = new Set();
  for (const [locale, packs] of Object.entries(catalogs)) {
    manifest[locale] = {};
    for (const [namespace, messages] of Object.entries(packs)) {
      const bytes = JSON.stringify(messages);
      const digest = hash(bytes);
      const name = `${locale}.${namespace}.${digest}.json`;
      currentFiles.add(name);
      fs.writeFileSync(path.join(output, name), bytes);
      manifest[locale][namespace] = { url: `/locales/${name}`, hash: digest };
    }
  }
  // Keep the release manifest bounded after local rebuilds. Previous packs
  // already cached by clients retain their immutable URL and bytes.
  for (const name of fs.readdirSync(output)) {
    if (/^[a-zA-Z-]+\.[a-z-]+\.[a-f0-9]{64}\.json$/.test(name) && !currentFiles.has(name)) {
      fs.unlinkSync(path.join(output, name));
    }
  }
  const generated = path.join(root, 'frontend/src/lib/i18n/catalogs.generated.json');
  fs.writeFileSync(generated, JSON.stringify({ languages: config.languages, namespaces: namespaces.filter(name => name !== 'server'), english: Object.fromEntries(Object.entries(catalogs.en).filter(([name]) => name !== 'server')), manifest }));
  return manifest;
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  if (process.argv.includes('--check')) {
    const { config, namespaces } = collectCatalogs(root);
    console.log(`Language catalogs: ${Object.keys(config.languages).length} languages, ${namespaces.length} namespaces`);
  } else buildLanguagePacks(root);
}
module.exports = { collectCatalogs, buildLanguagePacks, hash, parameters, componentTags, requiredMessages };
