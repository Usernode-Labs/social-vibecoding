'use strict';

// INVITE | APP on the made screen's card
// (frontend/src/features/first-session/made.tsx).
//
// Evan, 15 October 2026: "on the corner of the thumbnail, a toggle to switch
// between the share preview and what the app looks like; for templated apps
// have an example ready that shows this immediately". Then: the switch is on
// the made screen's own card only, never on the invite sheet, and it starts
// on App whenever there is a picture.
//
// A ready-made app's picture is its example (services/app-templates.js
// `exampleScreen`, drawn by scripts/render-starter-examples.js and answered
// by POST /api/apps), tagged "Example". A project Homeroom bot builds has
// its first look once it is drawn, with no tag. An import has none, and
// with no picture the card has no switch and is the card it always was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
const appTemplates = require('../src/services/app-templates');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const made = loadTsx(`${DIR}/made.tsx`);
const MADE_SRC = read(`${DIR}/made.tsx`);

const EXAMPLE = '/illustrations/starters/tier-list-restaurants.png';
const READY = {
  slug: 'restaurant-tier-list', name: 'Restaurant Tier List', emoji: '📊', description: 'A restaurant tier list',
  example: null, conversationId: null, readyMade: true, exampleScreen: EXAMPLE,
};
const BOT = { slug: 'plant-pal', name: 'Plant Pal', emoji: '🪴', description: null, example: null, conversationId: 12 };
const LOOK = '/api/apps/plant-pal/first-version/screens/first_look/0?v=3';
const DRAWN = '/api/apps/plant-pal/first-version/first-look/drawn?v=3';

const draw = (m) => renderToHtml(createElement(made.MadeScreen, { made: m, me: 'maya', onContinue() {}, onOpenChat() {} }));
const switchOf = (value) => createElement(made.CardViewSwitch, { value, onChange() {} });

test('a picture of the app is a ready-made app\'s example or the first look; an import has none', () => {
  const { appPictureOf } = made;
  const at = { imported: false, readyMade: false, botBuilds: false, exampleScreen: null, look: null };
  assert.deepEqual(appPictureOf({ ...at, readyMade: true, exampleScreen: EXAMPLE }), { src: EXAMPLE, example: true });
  assert.equal(appPictureOf({ ...at, readyMade: true }), null, 'a ready-made app without one');
  assert.equal(appPictureOf({ ...at, readyMade: true, look: LOOK }), null, 'a ready-made app has no first look to show');
  assert.deepEqual(appPictureOf({ ...at, botBuilds: true, look: LOOK }), { src: LOOK, example: false }, 'their own app: no tag');
  assert.deepEqual(appPictureOf({ ...at, botBuilds: true, look: DRAWN }), { src: DRAWN, example: false });
  assert.equal(appPictureOf({ ...at, botBuilds: true }), null, 'before the first look is drawn');
  assert.equal(appPictureOf({ ...at, imported: true, botBuilds: true, look: LOOK, exampleScreen: EXAMPLE }), null, 'an import');
  assert.equal(appPictureOf({ ...at, look: LOOK }), null, 'a project the bot does not build');
});

test('the card starts on App whenever there is a picture, and a side somebody picks stays picked', () => {
  const { cardViewOf } = made;
  const picture = { src: EXAMPLE, example: true };
  assert.equal(cardViewOf(picture, null), 'app');
  assert.equal(cardViewOf(picture, 'invite'), 'invite');
  assert.equal(cardViewOf(picture, 'app'), 'app');
  assert.equal(cardViewOf(null, null), 'invite', 'no picture: the invite, with no switch');
  assert.equal(cardViewOf(null, 'app'), 'invite', 'a picture that went away takes the App side with it');
  // A first look that arrives later turns an untouched card to App.
  assert.match(MADE_SRC, /const \[pickedView, setPickedView\] = useState<CardView \| null>\(null\);\n\s+const view = cardViewOf\(picture, pickedView\);/);
  assert.match(MADE_SRC, /const viewSwitch = picture \? <CardViewSwitch value=\{view\} onChange=\{setPickedView\} \/> : null;/);
});

