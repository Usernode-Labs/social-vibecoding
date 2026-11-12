'use strict';
// The Chromium builds Playwright installed in an image, with their versions.
// The image scan reads distro packages and lockfiles, and a browser Playwright
// downloads is neither: Chromium 141 sat in the worker image for a year with
// no finding (scripts/playwright-browser-findings.js says what follows).
// Runs inside the finished image like check-node-runtime.js, piped to `node`
// on stdin with no network and a read-only filesystem: it only reads.
//
// A browser directory is named for its revision (chromium-1254,
// chromium_headless_shell-1254). Its version is the one the installing
// Playwright's own browsers.json gives that revision, so every playwright-core
// in the image is read too; one that maps the revision is the browser's
// provenance, and the gate's baseline key (playwright-core@version).
const fs = require('node:fs');
const path = require('node:path');

const KINDS = new Map([['chromium', 'chromium'], ['chromium_headless_shell', 'chromium-headless-shell']]);
const NODE_MODULES = ['/usr/local/lib/node_modules', '/usr/lib/node_modules', '/app/node_modules'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Every playwright-core package under the given node_modules trees.
function playwrightCores(roots = NODE_MODULES) {
  const found = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const location = path.join(dir, name);
      if (name.startsWith('@')) { walk(location, depth + 1); continue; }
      const pkg = readJson(path.join(location, 'package.json'));
      if (!pkg) continue;
      let real = location;
      try { real = fs.realpathSync(location); } catch { /* keep the path */ }
      if (pkg.name === 'playwright-core' && !seen.has(real)) {
        seen.add(real);
        const browsers = readJson(path.join(location, 'browsers.json'));
        found.push({ path: location, version: String(pkg.version || ''), browsers: Array.isArray(browsers?.browsers) ? browsers.browsers : [] });
      }
      walk(path.join(location, 'node_modules'), depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
}

// Where Playwright keeps its browsers in this image: PLAYWRIGHT_BROWSERS_PATH,
// each home's default cache, the official images' /ms-playwright, and a
// package-local .local-browsers (PLAYWRIGHT_BROWSERS_PATH=0).
function browserRoots(env = process.env, cores = [], homeRoot = '/home') {
  const roots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') roots.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (env.HOME) roots.push(path.join(env.HOME, '.cache', 'ms-playwright'));
  roots.push('/root/.cache/ms-playwright', '/ms-playwright');
  try { for (const user of fs.readdirSync(homeRoot)) roots.push(path.join(homeRoot, user, '.cache', 'ms-playwright')); } catch { /* no homes */ }
  for (const core of cores) roots.push(path.join(core.path, '.local-browsers'));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function revisionsOf(entry) {
  return [entry.revision, ...Object.values(entry.revisionOverrides || {})].map(String);
}

function inventory({ env = process.env, nodeModules = NODE_MODULES, homeRoot = '/home' } = {}) {
  const cores = playwrightCores(nodeModules);
  const browsers = [];
  const seen = new Set();
  for (const root of browserRoots(env, cores, homeRoot)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names.sort()) {
      const match = /^(chromium|chromium_headless_shell)-(\d+)$/.exec(name);
      if (!match) continue;
      const dir = path.join(root, name);
      let real = dir;
      try { if (!fs.statSync(dir).isDirectory()) continue; real = fs.realpathSync(dir); } catch { continue; }
      if (seen.has(real)) continue;
      seen.add(real);
      const kind = KINDS.get(match[1]);
      const revision = match[2];
      const versions = new Set();
      const installedBy = [];
      for (const core of cores) {
        for (const entry of core.browsers) {
          if (entry.name === kind && revisionsOf(entry).includes(revision) && entry.browserVersion) {
            versions.add(String(entry.browserVersion));
            installedBy.push(`playwright-core@${core.version}`);
          }
        }
      }
      browsers.push({ dir, kind, revision,
        // Two Playwrights naming different versions for one revision is not
        // a version this probe can vouch for.
        version: versions.size === 1 ? [...versions][0] : null,
        installedBy: [...new Set(installedBy)].sort() });
    }
  }
  return { browsers };
}

if (!module.parent) console.log(JSON.stringify(inventory(), null, 2));
module.exports = { inventory, playwrightCores, browserRoots };
