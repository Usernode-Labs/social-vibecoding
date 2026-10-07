'use strict';

// Render a React source file to static HTML, from the ROOT test suite.
//
// ── Why this exists ────────────────────────────────────────────────────
//
// A handful of tests do not merely grep a module — they EXECUTE its renderer
// against a real payload, because the bug they exist for is a render-time
// throw that every grep passes: tests/estimator-card-render.test.js is the
// original, written when the estimator card grew three nested-template blocks
// and "a bad interpolation throws at render time" became the live risk.
//
// When #1120 converted those modules from `innerHTML` templates to React, the
// vm-plus-DOM-shim trick they used stopped working: JSX is not evaluable
// JavaScript, and a component is not a function that returns a string. The
// choice was to drop the executed coverage or to keep it. This keeps it.
//
// ── How ────────────────────────────────────────────────────────────────
//
// esbuild bundles the module (react and react-dom left external), the bundle
// is evaluated in-process as CommonJS, and `react-dom/server`'s
// renderToStaticMarkup turns a component into the string the assertions were
// already written against.
//
// Both tools come from `frontend/node_modules`, which the root suite's
// `pretest` (scripts/ensure-shell-artifacts.js) installs from the lockfile
// before any test runs — the same tree the shell build itself uses. Nothing
// is added to the root package.json.
//
// Effects do NOT run under renderToStaticMarkup. That is the honest limit of
// this helper: it covers the render pass, which is the pass the coverage was
// about. Anything an effect does needs a browser, and the ownership audit
// (scripts/audit-react-ownership.mjs) is where that lives.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createCompiledCodeCache } = require('./compiled-code-cache');

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');

const fromFrontend = (spec) => require(require.resolve(spec, { paths: [FRONTEND] }));
const compiled = createCompiledCodeCache();

// esbuild reports bundled files. Watch their directories too: adding a file
// can change extension/index resolution without changing an existing input.
// Config files may be absent today and appear later, so record those as well.
function compilationInputs(files) {
  const inputs = new Set(files);
  for (const file of files) {
    let dir = path.dirname(file);
    while (dir === ROOT || dir.startsWith(ROOT + path.sep)) {
      inputs.add(dir);
      inputs.add(path.join(dir, 'tsconfig.json'));
      inputs.add(path.join(dir, 'package.json'));
      if (dir === ROOT) break;
      dir = path.dirname(dir);
    }
  }
  inputs.add(path.join(FRONTEND, 'tsconfig.json'));
  return [...inputs];
}

/**
 * Bundle `entry` (a repo-relative .tsx/.ts path) and return its exports.
 *
 * `react`, `react-dom` and the JSX runtime stay external and are resolved out
 * of frontend/node_modules, so the component under test shares one React with
 * renderToStaticMarkup — two copies would fail on the first hook.
 *
 * `stubs` maps an import specifier, exactly as the source spells it, to the
 * exports that import should receive instead. tests/dialog-suspend-exit.test.js
 * uses it to run a hook against a React it can step through by hand — effects
 * included, which renderToStaticMarkup never runs. Only compilation is
 * reused: every call evaluates a fresh module with this call's stub values.
 * Use `cache: false` for tests changing resolution outside the tracked input
 * tree (for example, an extended tsconfig in another checkout).
 */
function loadTsx(entry, { stubs = {}, cache = true } = {}) {
  const esbuild = fromFrontend('esbuild');
  const options = {
    absWorkingDir: ROOT,
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/*', 'react/*', ...Object.keys(stubs).sort()],
    // `@/…` is the shell's alias for frontend/@ — the same one
    // frontend/tsconfig.json and vite.config.ts declare.
    alias: { '@': path.join(FRONTEND, '@') },
    logLevel: 'silent',
    metafile: true,
  };
  const fn = compiled(JSON.stringify(options), () => {
    const result = esbuild.buildSync(options);
    const code = result.outputFiles[0].text;
    return {
      value: new Function('exports', 'require', 'module', '__filename', '__dirname', code),
      bytes: Buffer.byteLength(code),
      inputs: compilationInputs(Object.keys(result.metafile.inputs).map((file) => path.resolve(ROOT, file))),
    };
  }, { cache });

  const filename = path.join(ROOT, entry);
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  // The bundle's only remaining `require`s are the externals above.
  const req = (spec) => (Object.hasOwn(stubs, spec) ? stubs[spec] : fromFrontend(spec));
  req.resolve = (spec) => require.resolve(spec, { paths: [FRONTEND] });
  mod._compile = undefined;
  fn(mod.exports, req, mod, filename, path.dirname(filename));
  return mod.exports;
}

/** `renderToStaticMarkup`, bound to the same React the bundle resolved. */
function renderToHtml(element) {
  const { renderToStaticMarkup } = fromFrontend('react-dom/server');
  return renderToStaticMarkup(element);
}

/** `React.createElement`, from the same copy. */
function createElement(type, props, ...children) {
  const React = fromFrontend('react');
  return React.createElement(type, props, ...children);
}

/**
 * Whether `value` is something createElement can draw: a function component,
 * or the object `memo()` / `forwardRef()` return, which is not a function.
 * Rows are memo()'d where a list re-renders often (#3104).
 */
function isComponent(value) {
  if (typeof value === 'function') return true;
  const kind = value && typeof value === 'object' ? value.$$typeof : null;
  return kind === Symbol.for('react.memo') || kind === Symbol.for('react.forward_ref');
}

/** Convenience: bundle, render one export with `props`, return the HTML. */
function renderComponent(entry, exportName, props) {
  const mod = loadTsx(entry);
  const Component = mod[exportName];
  if (!isComponent(Component)) {
    throw new Error(`${entry} does not export a component named ${exportName}`);
  }
  return renderToHtml(createElement(Component, props));
}

/**
 * Transpile one `.ts` file to plain CommonJS-free JavaScript — no bundling,
 * no module wrapper — for evaluation in a `vm` context.
 *
 * tests/challenge-template-prefill.test.js runs admin-topochain.js inside a
 * vm with a DOM shim, and that module imports its shared helpers from
 * `./topochain/*.ts`. The helpers have to be BOUND in the sandbox before the
 * module body runs, and hand-stripping their type annotations with regexes
 * broke the first time one gained a return type. esbuild already ships in
 * frontend/node_modules for the bundler above; this uses it for the one job
 * that needs a transformer rather than a bundler.
 *
 * `format: 'esm'` keeps the output free of `exports.x = …` wrappers, and the
 * caller strips the remaining `export ` keywords so every declaration lands
 * as a sandbox global — which is what `var` at a vm context's top level is.
 */
function transpileTs(entry) {
  const esbuild = fromFrontend('esbuild');
  const source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
  const options = {
    loader: 'ts',
    format: 'esm',
    target: 'node22',
  };
  return compiled(JSON.stringify({ transform: path.join(ROOT, entry), options, source }), () => {
    const { code } = esbuild.transformSync(source, options);
    return { value: code, bytes: Buffer.byteLength(source) + Buffer.byteLength(code), inputs: [] };
  });
}

module.exports = {
  loadTsx, renderToHtml, createElement, renderComponent, transpileTs, ROOT, FRONTEND, fs,
};
