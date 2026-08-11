// The home screen's three modules, as text the vm-based tests can eval.
//
// They live in frontend/src/features/home/ as of #1083 chunk F step 4, which
// converted #home-screen into a React island. The move is why this helper
// exists at all: a dozen tests read these sources by path, and one place to
// resolve them beats a dozen paths to re-point the next time they move.
//
// home.js is the only one with a bundle-ism to undo. It imports the shared
// card builders (frontend/src/features/apps/app-card.js), and an `import` line
// is a SyntaxError to a vm context, which runs classic script text. HOME_SRC
// strips exactly that line and nothing else, so the code under test is
// byte-for-byte the shipped code; a test whose sandbox reaches the two
// delegating methods (renderAppPillsHtml / iconTileFor) supplies the binding
// the import would have made by calling installAppCard(sandbox) from
// ./app-card first — running app-card.js's classic form declares `AppCard` in
// the same global lexical scope home.js resolves it against.
//
// home-panels.js and home-layout.js are plain scripts with no import at all,
// so their text needs no rewriting.

const fs = require('node:fs');
const path = require('node:path');

const FEATURE_DIR = path.join(__dirname, '..', '..', 'frontend', 'src', 'features', 'home');

const HOME_PATH = path.join(FEATURE_DIR, 'home.js');
const PANELS_PATH = path.join(FEATURE_DIR, 'home-panels.js');
const LAYOUT_PATH = path.join(FEATURE_DIR, 'home-layout.js');

// Raw file text, for the tests that assert ON the source rather than run it.
const HOME_RAW = fs.readFileSync(HOME_PATH, 'utf8');
const PANELS_SRC = fs.readFileSync(PANELS_PATH, 'utf8');
const LAYOUT_SRC = fs.readFileSync(LAYOUT_PATH, 'utf8');

// Classic-script form: the one `import` line removed. See the note above.
const HOME_SRC = HOME_RAW.replace(/^import .*;$/gm, '');

module.exports = {
  HOME_PATH, PANELS_PATH, LAYOUT_PATH,
  HOME_RAW, HOME_SRC, PANELS_SRC, LAYOUT_SRC,
};
