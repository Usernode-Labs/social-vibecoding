'use strict';

// A newcomer's first visit after the first session's hand-off (Evan, 15 Oct
// 2026, the onboarding canvas's "A tip in the app, then 1, 2, 3 on Home" and
// "An invited person, every screen"):
//
//   - the made screen's way on: "Go to app" once an invite is out, opening
//     the app itself full screen once it runs; Home and the walk while
//     Homeroom bot is still building it;
//   - one tip under the Homeroom mark the first time they open the app
//     (frontend/src/features/first-session/app-tip.tsx), the maker's words
//     or an invited person's, shown once per person and closed by any tap;
//   - the walk on Home the first time Home shows after that visit
//     (./first-visit.ts decides when; tests/first-session.test.js has the
//     walk's cards), never for somebody who had an account before an invite.
//
// Run with: node --test tests/first-session-app-tip.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';

const visit = loadTsx(`${DIR}/first-visit.ts`);

/** A localStorage stand-in. */
function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    data,
  };
}

/** A screen as readScreen reads it. */
const screen = (over = {}) => ({ app: null, tab: null, home: false, mark: false, opened: false, live: false, ...over });

// ── The made screen's way on ───────────────────────────────────────────

test('the made screen: "Go to app" once an invite is out, "Continue" while it is built, the line says only what went out', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.continueLabel('first-session', false, 'Plant Pal'), 'Invite people later');
  assert.equal(made.continueLabel('first-session', false, 'Plant Pal', true), 'Invite people later');
  assert.equal(made.continueLabel('first-session', true, 'Plant Pal'), 'Go to app');
  assert.equal(made.continueLabel('first-session', true, 'Plant Pal', true), 'Continue', 'no app to go to yet');
  // From Create, the project itself, as before.
  assert.equal(made.continueLabel('create', true, 'Plant Pal'), 'Go to Plant Pal');
  assert.equal(made.continueLabel('create', true, 'Plant Pal', true), 'Go to Plant Pal');
  // "Next, a short tour." is gone, from Create and the first session alike.
  assert.equal(made.sharedLine('copied'), 'Link copied.');
  assert.equal(made.sharedLine('shared'), 'Invite shared.');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /\{sentHow \? sharedLine\(sentHow\) : t\(INVITE_HINT\)\}/);
  assert.match(src, /\{continueLabel\(entry, true, made\.name, stage !== null\)\}/);
  assert.match(src, /\{continueLabel\(entry, false, made\.name\)\}/);
  // Still off until the app runs, both of them.
  assert.match(src, /onClick=\{\(\) => onContinue\(false, stage\)\}[^>]*disabled=\{holds\}/);
  assert.match(src, /onClick=\{\(\) => onContinue\(true, stage\)\} disabled=\{holds\}/);
  const catalog = JSON.parse(read('frontend/locales/en/onboarding.json'));
  for (const gone of ['made.startTour', 'made.sent.copiedTour', 'made.sent.sharedTour']) assert.equal(catalog[`firstSession.${gone}`], undefined, gone);
  assert.doesNotMatch(JSON.stringify(catalog), /short tour\./);
});

