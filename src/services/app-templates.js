'use strict';

/**
 * The starter templates a new project can begin from (#3521).
 *
 * `POST /api/apps` takes `template`, one of TEMPLATE_IDS; absent, the
 * project starts from `empty`: the scaffold every project got before this
 * existed, byte for byte (services/template.js). Strict, like the rest of
 * create-options.js: an id not on the list is refused, not swapped.
 *
 * READY-MADE APPS (Evan, 8 October 2026). The four general starters of the
 * old create dialog (social productivity, multimedia social, a 2D game, a 3D
 * game) were deleted with it. What came back are apps finished enough that
 * a project made from one needs nothing built: the eight choices on "What
 * do you want to make?" that need no typing
 * (frontend/src/features/first-session/examples.ts, each choice's
 * `template`). A tier list of restaurants, hikes, cities or games is one
 * app with its category filled in at creation; a grocery list, a chore
 * list, a lending library and a potluck planner are one app each. They are
 * `ready`: POST /api/apps starts no Homeroom bot build for them
 * (routes/apps.js), so the project is usable as soon as it is running.
 * Words of the maker's own, and every game, still go to Homeroom bot.
 *
 * A starter is files and an entry:
 *
 *   app-templates/<dir>/ at the repository root, outside src/ because
 *                        scripts/check-sql.js validates every query under
 *                        src/ against the platform's own catalog, and a
 *                        starter's queries are against the app's database.
 *                        `dir` is the entry's id unless it names another,
 *                        so several entries can share one app:
 *     api.js             the app's own routes and tables (server.js mounts
 *                        it after the sign-in check and awaits its migrate);
 *     public/index.html  the screen, with `{{APP_NAME}}`,
 *                        `{{DEV_CONSOLE_FORWARDER}}` and the entry's own
 *                        `fill` values filled in at creation;
 *     public/app.js      the screen's script, which holds no placeholder:
 *                        what an entry fills is in the page, so one script
 *                        serves every entry that shares the directory.
 *   an entry below       its title, summary, icon, features, tables and the
 *                        declared `tests` the new repository ships with.
 *
 * Rules every starter keeps: the platform conventions, like any app (the
 * bridge by relative path and never vendored, no CDN, the viewer's theme,
 * staging seeds gated on USERNODE_ENV and owned by fake identities, "now"
 * read through `req.now` and `usernode.now()`, "everyone in the group" from
 * the platform's member list), and the new app's design kit
 * (styles/tailwind-input.css, written by template.js): colour only from its
 * tokens, its type scale and components, so a ready-made app looks like the
 * apps Homeroom bot builds.
 *
 * A project made from one of the deleted starters keeps its `apps.template`
 * value; app-creator reads anything that is not on the list as `empty`, so
 * a Retry after a failed create scaffolds the empty starter.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_TEMPLATE = 'empty';
const STARTERS_DIR = path.join(__dirname, '..', '..', 'app-templates');

// Files every starter directory carries, relative to it. A starter may add
// more; these are the ones server.js and index.html depend on.
const REQUIRED_FILES = ['api.js', 'public/index.html', 'public/app.js'];

// Every starter's checks look at the screen and its script; one of them is
// the visual flow its first proposals are compared on.
const IMPACT = Object.freeze(['public/**', 'api.js']);

/**
 * One tier list per category: the same app (app-templates/tier-list), with
 * what it ranks filled in. `example` is the add field's placeholder.
 */
