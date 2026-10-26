'use strict';

// The shared link reader (frontend/src/lib/repo-link.js), for tests.
//
// The shell imports it at its entry (frontend/src/main.tsx), and it
// publishes itself as `window.RepoLink` for the classic scripts that label
// repository, change, request and commit links (public/js/app-view.js,
// group-chat.js). A test that evaluates one of those scripts in a vm gives
// its sandbox the same object: `installRepoLink(sandbox)` runs the shipped
// text, `export`s stripped, in a context of its own (so its names stay out
// of the script's global scope, and it has Node's URL whatever the sandbox
// lacks) and sets it on the sandbox. Without it, every such site draws no link
// rather than guessing (AppView._repoLink).
//
// `repoLink` is the same module, evaluated once for a test that calls its
// functions directly.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO_LINK_PATH = path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'repo-link.js');
const REPO_LINK_RAW = fs.readFileSync(REPO_LINK_PATH, 'utf8');
const BODY = REPO_LINK_RAW
  .replace(/^export default .*;$/m, '')
  .replace(/^export\s+/gm, '');

/** The module's object, evaluated in a context of its own (with Node's URL). */
function evaluate() {
  return vm.runInNewContext(`(function () {\n${BODY}\nreturn RepoLink;\n})()`, { URL });
}

/** Publish `window.RepoLink` on a vm sandbox (whose `window` is itself, or set). */
function installRepoLink(sandbox) {
  const links = evaluate();
  sandbox.RepoLink = links;
  if (sandbox.window && sandbox.window !== sandbox) sandbox.window.RepoLink = links;
  return links;
}

const repoLink = evaluate();

module.exports = { REPO_LINK_PATH, REPO_LINK_RAW, installRepoLink, repoLink };
