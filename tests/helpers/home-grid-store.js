// Install the launcher grid's view-model store into a vm sandbox.
//
// #1191 converted `#app-list` to React: `Home.render()` no longer assigns
// innerHTML, it pushes a plain view model into
// frontend/src/features/home/grid-store.ts, which features/home/app-grid.tsx
// renders. home.js reaches that store by `import`, and ./home-modules strips
// every import line so the source can run as classic script text in a vm — so
// any test that CALLS Home.render() has to supply the binding the import would
// have made, exactly as installAppCard(sandbox) already does for the shared
// card builders.
//
// This installs the REAL store rather than a spy: lib/plain-store.js is a few
// lines of dependency-free JavaScript, and running the shipped implementation
// means a test asserting on `gridStore.get()` is asserting on the same
// merge/notify semantics the browser gets — including the "a patch that
// changes nothing does not notify" rule, which is what keeps a no-op render
// from waking React.
//
// The store's own module is TypeScript, so its INITIAL value is transcribed
// here rather than parsed out of it. tests/home-grid-store-initial.test.js
// pins the two against each other, so a field added there without one here
// fails loudly instead of silently reading undefined.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLAIN_STORE_PATH = path.join(
  __dirname, '..', '..', 'frontend', 'src', 'lib', 'plain-store.js'
);

// Classic-script form: `export` stripped, same shape as the AdminUI registry
// eval in tests/admin-ui-registry.test.js and installAppCard's app-card.js.
const PLAIN_STORE_SRC = fs.readFileSync(PLAIN_STORE_PATH, 'utf8')
  .replace(/^export\s+/gm, '');

/** Mirrors INITIAL_GRID in frontend/src/features/home/grid-store.ts. */
const INITIAL_GRID = {
  ready: false,
  view: 'grid',
  rowTemplate: '',
  items: [],
  resultsHeading: null,
  emptyQuery: null,
};

/**
 * Declares `gridStore` in the sandbox's global lexical scope — the same scope
 * home.js resolves it against once its import line is stripped.
 *
 * Returns the store so a test can read `gridStore.get()` without reaching back
 * through the sandbox.
 */
function installGridStore(sandbox) {
  vm.runInContext(
    `${PLAIN_STORE_SRC}\n;var gridStore = createStore(${JSON.stringify(INITIAL_GRID)});`,
    sandbox,
  );
  return sandbox.gridStore;
}

module.exports = { installGridStore, INITIAL_GRID, PLAIN_STORE_SRC };
