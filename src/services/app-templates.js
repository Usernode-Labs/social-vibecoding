'use strict';

/**
 * The five starting points a new project can be created from, and the one
 * place that maps a stored `apps.template` key to the module that writes its
 * starter.
 *
 *   empty       Start from scratch — the Press! scaffold every new app had
 *   social      Social productivity — a shared plan board
 *   multimedia  Multimedia social — a media wall with reactions and Report
 *   2d          2D game — catch the stars on a canvas
 *   3d          3D game — collect orbs on a CSS 3D board
 *
 * `empty` is the column's default, so an existing row, an import, or a client
 * that sends no template gets exactly today's scaffold. `starterFor` falls
 * back to it for an unknown key for the same reason: a row written by a
 * newer platform (or a hand-edited one) must still produce a working app
 * rather than an empty repository.
 *
 * The frontend keeps its own list of the four named starting points
 * (`STARTERS` in frontend/src/features/dialogs/create-app.tsx), because the
 * picker does not repeat Start from scratch as an Empty row.
 * tests/app-templates.test.js keeps the two lists in step.
 */

const TEMPLATE_KEYS = Object.freeze(['empty', 'social', 'multimedia', '2d', '3d']);

const MODULE_FOR = Object.freeze({
  empty: 'empty',
  social: 'social',
  multimedia: 'multimedia',
  '2d': 'game-2d',
  '3d': 'game-3d',
});

function isTemplateKey(value) {
  return typeof value === 'string' && TEMPLATE_KEYS.includes(value);
}

/** The starter module for a key, or the empty starter for anything else. */
function starterFor(key) {
  const moduleName = MODULE_FOR[isTemplateKey(key) ? key : 'empty'];
  // Lazy: a scaffold request pays for one starter, not all five.
  return require(`../templates/starters/${moduleName}`);
}

module.exports = { TEMPLATE_KEYS, isTemplateKey, starterFor };