test('a ready-made app\'s card opens on its example: the phone, "Example", no note, and the switch on App', () => {
  const html = draw(READY);
  assert.match(html, /<div data-first-session-card="app" class="relative flex flex-col items-center overflow-hidden rounded-\[20px\]/);
  assert.match(html, /<div role="group" aria-label="Show the invite or the app" data-first-session-card-switch="app" class="flex rounded-full bg-black\/55 p-0\.5 text-\[12px\] font-semibold leading-4">/);
  assert.match(html, /<button type="button" data-card-view="invite" aria-current="false" class="[^"]*text-white">Invite<\/button>/);
  assert.match(html, /<button type="button" data-card-view="app" aria-current="page" class="[^"]*bg-white text-zinc-900">App<\/button>/);
  assert.match(html, /data-first-session-app-screen="example"/);
  assert.match(html, /<img src="\/illustrations\/starters\/tier-list-restaurants\.png" alt="An example of Restaurant Tier List&#x27;s main screen, with sample entries" draggable="false"/);
  assert.match(html, /<span data-first-session-example-tag="" class="pointer-events-none absolute left-3 top-3 [^"]*">Example<\/span>/);
  // The picture shows the app, so its name and description are not said
  // over it; and there is no note under it (20 Oct 2026: "It works as it
  // is..." read as random).
  assert.doesNotMatch(html, />Restaurant Tier List<\/p>|>A restaurant tier list<\/p>/);
  assert.doesNotMatch(html, /app-icon-tile flex h-20/);
  assert.doesNotMatch(html, /It works as it is/);
  // Before "Example", the switch, in the card; the invite buttons still under it.
  assert.ok(html.indexOf('data-first-session-example-tag') < html.indexOf('data-first-session-card-switch'));
  assert.match(html, />Share invite<\/button>/);
});

test('Invite is today\'s card: the icon tile, the name and the description, with the switch in its corner', () => {
  const card = (props, children) => renderToHtml(createElement(made.PlainCard, { made: READY, tile: '📊', emoji: '📊', ...props }, children));
  const today = card({});
  // No picture: the card it always was, with no switch and no side named.
  assert.match(today, /^<div class="relative flex flex-col items-center rounded-\[20px\] bg-white px-6 py-7 text-center shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] dark:bg-zinc-900"><span class="app-icon-tile flex h-20 w-20 items-center justify-center rounded-\[22px\] text-5xl" aria-hidden="true">📊<\/span><p class="mt-3 text-\[22px\] font-extrabold leading-tight">Restaurant Tier List<\/p><p class="mt-1 text-\[15px\] text-zinc-500 dark:text-zinc-400">A restaurant tier list<\/p><\/div>$/);
  assert.doesNotMatch(today, /data-first-session-card|data-card-view/);
  const invite = card({ corner: switchOf('invite') });
  // With the switch, the App side's card, its top the band's height: the
  // switch over its corner and the icon below it (pt-10), so the two never
  // meet (Evan, sign-up test, 19 Oct 2026: switching moved the screen).
  assert.match(invite, /^<div data-first-session-card="invite" class="relative flex flex-col items-center overflow-hidden rounded-\[20px\] bg-white px-6 pb-6 /);
  assert.match(invite, /<div data-first-session-card-top="" class="relative -mx-6 flex flex-col items-center justify-center self-stretch px-6 pt-10 h-\[264px\]"><div class="absolute right-3 top-3 z-10"><div role="group" aria-label="Show the invite or the app" data-first-session-card-switch="invite"/);
  assert.match(invite, /data-card-view="invite" aria-current="page"/);
  // Past the switch, the same tile, name and description as today's card,
  // each of the two clamped to two lines so a long one stays in the box.
  const face = invite.replace(/^<div [^>]*><div [^>]*>/, '').replace(/^<div class="absolute right-3 top-3 z-10">.*?<\/div><\/div>/, '');
  assert.match(face, /^<span class="app-icon-tile[^"]*"[^>]*>📊<\/span><p class="mt-3 line-clamp-2 text-\[22px\] font-extrabold leading-tight">Restaurant Tier List<\/p><p class="mt-1 line-clamp-2 text-\[15px\] /);
  assert.equal(face.replace(/ line-clamp-2/g, '').replace(/<\/div><\/div>$/, '</div>'), today.replace(/^<div [^>]*>/, ''));
  assert.doesNotMatch(invite, /data-first-session-app-screen|<img /);
  // App: the band to the card's edges in their place, the switch over it.
  const app = card({ corner: switchOf('app'), band: createElement(made.AppScreen, { picture: { src: EXAMPLE, example: true }, name: READY.name }) });
  // (React's server render puts a preload for the picture first.)
  assert.match(app, /^(?:<link rel="preload" as="image" href="[^"]+"\/>)?<div data-first-session-card="app" class="relative flex flex-col items-center overflow-hidden rounded-\[20px\] bg-white px-6 pb-6 /);
  assert.match(app, /<div class="relative -mx-6 self-stretch overflow-hidden bg-zinc-200 dark:bg-zinc-800 h-\[264px\]"/);
  assert.doesNotMatch(app, /app-icon-tile|Restaurant Tier List<\/p>/);
  // ONE HEIGHT: both sides are the same card, whose top is 264px on each,
  // so what follows it (the note) starts at the same place and nothing
  // under the card moves when the side changes.
  const outer = (html) => html.replace(/^<link [^>]*\/>/, '').match(/^<div data-first-session-card="(?:invite|app)" class="([^"]+)">/)[1];
  assert.equal(outer(invite), made.PLAIN_CARD_APP);
  assert.equal(outer(app), made.PLAIN_CARD_APP);
  assert.match(made.PLAIN_INVITE_TOP, new RegExp(` ${made.APP_BAND.replace(/[[\]]/g, '\\$&')}$`));
  assert.doesNotMatch(made.PLAIN_CARD_APP, /\bp[ty]-/, 'no padding above the top on either side');
  const note = createElement('p', null, 'The note');
  for (const html of [card({ corner: switchOf('invite') }, note), card({ corner: switchOf('app'), band: createElement('span', null, 'x') }, note)]) {
    assert.match(html, /h-\[264px\]"[^]*<\/div><p>The note<\/p><\/div>$/, 'the note right after the 264px top');
  }
  assert.match(MADE_SRC, /<PlainCard made=\{made\} tile=\{tile\} emoji=\{sketch\.card\?\.emoji \|\| made\.emoji \|\| null\} band=\{appScreen\} corner=\{viewSwitch\}>/);
});

test('no picture, no switch: an import, a ready-made app without one, and a project the bot builds before its first look', () => {
  for (const [label, m] of [
    ['a ready-made app without a picture', { ...READY, exampleScreen: undefined }],
    ['an import', { ...BOT, conversationId: null, imported: true, exampleScreen: EXAMPLE }],
    ['a project the bot builds, nothing drawn yet', BOT],
  ]) {
    const html = draw(m);
    assert.doesNotMatch(html, /data-first-session-card-switch|data-first-session-app-screen|data-first-session-example-tag|data-first-session-card=/, label);
  }
  // The ready-made one is the card it always was.
  assert.match(draw({ ...READY, exampleScreen: undefined }), /<span class="app-icon-tile flex h-20 w-20 [^"]*" aria-hidden="true">📊<\/span><p class="mt-3 text-\[22px\] font-extrabold leading-tight">Restaurant Tier List<\/p>/);
});

test('the first look is the App side of a project Homeroom bot builds: in the sketch\'s band, untagged, with no name under it', () => {
  const own = renderToHtml(createElement(made.AppScreen, { picture: { src: LOOK, example: false }, name: 'Plant Pal' }));
  assert.match(own, /data-first-session-app-screen="own"/);
  assert.match(own, /<img src="\/api\/apps\/plant-pal\/first-version\/screens\/first_look\/0\?v=3" alt="The first look at Plant Pal&#x27;s main screen"/);
  assert.doesNotMatch(own, /data-first-session-example-tag|Example/);
  // A first look only drawn so far is framed, as everywhere it shows.
  const drawn = renderToHtml(createElement(made.AppScreen, { picture: { src: DRAWN, example: false }, name: 'Plant Pal' }));
  assert.match(drawn, /data-first-look-drawn=""/);
  assert.match(drawn, /<iframe src="\/api\/apps\/plant-pal\/first-version\/first-look\/drawn\?v=3"[^>]* sandbox=""/);
  // The sketch's card: the band alone at the made screen's height, with the
  // switch over its corner; the App tab's FeaturedCard keeps its 340px band
  // and its name under it.
  const { SketchCard, FeaturedCard } = loadTsx(`${DIR}/sketch-card.tsx`);
  const sketch = { state: 'ready', card: { emoji: '🪴', tagline: 'Water reminders for the whole flat.', points: [] } };
  const band = createElement(made.AppScreen, { picture: { src: LOOK, example: false }, name: 'Plant Pal' });
  const app = renderToHtml(createElement(SketchCard, { made: BOT, sketch, line: null, band, bandClassName: made.APP_BAND, bandCorner: switchOf('app') }));
  assert.match(app, /h-\[264px\]">/);
  assert.match(app, /data-first-session-app-screen="own"/);
  assert.match(app, /<div class="absolute right-3 top-3 z-10"><div role="group" aria-label="Show the invite or the app" data-first-session-card-switch="app"/);
  assert.doesNotMatch(app, /Water reminders for the whole flat\.|>Plant Pal<\/p>/);
  const invite = renderToHtml(createElement(SketchCard, { made: BOT, sketch, line: null, bandClassName: made.APP_BAND, bandCorner: switchOf('invite') }));
  assert.match(invite, /h-\[148px\] pt-10">/, 'the icon below the switch');
  // ONE HEIGHT: with the switch, the card is the band's height on both
  // sides, its name and line inside it, so switching moves nothing under it.
  const cardClass = (html) => html.match(/<div data-featured-card="ready" class="([^"]+)">/)[1];
  assert.match(cardClass(invite), / flex flex-col h-\[264px\]$/);
  assert.equal(cardClass(invite), cardClass(app));
  assert.match(invite, />Plant Pal<\/p>/);
  assert.match(invite, /Water reminders for the whole flat\./);
  assert.match(invite, /data-first-session-card-switch="invite"/);
  const appTab = renderToHtml(createElement(FeaturedCard, { name: 'Plant Pal', colorKey: 'plant-pal', emoji: '🪴', card: sketch.card, band: createElement('span', null, 'screens') }));
  assert.match(appTab, /h-\[340px\]">/);
  assert.match(appTab, />Plant Pal<\/p>/);
  // The App tab's icon with its Preview | Live switch and no band stays as it was.
  const appTabIcon = renderToHtml(createElement(FeaturedCard, { name: 'Plant Pal', colorKey: 'plant-pal', emoji: '🪴', card: sketch.card, bandCorner: createElement('span', null, 'switch') }));
  assert.match(appTabIcon, /h-\[132px\]">/);
  // Neither is held to one height: only the made screen's switch is.
  for (const html of [appTab, appTabIcon]) assert.doesNotMatch(cardClass(html), /flex-col|h-\[/);
  // Nor the made screen's card before there is a picture (no switch).
  assert.doesNotMatch(cardClass(renderToHtml(createElement(SketchCard, { made: BOT, sketch, line: null, bandClassName: made.APP_BAND }))), /flex-col|h-\[/);
  // The made screen hands the first look it already reads to the card.
  assert.match(MADE_SRC, /const picture = appPictureOf\(\{ imported, readyMade, botBuilds, exampleScreen: brokenExample \? null : made\.exampleScreen, look: lookShown \}\);/);
});

test('one picture at a time: while the card shows the first look, the first look card keeps its words and leaves its phone out', () => {
  const progress = { setup: false, words: 'Building it', note: 'It’s set up.', busy: true, asks: false };
  const both = renderToHtml(createElement(made.FirstLookCard, { src: LOOK, name: 'Plant Pal', progress }));
  assert.match(both, /data-made-first-look-phone=/);
  assert.doesNotMatch(both, /data-made-first-look-above/);
  const words = renderToHtml(createElement(made.FirstLookCard, { src: LOOK, name: 'Plant Pal', progress, phone: false }));
  assert.match(words, /<section data-made-first-look="ready" data-made-first-look-above="" aria-labelledby="made-first-look-title" class="relative">/);
  assert.doesNotMatch(words, /data-made-first-look-phone|<img |<iframe /);
  // Its words and progress stay, in the same row at the same height.
  assert.match(words, new RegExp(`<div class="${made.FIRST_LOOK_ROW.replace(/[[\]().]/g, '\\$&')}">`));
  assert.match(words, />First look<\/p>/);
  assert.match(words, />Here&#x27;s what Homeroom bot is making<\/h2>/);
  assert.match(words, /data-made-first-look-status="stage"/);
  assert.match(words, />Building it<\/p>/);
  // Only while the App side shows the first look: on Invite, or with a
  // ready-made app's example, the first look card draws its phone.
  assert.match(MADE_SRC, /const lookInCard = !!appScreen && !!picture && !picture\.example;/);
  assert.match(MADE_SRC, /<FirstLookCard src=\{lookShown\} name=\{made\.name\} progress=\{lookProgress\} onBroken=\{setBrokenLook\} phone=\{!lookInCard\} onOpen=\{\(\) => onOpenChat\(made\.conversationId\)\} \/>/);
  assert.match(MADE_SRC, /const appScreen = picture && view === 'app'\n/);
});

test('tapping the first look opens the maker\'s chat with Homeroom bot (#5618)', () => {
  const progress = { setup: false, words: 'Building it', note: 'It’s set up.', busy: true, asks: false };
  const open = message('onboarding:firstSession.made.firstLook.open');
  assert.equal(open, 'Open your chat with Homeroom bot');
  // Without onOpen (any other reader) the card is what it was: no door.
  const plain = renderToHtml(createElement(made.FirstLookCard, { src: LOOK, name: 'Plant Pal', progress }));
  assert.doesNotMatch(plain, /data-made-first-look-open|<button/);
  // With it, one empty button covers the card: no invalid content inside it,
  // so a tap on the picture, the words or the progress is the card's tap.
  const calls = [];
  const card = renderToHtml(createElement(made.FirstLookCard, { src: LOOK, name: 'Plant Pal', progress, onOpen: () => calls.push('open') }));
  assert.match(card, /<button type="button" data-made-first-look-open="" aria-label="Open your chat with Homeroom bot" class="absolute inset-0 z-\[1\] rounded-\[20px\] [^"]*"><\/button><\/section>$/,
    'the door, empty, as the section\'s last child');
  // It covers the phone's picture and its iframe, which take pointer events.
  assert.match(MADE_SRC, /className="absolute inset-0 z-\[1\] rounded-\[20px\] hover:bg-black\/\[0\.03\] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:hover:bg-white\/\[0\.04\]"/);
  // The made screen hands it its own chat opener, and the card only shows
  // when the bot builds it (made.conversationId is set).
  assert.match(MADE_SRC, /onOpen=\{\(\) => onOpenChat\(made\.conversationId\)\}/);
  assert.match(MADE_SRC, /export function firstLookHereFor\(\{ botBuilds, imported, readyMade, entry \}[^]*?return botBuilds && !imported && !readyMade && entry !== 'create';/);
});

test('the switch never meets the icon: on the Invite side the icon starts below it, at any width', () => {
  // The switch: 12px from the top (top-3), 24px buttons in a 2px track: it
  // ends 40px down. The plain card's Invite side centres its icon below
  // 40px (pt-10) in a top as tall as the App side's band; the sketch's band
  // puts its icon below 40px (pt-10) in a band 16px taller; the App side's
  // phone stands 50px down (264 - 10 - 204), its 4px frame 46px.
  assert.equal(made.CARD_CORNER, 'absolute right-3 top-3 z-10');
  assert.match(MADE_SRC, /const CARD_SWITCH_SIDE = 'min-h-\[24px\] rounded-full px-2\.5 py-1';/);
  assert.match(made.CARD_SWITCH, / p-0\.5 /);
  assert.match(made.PLAIN_INVITE_TOP, / justify-center [^]* pt-10 h-\[264px\]$/);
  // What the Invite side's top holds, at most: the 80px tile, 12px, two
  // 27.5px lines of name, 4px and two 22.5px lines of description, under
  // the 40px it leaves the switch: 236px, inside 264.
  assert.ok(40 + 80 + 12 + 2 * 27.5 + 4 + 2 * 22.5 <= 264);
  assert.equal(made.PLAIN_CARD_SWITCH, undefined, 'retired: the Invite side is the App side\'s card');
  assert.equal(made.APP_BAND, 'h-[264px]');
  assert.match(made.APP_PHONE, /^relative h-\[204px\] w-\[94px\] /);
  assert.match(MADE_SRC, /className="absolute inset-0 flex items-end justify-center pb-2\.5">/);
  assert.match(read(`${DIR}/sketch-card.tsx`), /cornerRoom && bandCorner \? 'h-\[148px\] pt-10' : 'h-\[132px\]'/);
});

test('the invite sheet has no switch: what they\'ll see is the icon', () => {
  const html = renderToHtml(createElement(made.InviteSheet, { made: READY, me: 'maya', onClose() {}, onSent() {} }));
  assert.match(html, /What they&#x27;ll see/);
  assert.match(html, /app-icon-tile/);
  assert.doesNotMatch(html, /data-first-session-card-switch|data-first-session-app-screen|data-first-session-example-tag|illustrations\/starters/);
  const sheet = MADE_SRC.slice(MADE_SRC.indexOf('export function InviteSheet('), MADE_SRC.indexOf('export function PlanWaitsCard('));
  assert.ok(sheet.length > 500, 'the sheet is findable');
  assert.doesNotMatch(sheet, /CardViewSwitch|AppScreen|exampleScreen/);
});

test('the switch is the shell\'s tab strip, worn like the App tab\'s Preview | Live switch, and its words are the catalog\'s', () => {
  assert.match(MADE_SRC, /import \{ Tabs, TabsList, TabsTrigger \} from '@\/components\/ui\/tabs';/);
  assert.equal(made.CARD_SWITCH, 'flex rounded-full bg-black/55 p-0.5 text-[12px] font-semibold leading-4');
  assert.match(read('frontend/src/features/app-frame/live-switch.tsx'), /className="flex rounded-full bg-black\/55 p-0\.5 text-\[12px\] font-semibold leading-4"/);
  assert.equal(message('onboarding:firstSession.made.cardView.invite'), 'Invite');
  assert.equal(message('onboarding:firstSession.made.cardView.app'), 'App');
  assert.equal(message('onboarding:firstSession.made.cardView.example'), 'Example');
  assert.equal(message('onboarding:firstSession.made.cardView.label'), 'Show the invite or the app');
  for (const id of ['label', 'invite', 'app', 'example', 'exampleAlt']) {
    assert.doesNotMatch(message(`onboarding:firstSession.made.cardView.${id}`, { app: 'X' }), /—/, id);
  }
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('every ready-made app has an example picture on disk: its screen at a phone\'s size, small enough for a first session', () => {
  for (const id of appTemplates.READY_IDS) {
    const entry = appTemplates.get(id);
    assert.equal(entry.exampleScreen, `/illustrations/starters/${id}.png`, id);
    const file = path.join(ROOT, 'public', entry.exampleScreen);
    assert.ok(fs.existsSync(file), `${id}: ${entry.exampleScreen} is committed`);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${id}: a PNG`);
    // IHDR: 390 x 844 CSS px at 2x, as scripts/render-starter-examples.js draws it.
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [780, 1688], `${id}: 2x a 390 x 844 phone`);
    assert.ok(bytes.length < 150 * 1024, `${id}: ${bytes.length} bytes`);
  }
  // Only a ready-made app has one: a game starter is built by Homeroom bot,
  // whose first look is its picture.
  for (const id of appTemplates.TEMPLATE_IDS) {
    if (!appTemplates.isReadyMade(id)) assert.equal(appTemplates.get(id).exampleScreen, undefined, id);
  }
  // No picture without an entry, and the script that draws them knows every one.
  const committed = fs.readdirSync(path.join(ROOT, 'public/illustrations/starters')).sort();
  assert.deepEqual(committed, appTemplates.READY_IDS.map((id) => `${id}.png`).sort());
  const { SAMPLES, PHONE } = require('../scripts/render-starter-examples');
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...appTemplates.READY_IDS].sort());
  assert.deepEqual(PHONE, { width: 390, height: 844, scale: 2 });
  // Served to anyone, as the challenge artwork beside it is.
  assert.match(read('src/middleware/auth.js'), /'\/illustrations\/',/);
});

test('POST /api/apps answers a ready-made app\'s example, and the make screen hands it to the made screen', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /const exampleScreen = readyMade \? appTemplates\.get\(template\)\.exampleScreen \|\| null : null;/);
  assert.match(route, /\.\.\.\(exampleScreen \? \{ exampleScreen \} : \{\}\),\n\s+\}\);/);
  const make = read(`${DIR}/make.tsx`);
  assert.match(make, /\.\.\.\(ready && typeof data\.exampleScreen === 'string' && data\.exampleScreen \? \{ exampleScreen: data\.exampleScreen \} : \{\}\),/);
  assert.match(make, /exampleScreen\?: string \| null;/);
});
