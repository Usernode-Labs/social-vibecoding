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

const ROOT = path.join(__dirname, '..', '..');
const FRONTEND = path.join(ROOT, 'frontend');

const fromFrontend = (spec) => require(require.resolve(spec, { paths: [FRONTEND] }));

/**
 * Bundle `entry` (a repo-relative .tsx/.ts path) and return its exports.
 *
 * `react`, `react-dom` and the JSX runtime stay external and are resolved out
 * of frontend/node_modules, so the component under test shares one React with
 * renderToStaticMarkup — two copies would fail on the first hook.
 */
function loadTsx(entry) {
  const esbuild = fromFrontend('esbuild');
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/*', 'react/*'],
    // `@/…` is the shell's alias for frontend/@ — the same one
    // frontend/tsconfig.json and vite.config.ts declare.
    alias: { '@': path.join(FRONTEND, '@') },
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;

  const filename = path.join(ROOT, entry);
  const mod = new Module(filename, null);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  // The bundle's only remaining `require`s are the externals above.
  const req = (spec) => fromFrontend(spec);
  req.resolve = (spec) => require.resolve(spec, { paths: [FRONTEND] });
  mod._compile = undefined;
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', code);
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

/** Convenience: bundle, render one export with `props`, return the HTML. */
function renderComponent(entry, exportName, props) {
  const mod = loadTsx(entry);
  const Component = mod[exportName];
  if (typeof Component !== 'function') {
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
  const result = esbuild.transformSync(fs.readFileSync(path.join(ROOT, entry), 'utf8'), {
    loader: 'ts',
    format: 'esm',
    target: 'node22',
  });
  return result.code;
}

module.exports = {
  loadTsx, renderToHtml, createElement, renderComponent, transpileTs, ROOT, FRONTEND, fs,
};
