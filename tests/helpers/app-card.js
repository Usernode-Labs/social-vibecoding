// Install the shared app-card builders into a vm sandbox.
//
// frontend/src/features/apps/app-card.js is where the icon tile and the
// activity/visibility chip strip live as of #1083 chunk F. Both of its
// consumers — features/apps/browse.js and features/home/home.js, whose
// `iconTileFor` / `renderAppPillsHtml` methods delegate to it — reach it by
// `import`, so any test that evals either of those sources in a vm has to
// supply it, the same way it already supplies `document` and `location`.
// (The sources' single `import` line is stripped at each of those call sites;
// this installs the names it would have bound.)
//
// It has to run INSIDE the sandbox rather than be required from here: the
// module's escapeHtml goes through `document.createElement`, and the document
// that matters is the caller's stub, not Node's absent one.
//
// The `export` keywords are stripped because these sandboxes run classic
// script text, not modules — the same shape as the AdminUI registry eval in
// tests/admin-ui-registry.test.js. Nothing else about the source is rewritten,
// so the functions under test are byte-for-byte the shipped ones.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC_ROOT = path.join(__dirname, '..', '..', 'frontend', 'src');
const APP_CARD_PATH = path.join(SRC_ROOT, 'features', 'apps', 'app-card.js');
// app-card.js's one import is `openmojiSrcFor` from lib/openmoji.js (the
// subtle-y2k illustrated-icon lookup), so that source is evaluated into the
// sandbox first, in dependency order. ITS one import is the JSON manifest the
// vendor script writes — a vm can't parse an import at all, so the stripped
// source reads the module-scope `manifest` binding, supplied here from the
// real file via require(). (`lib/app-tint.js` used to be loaded alongside
// this — the slug→tint hash for the per-app identity colour. Both are gone:
// the tile is one neutral face now, so there is nothing to hash.)
const OPENMOJI_PATH = path.join(SRC_ROOT, 'lib', 'openmoji.js');
const OPENMOJI_MANIFEST = require(path.join(SRC_ROOT, 'lib', 'openmoji-manifest.json'));

// `export function f` -> `function f`, `export const X` -> `const X`, and drop
// the `import` lines outright — the sandbox binds those names by evaluating
// the imported module into the same context first, which is what the two
// sources below do in dependency order.
const toClassic = (src) => src
  .replace(/^import [^\n]*\n/gm, '')
  .replace(/^export \{[^}]*\};?\n/gm, '')
  .replace(/^export /gm, '');

const APP_CARD_SRC = fs.readFileSync(APP_CARD_PATH, 'utf8');
const APP_CARD_CLASSIC = toClassic(APP_CARD_SRC);
const OPENMOJI_SRC = fs.readFileSync(OPENMOJI_PATH, 'utf8');
const OPENMOJI_CLASSIC = toClassic(OPENMOJI_SRC);

// The sandbox must already be a vm context (vm.createContext) with `window`
// pointing at itself and a `document.createElement` stub. Returns the
// installed AppCard so a caller can also use it directly.
function installAppCard(sandbox) {
  sandbox.manifest = OPENMOJI_MANIFEST;
  vm.runInContext(OPENMOJI_CLASSIC, sandbox);
  vm.runInContext(APP_CARD_CLASSIC, sandbox);
  return sandbox.AppCard;
}

module.exports = { installAppCard, APP_CARD_PATH, APP_CARD_SRC, APP_CARD_CLASSIC };
