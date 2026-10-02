'use strict';

/**
 * The starter templates a new project can begin from (#3521).
 *
 * `POST /api/apps` takes `template`, one of TEMPLATE_IDS, and the create
 * dialog's last step offers the same list under "Start from a template"
 * (frontend/src/features/dialogs/create-app.tsx keeps a copy of the ids and
 * the words; tests/app-templates.test.js keeps the two equal). Absent, the
 * project starts from `empty`: the scaffold every project got before this
 * existed, byte for byte (services/template.js).
 *
 * ── What a starter is ──────────────────────────────────────────────────
 *
 * The platform plumbing is shared with `empty` and is not repeated here:
 * the Dockerfile, the Tailwind build, package.json and its lockfile, the
 * `.claude/` scaffold, and server.js's sign-in check, hosted-asset handler
 * and share-link fallback. A starter adds what differs, as real files under
 * `app-templates/<id>/` at the repository root:
 *
 *   api.js             the app's own routes and tables. server.js mounts it
 *                      after the sign-in check (`api.routes(app, pool)`) and
 *                      awaits `api.migrate(pool)` before it listens; a
 *                      staging preview also gets a few obviously fake rows.
 *   public/index.html  the screen, with `{{APP_NAME}}` and
 *                      `{{DEV_CONSOLE_FORWARDER}}` filled in at creation.
 *   public/app.js      the screen's script.
 *
 * They live OUTSIDE src/ on purpose: scripts/check-sql.js validates every
 * query under src/ against the platform's own catalog, and a starter's
 * queries are against the app's database, not this one.
 *
 * The metadata below is what the generated README, CLAUDE.md and dapp.json
 * say about each one. `tests` become the new repository's declared checks,
 * so every starter ships with checks that gate its first proposal; the
 * staging seed in its api.js is what they read.
 *
 * ── Rules every starter keeps ──────────────────────────────────────────
 *
 * The platform conventions apply to these like to any app: the bridge by
 * relative path and never vendored, no CDN, the platform's theme followed,
 * a graceful shutdown, staging seeds gated on USERNODE_ENV and owned by
 * fake identities, uploads through `usernode.uploadFile()` with only the
 * URL stored, and the content rules (the games have no combat or weapons;
 * a feed of posts keeps a way to report one). The 3D game draws with plain
 * WebGL rather than a vendored three.js: about 300 lines instead of a
 * 600 KB library in every new repository, and nothing to keep up to date.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TEMPLATE = 'empty';
const STARTERS_DIR = path.join(__dirname, '..', '..', 'app-templates');

// Files every starter directory carries, relative to it. A starter may add
// more; these are the ones server.js and index.html depend on.
const REQUIRED_FILES = ['api.js', 'public/index.html', 'public/app.js'];

const TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'empty',
    title: 'Empty',
    summary: 'The starter screen with one example to replace.',
  }),
  Object.freeze({
    id: 'social-productivity',
    title: 'Social productivity',
    summary: 'Shared lists that members add tasks to, claim and tick off.',
    icon: '✅',
    features: [
      '**Shared lists**: anyone in the project can start a list and add tasks to it.',
      '**Claim and finish**: "I\'ll do it" puts your name on a task; ticking it off records who did.',
      '**Tidy up**: a task\'s author or its list\'s author can remove it; a list\'s author can remove the list.',
    ],
    tables: '`lists` and `tasks`',
    tests: [
      {
        id: 'lists.board',
        name: 'Lists load with their tasks',
        path: '/',
        expectSelector: '#lists [data-list] [data-task]',
        visual: true,
        impact: ['public/**', 'api.js'],
      },
      { name: 'A new list can be started', path: '/', expectSelector: '#new-list-form input[name="title"]' },
    ],
  }),
  Object.freeze({
    id: 'multimedia-social',
    title: 'Multimedia social',
    summary: 'A feed of posts with photos, likes and a way to report a post.',
    icon: '📷',
    features: [
      '**Posts with photos**: a caption and an optional photo. Photos are uploaded through Homeroom\'s file storage (`usernode.uploadFile()`), shrunk in the browser first; the database keeps only the URL.',
      '**Likes**: one per person per post.',
      '**Report and delete**: anyone can report a post, and a post three people report is hidden; authors can delete their own.',
    ],
    tables: '`posts`, `post_likes` and `post_reports` (private to production)',
    tests: [
      {
        id: 'feed.posts',
        name: 'The feed shows posts with photos',
        path: '/',
        expectSelector: '#feed [data-post] img',
        visual: true,
        impact: ['public/**', 'api.js'],
      },
      { name: 'The composer is ready', path: '/', expectSelector: '#composer textarea[name="caption"]' },
    ],
  }),
  Object.freeze({
    id: 'game-2d',
    title: '2D game',
    summary: 'A canvas game played with keys or touch, with a leaderboard.',
    icon: '⭐',
    features: [
      '**Star catcher**: move the basket with the arrow keys, A and D, or a finger, and catch falling stars. Three missed stars end the round.',
      '**Game loop**: `requestAnimationFrame` with a frame-time step, so speed is the same on every screen.',
      '**Leaderboard**: each player\'s best score, saved when a round ends.',
    ],
    tables: '`scores`',
    tests: [
      {
        id: 'game.ready',
        name: 'The game is ready to play',
        path: '/',
        expectSelector: '#game canvas[data-ready="true"]',
        visual: true,
        impact: ['public/**', 'api.js'],
      },
      { name: 'The leaderboard lists players', path: '/', expectSelector: '#leaderboard [data-score]' },
    ],
  }),
  Object.freeze({
    id: 'game-3d',
    title: '3D game',
    summary: 'A 3D scene drawn with WebGL, with controls and a leaderboard.',
    icon: '💎',
    features: [
      '**Gem garden**: roll a ball around a garden with the arrow keys, WASD, or by dragging, and collect as many gems as you can in 45 seconds.',
      '**Plain WebGL**: a small renderer in `public/app.js` (meshes, a camera, one light), with no library to load or keep up to date. Swap in three.js later if the game outgrows it; serve it from this repository rather than a CDN.',
      '**Leaderboard**: each player\'s best score, saved when a round ends.',
    ],
    tables: '`scores`',
    tests: [
      {
        id: 'game3d.ready',
        name: 'The 3D scene is ready to play',
        path: '/',
        expectSelector: '#game canvas[data-ready="true"]',
        visual: true,
        impact: ['public/**', 'api.js'],
      },
      { name: 'The leaderboard lists players', path: '/', expectSelector: '#leaderboard [data-score]' },
    ],
  }),
]);

const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((t) => t.id));
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function isTemplate(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/** The template's metadata, or null for an id that is not one. */
function get(id) {
  return BY_ID.get(id) || null;
}