function tierList(id, { plural, one, example, title }) {
  return Object.freeze({
    id,
    dir: 'tier-list',
    ready: true,
    title,
    summary: `A tier list of the group's favorite ${plural}: anyone adds one, everyone drags them into tiers, and the group's ranking shows where each lands.`,
    icon: '📊',
    fill: Object.freeze({ ITEM_PLURAL: plural, ITEM_ONE: one, ITEM_EXAMPLE: example }),
    features: Object.freeze([
      `**Add ${plural}**: anyone in the project adds one; a name already on the list is not added twice.`,
      '**Your ranking**: drag each one into S, A, B, C, D or F, or tap it and then tap a tier. Change your mind any time.',
      '**The group\'s ranking**: the same board, with every item in the tier its average lands in (a tie goes up). One tap switches between the two.',
    ]),
    tables: '`tier_items` and `tier_votes`',
    tests: Object.freeze([
      {
        id: 'tiers.board',
        name: 'The group\'s tier list shows items in their tiers',
        path: '/',
        expectSelector: '#board[data-view="group"] [data-tier="S"] [data-item]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'The board switches to your own ranking', path: '/', expectSelector: '#view-toggle button[data-view="yours"]' },
      { name: 'A new item can be added', path: '/', expectSelector: '#add-form input[name="name"]' },
    ]),
  });
}

const TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'empty',
    title: 'Empty',
    summary: 'The starter screen with one example to replace.',
  }),
  tierList('tier-list-restaurants', { plural: 'restaurants', one: 'restaurant', example: 'e.g. the taco place on Main St', title: 'Restaurant tier list' }),
  tierList('tier-list-hikes', { plural: 'hikes', one: 'hike', example: 'e.g. the lake loop', title: 'Hiking tier list' }),
  tierList('tier-list-cities', { plural: 'cities', one: 'city', example: 'e.g. Lisbon', title: 'City tier list' }),
  tierList('tier-list-games', { plural: 'games', one: 'game', example: 'e.g. chess', title: 'Game tier list' }),
  Object.freeze({
    id: 'grocery-list',
    ready: true,
    title: 'Grocery list',
    summary: 'One shared grocery list, aisle by aisle: anyone adds what is needed, whoever is at the store ticks things off.',
    icon: '🛒',
    features: Object.freeze([
      '**Aisle by aisle**: an item goes in its aisle (guessed as you type: milk is dairy), and the aisles can be renamed, added and put in the order your store is laid out. Fold away the ones you are done with.',
      '**Ticked in place**: whoever buys something ticks it, it stays where it was, struck through, with who bought it, and "Clear bought" tidies up afterwards.',
      '**Who did what**: the latest thing somebody else did is at the top, with the last few under "Recent activity". Tap an item to change it, its note or its aisle.',
    ]),
    tables: '`grocery_aisles`, `grocery_items` and `grocery_events`',
    tests: Object.freeze([
      {
        id: 'groceries.list',
        name: 'The list shows what is needed, aisle by aisle',
        path: '/',
        expectSelector: '#aisles [data-aisle] [data-item] input[type="checkbox"]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'An item can be added', path: '/', expectSelector: '#add-form input[name="name"]' },
    ]),
  }),
  Object.freeze({
    id: 'chore-list',
    ready: true,
    title: 'Chore list',
    summary: 'The group\'s chores, each always one person\'s or taking turns; turns move on every Monday.',
    icon: '🧹',
    features: Object.freeze([
      '**Yours or taking turns**: a chore can always be one person\'s, or go round the project\'s members (the platform\'s member list, never just whoever opened the app), moving on every Monday (UTC). Tap a chore to change which.',
      '**Your turn**: the chores that are yours this week come first, with who is next.',
      '**Done this week**: anyone can tick a chore off, and the list says who did.',
    ]),
    tables: '`chores` and `chore_done`',
    tests: Object.freeze([
      {
        id: 'chores.week',
        name: 'This week\'s chores are listed',
        path: '/',
        expectSelector: '#chores [data-chore]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'With the demo rota, each chore says whose turn it is', path: '/?demo=1', expectSelector: '#chores [data-chore] [data-turn]' },
    ]),
  }),
  Object.freeze({
    id: 'lending-library',
    ready: true,
    title: 'Lending library',
    summary: 'The things members can lend each other, who has each one now, and who has asked for it next.',
    icon: '📚',
    features: Object.freeze([
      '**Things to lend**: add something you can lend, with an optional note. It starts on your shelf.',
      '**Ask for it**: anyone can ask for a thing and joins the line; whoever has it hands it on to someone who asked.',
      '**Who has what**: each thing says who has had it since when. No due dates: its owner can always say it is back.',
    ]),
    tables: '`library_items` and `library_requests`',
    tests: Object.freeze([
      {
        id: 'library.shelf',
        name: 'The library lists things, borrowed and available',
        path: '/',
        expectSelector: '#shelf [data-thing][data-status="out"]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'Something can be added to lend', path: '/', expectSelector: '#add-form input[name="name"]' },
    ]),
  }),
  Object.freeze({
    id: 'potluck-planner',
    ready: true,
    title: 'Potluck planner',
    summary: 'Potlucks with a date and a place, who is bringing what by course (so the table is not six salads), and a chat for each one.',
    icon: '🍲',
    features: Object.freeze([
      '**Plan a potluck**: a name, a date, a time and a place.',
      '**Who\'s bringing what**: say what you will bring and which course it is. Each course lists what is coming, and the courses nobody has taken yet are named.',
      '**Talk about it**: react to a dish, comment on it ("is it vegetarian?"), and chat with everyone coming.',
    ]),
    tables: '`potlucks`, `potluck_dishes`, `potluck_reactions`, `potluck_comments` and `potluck_messages`',
    tests: Object.freeze([
      {
        id: 'potluck.next',
        name: 'The next potluck shows who is bringing what',
        path: '/',
        expectSelector: '#potlucks [data-potluck] [data-course] [data-dish]',
        visual: true,
        impact: IMPACT,
      },
      { name: 'A potluck can be planned', path: '/', expectSelector: '#plan-form input[name="title"]' },
      { name: 'Each potluck has its chat', path: '/', expectSelector: '#potlucks [data-potluck] [data-chat] [data-message]' },
    ]),
  }),
]);

const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((t) => t.id));
const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));
/** The ready-made apps: a project made from one needs nothing built. */
const READY_IDS = Object.freeze(TEMPLATES.filter((t) => t.ready).map((t) => t.id));

function isTemplate(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Whether a project made from this template is ready as it is (no Homeroom bot build). */
function isReadyMade(id) {
  return isTemplate(id) && !!BY_ID.get(id).ready;
}

/** The template's metadata, or null for an id that is not one. */
function get(id) {
  return BY_ID.get(id) || null;
}

/** The directory a starter's files live in, under STARTERS_DIR. */
function dirOf(id) {
  const t = get(id);
  return t ? (t.dir || t.id) : null;
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
 * filled in. `fill` maps a placeholder name (APP_NAME, or one of the
 * entry's own `fill` names) to its text, already escaped for where it
 * lands. Empty for `empty`, which has none.
 */
function starterFiles(id, fill = {}) {
  if (!isTemplate(id) || id === DEFAULT_TEMPLATE) return [];
  const dir = path.join(STARTERS_DIR, dirOf(id));
  return walk(dir).map((rel) => ({
    path: rel,
    content: fs.readFileSync(path.join(dir, rel), 'utf8')
      .replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(fill, key) ? fill[key] : whole)),
  }));
}

module.exports = {
  DEFAULT_TEMPLATE,
  READY_IDS,
  REQUIRED_FILES,
  STARTERS_DIR,
  TEMPLATES,
  TEMPLATE_IDS,
  dirOf,
  get,
  isReadyMade,
  isTemplate,
  parseTemplate,
  starterFiles,
};
