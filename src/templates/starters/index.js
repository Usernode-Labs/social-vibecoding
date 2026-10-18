'use strict';

/**
 * The create screen's starter templates (request #3521): a registry keyed
 * by id, read by services/template.js when a project is created from one.
 * Each module seeds the new repository's demo — the example card in
 * public/index.html and its inline script, the demo routes and demo table
 * bootstrap in server.js — and the wording that names them in CLAUDE.md
 * and README.md. Everything else the scaffold ships (the auth chassis,
 * the hosted-asset handler, the welcome card, the `.claude/` scaffold) is
 * untouched, so a templated project deploys and is built on exactly like
 * a scratch one.
 *
 * Parity is checked AT LOAD: an id here that services/create-options'
 * STARTER_TEMPLATE_IDS does not list (or the reverse) is a broken build,
 * not a missing picker row.
 */

const STARTERS = {
  'social-productivity': require('./social-productivity'),
  'multimedia-social': require('./multimedia-social'),
  'game-2d': require('./game-2d'),
  'game-3d': require('./game-3d'),
};

const { STARTER_TEMPLATE_IDS } = require('../../services/create-options');

for (const id of Object.keys(STARTERS)) {
  if (!STARTER_TEMPLATE_IDS.includes(id)) {
    throw new Error(`Starter template "${id}" is not in create-options STARTER_TEMPLATE_IDS`);
  }
}
for (const id of STARTER_TEMPLATE_IDS) {
  if (!STARTERS[id]) {
    throw new Error(`STARTER_TEMPLATE_IDS lists "${id}" but src/templates/starters has no module for it`);
  }
}

/** The starter for an id, or null for the default (no template, or an id this build no longer knows — services/template.js falls back to the generic starter and logs). */
function get(id) {
  return STARTERS[id] || null;
}

module.exports = { STARTERS, get };