test('the made screen\'s hand-off: a running app opens full screen with the tip and the walk owed; one being built goes Home to the walk', () => {
  const src = read(`${DIR}/index.tsx`);
  const hand = src.slice(src.indexOf('onContinue={(skipped, firstVersion) => {'), src.indexOf('// The plan is answered in the chat with Homeroom bot'));
  assert.ok(hand.length > 400, 'the hand-off is found');
  // From Create: the hub, as before, and nothing owed.
  assert.match(hand, /if \(fromCreate\) \{\s+leaveDoor\(true\);\s+enterScreen\('hub', made\.slug\);\s+return;\s+\}/);
  assert.ok(hand.indexOf('if (fromCreate)') < hand.indexOf('oweTip'), 'Create returns before anything is owed');
  // Not live yet: the tip waits for it to be live, the walk runs now on
  // Home, told to the server card by card (moments).
  assert.match(hand, /if \(firstVersion !== null\) \{\s+if \(uid != null\) oweTip\(uid, \{ slug, name, who: 'maker', live: true \}\);[\s\S]*?enterScreen\('home', slug\);\s+if \(uid != null && !claimWalk\(uid\)\) \{ setMode\(\{ kind: 'none' \}\); return; \}\s+setMode\(\{ kind: 'tour', info: \{ slug, name \}, path: 'walk', moments: true \}\);\s+return;\s+\}/);
  // Running: the tip and the walk owed, and the app itself, full screen.
  assert.match(hand, /if \(uid != null\) \{\s+oweTip\(uid, \{ slug, name, who: 'maker' \}\);\s+oweWalk\(uid, \{ slug, name, maker: true \}\);\s+\}\s+setOwing\(\(n\) => n \+ 1\);\s+setMode\(\{ kind: 'none' \}\);\s+enterScreen\('app', slug\);/);
  assert.doesNotMatch(hand, /path: 'maker'|enterScreen\('home', made\.slug\);\s+setMode\(\{ kind: 'tour'/);
  // Still told to the server, and still marked seen.
  assert.match(hand, /noteMoment\(made\.slug, skipped \? 'invite_later_tapped' : 'continue_tapped'\);\s+markSeen\(made\.slug\);\s+rememberCommunity\(made\.slug\);/);
});

// ── What is owed, and once ─────────────────────────────────────────────

test('the tip and the walk are owed per person on this device, and shown once', () => {
  const store = memoryStore();
  assert.equal(visit.TIP_PREFIX, 'usernode:first-session:tip:');
  assert.equal(visit.WALK_PREFIX, 'usernode:first-session:walk:');
  assert.equal(visit.anyOwed(store), false);
  assert.equal(visit.owedTip(7, store), null);

  // Owed from the hand-off, to that account only.
  assert.equal(visit.oweTip(7, { slug: 'plant-pal', name: 'Plant Pal', who: 'invited', inviter: 'Maya' }, store), true);
  assert.deepEqual(visit.owedTip(7, store), { slug: 'plant-pal', name: 'Plant Pal', who: 'invited', inviter: 'Maya', live: false });
  assert.equal(visit.owedTip(8, store), null, 'another account on the same device');
  assert.equal(visit.anyOwed(store), true);
  // Shown: never again, whatever is owed later (another invite, another project).
  visit.noteTipShown(7, store);
  assert.equal(store.getItem('usernode:first-session:tip:7'), 'done');
  assert.equal(visit.owedTip(7, store), null);
  assert.equal(visit.oweTip(7, { slug: 'other', name: 'Other', who: 'invited' }, store), false);
  assert.equal(visit.owedTip(7, store), null);
  assert.equal(visit.anyOwed(store), false);

  // The walk: owed unarmed, armed by the app, then run once.
  assert.equal(visit.oweWalk(7, { slug: 'plant-pal', name: 'Plant Pal', privateMember: true }, store), true);
  assert.deepEqual(visit.owedWalk(7, store), { slug: 'plant-pal', name: 'Plant Pal', privateMember: true, maker: false, armed: false });
  visit.armWalk(7, store);
  assert.equal(visit.owedWalk(7, store).armed, true);
  visit.noteWalkRun(7, store);
  assert.equal(visit.owedWalk(7, store), null);
  assert.equal(visit.oweWalk(7, { slug: 'x', name: 'X' }, store), false, 'run once per person');
  visit.armWalk(7, store);
  assert.equal(store.getItem('usernode:first-session:walk:7'), 'done', 'arming a walk that ran writes nothing');

  // A maker whose app is still built takes the walk now: once.
  const fresh = memoryStore();
  assert.equal(visit.claimWalk(3, fresh), true);
  assert.equal(visit.claimWalk(3, fresh), false);
  assert.equal(visit.owedWalk(3, fresh), null);

  // What is not a record is nothing owed.
  const junk = memoryStore({ 'usernode:first-session:tip:9': '{oops', 'usernode:first-session:walk:9': '{"name":"no slug"}' });
  assert.equal(visit.owedTip(9, junk), null);
  assert.equal(visit.owedWalk(9, junk), null);
  // A store that refuses (private mode) owes nothing and throws nothing.
  const refusing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(visit.oweTip(1, { slug: 'a', name: 'A', who: 'maker' }, refusing), true);
  assert.equal(visit.owedTip(1, refusing), null);
  assert.equal(visit.anyOwed(refusing), false);
  // The "seen" marks share the prefix's start, never its keys.
  assert.equal(visit.anyOwed(memoryStore({ 'usernode:first-session:7:plant-pal': '1791453600000' })), false);
});

test('when each is due: the tip on its app opened, the walk armed by the app and run on the Home after it', () => {
  const { tipDue, walkArms, walkDue } = visit;
  const tip = { slug: 'plant-pal', name: 'Plant Pal', who: 'maker' };
  const onApp = screen({ app: 'plant-pal', tab: 'app', mark: true, opened: true });
  assert.equal(tipDue(tip, onApp), true);
  assert.equal(tipDue(tip, { ...onApp, opened: false }), false, 'still loading');
  assert.equal(tipDue(tip, { ...onApp, mark: false }), false, 'no mark to point at');
  assert.equal(tipDue(tip, { ...onApp, tab: 'dev' }), false, 'its project page is not the app');
  assert.equal(tipDue(tip, { ...onApp, app: 'other' }), false, 'somebody already here opening some other app');
  assert.equal(tipDue(tip, screen({ home: true })), false);
  // A maker whose first version was being built: only once it is live.
  const live = { ...tip, live: true };
  assert.equal(tipDue(live, onApp), false, 'the build\'s own screen is open, but nothing is live');
  assert.equal(tipDue(live, { ...onApp, live: true }), true);

  const walk = { slug: 'plant-pal', name: 'Plant Pal' };
  assert.equal(walkArms(walk, onApp), true);
  assert.equal(walkArms(walk, { ...onApp, tab: 'dev' }), true, 'any tab of it is a visit');
  assert.equal(walkArms(walk, screen({ app: 'other', tab: 'app' })), false);
  assert.equal(walkArms({ ...walk, armed: true }, onApp), false, 'armed once');
  assert.equal(walkDue(walk, screen({ home: true })), false, 'Home before the app is not after it');
  assert.equal(walkDue({ ...walk, armed: true }, screen({ home: true })), true);
  assert.equal(walkDue({ ...walk, armed: true }, onApp), false);
  assert.equal(walkDue({ ...walk, armed: true }, screen()), false, 'a community first: it waits for Home');
});

test('the screen as the shell shows it: the app over Home, its tab, the mark, opened, live', () => {
  const host = (screens, over = {}) => ({
    App: { currentApp: 'plant-pal', currentTab: 'app', _isScreenVisible: (id) => !!screens[id], ...over },
  });
  const doc = (width) => ({ getElementById: (id) => (id === 'platform-mark-btn' ? { getBoundingClientRect: () => ({ width, height: width ? 28 : 0 }) } : null) });
  const frame = (over) => ({ slug: 'plant-pal', active: true, cover: null, ...over });
  const checking = message('changes:appStatus.checking');
  // The app itself, its frame up and uncovered.
  assert.deepEqual(visit.readScreen(host({ 'app-view': true }), doc(48), { frame: frame(), view: null }),
    { app: 'plant-pal', tab: 'app', home: false, mark: true, opened: true, live: true });
  // Its launch cover still up: not opened, not live.
  const covered = visit.readScreen(host({ 'app-view': true }), doc(48), { frame: frame({ cover: { out: false } }), view: null });
  assert.deepEqual([covered.opened, covered.live], [false, false]);
  // The first version being built: its screen is open, nothing is live.
  const building = visit.readScreen(host({ 'app-view': true }), doc(48), {
    frame: frame({ active: false }), view: { dot: null, message: 'Plant Pal', tourSays: true, action: null },
  });
  assert.deepEqual([building.opened, building.live], [true, false]);
  const loading = visit.readScreen(host({ 'app-view': true }), doc(48), { frame: frame({ active: false }), view: { dot: null, message: checking, action: null } });
  assert.equal(loading.opened, false, '"Opening…"');
  // Home, with the app zooming over it: neither yet.
  assert.deepEqual(visit.readScreen(host({ 'app-view': true, 'home-screen': true }), doc(48), { frame: frame(), view: null }),
    { app: null, tab: null, home: false, mark: false, opened: false, live: false }, 'the mark is measured only over an app');
  // Home alone.
  assert.equal(visit.readScreen(host({ 'home-screen': true }), doc(0), { frame: frame({ slug: '' }), view: null }).home, true);
  assert.equal(visit.readScreen(host({ 'home-screen': true }), doc(0), { frame: frame({ slug: '' }), view: null }).mark, false);
  assert.equal(visit.frameLive('plant-pal', frame({ cover: { out: true } })), true, 'its cover fading out');
  assert.equal(visit.frameLive('plant-pal', frame({ slug: 'other' })), false);
});

// ── The island owes them and looks ─────────────────────────────────────

test('the island looks at the screen only while something is owed, arms the walk before the tip, and records each before it shows', () => {
  const src = read(`${DIR}/index.tsx`);
  const watch = src.slice(src.indexOf('// THE FIRST VISIT (./first-visit.ts)'), src.indexOf('const closeTip = useCallback'));
  assert.ok(watch.length > 400, 'the watcher is found');
  // Nothing of the island's up, no tip up, and something owed on this device.
  assert.match(watch, /if \(mode\.kind !== 'none' \|\| tip \|\| !anyOwed\(\)\) return undefined;/);
  assert.match(watch, /timer = window\.setInterval\(tick, FIRST_VISIT_CHECK_MS\);/);
  assert.match(watch, /if \(!owed\.tip && !owed\.walk\) \{ window\.clearInterval\(timer\); return; \}/);
  // Armed first, so the tip that shows on the same visit cannot keep the
  // walk from its Home.
  assert.ok(watch.indexOf('walkArms(owed.walk, screen)') < watch.indexOf('tipDue(owed.tip, screen)'));
  assert.match(watch, /else if \(owed\.walk && walkDue\(owed\.walk, screen\)\) \{\s+noteWalkRun\(uid\);\s+startWalk\(owed\.walk\);/);
  assert.match(watch, /if \(owed\.tip && tipDue\(owed\.tip, screen\)\) \{\s+noteTipShown\(uid\);\s+setTip\(owed\.tip\);/);
  // The walk opens over nothing else, numbered, told to the server for a maker.
  assert.match(watch, /prev\.kind === 'none'\s+\? \{ kind: 'tour', info: \{ slug: walk\.slug, name: walk\.name, privateMember \}, path: 'walk', moments: !!walk\.maker \}/);
  // The waitlist card only while they are still a private member.
  assert.match(watch, /const privateMember = !!walk\.privateMember && !!legacy\(\)\.App\?\.user\?\.privateMember;/);
  assert.match(src, /if \(tip\) return <AppTip tip=\{tip\} onClose=\{closeTip\} \/>;/);
  assert.equal(visit.FIRST_VISIT_CHECK_MS, 250);
  // A private member's "Go to Homeroom": their first visit was the app.
  const goHome = src.slice(src.indexOf('goHome(_info'), src.indexOf('holdWelcome(): boolean'));
  assert.match(goHome, /app\?\._notePrivateHome\?\.\(\);\s+app\?\.navigateHome\?\.\(\);\s+const uid = app\?\.user\?\.id;\s+if \(uid != null\) \{ armWalk\(uid\); setOwing\(\(n\) => n \+ 1\); \}/);
  assert.doesNotMatch(goHome, /path: 'private'|_privateHomeVisited/);
});

// ── The tip ────────────────────────────────────────────────────────────

const tip = loadTsx(`${DIR}/app-tip.tsx`);

test('the tip\'s words: the maker\'s, an invited person\'s with who sent it, and without', () => {
  assert.deepEqual(['title', 'titleInvited', 'line', 'lineInvited'].map((k) => message(`onboarding:firstSession.tip.${k}`, { app: 'Plant Pal', inviter: 'Maya' })), [
    'Welcome to your app',
    'Welcome to Plant Pal',
    'Tap <0></0> to suggest a change, or to go to the community and Homeroom.',
    'Maya invited you. Tap <0></0> to suggest a change, or to go to the community and Homeroom.',
  ]);
  assert.deepEqual(tip.tipWords({ who: 'maker', name: 'Plant Pal' }), {
    title: 'onboarding:firstSession.tip.title', titleValues: {}, line: 'onboarding:firstSession.tip.line', lineValues: {},
  });
  assert.deepEqual(tip.tipWords({ who: 'invited', name: 'Plant Pal', inviter: 'Maya' }), {
    title: 'onboarding:firstSession.tip.titleInvited', titleValues: { app: 'Plant Pal' }, line: 'onboarding:firstSession.tip.lineInvited', lineValues: { inviter: 'Maya' },
  });
  // Who sent it not known: the line without its first sentence.
  for (const inviter of [null, undefined, '', '  ']) {
    assert.equal(tip.tipWords({ who: 'invited', name: 'Plant Pal', inviter }).line, 'onboarding:firstSession.tip.line', String(inviter));
  }
});

test('the tip names Homeroom alone while the menu offers only "Go to Homeroom" (sign-up test, 19 Oct 2026)', () => {
  // While the walk on Home is owed (or a private member has not been Home),
  // the mark's menu has "Go to Homeroom" and no "Go to community", so the
  // tip promises only what is there.
  assert.deepEqual(['lineHomeroom', 'lineInvitedHomeroom'].map((k) => message(`onboarding:firstSession.tip.${k}`, { inviter: 'Maya' })), [
    'Tap <0></0> to suggest a change, or to go to Homeroom.',
    'Maya invited you. Tap <0></0> to suggest a change, or to go to Homeroom.',
  ]);
  assert.deepEqual(tip.tipWords({ who: 'maker', name: 'Plant Pal' }, true), {
    title: 'onboarding:firstSession.tip.title', titleValues: {}, line: 'onboarding:firstSession.tip.lineHomeroom', lineValues: {},
  });
  assert.deepEqual(tip.tipWords({ who: 'invited', name: 'Plant Pal', inviter: 'Maya' }, true), {
    title: 'onboarding:firstSession.tip.titleInvited', titleValues: { app: 'Plant Pal' }, line: 'onboarding:firstSession.tip.lineInvitedHomeroom', lineValues: { inviter: 'Maya' },
  });
  assert.equal(tip.tipWords({ who: 'invited', name: 'Plant Pal', inviter: null }, true).line, 'onboarding:firstSession.tip.lineHomeroom');
  // The menu's own test of it: the walk owed, or a private member not yet Home.
  const src = read(`${DIR}/app-tip.tsx`);
  assert.match(src, /return owedHomeWalk\(\) \|\| offeringGoToHomeroom\(!!app\?\.user\?\.privateMember\);/);
  assert.match(src, /const \[homeroomOnly\] = useState\(homeroomOnlyNow\);/);
  assert.match(src, /const words = tipWords\(tip, homeroomOnly\);/);
});

test('the tip sits under the mark, its pointer at the mark\'s middle, whole on the screen', () => {
  const phone = { width: 390, height: 844 };
  // The mark at the header's top-left, in the app.
  const mark = { left: 56, top: 55, width: 26, height: 28 };
  const at = tip.tipPlacement(mark, phone);
  assert.deepEqual(at, { top: 93, left: 41, width: 320, pointer: 28 });
  assert.equal(at.top, mark.top + mark.height + tip.TIP_GAP);
  assert.equal(at.left + at.pointer, mark.left + mark.width / 2, 'the pointer is under the mark\'s middle');
  // A narrow screen: as wide as it can be, its sides 16px in.
  const small = tip.tipPlacement(mark, { width: 320, height: 568 });
  assert.equal(small.width, 288);
  assert.equal(small.left, 16);
  // A mark further right: the card follows it, never off the screen.
  const right = tip.tipPlacement({ left: 360, top: 10, width: 26, height: 28 }, phone);
  assert.ok(right.left + right.width <= phone.width - 16);
  assert.ok(right.pointer <= right.width - 20, 'the pointer stays off the rounded corner');
  const wide = tip.tipPlacement({ left: 260, top: 12, width: 26, height: 28 }, { width: 1280, height: 800 });
  assert.equal(wide.left, 260 + 13 - 28);
  assert.equal(wide.pointer, 28);
});

/** The tip as it first paints, under a mark at the given box, on a phone. */
function drawTip(record, box = { left: 56, top: 55, width: 26, height: 28 }, { walkOwed = false } = {}) {
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const rect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
  const tile = { getBoundingClientRect: rect };
  globalThis.window = { innerWidth: 390, innerHeight: 844, ...(walkOwed ? { App: { user: { id: 42 } } } : {}) };
  globalThis.document = {
    getElementById: (id) => (id === 'platform-mark-btn' ? { getBoundingClientRect: rect, querySelector: () => tile } : null),
  };
  if (walkOwed) {
    const walk = JSON.stringify({ slug: record.slug, name: record.name, armed: true });
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k) => (k === 'usernode:first-session:walk:42' ? walk : null), setItem() {} },
      configurable: true, writable: true,
    });
  }
  try {
    return renderToHtml(createElement(tip.AppTip, { tip: record, onClose() {} }));
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
    if (walkOwed) {
      if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else delete globalThis.localStorage;
    }
  }
}

