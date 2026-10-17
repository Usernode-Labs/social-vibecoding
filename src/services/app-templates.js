'use strict';

/**
 * The starting points a brand-new project can be scaffolded from.
 *
 * `empty` is the platform's original scaffold: the Press! screen and its two
 * example routes. It is the default, and a body that names no template gets
 * exactly the files it always did.
 *
 * The four starters are real, small working apps. Their sources live in
 * `app-templates/<id>/` — outside `src/` on purpose, so the platform's own
 * SQL checker never validates their queries against the platform catalog, and
 * so the Tailwind build that scans this repository never sees them (each
 * generated app compiles its own stylesheet).
 *
 * The allow-list is closed. `parseTemplate` refuses an unknown id rather than
 * silently replacing it with Empty: a typo must not create a project that
 * quietly is not the thing the person asked for.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TEMPLATE = 'empty';
const STARTERS_DIR = path.join(__dirname, '..', '..', 'app-templates');

/** The four ready-made apps, in the order the create dialog shows them. */
const TEMPLATES = [
  {
    id: 'social-productivity',
    title: 'Social productivity',
    caption: 'Shared lists that members add tasks to, claim and tick off.',
    description: 'Lists everyone here can add to, claim and tick off.',
    color: '#0a6ee0',
    checks: [
      { id: 'lists.board', name: 'The shared lists board is ready', path: '/', expectSelector: '#lists-board', expectText: 'Lists everyone here can add to, claim and tick off.', visual: true },
      { id: 'lists.add', name: 'A new list can be started', path: '/', expectSelector: '#new-list-title', expectText: 'Add list' },
    ],
  },
  {
    id: 'multimedia-social',
    title: 'Multimedia social',
    caption: 'A feed of posts with photos, likes and a way to report a post.',
    description: 'A feed of posts with photos and likes.',
    color: '#0a6ee0',
    checks: [
      { id: 'feed.posts', name: 'The feed is ready', path: '/', expectSelector: '#feed-posts', expectText: 'A feed of posts with photos and likes.', visual: true },
      { id: 'feed.composer', name: 'The composer is ready', path: '/', expectSelector: '#composer-caption', expectText: 'Post' },
    ],
  },
  {
    id: 'game-2d',
    title: '2D game',
    caption: 'A canvas game played with keys or touch, with a leaderboard.',
    description: 'Catch the falling stars. Miss three and the round is over.',
    color: '#0a6ee0',
    checks: [
      { id: 'game.ready', name: 'Star catch is ready to play', path: '/', expectSelector: '#game-canvas', expectText: 'Star catch', visual: true },
      { id: 'game.leaderboard', name: 'The leaderboard lists players', path: '/', expectSelector: '#leaderboard', expectText: 'Leaderboard' },
    ],
  },
  {
    id: 'game-3d',
    title: '3D game',
    caption: 'A 3D scene drawn with WebGL, with controls and a leaderboard.',
    description: 'Roll around the garden and collect gems in 45 seconds.',
    color: '#0a6ee0',
    checks: [
      { id: 'game3d.ready', name: 'Gem garden is ready to play', path: '/', expectSelector: '#game3d-canvas', expectText: 'Gem garden', visual: true },
      { id: 'game3d.leaderboard', name: 'The leaderboard lists players', path: '/', expectSelector: '#leaderboard', expectText: 'Leaderboard' },
    ],
  },
];

const TEMPLATE_IDS = [DEFAULT_TEMPLATE, ...TEMPLATES.map((t) => t.id)];

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

/** One starter's metadata, or null. */
function get(id) {
  return BY_ID.get(id) || null;
}

function isTemplate(id) {
  return TEMPLATE_IDS.includes(id);
}

/**
 * A create body's `template`, as `{ template }` or `{ error }`.
 *
 * Absent, null and '' are all Empty, which is what an older client sends.
 * An import may not carry a starter: it keeps its own repository, so there is
 * nothing for the starter's files to replace.
 */
function parseTemplate(raw, { imported = false } = {}) {
  if (raw == null || raw === '') return { template: DEFAULT_TEMPLATE };
  if (typeof raw !== 'string' || !isTemplate(raw)) {
    return { error: `template must be one of: ${TEMPLATE_IDS.join(', ')}` };
  }
  if (imported && raw !== DEFAULT_TEMPLATE) {
    return { error: 'An imported project keeps its own repository, so it cannot start from a template.' };
  }
  return { template: raw };
}

/**
 * Every file under one starter, deepest paths included, as
 * `{ path, content }` relative to the new repository's root. Sorted so two
 * runs write the same list in the same order.
 */
function starterFiles(id) {
  if (!get(id)) throw new Error(`Unknown app template: ${id}`);
  const root = path.join(STARTERS_DIR, id);
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(root, '');
  return out;
}

module.exports = {
  DEFAULT_TEMPLATE,
  STARTERS_DIR,
  TEMPLATES,
  TEMPLATE_IDS,
  get,
  isTemplate,
  parseTemplate,
  starterFiles,
};
