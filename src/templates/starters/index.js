'use strict';

// The starters a project can be created from (the create dialog's last step).
// `empty` is not here: it is template.js's own long-standing scaffold, kept
// there so its output stays byte-identical. Each module below exports the same
// shape:
//
//   id        the value stored in apps.starter_template
//   label     the row's title on the create screen
//   caption   the row's one-line caption
//   docs      { claude, readme } — the paragraphs that replace the starter
//             notes in the generated CLAUDE.md and README.md
//   routes    the Express route source placed in server.js
//   bootstrap the CREATE TABLE source placed in server.js's start()
//   body()    the example card's markup for public/index.html
//   script    the page's inline JavaScript, replacing the Press! script
//
// An unknown id (or `empty`) resolves to null, and template.js keeps the
// press-counter example.

const modules = [
  require('./social-productivity'),
  require('./multimedia-social'),
  require('./game-2d'),
  require('./game-3d'),
];

const byId = new Map(modules.map((starter) => [starter.id, starter]));
const STARTER_IDS = modules.map((starter) => starter.id);

function starterFor(id) {
  return byId.get(id) || null;
}

module.exports = { STARTER_IDS, starterFor };
