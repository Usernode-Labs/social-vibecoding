'use strict';

// App templates (#3521): a new project starts from Empty, the scaffold every
// project always got, or from one of Homeroom's ready-made apps. The four
// general starters (social productivity, multimedia social, a 2D game and a
// 3D game) were deleted with the create dialog that offered them. What came
// back (Evan, 8 October 2026) are apps finished enough that a project made
// from one needs nothing built: the make screen's choices that need no
// typing (frontend/src/features/first-session/examples.ts; the make screen's
// side is tests/first-session-make.test.js). And the four game starters
// (Evan, the same day): working multiplayer games the make screen's game
// presets start from, on one shared game room, which Homeroom bot's first
// version builds the maker's idea on (tests/homeroom-bot-plan.test.js has
// the bot's side).
//
// What is pinned here, without a database (tests/app-templates-postgres
// .test.js runs each one):
//
//   1. THE ALLOW-LIST. POST /api/apps takes `template` from
//      services/app-templates.js's TEMPLATE_IDS and nothing else: `empty`,
//      the twenty ready-made apps and the four game starters; absent is
//      `empty`; a deleted starter's id is refused, not swapped.
//   2. EMPTY IS THE DEFAULT. Absent and `empty` write exactly the same
//      files (#4047 dropped the scaffold's Press! demo, so "always got" is
//      the static welcome screen, not the old one).
//   3. A ROW FROM A DELETED STARTER RETRIES AS EMPTY: app-creator reads an
//      id no longer on the list as the default.
//   4. EVERY READY-MADE APP is a whole repository on the platform's
//      conventions and the new app's design kit: its files, the entry's
//      fill escaped where it lands, the bridge, the theme, no CDN, its own
//      declared checks resolving against its own screen.
//   5. EVERY GAME STARTER is a whole repository too, built on the shared
//      game room (app-templates/_game-room) with its own rules and screen,
//      `ws` added to its package.json and lockfile only, and server.js
//      handing it the server for its live connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appTemplates = require('../src/services/app-templates');
const { parseCreateOptions } = require('../src/services/create-options');
const { getTemplateFiles, fillAppName } = require('../src/services/template');
const appManifest = require('../src/services/app-manifest');

const ROOT = path.join(__dirname, '..');
// The app frame's sandbox flags, read from the source the shell builds from.
const APP_FRAME_SANDBOX = /APP_FRAME_SANDBOX =\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/app-frame/app-frame-policy.js'), 'utf8'))[1];
const DELETED = ['social-productivity', 'multimedia-social', 'game-2d', 'game-3d'];
const READY = [
  'tier-list-restaurants', 'tier-list-hikes', 'tier-list-cities', 'tier-list-games',
  'poll-dinner', 'poll-spending', 'poll-movies',
  'grocery-list', 'chore-list', 'lending-library', 'study-timer',
  'find-a-time-book-club', 'find-a-time-game-night', 'find-a-time-trip',
  'potluck-planner', 'signup-shifts', 'signup-rsvp',
  'challenge-miles', 'challenge-steps', 'challenge-books',
];
const GAMES = ['game-board', 'game-space', 'game-blocks', 'game-trivia'];

const file = (files, p) => {
  const found = files.find((f) => f.path === p);
  assert.ok(found, `${p} is generated`);
  return found.content;
};

const generate = (id, name = 'Demo App') => getTemplateFiles(name, 'demo-app-abc123', 'postgres://x', null, { template: id });

test('the allow-list: Empty, the default, the twenty ready-made apps and the four game starters; a deleted starter is refused', () => {
  assert.deepEqual([...appTemplates.TEMPLATE_IDS], ['empty', ...READY, ...GAMES]);
  assert.deepEqual([...appTemplates.READY_IDS], READY);
  assert.equal(appTemplates.DEFAULT_TEMPLATE, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo' }).template, 'empty', 'absent is Empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: '' }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'solo', template: null }).template, 'empty');
  assert.equal(parseCreateOptions({ audience: 'open', template: 'empty' }).template, 'empty');
  for (const id of [...READY, ...GAMES]) assert.equal(parseCreateOptions({ audience: 'invited', template: id }).template, id);
  const refusal = new RegExp(`^template must be one of: ${['empty', ...READY, ...GAMES].join(', ')}$`);
  for (const bad of [...DELETED, 'chess', 'EMPTY', 'tier-list', '../game-2d', 'toString', '__proto__', 42, ['game-2d'], { id: 'game-2d' }]) {
    assert.match(parseCreateOptions({ audience: 'solo', template: bad }).error, refusal, String(bad));
  }
  for (const id of DELETED) assert.equal(appTemplates.get(id), null, id);
  // `tier-list` is a directory four entries share, not an entry of its own.
  assert.equal(appTemplates.isTemplate('tier-list'), false);
  // An import keeps its repository: Empty (or nothing) is fine, a ready-made app is not.
  assert.equal(parseCreateOptions({ template: 'empty' }, { imported: true }).template, 'empty');
  assert.equal(parseCreateOptions({}, { imported: true }).template, 'empty');
  assert.match(parseCreateOptions({ template: 'grocery-list' }, { imported: true }).error, /cannot start from a template/);
  assert.match(parseCreateOptions({ template: 'game-board' }, { imported: true }).error, /cannot start from a template/);
  // `_game-room` is the directory every game starter shares, not an entry.
  assert.equal(appTemplates.isTemplate('_game-room'), false);
  // The route reads the import flag and the template from the same call.
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(route, /createOptions\.parseCreateOptions\(req\.body, \{ imported: !!repoUrl \}\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'),
    /ALTER TABLE apps ADD COLUMN IF NOT EXISTS template VARCHAR\(40\);/);
  for (const id of appTemplates.TEMPLATE_IDS) assert.ok(id.length <= 40, `${id} fits apps.template`);
});

// Evan, 10 Oct 2026, iPhone: Home showed a new ready-made project as its
// name's letter until the first deploy read dapp.json's icon back. The icon
// is on the record from the moment it is made, the one dapp.json is written
// with, so that reconcile finds nothing to change.
test('a ready-made app\'s icon is on its record from the start', () => {
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  assert.match(route, /const readyIcon = appTemplates\.isReadyMade\(template\) \? appTemplates\.get\(template\)\.icon \|\| null : null;\s+const \{ rows: templated \} = await db\.query\(\s+`UPDATE apps SET template = \$1, icon_emoji = COALESCE\(\$3, icon_emoji\) WHERE id = \$2 RETURNING \*`,\s+\[template, appRow\.id, readyIcon\]/);
  for (const id of READY) {
    const dapp = JSON.parse(file(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: id }), 'dapp.json'));
    assert.deepEqual(dapp.icon, { emoji: appTemplates.get(id).icon }, id);
  }
});

