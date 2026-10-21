'use strict';

/**
 * The starter registry, in the order the create dialog lists them. `empty`
 * is not here: it is the base scaffold, which src/services/template.js
 * writes unchanged when no starter resolves. An unrecognised key resolves
 * to null too, so a rollback or an old row can never break an app heal.
 */

const starters = [
  require('./social'),
  require('./media'),
  require('./game2d'),
  require('./game3d'),
];

const BY_KEY = new Map(starters.map((starter) => [starter.key, starter]));

function starterFor(key) {
  return BY_KEY.get(key) || null;
}

module.exports = { starters, starterFor };
