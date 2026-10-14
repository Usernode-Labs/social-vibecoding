#!/usr/bin/env node
'use strict';

// The translation step, by hand, on this checkout (frontend/locales/README.md).
//
// Homeroom runs the same step itself (services/language-sync-runner.js), so a
// contributor never needs this. It exists for the person looking after the
// catalogs: to see what a language is missing, or to fill it from a machine
// that has a key. Never part of a build.
//
//   node scripts/language-sync.js --plan                  what each language needs
//   node scripts/language-sync.js [--languages id,es]     translate it, one request at a time
//   node scripts/language-sync.js --batch                 the same as one Message Batch (half price, slower)
//   node scripts/language-sync.js --changed-from <ref>    only the messages whose English differs from <ref>
//
// Translating reads ANTHROPIC_API_KEY from the environment.

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sync = require('../src/services/language-sync');

const ROOT = path.join(__dirname, '..');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

/** The English catalogs as they were at a git ref, for --changed-from. */
function englishAt(ref) {
  const english = {};
  const listing = execFileSync('git', ['ls-tree', '--name-only', `${ref}:frontend/locales/en`], { cwd: ROOT, encoding: 'utf8' });
  for (const file of listing.split('\n').filter((name) => name.endsWith('.json'))) {
    english[file.slice(0, -5)] = JSON.parse(execFileSync('git', ['show', `${ref}:frontend/locales/en/${file}`], { cwd: ROOT, encoding: 'utf8' }));
  }
  return english;
}

async function waitForBatch(llm, id) {
  for (;;) {
    const status = await llm.catalogBatchStatus(id);
    console.log(`[language-sync] batch ${id}: ${status.status}`, status.counts ? JSON.stringify(status.counts) : '');
    if (status.status === 'ended') return llm.catalogBatchAnswers(id);
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }
}

async function main() {
  const languages = option('--languages') ? option('--languages').split(',').map((tag) => tag.trim()).filter(Boolean) : null;
  const ref = option('--changed-from');
  const onlyIds = ref ? sync.changedEnglishIds(englishAt(ref), sync.readEnglishEntries(ROOT)) : null;

  if (process.argv.includes('--plan')) {
    const config = require('./language-packs').readConfig(path.join(ROOT, 'frontend/locales'));
    for (const language of Object.keys(config.languages)) {
      if (language === 'en' || (languages && !languages.includes(language))) continue;
      const items = sync.planLanguage(ROOT, language, { onlyIds });
      console.log(`${language}: ${items.length} message(s) to translate, ${sync.buildRequests(language, language, items, sync.readGlossary(ROOT)).length} request(s)`);
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const llm = require('../src/services/llm');
  await llm.init({ anthropicApiKey: process.env.ANTHROPIC_API_KEY });
  const translate = process.argv.includes('--batch')
    ? async (requests) => waitForBatch(llm, (await llm.submitCatalogBatch(requests)).id)
    : (requests) => llm.translateCatalogDirect(requests);
  const summary = await sync.syncTranslations({
    root: ROOT, translate, languages, onlyIds, log: (line) => console.log(`[language-sync] ${line}`),
  });
  for (const [language, result] of Object.entries(summary.languages)) {
    console.log(`${language}: ${result.written} of ${result.requested} written, ${result.failed.length} left in English`);
    for (const { id, problem } of result.failed.slice(0, 20)) console.log(`  ${id}: ${problem}`);
  }
  console.log(`[language-sync] ${summary.files.length} file(s) written`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
