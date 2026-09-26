'use strict';

/**
 * An imported repository keeps its own dapp.json, and what that file already
 * says wins: its name, visibility and approval rule are reconciled onto the
 * project on the first deploy (services/app-manifest.js), and its description
 * is the one every surface shows. The create dialog reads the file at the
 * repo check and tells the person which of their answers it replaces.
 *
 * What the file does NOT say yet, the person's answers fill in: the one-line
 * description and a non-default approval rule are committed into the repo's
 * dapp.json by the bot (which the check has just proved has Write access)
 * before the first clone, so the first deploy reads them like any other line
 * of the file, and a later vote can change them the same way. Only missing
 * keys are added; a file that does not parse is left alone.
 */

const log = require('./logger');
const github = require('./github');
const appManifest = require('./app-manifest');
const { governanceBlock } = require('./create-options');

/**
 * The repo's manifest object with the creator's answers added where it has
 * none. Pure. Returns `{ manifest, added }`; `added` lists the keys written
 * (`description`, `governance`), empty when there is nothing to commit.
 */
function mergeCreateAnswers(existing, { description = null, governance = null } = {}) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : { secrets: [] };
  const added = [];
  const line = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  const wantsDescription = line && !appManifest.readDescription(base);
  const block = governanceBlock(governance);
  const wantsRule = block && base.governance == null;
  if (!wantsDescription && !wantsRule) return { manifest: base, added };
  // The description leads, the way the template writes it.
  const manifest = wantsDescription ? { description: line, ...base } : { ...base };
  if (wantsDescription) added.push('description');
  if (wantsRule) { manifest.governance = block; added.push('governance'); }
  return { manifest, added };
}

/**
 * Commit the creator's answers into an imported repo's dapp.json, where it
 * has none. Returns the keys committed (possibly none). Throws on a GitHub
 * failure; the caller treats that as non-fatal.
 */
async function commitCreateAnswers({ repoUrl, description = null, governance = null }) {
  const parsed = github.parseGithubUrl(repoUrl || '');
  if (!parsed || !github.isEnabled()) return [];
  const raw = await github.getFileContent(parsed.owner, parsed.repo, appManifest.MANIFEST_FILENAME, 'main');
  let existing = null;
  if (raw != null) {
    try {
      existing = JSON.parse(raw);
    } catch {
      log.warn('import-manifest', 'Imported dapp.json does not parse; leaving it alone', { repoUrl });
      return [];
    }
  }
  const { manifest, added } = mergeCreateAnswers(existing, { description, governance });
  if (!added.length) return [];
  await github.pushFiles(parsed.owner, parsed.repo, [{
    path: appManifest.MANIFEST_FILENAME,
    content: `${JSON.stringify(manifest, null, 2)}\n`,
  }], {
    message: `Add the ${added.join(' and ')} chosen when this project was imported to Homeroom`,
  });
  return added;
}

module.exports = { mergeCreateAnswers, commitCreateAnswers };