test('the tip, drawn: its title, its line with the mark in it, a small ✕, and a pointer up at the mark', () => {
  const maker = drawTip({ slug: 'plant-pal', name: 'Plant Pal', who: 'maker' });
  assert.match(maker, /<div role="dialog" aria-labelledby="first-session-tip-title" data-first-session-tip="maker" class="fixed z-\[9000\] rounded-\[20px\] bg-white [^"]*" style="top:93px;left:41px;width:320px">/);
  assert.match(maker, /<p id="first-session-tip-title" class="text-\[17px\] font-semibold leading-snug">Welcome to your app<\/p>/);
  // [H] is the mark's own artwork, at the size of the text, read as the
  // mark button's own name.
  assert.match(maker, /<p class="mt-1 text-\[15px\] leading-snug text-zinc-600 dark:text-zinc-300">Tap <img src="\/brand\/homeroom-mark\.png" alt="Homeroom menu" draggable="false" width="18" height="18" data-first-session-tip-mark="" class="platform-mark-tile [^"]*h-\[1\.2em\] w-\[1\.2em\][^"]*"\/> to suggest a change, or to go to the community and Homeroom\.<\/p>/);
  assert.match(maker, /<span aria-hidden="true" data-first-session-tip-pointer="" class="absolute -top-1\.5 h-3 w-3 rotate-45 [^"]*" style="left:22px"><\/span>/);
  assert.match(maker, /<button type="button" data-first-session-tip-close="" aria-label="Close" class="un-touch-target [^"]*">/);
  assert.doesNotMatch(maker, /invited you|Welcome to Plant Pal|Next|Skip|—|!/);

  const invited = drawTip({ slug: 'plant-pal', name: 'Plant Pal', who: 'invited', inviter: 'Maya' });
  assert.match(invited, /data-first-session-tip="invited"/);
  assert.match(invited, />Welcome to Plant Pal<\/p>/);
  assert.match(invited, />Maya invited you\. Tap <img [^>]*alt="Homeroom menu"[^>]*\/> to suggest a change, or to go to the community and Homeroom\.<\/p>/);
  // Who sent it unknown: the line alone.
  const unknown = drawTip({ slug: 'plant-pal', name: 'Plant Pal', who: 'invited', inviter: null });
  assert.match(unknown, />Welcome to Plant Pal<\/p>/);
  assert.match(unknown, />Tap <img /);
  assert.doesNotMatch(unknown, /invited you/);
  // A name is text, never markup.
  assert.match(drawTip({ slug: 'x', name: '<b>X</b>', who: 'invited', inviter: '<i>M</i>' }), />&lt;i&gt;M&lt;\/i&gt; invited you\./);
  // The walk on Home owed (the menu offers "Go to Homeroom" alone): Homeroom.
  const owedMaker = drawTip({ slug: 'plant-pal', name: 'Plant Pal', who: 'maker' }, undefined, { walkOwed: true });
  assert.match(owedMaker, />Tap <img [^>]*alt="Homeroom menu"[^>]*\/> to suggest a change, or to go to Homeroom\.<\/p>/);
  assert.doesNotMatch(owedMaker, /community/);
  const owedInvited = drawTip({ slug: 'plant-pal', name: 'Plant Pal', who: 'invited', inviter: 'Maya' }, undefined, { walkOwed: true });
  assert.match(owedInvited, />Maya invited you\. Tap <img [^>]*\/> to suggest a change, or to go to Homeroom\.<\/p>/);
  // No mark on screen: nothing drawn.
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { innerWidth: 390, innerHeight: 844 };
  globalThis.document = { getElementById: () => null };
  try {
    assert.equal(renderToHtml(createElement(tip.AppTip, { tip: { slug: 'x', name: 'X', who: 'maker' }, onClose() {} })), '');
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
  }
});

