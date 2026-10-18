'use strict';

/**
 * The ready-made starters a new project can begin from (#3521).
 *
 * The create dialog's last step offers "Start from a template", and this is
 * the one catalog behind it: the same keys, titles and captions the dialog
 * exports as TEMPLATE_CHOICES (frontend/src/features/dialogs/create-app.tsx),
 * pinned equal by tests/app-templates.test.js. `empty` is Start from scratch,
 * the Press! example every new project got before this existed, and it stays
 * the default for an older client that sends no template at all.
 *
 * Each starter is two files under src/templates/starters/<key>/:
 *
 *   index.html   the page, with {{APP_NAME}} and {{DEV_CONSOLE}} placeholders
 *   starter.js   the routes and schema the generated server attaches
 *
 * Both are read once, at module load, the way template.js reads the freshness
 * hook. A template key reaches here only after services/create-options.js
 * validated it, so an unknown key is a code error rather than a user answer
 * and throws.
 */

const fs = require('fs');
const path = require('path');

const STARTERS_DIR = path.join(__dirname, '..', 'templates', 'starters');

// `summary` is how the scaffolded README and CLAUDE.md describe the starter
// to a coding agent; it never appears on the create dialog.
const TEMPLATES = Object.freeze([
  {
    key: 'social',
    title: 'Social productivity',
    caption: 'Shared goals to work on together.',
    summary: 'a shared goals board where anyone can add a goal, cheer one on, and mark their own done',
  },
  {
    key: 'media',
    title: 'Multimedia social',
    caption: 'A photo wall for the group.',
    summary: 'a photo wall where members add a photo through Homeroom and give it a short caption',
  },
  {
    key: 'game2d',
    title: '2D game',
    caption: 'A one-minute game of catching falling stars.',
    summary: 'Star catch, a one-minute game of catching falling stars',
  },
  {
    key: 'game3d',
    title: '3D game',
    caption: 'A one-minute run through a 3D course.',
    summary: 'Orb run, a one-minute run through a 3D course collecting glowing orbs',
  },
]);

const TEMPLATE_KEYS = Object.freeze(['empty', ...TEMPLATES.map((t) => t.key)]);

const starters = new Map();
for (const key of TEMPLATE_KEYS) {
  const dir = path.join(STARTERS_DIR, key);
  starters.set(key, {
    index: fs.readFileSync(path.join(dir, 'index.html'), 'utf8'),
    starter: fs.readFileSync(path.join(dir, 'starter.js'), 'utf8'),
  });
}

function isTemplate(key) {
  return typeof key === 'string' && TEMPLATE_KEYS.includes(key);
}

/** The catalog entry for a ready-made template, or null for `empty`. */
function templateEntry(key) {
  return TEMPLATES.find((t) => t.key === key) || null;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The chosen starter, rendered for one app: its public/index.html and the
 * starter.js every generated repo ships. Throws on a key outside the catalog.
 */
function renderStarter(key, { appName, devConsole = '' } = {}) {
  const files = starters.get(key);
  if (!files) throw new Error(`Unknown app template: ${key}`);
  return {
    index: files.index
      .replace(/\{\{DEV_CONSOLE\}\}/g, devConsole)
      .replace(/\{\{APP_NAME\}\}/g, escapeHtml(appName)),
    starter: files.starter,
  };
}

/**
 * body.template → the key a new project starts from, or a 400 message.
 * Absent or empty is `empty` (an older client keeps today's Press! starter);
 * a key outside the catalog is refused by name; and a template sent with a
 * repository URL is refused, because an import keeps its own repository.
 */
function parseTemplate(raw, { imported = false } = {}) {
  if (raw == null || raw === '') return { template: 'empty' };
  if (!isTemplate(raw)) {
    return { error: `template must be one of ${TEMPLATE_KEYS.map((k) => `"${k}"`).join(', ')}` };
  }
  if (imported) return { error: 'A template applies to a new project, not an imported repository.' };
  return { template: raw };
}

module.exports = {
  TEMPLATES,
  TEMPLATE_KEYS,
  isTemplate,
  templateEntry,
  renderStarter,
  parseTemplate,
};
