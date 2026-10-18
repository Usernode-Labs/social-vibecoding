'use strict';

/**
 * The starter templates a new project can begin from (#3521).
 *
 * The create dialog's last question gains a working "Start from a template"
 * choice: Empty (what the platform always shipped, byte for byte) plus four
 * ready-made examples — a shared task board, a photo feed, and two small
 * games. A template is only a STARTING POINT: each example is clearly
 * labelled placeholder content, and the group's first real change replaces
 * it exactly the way today's starter Press demo is replaced.
 *
 * Every entry names its example twice: `label` is what the picker row says,
 * and the `claude`/`readme` fragments are what the scaffolded CLAUDE.md and
 * README say when they tell the coding agent to replace the template —
 * they name this template's own tables and routes instead of the presses
 * demo's. The example screens themselves live in
 * `src/templates/apps/<id>/` (server-app.js, index-body.html, and for the
 * games a public/ directory copied verbatim into the scaffold).
 *
 * `resolveTemplateId` is the pure gate POST /api/apps reads `template`
 * through (services/create-options.js), the create-options precedent:
 * absent, empty or whitespace means Empty, a known id maps to itself, and
 * anything else is an error the route answers 400 "Unknown template".
 */

const TEMPLATE_LIST = [
  {
    id: 'empty',
    label: 'Empty',
    example: 'Today\'s starter screen: the Press demo',
    claudeShips: 'the hero, the "What\'s already\n'
      + 'working" card, and the Press! example (the demo markup in\n'
      + '`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and\n'
      + 'the `presses` table bootstrap in `server.js`)',
    claudeDemo: 'the `presses` table',
    readmeDb: 'stores button presses in a `presses` table',
    readmeApi: 'two example routes (`/api/press`,\n  `/api/leaderboard`)',
  },
  {
    id: 'social',
    label: 'Social productivity',
    example: 'Shared task board: add a task, tick it done, see who added what, open and done counts',
    claudeShips: 'the shared task board example (the demo markup in\n'
      + '`public/index.html`, the `/api/tasks` routes, and the `tasks` table\n'
      + 'bootstrap in `server.js`)',
    claudeDemo: 'the `tasks` table',
    readmeDb: 'stores tasks in a `tasks` table',
    readmeApi: 'the example routes (`/api/tasks` to list and add,\n  `/api/tasks/:id/toggle` to tick one done)',
  },
  {
    id: 'media',
    label: 'Multimedia social',
    example: 'Photo feed: post a picture with a one-line caption, newest first; Report hides a post',
    claudeShips: 'the photo feed example (the demo markup in\n'
      + '`public/index.html`, the `/api/posts` routes, and the `posts` table\n'
      + 'bootstrap in `server.js`)',
    claudeDemo: 'the `posts` table',
    readmeDb: 'stores photo posts in a `posts` table',
    readmeApi: 'the example routes (`/api/posts` to list and add,\n  `/api/posts/:id/report` to report one)',
  },
  {
    id: 'game2d',
    label: '2D game',
    example: 'Canvas paddle game: catch falling stars, three misses end the run, best runs listed',
    claudeShips: 'the star-catching paddle game (the demo markup in\n'
      + '`public/index.html`, its script in `public/game.js`, the `/api/scores`\n'
      + 'routes, and the `scores` table bootstrap in `server.js`)',
    claudeDemo: 'the `scores` table',
    readmeDb: 'stores best runs in a `scores` table',
    readmeApi: 'the example routes (`/api/scores`, the shared\n  scoreboard of the best runs)',
  },
  {
    id: 'game3d',
    label: '3D game',
    example: 'Ball rolls on a platform, collect eight orbs against the clock, best times listed',
    claudeShips: 'the ball-and-orbs collection game (the demo markup in\n'
      + '`public/index.html`, its script in `public/game.js` with the vendored\n'
      + 'three.js in `public/vendor/`, the `/api/scores` routes, and the `scores`\n'
      + 'table bootstrap in `server.js`)',
    claudeDemo: 'the `scores` table',
    readmeDb: 'stores best times in a `scores` table',
    readmeApi: 'the example routes (`/api/scores`, the shared\n  scoreboard of the best times)',
  },
];

const TEMPLATES = new Map(TEMPLATE_LIST.map((t) => [t.id, t]));

/**
 * The create body's `template` choice. Absent, empty or whitespace is Empty;
 * a known id maps to itself; anything else is a 400. Trims and lowercases,
 * so " Social " and "SOCIAL" are the social template.
 */
function resolveTemplateId(raw) {
  if (raw == null) return { template: 'empty' };
  if (typeof raw !== 'string') return { error: 'Unknown template' };
  const id = raw.trim().toLowerCase();
  if (!id) return { template: 'empty' };
  if (TEMPLATES.has(id)) return { template: id };
  return { error: 'Unknown template' };
}

/**
 * The registry entry for a template id. Internal callers only (template.js):
 * an id the registry does not know is a caller's error, not a user-input
 * path — user input goes through resolveTemplateId above.
 */
function getTemplate(id) {
  const tpl = TEMPLATES.get(id);
  if (!tpl) throw new Error(`Unknown app template: ${id}`);
  return tpl;
}

module.exports = { TEMPLATE_LIST, TEMPLATES, resolveTemplateId, getTemplate };