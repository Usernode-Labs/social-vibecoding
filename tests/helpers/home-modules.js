// The home screen's three modules, as text the vm-based tests can eval.
//
// They live in frontend/src/features/home/ as of #1083 chunk F step 4, which
// converted #home-screen into a React island. The move is why this helper
// exists at all: a dozen tests read these sources by path, and one place to
// resolve them beats a dozen paths to re-point the next time they move.
//
// Two of them carry bundle-isms to undo. An `import` line is a SyntaxError to
// a vm context, which runs classic script text, so HOME_SRC and PANELS_SRC
// strip exactly those lines and nothing else — the code under test is
// byte-for-byte the shipped code otherwise.
//
// What each import would have bound, the test supplies:
//
//   * home.js imports the shared card builders
//     (frontend/src/features/apps/app-card.js) and the two view-model stores
//     (./grid-store, ./chrome-store). `installAppCard(sandbox)` from
//     ./app-card runs the card module's classic form, and
//     `installGridStore(sandbox)` from ./home-grid-store creates both stores —
//     each declaring its binding in the same global lexical scope home.js
//     resolves it against.
//   * home-panels.js imports ./panels-store, which
//     `installPanelsStore(sandbox)` supplies the same way. Its renderers moved
//     into frontend/src/features/home/panels/*.tsx, so a test that used to
//     read a host's innerHTML renders those components against what
//     `HomePanels.render()` pushed.
//
// home-layout.js is still a plain script with no import at all.

const fs = require('node:fs');
const path = require('node:path');

const FEATURE_DIR = path.join(__dirname, '..', '..', 'frontend', 'src', 'features', 'home');

const HOME_PATH = path.join(FEATURE_DIR, 'home.js');
const PANELS_PATH = path.join(FEATURE_DIR, 'home-panels.js');
const LAYOUT_PATH = path.join(FEATURE_DIR, 'home-layout.js');

// Raw file text, for the tests that assert ON the source rather than run it.
const HOME_RAW = fs.readFileSync(HOME_PATH, 'utf8');
const PANELS_RAW = fs.readFileSync(PANELS_PATH, 'utf8');
const LAYOUT_SRC = fs.readFileSync(LAYOUT_PATH, 'utf8');

// Classic-script form: the `import` lines removed. See the note above.
const HOME_SRC = HOME_RAW.replace(/^import .*;$/gm, '');
const PANELS_SRC = PANELS_RAW.replace(/^import .*;$/gm, '');

module.exports = {
  HOME_PATH, PANELS_PATH, LAYOUT_PATH,
  HOME_RAW, HOME_SRC, PANELS_RAW, PANELS_SRC, LAYOUT_SRC,
};