// "A more contextual tour" (Evan, 15 Oct 2026): the first-session walk's
// Homeroom bot card offers one change somebody could ask for in THIS app
// ("Ask it for changes, like “add a cheap eats tier”."), from its starter.
// Short enough for the card on a phone, lowercase-led to sit inside the
// sentence, and plain: no em dash, no quotation marks of its own (the card
// draws them), no closing full stop. The walk's side is
// tests/first-session.test.js.
test('every ready-made app has a short example change for the walk; Empty and the games have none', () => {
  const seen = new Set();
  for (const id of READY) {
    const change = appTemplates.get(id).exampleChange;
    assert.equal(typeof change, 'string', id);
    assert.equal(appTemplates.exampleChangeOf(id), change, id);
    assert.ok(change.length > 0 && change.length <= 32, `${id}: ${change} (${change.length})`);
    assert.match(change, /^[a-z]/, `${id}: lowercase-led`);
    assert.equal(change, change.trim(), id);
    assert.doesNotMatch(change, /[—–"“”.!?]/, `${id}: no em dash, quotes or closing punctuation`);
    assert.ok(!seen.has(change), `${id}: its own`);
    seen.add(change);
  }
  assert.equal(appTemplates.get('tier-list-restaurants').exampleChange, 'add a cheap eats tier');
  // Nothing to offer: Empty (stored as NULL), a game, a deleted or unknown starter.
  for (const id of ['empty', null, undefined, ...GAMES, ...DELETED, 'chess']) {
    assert.equal(appTemplates.exampleChangeOf(id), null, String(id));
  }
  for (const id of GAMES) assert.equal(appTemplates.get(id).exampleChange, undefined, id);
  // GET /api/apps/:slug carries it, read off the row's own template.
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/apps.js'), 'utf8');
  const get = route.slice(route.indexOf("router.get('/api/apps/:slug', async"), route.indexOf('res.json({ app: appPayload });'));
  assert.match(get, /`SELECT \$\{appAccess\.nonSecretAppColumnList\(\)\}, template,/);
  assert.match(get, /exampleChange: appTemplates\.exampleChangeOf\(appRow\.template\),/);
});

test('Empty is the scaffold every project always got, byte for byte', () => {
  const plain = getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, {});
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: 'empty' }), plain);
  assert.deepEqual(getTemplateFiles('Notes', 'notes-abc123', 'postgres://x', null, { template: null }), plain);
  assert.ok(!plain.some((f) => f.path === 'api.js' || f.path === 'public/app.js'));
  const server = file(plain, 'server.js');
  // #4047: the scaffold ships no Press! demo any more — no demo endpoints
  // and no table; the starter screen is static. The server still listens.
  assert.doesNotMatch(server, /\/api\/press|\/api\/leaderboard|presses/);
  assert.match(server, /app\.listen\(port/);
  assert.doesNotMatch(server, /require\('\.\/api'\)/);
  // The key a first version's checks go under is there from the first
  // commit (App bench run 191: builds wrote theirs under `checks`).
  assert.deepEqual(JSON.parse(file(plain, 'dapp.json')), { category: 'other', secrets: [], tests: [] });
  // #4047: the welcome card opens with the app's thumbnail tile (no sketch,
  // no starter here, so the name's letter falls back the way the home tile
  // does).
  const emptyHtml = file(plain, 'public/index.html');
  assert.match(emptyHtml, /<div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ground text-title"><span class="text-muted">N<\/span><\/div>/);
  assert.doesNotMatch(emptyHtml, /Try the example|What's already working/);
  assert.throws(() => getTemplateFiles('Notes', 'notes', 'pg://x', null, { template: 'chess' }), /Unknown app template: chess/);
});

test('app-creator scaffolds from the row, and a deleted starter\'s row retries as Empty', () => {
  const creator = fs.readFileSync(path.join(ROOT, 'src/services/app-creator.js'), 'utf8');
  assert.match(creator, /function templateOf\(row\) \{\s*const t = row\?\.template;\s*return typeof t === 'string' && appTemplates\.isTemplate\(t\) \? t : appTemplates\.DEFAULT_TEMPLATE;/);
  // The starter's files come from the row (starterFiles), for the setup's
  // first commit and for a deploy without GitHub alike.
  assert.match(creator, /function starterFiles\(row, \{ repoUrl = null, sketch = null \} = \{\}\) \{[\s\S]{0,300}template: templateOf\(row\), sketch,/);
  // What templateOf answers for a project made from a starter before they went.
  for (const id of DELETED) assert.equal(appTemplates.isTemplate(id), false, id);
});

test('each ready-made app is a directory of its own files; the four tier lists share one', () => {
  assert.equal(appTemplates.STARTERS_DIR, path.join(ROOT, 'app-templates'));
  assert.deepEqual(appTemplates.starterFiles('empty'), []);
  for (const id of DELETED) assert.deepEqual(appTemplates.starterFiles(id), [], id);
  const dirs = new Set(READY.map((id) => appTemplates.dirOf(id)));
  assert.deepEqual([...dirs].sort(), ['chore-list', 'find-a-time', 'grocery-list', 'group-challenge', 'group-poll', 'lending-library', 'potluck-planner', 'signup-sheet', 'study-timer', 'tier-list']);
  const games = new Set(GAMES.map((id) => appTemplates.dirOf(id)));
  const shared = new Set(GAMES.map((id) => appTemplates.get(id).shared));
  assert.deepEqual([...shared], ['_game-room'], 'every game starter shares one game room');
  // `_scaffold` holds files services/template.js writes itself: what every
  // new app gets, starter or not (usernode-user-data.js, #5118), and what
  // every ready-made app gets (live-updates.js and its page's half).
  assert.deepEqual(fs.readdirSync(appTemplates.STARTERS_DIR).sort(), [...dirs, ...games, ...shared, '_scaffold'].sort(), 'no directory that no entry uses');
  for (const dir of dirs) {
    for (const rel of appTemplates.REQUIRED_FILES) {
      assert.ok(fs.existsSync(path.join(appTemplates.STARTERS_DIR, dir, rel)), `${dir}/${rel}`);
    }
  }
  for (const id of READY) {
    const t = appTemplates.get(id);
    assert.equal(t.ready, true, id);
    assert.equal(appTemplates.isReadyMade(id), true, id);
    for (const k of ['title', 'summary', 'icon', 'tables']) assert.ok(t[k], `${id}.${k}`);
    assert.ok(t.features.length >= 3, `${id} says what it already does`);
  }
  assert.equal(appTemplates.isReadyMade('empty'), false, 'Empty is built by its first version');
  // The tier lists: one app, what it ranks filled in.
  for (const id of READY.slice(0, 4)) {
    const t = appTemplates.get(id);
    assert.equal(t.dir, 'tier-list');
    assert.deepEqual(Object.keys(t.fill).sort(), ['ITEM_EXAMPLE', 'ITEM_ONE', 'ITEM_PLURAL', 'WANT_VERB']);
    assert.match(t.fill.ITEM_EXAMPLE, /^e\.g\. /, 'the add field\'s placeholder is an example that says so');
  }
  // The platform's own build never reads the starters.
  for (const f of ['Dockerfile', 'tailwind.config.js', '.dockerignore']) {
    if (fs.existsSync(path.join(ROOT, f))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /app-templates/, f);
  }
});

// Which revision of its starter a project began from (apps.template_version),
// for a later change to every copy of one starter: the starter's own files,
// unfilled, so the four tier lists of one revision share it.
test('a project records which revision of its starter its first commit carried', () => {
  assert.equal(appTemplates.versionOf('empty'), null);
  for (const id of DELETED) assert.equal(appTemplates.versionOf(id), null, id);
  const versions = new Map();
  for (const id of [...READY, ...GAMES]) {
    const v = appTemplates.versionOf(id);
    assert.match(v, /^[0-9a-f]{12}$/, id);
    assert.equal(appTemplates.versionOf(id), v, `${id} is the same each time`);
    const dir = appTemplates.dirOf(id);
    if (versions.has(dir)) assert.equal(versions.get(dir), v, `${id} shares its directory's revision`);
    versions.set(dir, v);
  }
  assert.equal(new Set(versions.values()).size, versions.size, 'each starter directory has its own revision');
  // Written with the first commit, beside the repository.
  const creator = fs.readFileSync(path.join(ROOT, 'src/services/app-creator.js'), 'utf8');
  assert.match(creator, /'UPDATE apps SET repo_url = \$1, template_version = \$3 WHERE id = \$2',\s*\[repoUrl, row\.id, appTemplates\.versionOf\(template\)\]/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8'), /^ALTER TABLE apps ADD COLUMN IF NOT EXISTS template_version VARCHAR\(64\);$/m);
});

test('a tier list ranks what its entry says, escaped where it lands, and its script reads none of it', () => {
  const hikes = generate('tier-list-hikes');
  const html = file(hikes, 'public/index.html');
  assert.match(html, /Our favorite hikes, ranked together\./);
  assert.match(html, /<label for="add-name" class="section-label mb-0">Add a hike<\/label>/);
  assert.match(html, /placeholder="e\.g\. the lake loop"/);
  assert.match(html, /<p class="text-heading">No hikes yet<\/p>/);
  assert.doesNotMatch(file(generate('tier-list-cities'), 'public/index.html'), /hike/);
  // The fill is the entry's, never the maker's, but it is escaped all the same,
  // like the name. The name is the one placeholder left: the page keeps
  // {{APP_NAME}} for its server.js to fill in, escaped, at runtime
  // (tests/starter-images.test.js), and fillAppName writes it in, escaped,
  // for a page served as it is.
  const odd = getTemplateFiles('A <b>"Best"</b> & co', 'x', 'postgres://x', null, { template: 'tier-list-games' });
  assert.match(file(odd, 'public/index.html'), /<title>\{\{APP_NAME\}\}<\/title>/);
  const oddHtml = file(fillAppName(odd, 'A <b>"Best"</b> & co'), 'public/index.html');
  assert.match(oddHtml, /<title>A &lt;b&gt;&quot;Best&quot;&lt;\/b&gt; &amp; co<\/title>/);
  assert.doesNotMatch(oddHtml, /<b>"Best"/);
  for (const id of READY) {
    for (const f of generate(id)) assert.doesNotMatch(f.content, /\{\{(?!APP_NAME\}\})[A-Z_]+\}\}/, `${id}: ${f.path} has every placeholder but the name filled`);
  }
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/public/app.js'), 'utf8');
  assert.doesNotMatch(script, /\{\{/, 'the script is the same for every tier list');
  // It opens on Yours, so a newcomer can drag straight away; a saved choice
  // of the group's still wins.
  assert.match(html, /<div id="board" class="list" data-view="yours">/);
  assert.match(html, /data-view="yours" aria-checked="true"/);
  assert.match(html, /data-view="group" aria-checked="false"/);
  assert.match(script, /var view = 'yours';\n\s*try \{ if \(localStorage\.getItem\('tier-list:view'\) === 'group'\) view = 'group'; \}/);
  // With nothing added yet, the empty tiers still show under "No hikes yet".
  assert.match(script, /el\.ranking\.hidden = state !== 'ready' && state !== 'empty';/);
  assert.doesNotMatch(script, /if \(!data\.items\.length\) return show\('empty'\)/);
  const board = appTemplates.get('tier-list-hikes').tests.find((c) => c.id === 'tiers.board');
  assert.match(board.expectSelector, /#board\[data-view="yours"\]/, 'the visual check reads the board it opens on');
});

// "For tier list, make it so if you tap a place, it shows information about
// who rated it what. You can drop the tap-a-tier thing, it can just be drag
// based for that." (Evan, 20 Oct 2026.) Ranking is dragging; a tap, on
// either board, opens the item's sheet, which is also where removing it
// went. tests/app-templates-postgres.test.js runs GET /api/items/:id.
test('a tier list ranks by dragging, and tapping one shows who ranked it what', () => {
  const html = file(generate('tier-list-restaurants'), 'public/index.html');
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/public/app.js'), 'utf8');
  // No tap-a-chip-then-tap-a-tier: no picked item, no tier to tap.
  assert.doesNotMatch(script, /\bpicked\b|function pick\(|tap a tier/);
  assert.doesNotMatch(html, /picked-actions/);
  assert.match(script, /var label = h\('div', 'flex w-14 shrink-0 items-center justify-center text-heading ' \+ TIER_CLASS\[tier\], tier\);/,
    'a tier\'s label is not a button any more');
  // A press that moves drags at once, with no hold to time, from a 44 px
  // target that holds the finger; the page scrolls from anywhere else, and
  // under a drag held at the screen's edge (Evan, 21 Oct 2026: "you need to
  // hold on it just right to start dragging").
  assert.match(script, /var CHIP_MOVABLE = 'inline-flex min-h-11 [^']*touch-none select-none /);
  assert.match(script, /var CHIP = 'inline-flex min-h-11 /);
  assert.doesNotMatch(script, /setTimeout\(begin/, 'no hold before a drag');
  assert.match(script, /if \(Math\.abs\(e\.clientX - drag\.x\) \+ Math\.abs\(e\.clientY - drag\.y\) < SLOP_PX\) return;\s+if \(!begin\(\)\) return;/);
  assert.match(script, /gestures\.claim\('touch', 'tier-drag'\)/, 'a drag owns the gesture, so pulling to refresh never starts under it');
  assert.match(script, /function edgeScroll\(\)/);
  // A tap (a press that was not a drag) opens the item's sheet, on either board.
  assert.match(script, /chip\.addEventListener\('click', function \(\) \{\s*if \(!justDragged\) openDetail\(item\.id, chip\);/);
  assert.match(script, /chip = h\('button', CHIP, item\.name\);/, 'the group\'s board too');
  // The sheet: the name, the group's tier, who ranked it what.
  for (const id of ['detail', 'detail-scrim', 'detail-name', 'detail-by', 'detail-group', 'detail-raters', 'detail-close', 'detail-off', 'detail-remove']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<section id="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-name"/);
  // It moves as a phone's sheet does (Evan, 20 Oct 2026: it "animates up
  // weirdly, really fast" and "doesn't animate out"): up from the bottom
  // edge over the dim, once its rows are in (or after a moment), focusing
  // Close without scrolling the page, and back down as the dim fades.
  assert.match(html, /@keyframes rise \{ from \{ transform: translateY\(100%\); \} to \{ transform: none; \} \}/);
  assert.match(html, /\.rise \{ animation: rise 340ms cubic-bezier\(0\.32, 0\.72, 0, 1\); \}/);
  assert.match(html, /\.leaving \.rise \{ animation: sink 240ms [^;]+ forwards; \}/);
  assert.match(html, /\.leaving \.appear \{ animation: vanish 240ms ease-in forwards; \}/);
  assert.match(html, /id="detail-scrim" class="scrim appear /);
  assert.match(html, /id="detail-sheet"[^>]*class="rise /);
  assert.match(script, /loadDetail\(\)\.then\(present, present\);\s+setTimeout\(present, OPEN_WAIT_MS\);/);
  assert.match(script, /el\.detailClose\.focus\(\{ preventScroll: true \}\);/);
  assert.match(script, /if \(el\.detail\.hidden \|\| reducedMotion\(\)\) \{ el\.detail\.hidden = true; return; \}\s+el\.detail\.classList\.add\('leaving'\);\s+leaving = setTimeout\(finishLeaving, LEAVE_MS\);/);
  assert.match(script, /function openDetail\(id, opener\) \{\s+finishLeaving\(\);/, 'a sheet on its way down goes at once for the next');
  assert.match(script, /api\('GET', '\/api\/items\/' \+ asked\)/);
  assert.match(script, /el\.main\.inert = true;/, 'the board behind it cannot be reached');
  assert.match(script, /if \(e\.key === 'Escape' && detail\) closeDetail\(\);/);
  // Removing it went into the sheet: two taps, for whoever added it.
  assert.match(script, /tapTwice\(el\.detailRemove, 'Tap again to remove'/);
  assert.match(script, /el\.detailRemove\.hidden = !item\.mine;/);
  assert.match(script, /el\.detailOff\.hidden = !signedIn \|\| !item\.yours;/);
  // A keyboard or a screen reader cannot drag: the sheet's own tiers, shown once focus reaches them.
  assert.match(html, /id="detail-yours"[^>]*class="sr-only [^"]*focus-within:not-sr-only/);
  for (const tier of ['S', 'A', 'B', 'C', 'D', 'F', 'W', '']) assert.match(html, new RegExp(`data-set-tier="${tier}"`));
  // What the README and the made screen say.
  for (const id of READY.slice(0, 4)) {
    const t = appTemplates.get(id);
    assert.ok(t.features.some((f) => f.startsWith(`**Who ranked it what**: tap any of the ${t.fill.ITEM_PLURAL}`)), id);
    assert.doesNotMatch(JSON.stringify(t.features), /tap a tier|tap it and then/, id);
  }
});

// "Thinking it would live below F, and people could drag things there, and
// they wouldn't impact the averages, but you could say where you want to go
// and others could see too." (Evan, 20 Oct 2026.) Want to (W) is a person's
// one place for an item, like a tier, but worth no score; its name ends in
// the entry's own verb. tests/app-templates-postgres.test.js runs the API.
test('a tier list has Want to below F, which counts toward no tier', () => {
  const verbs = { 'tier-list-restaurants': 'go', 'tier-list-hikes': 'hike', 'tier-list-cities': 'go', 'tier-list-games': 'play' };
  for (const [id, verb] of Object.entries(verbs)) {
    const t = appTemplates.get(id);
    assert.equal(t.fill.WANT_VERB, verb, id);
    const html = file(generate(id), 'public/index.html');
    assert.match(html, new RegExp(`<div id="want" [^>]*data-drop="W" data-verb="${verb}">`), id);
    assert.match(html, new RegExp(`<span>Want</span> <span>to ${verb}</span>`), id);
    assert.match(html, new RegExp(`data-set-tier="W" class="btn-secondary">Want to ${verb}</button>`), id);
    assert.ok(t.features.some((f) => f.startsWith(`**Want to ${verb}**: a row below F for ${t.fill.ITEM_PLURAL}`)), id);
    assert.ok(t.tests.some((c) => c.expectSelector === '#board ~ #want[data-drop="W"]'), id);
  }
  // Between the tiers and the tray, so the visual check's tray still follows the board.
  const html = file(generate('tier-list-cities'), 'public/index.html');
  assert.ok(html.indexOf('id="board"') < html.indexOf('id="want"') && html.indexOf('id="want"') < html.indexOf('id="tray"'));
  assert.match(html, /id="detail-raters"><\/div>\s*<div id="detail-wants" [^>]*hidden>/, 'who wants to, below who ranked it');
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/public/app.js'), 'utf8');
  assert.match(script, /var WANT_VERB = el\.want\.getAttribute\('data-verb'\) \|\| 'try';/);
  // Yours: dropped on like a tier. The group's: every one somebody wants
  // to, most people first, with how many, and no longer in its tray.
  assert.match(script, /el\.want\.setAttribute\('data-drop', 'W'\);/);
  assert.match(script, /el\.want\.removeAttribute\('data-drop'\);/);
  assert.match(script, /data\.items\.filter\(function \(i\) \{ return i\.wants; \}\)\.sort\(function \(a, b\) \{ return b\.wants - a\.wants; \}\)/);
  assert.match(script, /if \(withWants\) chip\.appendChild\(wantBadge\(item\.wants\)\);/);
  assert.match(script, /return !placeOf\(i\) && \(view === 'yours' \|\| !i\.wants\);/);
  const api = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/api.js'), 'utf8');
  assert.match(api, /CHECK \(tier IN \('S', 'A', 'B', 'C', 'D', 'F', 'W'\)\)/);
  assert.match(api, /COUNT\(v\.user_id\) FILTER \(WHERE v\.tier <> 'W'\)::int AS votes/);
  assert.match(api, /FROM tier_votes WHERE tier <> 'W'/, 'nor in "From N people\'s rankings"');
});

// "Add to the tier list template an indicator of who else is live on the app
// at the same time" (Homeroom request #5842). A quiet line under the opening
// sentence names the other signed-in people with the list open. It rides the
// look the screen already keeps, so app.js adds no timer of its own;
// tests/app-templates-postgres.test.js runs GET /api/presence.
test('a tier list says who else is here', () => {
  for (const id of READY.slice(0, 4)) {
    const t = appTemplates.get(id);
    const html = file(generate(id), 'public/index.html');
    // Under the opening line, in the hint's own small muted text, announced
    // politely; it starts hidden, and stays so with nobody else here.
    assert.match(html, /<p class="text-body text-muted">Our favorite [^<]+, ranked together\.<\/p>\s*<!--[^>]*?-->\s*<p id="presence" class="text-small text-muted" aria-live="polite" hidden><\/p>/);
    assert.ok(html.indexOf('id="presence"') < html.indexOf('</header>'), `${id}: inside the header`);
    assert.ok(t.features.some((f) => f.startsWith('**Who else is here**: a line under the title')), id);
    assert.ok(t.tests.some((c) => c.expectSelector === 'header #presence[aria-live="polite"]'), id);
  }
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/public/app.js'), 'utf8');
  assert.match(script, /presence: document\.getElementById\('presence'\)/);
  // It rides the look the screen already keeps, holding a change back under
  // a drag as the board does, and the opening cover never waits on it.
  assert.match(script, /function refresh\(\) \{\s*return Promise\.all\(\[load\(\), detail \? loadDetail\(\) : null, loadPresence\(\)\]\);/);
  assert.match(script, /api\('GET', '\/api\/presence'\)/);
  assert.match(script, /if \(drag\) \{ if \(live\) live\.changed\(\); return; \}/);
  assert.match(script, /el\.presence\.textContent = 'Also here: ' \+ text;/);
  assert.doesNotMatch(script, /el\.presence\.innerHTML/);
  assert.match(script, /loadPresence\(\);\s+if \(window\.usernode && window\.usernode\.ready\)/, 'not what the opening cover waits on');
  const api = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'tier-list/api.js'), 'utf8');
  assert.match(api, /const present = new Map\(\);/);
  assert.match(api, /const PRESENCE_WINDOW_MS = 90000;/);
  assert.match(api, /app\.get\('\/api\/presence'/);
  // Nothing new is stored: still the two tables the entry names.
  assert.deepEqual([...api.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['tier_items', 'tier_votes']);
});

// "Add SSE to all of the templated apps. Tier list for example, changes are
// only showing up with a long delay." (Evan, 20 Oct 2026.) Every ready-made
// app's server tells the open screens when a write succeeds (GET
// /api/changes, app-templates/_scaffold/live-updates.js), and every screen
// that shows what other people do listens and fetches again
// (public/live-updates.js), which also looks every minute. The study timer
// keeps only each person's own count, so its screen has nothing to hear.
// A game keeps its own live connection. The helper itself is
// tests/scaffold-live-updates.test.js.
test('every ready-made app hears its own writes, and every screen that shares anything listens', () => {
  const scaffold = (rel) => fs.readFileSync(path.join(appTemplates.STARTERS_DIR, '_scaffold', rel), 'utf8');
  for (const id of READY) {
    const files = generate(id);
    assert.equal(file(files, 'live-updates.js'), scaffold('live-updates.js'), id);
    assert.equal(file(files, 'public/live-updates.js'), scaffold('public/live-updates.js'), id);
    const server = file(files, 'server.js');
    const mount = server.indexOf("const changes = require('./live-updates').mount(app);");
    assert.ok(mount > server.indexOf('app.use((req, res, next) => {\n  req.now'), `${id}: behind the sign-in check`);
    assert.ok(mount < server.indexOf("const api = require('./api');"), `${id}: before api.js, so every write it answers is heard`);
    assert.match(server, /    changes\.close\(\);\n    server\.close\(\(\) => \{\}\);/, `${id}: its streams end on SIGTERM`);
    assert.match(file(files, 'CLAUDE.md'), /`live-updates\.js` and `public\/live-updates\.js`: live updates\./, id);
    const script = file(files, 'public/app.js');
    const html = file(files, 'public/index.html');
    if (id === 'study-timer') {
      assert.doesNotMatch(script + html, /LiveUpdates|live-updates/, 'nothing shared to hear');
      continue;
    }
    assert.match(html, /<script src="\/live-updates\.js"><\/script>\s*<script src="\/app\.js"><\/script>/, `${id}: the page's half first`);
    assert.match(script, /window\.LiveUpdates\.watch\(\{ refresh: [^,]+, quiet: /, `${id}: listens, and holds a change while it would interrupt`);
    assert.doesNotMatch(script, /setInterval\(|visibilitychange/, `${id}: the page's half is its one clock, and knows when nobody is looking`);
  }
  for (const id of ['empty', ...GAMES]) {
    const files = generate(id);
    assert.ok(!files.some((f) => /live-updates\.js$/.test(f.path)), id);
    assert.doesNotMatch(file(files, 'server.js'), /live-updates|changes\.close/, id);
  }
});

// Evan, 21 Oct 2026: "Book club times: shouldn't this be a weekly time? Not
// just a few times to choose between?" and "If you type in 'what's it for',
// it's unclear how to close the keyboard." One find-a-time app, two modes:
// the book club marks the hours of every week; game night and the trip
// suggest dates. tests/app-templates-postgres.test.js runs both.
test('find a time: the book club finds a weekly time, the others suggest dates, and the keyboard closes', () => {
  const modes = { 'find-a-time-book-club': 'weekly', 'find-a-time-game-night': 'dates', 'find-a-time-trip': 'dates' };
  for (const [id, mode] of Object.entries(modes)) {
    const files = generate(id);
    const html = file(files, 'public/index.html');
    assert.equal(appTemplates.get(id).fill.TIME_MODE, mode, id);
    assert.match(html, new RegExp(`<main id="app" class="[^"]*" data-mode="${mode}">`), id);
    assert.match(file(files, 'api.js'), new RegExp(`const MODE = '${mode}' === 'weekly' \\? 'weekly' : 'dates';`), id);
    // Homeroom's native kit, by relative path: a tap outside a field closes
    // the keyboard, and the page stays put instead of dragging Homeroom along.
    assert.match(html, /<link rel="stylesheet" href="\/usernode-native\/v1\/native\.css">[\s\S]*<link rel="stylesheet" href="\/tailwind\.css">/, id);
    // The kit's script after the theme script, which comes first after the
    // bridge (tests/new-app-theme.test.js).
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>[\s\S]*applyTheme\(\);[\s\S]*<\/script>\s*(?:<!--[\s\S]*?-->\s*)?<script src="\/usernode-native\/v1\/native\.js"><\/script>/, id);
    assert.match(html, /viewport-fit=cover/, id);
    assert.match(html, /html \{ overscroll-behavior-y: contain; overscroll-behavior-x: none; touch-action: pan-y pinch-zoom; \}/, id);
  }
  const html = file(generate('find-a-time-book-club'), 'public/index.html');
  assert.match(html, /Find a weekly time for our book club\./);
  assert.match(html, /\[data-mode="weekly"\] \[data-dates-only\], \[data-mode="dates"\] \[data-weekly-only\] \{ display: none !important; \}/);
  assert.match(html, /<section id="week" [^>]*data-weekly-only hidden>/);
  assert.match(html, /<div id="plans" [^>]*data-dates-only hidden><\/div>/);
  assert.match(file(generate('find-a-time-trip'), 'public/index.html'), /Find a time for our trip\./);
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'find-a-time/public/app.js'), 'utf8');
  assert.match(script, /var refresh = weekly \? week\.load : load;/);
  assert.match(script, /window\.unNative\.attachPullToRefresh\(window, refresh\)/);
  // A hold, then a drag, marks a block of hours without scrolling the page;
  // a quick swipe is left to the page.
  assert.match(script, /w\.grid\.addEventListener\('touchmove', function \(e\) \{\s+var t = e\.touches\[0\];\s+if \(paint\) \{\s+e\.preventDefault\(\);/);
  assert.match(script, /\}, \{ passive: false \}\);/);
  // The name's Done key closes the keyboard rather than starting a plan half done.
  assert.match(html, /id="plan-name"[^>]*\s+enterkeyhint="done"/);
  assert.match(script, /if \(e\.key !== 'Enter'\) return;\s+e\.preventDefault\(\);\s+e\.target\.blur\(\);/);
});

for (const id of READY) {
  test(`the ${id} app is a whole repository on the platform's conventions`, () => {
    const files = generate(id);
    const html = file(files, 'public/index.html');
    const script = file(files, 'public/app.js');
    const api = file(files, 'api.js');
    // The screen: forwarder, precompiled Tailwind, the bridge by relative
    // path, the viewer's theme, its own script last.
    assert.match(html, /usernode-dev-console@1/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/);
    assert.match(html, /window\.usernode && window\.usernode\.theme/);
    assert.match(html, /<script src="\/app\.js"><\/script>\s*<\/body>/);
    assert.match(html, /<title>\{\{APP_NAME\}\}<\/title>/);
    // A tier list leaves its name to Homeroom's header (Evan, 21 Oct 2026),
    // keeping it for a screen reader.
    assert.match(html, appTemplates.dirOf(id) === 'tier-list' ? /<h1 class="sr-only">\{\{APP_NAME\}\}<\/h1>/ : /<h1 class="text-title">\{\{APP_NAME\}\}<\/h1>/);
    // No CDN: every script and stylesheet is the app's own or the platform's, by path.
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/') || m[1].startsWith('data:'), `${id}: ${m[1]} is not fetched from another origin`);
    }
    // A ready-made app is the app: no "started from a template" notice to delete.
    assert.doesNotMatch(html, /usernode-starter-notice@1/);
    // Its script: plain DOM, people's words as text, the platform's token on every call.
    assert.doesNotThrow(() => new vm.Script(script), `${id}: app.js parses`);
    assert.doesNotMatch(script, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    assert.match(script, /var headers = \{ 'x-usernode-token': token \};/);
    assert.match(script, /if \(window\.usernode && window\.usernode\.previewNow\) headers\['x-usernode-now'\] = window\.usernode\.now\(\)\.toISOString\(\);/);
    assert.match(script, /\b\w+\.error === 'account_required'/, 'a guest\'s write is asked to make an account, not shown a code');
    // Homeroom's app frame allows no dialogs (no allow-modals), so confirm()
    // answers false unseen and the action never happens: ask in the page.
    assert.doesNotMatch(APP_FRAME_SANDBOX, /allow-modals/);
    assert.doesNotMatch(script.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(?:confirm|alert|prompt)\(/, `${id}: no browser dialogs`);
    // Its server half: mounted after the sign-in check, tables on boot,
    // staging rows only in staging and owned by fake identities, now from req.now.
    assert.doesNotThrow(() => new vm.Script(`(function (module, require, process) {${api}\n})`), `${id}: api.js parses`);
    assert.match(api, /module\.exports = \{ migrate, routes \};/);
    assert.match(api, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
    // The study timer seeds nothing: its only data is each viewer's own
    // count of finished sessions, and the staging conventions forbid
    // seeding rows the viewer owns. Its Today card starts empty in a
    // preview, which is the honest state for it.
    if (id !== 'study-timer') {
      assert.match(api, /if \(IS_STAGING\) \{[\s\S]*'staging-demo-user'/);
      assert.match(api, /'Staging demo /, 'seeded rows say so');
    }
    assert.doesNotMatch(api.replace(/\/\/.*$/gm, ''), /new Date\(\)/, 'now is req.now, not the server clock');
    assert.doesNotMatch(api, /err\.message \}\)/, 'a failure is logged, not sent to the screen');
    const server = file(files, 'server.js');
    assert.ok(server.indexOf("const api = require('./api');") > server.indexOf('app.use((req, res, next) => {'), 'after the sign-in check');
    assert.match(server, /await api\.migrate\(pool\);/);
    assert.match(server, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\);/);
    // Its manifest: the entry's icon and checks; its README and notes say what it is.
    const t = appTemplates.get(id);
    const manifest = JSON.parse(file(files, 'dapp.json'));
    assert.deepEqual(manifest.icon, { emoji: t.icon });
    assert.deepEqual(manifest.tests, JSON.parse(JSON.stringify(t.tests)));
    const readme = file(files, 'README.md');
    assert.match(readme, new RegExp(`ready-made\\s+> \\*\\*${t.title}\\*\\*`));
    for (const f of t.features) assert.ok(readme.includes(`- ${f}`), `${id}: README lists "${f.slice(0, 30)}"`);
    const claude = file(files, 'CLAUDE.md').replace(/\s+/g, ' ');
    assert.match(claude, new RegExp(`created from Homeroom's ready-made \\*\\*${t.title}\\*\\*`));
    assert.ok(claude.includes(`(${t.tables})`), `${id}: its tables are named`);
    // No em dashes in what the app says or what its notes say about it.
    for (const f of appTemplates.starterFiles(id)) assert.doesNotMatch(f.content, /\u2014/, `${id}: ${f.path}`);
    assert.doesNotMatch(JSON.stringify(t), /\u2014/);
  });

  test(`the ${id} app is drawn with the design kit only`, () => {
    const own = appTemplates.starterFiles(id).filter((f) => /^public\//.test(f.path));
    const src = own.map((f) => f.content.replace(/<!--[\s\S]*?-->/g, '')).join('\n');
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?!['"]?\))/, 'no raw hex colour');
    const stock = /(?<![\w:/-])(?:[a-z]+:)*(?:bg|text|border|ring|divide|from|via|to|accent|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
    assert.deepEqual([...src.matchAll(stock)].map((m) => m[0]), [], 'colour comes from the kit\'s tokens, never a stock palette class');
    assert.doesNotMatch(src, /\bdark:/, 'the tokens carry both looks');
    assert.doesNotMatch(src, /\buppercase\b|\btracking-/, 'no uppercase eyebrows');
    assert.match(src, /class="min-h-screen bg-ground text-fg"/);
    // Honest states: loading shapes, an error with Retry, an empty state.
    assert.match(src, /class="skeleton /);
    assert.match(src, /class="state-error card"[\s\S]*?>Retry<\/button>/);
    assert.match(src, /class="state-empty card"/);
  });

  test(`the ${id} app's declared checks are valid and select its own screen`, () => {
    const t = appTemplates.get(id);
    const parsed = appManifest.readTests({ tests: t.tests });
    assert.equal(parsed.length, t.tests.length, 'every check survives the manifest\'s own validation');
    const visual = parsed.filter((c) => c.visual);
    assert.equal(visual.length, 1, 'one visual flow its first proposals are compared on');
    assert.ok(visual[0].impact.length, 'with the files that change it');
    const own = appTemplates.starterFiles(id);
    const src = own.filter((f) => /^public\//.test(f.path)).map((f) => f.content).join('\n');
    for (const c of parsed) {
      for (const [, name] of c.expectSelector.matchAll(/#([\w-]+)/g)) assert.match(src, new RegExp(`id="${name}"|'${name}'`), `${id}: #${name}`);
      for (const [, attr] of c.expectSelector.matchAll(/\[(data-[\w-]+)/g)) assert.ok(src.includes(attr), `${id}: [${attr}]`);
    }
    // Each is reached on a staging preview through seeded rows: the API
    // seeds ids the screen draws. The study timer's count is each viewer's
    // own data (its table is staging:private) and starts empty in a
    // preview, which is what its check reads.
    if (id !== 'study-timer') {
      assert.match(own.find((f) => f.path === 'api.js').content, /VALUES\s*\(900001,/);
    }
  });
}

// The study timer keeps its session on the device and counts a finished one
// by the key it made when it started. It goes by the clock, not by counting
// ticks: what is left of a session is endsAt minus now, so a locked phone
// or a background tab still ends it at the right moment.
test('the study timer counts by the clock, keeps its key, and beeps from the browser', () => {
  const script = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'study-timer/public/app.js'), 'utf8');
  assert.match(script, /window\.usernode && window\.usernode\.now \? window\.usernode\.now\(\) : new Date\(\)/, 'now comes from the platform when it says so');
  assert.match(script, /AudioContext/, 'the beep is made by the browser, no sound file');
  assert.match(script, /'study-timer:session'/, 'the session is kept on the device across a reload');
  assert.match(script, /endsAt - now\(\)\.getTime\(\)/, 'what is left of a session is endsAt minus now');
  assert.doesNotMatch(script, /-=\s*\d+\s*;|--\)/, 'no countdown arithmetic: the interval only reads the clock');
  const api = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'study-timer/api.js'), 'utf8');
  assert.match(api, /ON CONFLICT \(user_id, client_key\) DO NOTHING/, 'a retried session counts once');
  assert.match(api, /staging:private/, 'each person’s study record is theirs, never seeded into a preview');
});

// ── The game starters ────────────────────────────────────────────────────

test('the game starters: not ready-made, built on the shared game room, and told to Homeroom bot', () => {
  const extra = require('../src/templates/node-app/extra-packages.json');
  for (const id of GAMES) {
    const t = appTemplates.get(id);
    assert.equal(t.kind, 'game', id);
    assert.equal(appTemplates.isReadyMade(id), false, `${id}: Homeroom bot still builds its first version`);
    assert.equal(appTemplates.botStarter(id), t, `${id}: the bot is told what it builds on`);
    assert.equal(t.shared, '_game-room');
    assert.deepEqual([...t.dependencies], ['ws']);
    for (const dep of t.dependencies) assert.ok(extra[dep] && extra[dep].packages[`node_modules/${dep}`], `${dep} is locked`);
    for (const k of ['title', 'summary', 'icon']) assert.ok(t[k], `${id}.${k}`);
    assert.ok(t.features.length >= 3, `${id} says what it already does`);
    assert.ok(t.bot.what && t.bot.build, `${id}: what it is, and what to keep`);
    assert.doesNotMatch(JSON.stringify(t), /—/, `${id}: no em dashes`);
  }
  for (const id of ['empty', ...READY, 'nope']) assert.equal(appTemplates.botStarter(id), null, id);
  // `ws` comes only with a game: every other app's package and lockfile
  // are the template's, untouched.
  const plain = generate('empty');
  for (const id of ['empty', ...READY]) {
    const files = generate(id);
    assert.equal(file(files, 'package.json'), file(plain, 'package.json'), id);
    assert.doesNotMatch(file(files, 'package-lock.json'), /node_modules\/ws/, id);
  }
});

// The starter's shared layer cache (services/kubernetes-buildkit.js) can
// serve a new app its `npm ci` steps only when its package files are the
// same bytes as every other copy's: no app's slug or name goes into them.
test('two apps made from the same starter have the same package files', () => {
  const other = (id) => getTemplateFiles('Another One', 'another-one-f00d42', null, 'https://github.com/example/another-one-f00d42', { template: id });
  for (const id of ['empty', ...READY, ...GAMES]) {
    const one = generate(id);
    const two = other(id);
    for (const p of ['package.json', 'package-lock.json']) {
      assert.equal(file(two, p), file(one, p), `${id}: ${p}`);
      assert.doesNotMatch(file(one, p), /demo-app-abc123|Demo App/, `${id}: ${p} names no app`);
    }
  }
});

for (const id of GAMES) {
  test(`the ${id} game starter is a whole repository on the platform's conventions`, () => {
    const t = appTemplates.get(id);
    const files = generate(id);
    for (const p of ['api.js', 'game/room.js', 'game/live.js', 'game/rules.js', 'public/index.html', 'public/app.js', 'public/game/room.js']) file(files, p);
    const html = file(files, 'public/index.html');
    assert.match(html, /usernode-dev-console@1/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">/);
    assert.match(html, /<script src="\/usernode-bridge\/v1\/bridge\.js"><\/script>/);
    assert.match(html, /window\.usernode && window\.usernode\.theme/);
    assert.match(html, /<script src="\/game\/room\.js"><\/script>\s*<script (?:type="module" )?src="\/app\.js"><\/script>\s*<\/body>/,
      'the game room\'s page side, then the game');
    // A title screen with the game's name, and the game's own scene,
    // styled after the kit (public/scene.css).
    assert.match(html, /<h1 class="[^"]*">\{\{APP_NAME\}\}<\/h1>/);
    assert.match(html, /<link rel="stylesheet" href="\/tailwind\.css">\s*<link rel="stylesheet" href="\/scene\.css">/);
    assert.match(file(files, 'public/scene.css'), /CLAUDE\.md "## Design"/, 'the scene says where its look is written down');
    assert.match(html, /id="title"[^>]*>/, 'a title screen');
    assert.match(html, /id="stage"[^>]*class="[^"]*\bfixed inset-0\b/, 'the game fills the screen');
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(m[1].startsWith('/') || m[1].startsWith('data:'), `${id}: ${m[1]} is not fetched from another origin`);
    }
    assert.doesNotMatch(html, /usernode-starter-notice@1/);
    // Honest states: loading shapes, an error with Retry, an empty state.
    assert.match(html, /class="skeleton /);
    assert.match(html, /class="state-error[^"]*"[\s\S]*?>Retry<\/button>/);
    assert.match(html, /class="state-empty[^"]*"/);
    assert.match(html, /<body class="min-h-screen bg-ground text-fg">/);
    // Its scripts: plain DOM, people's words as text, no browser dialogs.
    for (const p of ['public/app.js', 'public/game/room.js']) {
      const js = file(files, p);
      // The 3D starter's screen is an ES module: its import is the only module syntax.
      assert.doesNotThrow(() => new vm.Script(js.replace(/^import .*$/m, '')), `${id} ${p} parses`);
      assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|document\.write/, `${id} ${p}`);
      assert.doesNotMatch(js.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /\b(?:confirm|alert|prompt)\(/, `${id} ${p}: no browser dialogs`);
    }
    const room = file(files, 'public/game/room.js');
    assert.match(room, /var headers = \{ 'x-usernode-token': token \};/);
    assert.match(room, /\b\w+\.error === 'account_required'/, 'a guest\'s move is asked to make an account');
    assert.match(room, /usernode:visibility-changed/, 'quiet while Homeroom keeps it loaded but hidden');
    // Content rules: nothing on screen is a weapon, combat or gambling.
    const screen = files.filter((f) => /^public\//.test(f.path) && !/^public\/vendor\//.test(f.path)).map((f) => f.content).join('\n');
    assert.doesNotMatch(screen, /\b(?:guns?|weapons?|shoot(?:ing)?|bullets?|kill|enem(?:y|ies)|bombs?|explo(?:de|sion)|bet|wager|casino)\b/i, `${id}: content rules`);
    // Its server half: the room on boot, the live connection on the server.
    const api = file(files, 'api.js');
    assert.doesNotThrow(() => new vm.Script(`(function (module, require, process) {${api}\n})`), `${id}: api.js parses`);
    assert.match(api, /module\.exports = \{ migrate, routes, attach \};/);
    assert.match(api, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging';/);
    assert.match(api, /if \(IS_STAGING\) \{[\s\S]*?await room\.seed\(pool, \{/, 'staging rows, only in staging');
    for (const [, who] of api.matchAll(/username: '([^']+)'/g)) assert.match(who, /^staging-demo-/, `${id}: ${who} is obviously fake`);
    assert.match(api, /await room\.migrate\(pool\);[\s\S]*await room\.load\(pool\);/);
    assert.doesNotMatch(api.replace(/\/\/.*$/gm, ''), /new Date\(\)/);
    const server = file(files, 'server.js');
    assert.match(server, /const live = typeof api\.attach === 'function' \? api\.attach\(server\) : null;/);
    assert.match(server, /if \(live && typeof live\.close === 'function'\) live\.close\(\);/, 'its sockets close on SIGTERM');
    // `ws`, in both package.json and the lockfile `npm ci` installs from.
    const extra = require('../src/templates/node-app/extra-packages.json');
    const pkg = JSON.parse(file(files, 'package.json'));
    const lock = JSON.parse(file(files, 'package-lock.json'));
    assert.equal(pkg.dependencies.ws, extra.ws.range);
    assert.equal(lock.packages[''].dependencies.ws, extra.ws.range);
    assert.deepEqual(lock.packages['node_modules/ws'], extra.ws.packages['node_modules/ws']);
    assert.equal(lock.packages[''].name, 'usernode-app-template', 'the template\'s own name, not the app\'s');
    assert.deepEqual(Object.keys(lock.packages)[0], '', 'the root package first, as npm writes it');
    // Its manifest, README and notes.
    const manifest = JSON.parse(file(files, 'dapp.json'));
    assert.deepEqual(manifest.icon, { emoji: t.icon });
    assert.deepEqual(manifest.tests, JSON.parse(JSON.stringify(t.tests)));
    const readme = file(files, 'README.md');
    assert.match(readme, /> \*\*Game starter\.\*\* This repo was scaffolded by Homeroom from its/);
    for (const f of t.features) assert.ok(readme.includes(`- ${f}`), `${id}: README lists "${f.slice(0, 30)}"`);
    const claude = file(files, 'CLAUDE.md');
    assert.match(claude, new RegExp(`## Starter template: ${t.title}`));
    assert.match(claude, /Never delete the game room\s+layer to start over/);
    assert.match(claude, /`game\/rules\.js`: this game's rules/);
    assert.doesNotMatch(claude, /ready-made \*\*/, 'a game starter is not a ready-made app');
    // No em dashes anywhere the app says something (the vendored library aside).
    for (const f of appTemplates.starterFiles(id)) {
      if (!/^public\/vendor\/.*\.js$/.test(f.path)) assert.doesNotMatch(f.content, /—/, `${id}: ${f.path}`);
    }
  });

  test(`the ${id} game starter's declared checks are valid and select its own screen`, () => {
    const t = appTemplates.get(id);
    const parsed = appManifest.readTests({ tests: t.tests });
    assert.equal(parsed.length, t.tests.length);
    const visual = parsed.filter((c) => c.visual);
    assert.equal(visual.length, 1, 'one visual flow');
    assert.deepEqual(visual[0].impact, ['public/**', 'api.js', 'game/**']);
    const src = appTemplates.starterFiles(id).filter((f) => /^public\/.*\.(?:html|js)$/.test(f.path) && !/^public\/vendor\//.test(f.path))
      .map((f) => f.content).join('\n');
    for (const c of parsed) {
      for (const [, name] of c.expectSelector.matchAll(/#([\w-]+)/g)) assert.match(src, new RegExp(`id="${name}"|'${name}'`), `${id}: #${name}`);
      for (const [, attr] of c.expectSelector.matchAll(/\[(data-[\w-]+)/g)) assert.ok(src.includes(attr), `${id}: [${attr}]`);
    }
  });
}

test('the 3D blocks starter carries three.js itself, copied exactly, and never from a CDN', () => {
  const files = appTemplates.starterFiles('game-blocks');
  const three = file(files, 'public/vendor/three.module.min.js');
  const onDisk = fs.readFileSync(path.join(appTemplates.STARTERS_DIR, 'game-blocks/public/vendor/three.module.min.js'), 'utf8');
  assert.equal(three, onDisk, 'never touched by placeholder filling');
  assert.match(three.slice(0, 200), /@license[\s\S]*Three\.js Authors[\s\S]*MIT/);
  assert.match(three, /REVISION|"186"/);
  assert.ok(three.length < 800 * 1024, 'one minified module');
  assert.match(file(files, 'public/vendor/README.md'), /three\.js\]\(https:\/\/threejs\.org\) 0\.186\.1/);
  assert.match(file(files, 'public/app.js'), /^import \* as THREE from '\.\/vendor\/three\.module\.min\.js';$/m);
});

// ── Each game's rules, as plain functions ────────────────────────────────

const rulesOf = (dir) => require(path.join(appTemplates.STARTERS_DIR, dir, 'game/rules.js'));
const seq = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test('the board game: turns, a six rolls again, shortcuts and slides, a roll made for somebody away', () => {
  const r = rulesOf('game-board');
  const players = [{ id: 1, username: 'ana' }, { id: 2, username: 'ben' }];
  let g = r.setup({ players, now: 0 });
  const ctx = (id, roll, now = 0, here = true) => ({ player: { id }, now, random: () => (roll - 1) / 6 + 0.01, isOnline: () => here });
  assert.equal(r.act(g, { type: 'roll' }, ctx(2, 3)).error, 'It is not your turn yet.');
  g = r.act(g, { type: 'roll' }, ctx(1, 6)).game;
  assert.deepEqual([g.pieces[1].pos, g.turn], [6, 0], 'a six rolls again');
  g = r.act(g, { type: 'roll' }, ctx(1, 2)).game;
  assert.deepEqual([g.pieces[1].pos, g.lastMove.landed, g.turn], [20, 8, 1], 'square 8 is a shortcut to 20');
  g = r.act(g, { type: 'roll' }, ctx(2, 3)).game;
  assert.equal(g.pieces[2].pos, 15, 'square 3 is a shortcut to 15');
  g = r.act(g, { type: 'roll' }, ctx(1, 3)).game;
  assert.deepEqual([g.pieces[1].pos, g.lastMove.landed], [11, 23], 'square 23 is a slide to 11');
  // Away: their roll is made for them after a moment, never before.
  assert.equal(r.update(g, { now: 1000, random: () => 0.1, isOnline: () => false }), null);
  const auto = r.update(g, { now: 3000, random: () => 0.1, isOnline: () => false });
  assert.match(auto.log[0].text, /^@ben rolled 1 \(rolled for them\)/);
  // Reaching the finish wins: the winner first, then by how far they got.
  g.pieces[1].pos = 27;
  g.turn = 0;
  g = r.act(g, { type: 'roll' }, ctx(1, 5)).game;
  assert.deepEqual(r.result(g).map((x) => [x.username, x.place]), [['ana', 1], ['ben', 2]]);
  assert.equal(r.act(g, { type: 'roll' }, ctx(2, 1)).error, 'This game is over.');
  // Leaving mid-game: their turn passes on.
  let h = r.setup({ players, now: 0 });
  h = r.removePlayer(h, 1, { now: 5 });
  assert.deepEqual([h.order, h.turn, h.turnAt], [[2], 0, 5]);
});

test('trivia: the author never answers or sees the answer early; quick and known answers score', () => {
  const r = rulesOf('game-trivia');
  const bank = [{ id: 1, authorId: 2, author: 'ben', text: 'My pet?', answer: 'Cat', wrong: ['Dog', 'Fish'] }];
  assert.match(r.setup({ players: [{ id: 2, username: 'ben' }], random: Math.random, now: 0, extra: bank }).error, /about you/);
  assert.match(r.setup({ players: [{ id: 1, username: 'ana' }], random: Math.random, now: 0, extra: [] }).error, /Write a question/);
  let g = r.setup({ players: [{ id: 1, username: 'ana' }, { id: 2, username: 'ben' }], random: seq(0.1, 0.9, 0.5), now: 0, extra: bank });
  const v = r.view(g, 1);
  assert.equal(v.question.correct, null, 'no answer before it shows');
  assert.equal(v.picks, null);
  const at = (id, now) => ({ player: { id }, now, random: Math.random, isOnline: () => true });
  assert.match(r.act(g, { type: 'answer', choice: 0 }, at(2, 100)).error, /about you/);
  const right = g.questions[0].correct;
  g = r.act(g, { type: 'answer', choice: right }, at(1, 10000)).game;
  assert.equal(g.stage, 'reveal', 'everyone here answered: no waiting out the clock');
  assert.deepEqual(g.points, { 1: 100 + 25, 2: 25 }, 'half the clock left: 25 for speed; the author 25 for being known');
  assert.equal(r.view(g, 1).question.correct, right);
  assert.equal(r.update(g, { now: 10001 }), null, 'the answer shows for a while');
  g = r.update(g, { now: 20000 });
  assert.equal(g.done, true);
  assert.deepEqual(r.result(g).map((x) => [x.username, x.score, x.place]), [['ana', 125, 1], ['ben', 25, 2]]);
});

test('the space game: storms of sparks made of numbers, stardust to collect, a hit costs a shield, out of shields the ship is out', () => {
  const r = rulesOf('game-space');
  const players = [{ id: 1, username: 'ana' }, { id: 2, username: 'ben' }];
  let g = r.setup({ players, now: 0 });
  const random = seq(0.5, 0.2, 0.8, 0.35);
  const fly = (to) => {
    for (let t = g.now + 50; t <= to; t += 50) {
      for (const ship of Object.values(g.ships)) ship.seenAt = t;
      g = r.tick(g, 50, { now: t, random });
    }
  };
  fly(4000);
  // A storm: a pulsar that drifts in from above and throws sparks in a
  // pattern. The frame carries its numbers, not a position for each spark.
  assert.equal(g.storms.length, 1, 'one storm at a time in the first sector');
  const s = g.storms[0];
  assert.equal(s.kind, 'ring', 'the first sector\'s storms are rings');
  assert.equal(r.pulsarAt(s, s.t0).y, -60, 'from above the field');
  assert.equal(r.pulsarAt(s, s.t0 + s.enter).y, s.ys);
  const f = r.frame(g);
  assert.deepEqual(Object.keys(f.storms[0]).filter((k) => ['interval', 'n', 'rot', 'spread', 'v', 'curve', 'a0'].includes(k)).length, 7);
  assert.ok(f.dust.length >= 2, 'stardust drifts down');
  assert.ok(g.ships[1].score > 0, 'time flown scores');
  // Later sectors bring more storms, and fans aimed at the nearest ship.
  fly(95000);
  assert.equal(g.sector, 4);
  assert.ok(g.bursts.some((b) => b.colour === 4), 'comet showers');
  // A ship's own page says where it is, within the speed limit.
  const was = { x: g.ships[1].x, y: g.ships[1].y };
  g = r.input(g, { id: 1 }, { x: was.x + 900, y: was.y }, { now: g.now });
  assert.deepEqual([g.ships[1].x, g.ships[1].y], [was.x, was.y], 'a jump is not believed');
  g = r.input(g, { id: 1 }, { x: was.x + 20, y: was.y - 10 }, { now: g.now + 50 });
  assert.deepEqual([g.ships[1].x, g.ships[1].y], [was.x + 20, was.y - 10]);
  // Stardust close to your ship is yours, once; far away, it is not.
  const d = g.dust[g.dust.length - 1];
  const at = r.dustAt(d, g.now);
  g.ships[2].x = at.x + 400;
  g.ships[2].y = at.y;
  assert.equal(r.act(g, { type: 'collect', id: d.id }, { player: { id: 2 }, now: g.now }).event, undefined, 'too far');
  g.ships[2].x = at.x + 20;
  const got = r.act(g, { type: 'collect', id: d.id }, { player: { id: 2 }, now: g.now });
  assert.deepEqual([got.event, got.game.ships[2].dust], [{ type: 'dust', id: d.id, by: 2 }, 1]);
  assert.equal(r.act(got.game, { type: 'collect', id: d.id }, { player: { id: 1 }, now: g.now }).event, undefined, 'gone');
  // A hit costs a shield, then a moment of cover; out of shields, the ship is out.
  let now = g.now;
  let out = r.act(g, { type: 'hit' }, { player: { id: 1 }, now });
  assert.deepEqual(out.event, { type: 'hit', id: 1, shields: 2 });
  assert.equal(r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now: now + 100 }).game.ships[1].shields, 2, 'covered');
  out = r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now: (now += 2500) });
  out = r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now: (now += 2500) });
  assert.deepEqual([out.game.ships[1].shields, out.game.ships[1].out, out.game.over], [0, true, false], 'the others fly on');
  assert.match(r.act(out.game, { type: 'hit' }, { player: { id: 1 }, now }).error, /out of this run/);
  assert.match(r.act(out.game, { type: 'fire' }, { player: { id: 2 }, now }).error, /not a move/);
  // The run ends when every ship is out: each pilot's own score, highest first.
  g = r.removePlayer(out.game, 2);
  assert.equal(g.over, true);
  const res = r.result(g);
  assert.deepEqual(res.map((x) => x.place), [1, 2]);
  assert.ok(res[0].score >= res[1].score);
  assert.deepEqual(res.map((x) => x.username).sort(), ['ana', 'ben']);
});

test('the block world: blocks inside the world, one per cell, sent to everyone as an event', () => {
  const r = rulesOf('game-blocks');
  let g = r.setup();
  const me = { player: { id: 1, username: 'ana' } };
  const out = r.act(g, { type: 'place', x: 1, y: 0, z: 2, c: 3 }, me);
  assert.deepEqual(out.event, { type: 'place', x: 1, y: 0, z: 2, c: 3, by: 'ana' });
  g = out.game;
  assert.match(r.act(g, { type: 'place', x: 1, y: 0, z: 2, c: 1 }, me).error, /already/);
  assert.match(r.act(g, { type: 'place', x: r.SIZE.x, y: 0, z: 0, c: 1 }, me).error, /outside/);
  assert.match(r.act(g, { type: 'place', x: 0, y: 0, z: 0, c: r.BLOCKS }, me).error, /Pick a block/);
  assert.match(r.act(g, { type: 'remove', x: 9, y: 9, z: 9 }, me).error, /no block/);
  assert.deepEqual(r.view(g).blocks, [[1, 0, 2, 3]]);
  g = r.act(g, { type: 'remove', x: 1, y: 0, z: 2 }, me).game;
  assert.equal(g.count, 0);
  // Where each builder is flying, which way they face, and their block.
  g = r.input(g, { id: 1, username: 'ana' }, { x: 3.04, y: 6.5, z: -4.2, yaw: 1.234, c: 2 }, { now: Date.now() });
  assert.deepEqual(r.frame(g).builders, [[1, 'ana', 3, 6.5, -4.2, 1.23, 2]]);
  assert.deepEqual(r.view(g).builders, r.frame(g).builders, 'a plain request sees them too');
  g = r.input(g, { id: 1, username: 'ana' }, { x: 500, y: 1, z: 1 }, { now: Date.now() });
  assert.deepEqual(r.frame(g).builders, [], 'nobody is far outside the world');
  assert.equal(r.open, true, 'always on: no lobby');
  assert.equal(r.result(g), null, 'never over');
});