/**
 * `template` from a create body: absent is the default, anything else must
 * be on the list. Strict, like the rest of create-options.js: a creator who
 * sent a value meant it, and a silently substituted template would be a
 * project that is not what they picked.
 */
function parseTemplate(raw) {
  if (raw == null || raw === '') return { template: DEFAULT_TEMPLATE };
  if (!isTemplate(raw)) return { error: `template must be one of: ${TEMPLATE_IDS.join(', ')}` };
  return { template: raw };
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * A starter's own files, as `{ path, content }` with the placeholders
 * filled in. `fill` maps a placeholder name (APP_NAME) to its text, already
 * escaped for where it lands. Empty for `empty`, which has none.
 */
function starterFiles(id, fill = {}) {
  if (!isTemplate(id) || id === DEFAULT_TEMPLATE) return [];
  const dir = path.join(STARTERS_DIR, id);
  return walk(dir).map((rel) => ({
    path: rel,
    content: fs.readFileSync(path.join(dir, rel), 'utf8')
      .replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(fill, key) ? fill[key] : whole)),
  }));
}

module.exports = {
  DEFAULT_TEMPLATE,
  REQUIRED_FILES,
  STARTERS_DIR,
  TEMPLATES,
  TEMPLATE_IDS,
  get,
  isTemplate,
  parseTemplate,
  starterFiles,
};
