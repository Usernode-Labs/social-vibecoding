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
// The slug→tint hash app-card.js imports. It lives in lib/ because it has a
// second reader in the React world (@/components/ui/icon-tile.tsx re-exports
// it), and it is dependency-free precisely so it can be evaluated here as
// classic script text alongside app-card.js itself.
const APP_TINT_PATH = path.join(SRC_ROOT, 'lib', 'app-tint.js');

// `export function f` -> `function f`, `export const X` -> `const X`, and drop
// the `import` lines outright — the sandbox binds those names by evaluating
// the imported module into the same context first, which is what the two
// sources below do in dependency order.
const toClassic = (src) => src
  .replace(/^import [^\n]*\n/gm, '')
  .replace(/^export \{[^}]*\};?\n/gm, '')
  .replace(/^export /gm, '');

const APP_TINT_CLASSIC = toClassic(fs.readFileSync(APP_TINT_PATH, 'utf8'));
const APP_CARD_SRC = fs.readFileSync(APP_CARD_PATH, 'utf8');
const APP_CARD_CLASSIC = toClassic(APP_CARD_SRC);

// The sandbox must already be a vm context (vm.createContext) with `window`
// pointing at itself and a `document.createElement` stub. Returns the
// installed AppCard so a caller can also use it directly.
function installAppCard(sandbox) {
  vm.runInContext(APP_TINT_CLASSIC, sandbox);
  vm.runInContext(APP_CARD_CLASSIC, sandbox);
  return sandbox.AppCard;
}

module.exports = { installAppCard, APP_CARD_PATH, APP_CARD_SRC, APP_CARD_CLASSIC };
