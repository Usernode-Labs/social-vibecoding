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

// ─────────────────────────────────────────────────────────────────────
// Repo shape and Next.js warnings (the import check's second half).
//
// Access is what the check GATES; these findings are what it WARNS about.
// They read the repo's root file list and its package.json after the
// access check has passed, and name what would stop the app building or
// starting on Homeroom: a Next.js app without a build or start script, a
// start script on the wrong port, no package.json at the root. Warnings
// only — "Import it" stays available, because the person may fix the repo
// after importing.
// ─────────────────────────────────────────────────────────────────────

// The Dockerfile names the platform's builds look for at a repo's root
// (config.kubernetes.buildkitDockerfiles), read from the same env so an
// operator's override answers here too. A repo with one of these builds
// and starts by its own recipe, and gets no package.json warnings.
function dockerfileNames() {
  return (process.env.BUILDKIT_DOCKERFILES || 'Dockerfile.kubernetes,Dockerfile')
    .split(',').map((name) => name.trim()).filter(Boolean);
}

// The port a start script pins, when it does: `-p N`, `--port N`,
// `--port=N` or `PORT=N`. The last mention wins, the way a shell would
// resolve the last flag. Null when the script leaves the port alone.
function startPort(script) {
  if (typeof script !== 'string' || !script) return null;
  let port = null;
  for (const re of [/(?:^|\s)-p[= ]*(\d+)\b/g, /\b--port[= ]+(\d+)\b/g, /\bPORT\s*=\s*(\d+)\b/g]) {
    let m;
    while ((m = re.exec(script))) port = Number(m[1]);
  }
  return port;
}

// A start script that launches the development server instead of a build:
// it never finishes starting, which on Homeroom reads as a hung container.
const NEXT_DEV_PATTERN = /\bnext\s+dev\b/;

// The warning codes that name a Next.js fix specifically. The form picks
// its lead line by whether one is present.
const NEXT_WARNING_CODES = ['next_no_build', 'next_no_start', 'next_dev_start'];

/**
 * What a repo's shape means for running it on Homeroom, as warnings the
 * import check shows under a green check. Pure.
 *
 *   files            root-level paths from github.listRepoFiles (entries or
 *                    plain strings; paths below the root are ignored)
 *   truncated        GitHub cut the tree listing short — the root list may
 *                    be incomplete, so the "no package.json" finding is
 *                    withheld
 *   packageText      the raw root package.json, or null when there is none
 *   manifestInvalid  the dapp.json JSON.parse error message, or null
 *
 * Returns `{ framework: 'nextjs' | null, warnings: [{ code, message }] }`,
 * warnings in display order. A root Dockerfile silences every
 * package.json finding: its recipe decides how the app builds and starts.
 */
function repoWarnings({ files = [], truncated = false, packageText = null, manifestInvalid = null } = {}) {
  const warnings = [];
  const rootNames = new Set((Array.isArray(files) ? files : [])
    .map((f) => (f && typeof f === 'object' ? f.path : f))
    .filter((p) => typeof p === 'string' && !p.includes('/')));
  const hasRoot = (name) => rootNames.has(name);
  const hasDockerfile = dockerfileNames().some(hasRoot);

  if (manifestInvalid) {
    warnings.push({
      code: 'manifest_invalid',
      message: `Its dapp.json isn't valid JSON (${manifestInvalid}), so Homeroom ignores it until it's fixed.`,
    });
  }

  if (!hasRoot('package.json')) {
    if (!hasDockerfile && !truncated) {
      warnings.push({
        code: 'no_package',
        message: "There's no package.json or Dockerfile at the top of the repo, so Homeroom can't tell how to build it. Move the app to the repo root or add a Dockerfile.",
      });
    }
    return { framework: null, warnings };
  }

  let pkg = null;
  let packageInvalid = false;
  try { pkg = JSON.parse(packageText); } catch { packageInvalid = true; }
  if (packageInvalid) {
    if (!hasDockerfile) {
      warnings.push({
        code: 'package_invalid',
        message: "Its package.json isn't valid JSON, so it won't build.",
      });
    }
    return { framework: null, warnings };
  }

  const scripts = (pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object')
    ? pkg.scripts : {};
  const deps = (pkg && typeof pkg === 'object' && pkg.dependencies != null) ? pkg.dependencies : {};
  const devDeps = (pkg && typeof pkg === 'object' && pkg.devDependencies != null) ? pkg.devDependencies : {};
  const isNext = (deps.next != null) || (devDeps.next != null);
  const framework = isNext ? 'nextjs' : null;
  const start = typeof scripts.start === 'string' ? scripts.start : '';

  // A Dockerfile decides how the app builds and starts; the package.json
  // findings below would second-guess a recipe that works.
  if (hasDockerfile) return { framework, warnings };

  if (isNext && typeof scripts.build !== 'string') {
    warnings.push({
      code: 'next_no_build',
      message: 'Add "build": "next build" to its package.json scripts.',
    });
  }
  if (!start) {
    if (isNext) {
      warnings.push({
        code: 'next_no_start',
        message: 'Add "start": "next start" to its package.json scripts.',
      });
    } else if (!['server.js', 'app.js', 'main.js', 'index.js'].some(hasRoot)) {
      warnings.push({
        code: 'no_start',
        message: 'Add a "start" script to its package.json that starts the server on port 3000.',
      });
    }
  } else if (isNext && NEXT_DEV_PATTERN.test(start)) {
    warnings.push({
      code: 'next_dev_start',
      message: 'Its start script runs "next dev". Change it to "next start".',
    });
  }
  const port = startPort(start);
  if (port != null && port !== 3000) {
    warnings.push({
      code: 'wrong_port',
      message: `Its start script uses port ${port}. Apps on Homeroom listen on port 3000: remove the port or set it to 3000.`,
    });
  }
  return { framework, warnings };
}

/**
 * Read what the shape checks need about a repo: its full file list and,
 * when the tree shows one at the root, its package.json text. Both reads
 * go through github.preflightCall, so a slow GitHub is retried the way the
 * access check retries. Returns null on any read failure — the shape
 * checks never fail the check, access is its only gate.
 */
async function readRepoShape(owner, repo) {
  let tree;
  try {
    tree = await github.preflightCall(() => github.listRepoFiles(owner, repo));
  } catch (err) {
    log.warn('import-manifest', 'Import repo shape read failed', { repo: `${owner}/${repo}`, err: err.message });
    return null;
  }
  if (!tree || !Array.isArray(tree.files)) return null;
  const packageText = tree.files.some((f) => f && f.path === 'package.json')
    ? await readRootPackageText(owner, repo)
    : null;
  if (packageText === false) return null;
  return { files: tree.files, truncated: tree.truncated === true, packageText };
}

// The root package.json's text, or null when it vanished between the tree
// read and this one. `false` marks a READ failure (distinct from absent),
// which readRepoShape treats as "no warnings" rather than a half answer.
async function readRootPackageText(owner, repo) {
  try {
    return await github.preflightCall(() => github.getFileContent(owner, repo, 'package.json'));
  } catch (err) {
    log.warn('import-manifest', 'Import package.json read failed', { repo: `${owner}/${repo}`, err: err.message });
    return false;
  }
}

module.exports = { mergeCreateAnswers, commitCreateAnswers, repoWarnings, readRepoShape };
