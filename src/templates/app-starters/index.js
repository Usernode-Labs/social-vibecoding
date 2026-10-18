'use strict';

// The app starters a new project can begin from. `empty` is today's Press!
// scaffold and the default: a body with no template keeps exactly what it
// had. The other four are working starters the create dialog offers.
//
// A template is a starting point, not a locked kind of project. The key is
// stored once on `apps.app_template` and read by every later create path
// (the initial create, a Retry, the GitHub-disabled local build, the
// repo-less repo heal), so the same choice produces the same starter each
// time. The repository carries no marker of its own: its files are the
// result, and a fork copies them like any other source.

const STARTERS = {
  empty: require('./empty'),
  social: require('./social'),
  media: require('./media'),
  'game-2d': require('./game-2d'),
  'game-3d': require('./game-3d'),
};

const DEFAULT_TEMPLATE = 'empty';

function isTemplateKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(STARTERS, key);
}

function templateKeys() {
  return Object.keys(STARTERS);
}

// An unknown key falls back to `empty` rather than throwing: a stored value
// from a renamed template must not break creation or healing.
function getStarter(key) {
  return isTemplateKey(key) ? STARTERS[key] : STARTERS[DEFAULT_TEMPLATE];
}

module.exports = { STARTERS, DEFAULT_TEMPLATE, isTemplateKey, templateKeys, getStarter };