test('any tap anywhere closes the tip, and what was tapped still happens', () => {
  const src = read(`${DIR}/app-tip.tsx`);
  // A press on the page outside the card goes on to what it pressed (the
  // mark opens its menu): it is heard in the capture phase and never stopped.
  assert.match(src, /const onDown = \(e: Event\) => \{\s+const target = e\.target as Node \| null;\s+if \(target && rootRef\.current\?\.contains\(target\)\) return;\s+close\(\);\s+\};/);
  assert.match(src, /document\.addEventListener\('pointerdown', onDown, true\);/);
  assert.doesNotMatch(src, /preventDefault|stopImmediatePropagation/);
  // The card's own taps are its click, so nothing under it is pressed as it goes.
  assert.match(src, /data-first-session-tip=\{tip\.who\}\s+onClick=\{close\}/);
  assert.match(src, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); close\(\); \}\}/);
  // A tap in the app, another document: the frame takes the focus.
  assert.match(src, /if \(Date\.now\(\) - shownAt < BLUR_GRACE_MS\) return;\s+if \(document\.activeElement\?\.tagName === 'IFRAME'\) close\(\);/);
  assert.match(src, /window\.addEventListener\('blur', onBlur\);/);
  assert.equal(tip.BLUR_GRACE_MS, 400);
  // Escape, a route change, and the app leaving the screen.
  assert.match(src, /if \(e\.key === 'Escape'\) close\(\);/);
  assert.match(src, /window\.addEventListener\('hashchange', close\);/);
  assert.match(src, /const appUp = !!\(window as unknown as Shell\)\.App\?\._isScreenVisible\?\.\('app-view'\);\s+missing = box && appUp \? 0 : missing \+ 1;\s+\/\/[^\n]*\n\s+if \(missing > 10\) \{ close\(\); return; \}/);
  // Closed once, however many ways at once.
  assert.match(src, /const close = useCallback\(\(\) => \{\s+if \(closed\.current\) return;\s+closed\.current = true;\s+onClose\(\);\s+\}, \[onClose\]\);/);
});

test('the tip and the walk add nothing to the prerendered shell, and the tip notes a first visit', () => {
  const { renderComponent } = require('./lib/render-tsx');
  assert.equal(renderComponent(`${DIR}/index.tsx`, 'FirstSession'), '');
  const src = read(`${DIR}/index.tsx`);
  // Only once due, client-side: the tip is state set by the watcher or a
  // screenshot state, never by a render.
  assert.match(src, /const \[tip, setTip\] = useState<TipRecord \| null>\(null\);/);
  // The home-screen strip holds for a visit that showed the tip, as for one
  // that showed the first session's other screens (./tour-running.ts).
  assert.match(src, /if \(mode\.kind === 'none' && !tip\) return;/);
  // The shell's markup is unchanged: no new ids.
  const tipSrc = read(`${DIR}/app-tip.tsx`);
  assert.doesNotMatch(tipSrc, /\bid="(?!first-session-tip-title")/);
});
