'use strict';

const vm = require('node:vm');

// tests/helpers/bundle-module.js — evaluate a `frontend/src/features/**`
// module inside a plain `vm` context.
//
// Several harnesses load the REAL shipped source of a relocated module
// (work-drawer.js, merge-status.js, …) rather than a copy, so the assertions
// cannot drift from what runs. Those modules are "a classic script that
// happens to live in the bundle": imperative bodies that still publish
// `window.X`. But they are ES modules, and `vm.runInContext` compiles a
// classic script — the moment one grows a real `import`, every harness
// loading it dies with `Cannot use import statement outside a module`
// (#1120 slice 3 added `import { adoptKitSurface } …` and did exactly that
// to 30 tests).
//
// Rewriting the module text is the smaller of the two evils. The alternative
// — forbidding bundle modules from importing — would freeze the relocated
// files out of the seams the migration exists to create. So: static imports
// become reads of an explicit stub table the harness supplies, and `export`
// keywords are dropped. Nothing else about the source is touched, and an
// import the harness forgot to stub is an immediate throw rather than an
// `undefined` that surfaces ten assertions later.

/** `import { a, b as c } from 'x';` → `const { a, b: c } = <stubs>;` */
const FROM_IMPORT = /^[ \t]*import\s+([\s\S]*?)\s+from\s+'([^']+)';?[ \t]*$/gm;
/** `import 'x';` — a side-effect import has nothing to bind. */
const BARE_IMPORT = /^[ \t]*import\s+'([^']+)';?[ \t]*$/gm;
/** `export { A, B };` — the harness reads `window.X`, not the ES exports. */
const EXPORT_LIST = /^[ \t]*export\s+\{[^}]*\};?[ \t]*$/gm;
/** `export const X = …` → `const X = …` (the binding itself stays). */
const EXPORT_DECL = /^([ \t]*)export\s+(?=(?:default\s+)?(?:const|let|var|function|class|async)\b)(?:default\s+)?/gm;

/**
 * Rewrite ES module source into an equivalent classic script.
 *
 * @param {string} src module source
 * @param {string} table name of the sandbox global holding the import stubs,
 *   keyed by specifier exactly as written in the source
 * @returns {{ code: string, specifiers: string[] }}
 */
function toClassicScript(src, table = '__bundleImports') {
  const specifiers = [];
  let code = src.replace(FROM_IMPORT, (_m, clause, spec) => {
    specifiers.push(spec);
    const from = `${table}[${JSON.stringify(spec)}]`;
    const c = clause.trim();
    // `{ a, b as c }` → `{ a, b: c }`; `* as ns` → `ns`; `X` → `X` (default).
    if (c.startsWith('{')) return `const ${c.replace(/\s+as\s+/g, ': ')} = ${from};`;
    if (c.startsWith('*')) return `const ${c.replace(/^\*\s*as\s+/, '')} = ${from};`;
    return `const ${c} = ${from}.default;`;
  });
  code = code.replace(BARE_IMPORT, (_m, spec) => {
    specifiers.push(spec);
    return '';
  });
  code = code.replace(EXPORT_LIST, '').replace(EXPORT_DECL, '$1');
  return { code, specifiers };
}

/**
 * `toClassicScript`, plus the check that the harness actually stubbed every
 * specifier the module imports. A missing stub is a test-harness bug, and it
 * is much cheaper to see it here than as `adoptKitSurface is not a function`.
 *
 * @param {string} src module source
 * @param {object} imports specifier → module-namespace stub
 * @param {string} label file name, for the error message
 */
function classicScriptFor(src, imports = {}, label = 'module') {
  const { code, specifiers } = toClassicScript(src);
  for (const spec of specifiers) {
    if (!Object.prototype.hasOwnProperty.call(imports, spec)) {
      throw new Error(
        `${label} imports '${spec}', which this harness does not stub. Add it to the `
        + 'imports table (see tests/helpers/bundle-module.js).',
      );
    }
  }
  return code;
}

/**
 * Evaluate one or more bundle modules in a shared function scope over
 * `sandbox`'s globals.
 *
 * The stub table is passed as a parameter of the wrapper function rather than
 * planted on the sandbox: these contexts alias `window`/`globalThis` to the
 * sandbox itself, so a global named `__bundleImports` would be a global the
 * modules could see — and the point of the harness is that cross-file
 * communication goes through the `window.X` publications and nothing else.
 *
 * @param {object} sandbox a context created by `vm.createContext`
 * @param {Array<[string, string]>} modules `[label, source]` pairs, in load
 *   order. Passing one pair per call gives each module its own scope; passing
 *   several shares one, which is what the page's classic <script>s did.
 * @param {{ imports?: object, tail?: string }} [options] `tail` is extra code
 *   appended inside the same scope (e.g. re-publishing a private binding).
 */
function runModules(sandbox, modules, { imports = DESKTOP_KIT_SURFACE, tail = '' } = {}) {
  const body = modules.map(([label, src]) => classicScriptFor(src, imports, label)).join('\n');
  const fn = vm.runInContext(`(function (__bundleImports) {\n${body}\n${tail}\n})`, sandbox);
  return fn(imports);
}

// The stub table the drawer/menu harnesses share.
//
// `adoptKitSurface` returning null is the DESKTOP answer, and it is the one
// these sandboxes want: `gate: 'touch'` means the real implementation returns
// null whenever `PlatformUI.isTouch()` is false, and none of the harnesses
// below stub a touch environment. So this is not a convenience shim standing
// in for behaviour — it is the branch that actually runs, and the callers'
// `if (!sheet) { …desktop path… }` fallbacks are what the tests assert.
const DESKTOP_KIT_SURFACE = {
  '../../lib/kit-surface': { adoptKitSurface: () => null },
};

/**
 * A stand-in for one of lib/plain-store.js's stores.
 *
 * #1191 slice 6 conversion 4: work-drawer.js's renderers stopped returning HTML
 * strings and now push descriptors into ./work-drawer-store.js. The real store
 * would work here — it is dependency-free plain JS — but it lives behind a
 * second import, and a harness that reached for it would be asserting through
 * React's subscription plumbing to read data the controller just computed. The
 * stub keeps the last pushed value on `.state`, which is what the assertions
 * want, and `.sets` counts the pushes for the tests that care that a re-render
 * happened at all.
 *
 * Every sandbox needs its OWN store (the state is per-load), so this is a
 * factory and `workDrawerImports()` below is one too — sharing one table across
 * `loadAll()` calls would leak one test's rows into the next.
 */
function makeStoreStub(initial = {}) {
  const store = {
    state: { ...initial },
    sets: 0,
    get: () => store.state,
    set: (patch) => {
      store.state = { ...store.state, ...patch };
      store.sets += 1;
    },
    subscribe: () => () => {},
    setFlush: () => {},
  };
  return store;
}

/** The stub table for the four harnesses that load work-drawer.js's real source. */
function workDrawerImports() {
  return {
    ...DESKTOP_KIT_SURFACE,
    './work-drawer-store.js': {
      workDrawerStore: makeStoreStub({ sections: null, empty: false, markAll: false }),
    },
  };
}

module.exports = {
  toClassicScript,
  classicScriptFor,
  runModules,
  DESKTOP_KIT_SURFACE,
  makeStoreStub,
  workDrawerImports,
};
