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

// ── Runtime warnings read at the repo check ───────────────────────────
//
// After the check proves the bot's Write access, the form reads the repo's
// package.json so it can warn (never refuse) when the repo would not build
// or start as it stands. The platform builds with kpack and runs `build`
// through BP_NODE_RUN_SCRIPTS only when the script exists, and the launch
// process needs a `start` script, so a missing script is a real gap the
// owner can push a fix for on GitHub and re-check.

/** The warning lines, verbatim what the form shows. Pure, for tests. */
function packageRuntimeWarnings(pkg) {
  const scripts = pkg && typeof pkg === 'object' && !Array.isArray(pkg) && pkg.scripts
    && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
    ? pkg.scripts : null;
  const deps = pkg && typeof pkg === 'object' && !Array.isArray(pkg)
    ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const isNext = Object.prototype.hasOwnProperty.call(deps, 'next');
  const lines = [];
  if (!scripts || typeof scripts.start !== 'string' || !scripts.start.trim()) {
    lines.push('Its package.json has no "start" script, so Homeroom can\'t start the app after it builds. '
      + 'Add a start script; for Next.js that is "start": "next start".');
  }
  if (isNext && (!scripts || typeof scripts.build !== 'string' || !scripts.build.trim())) {
    lines.push('This repo uses Next.js but has no "build" script, so nothing compiles it. '
      + 'Add "build": "next build" to its package.json.');
  }
  return lines;
}

/**
 * Read the repo's package.json and map it to the warning lines the check
 * shows. Best-effort: a read that fails after its retry produces no warning
 * (logged), because a wrong one is worse than none. `parsed` is
 * github.parseGithubUrl's { owner, repo }.
 */
async function readRepoRuntimeWarnings(parsed) {
  let raw = null;
  try {
    raw = await github.readFileForVerify(parsed.owner, parsed.repo, 'package.json');
  } catch (err) {
    log.warn('import-manifest', 'package.json read failed at the repo check; no runtime warning', {
      repo: `${parsed.owner}/${parsed.repo}`, err: err.message,
    });
    return [];
  }
  if (raw == null) {
    return ['The repo has no package.json, so Homeroom can\'t tell how to build and start it.'];
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return ['The repo\'s package.json doesn\'t parse, so Homeroom can\'t tell how it builds or starts.'];
  }
  return packageRuntimeWarnings(pkg);
}

module.exports = { mergeCreateAnswers, commitCreateAnswers, packageRuntimeWarnings, readRepoRuntimeWarnings };
