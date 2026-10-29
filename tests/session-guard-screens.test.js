'use strict';

// The signed-out screens' reads, run through the REAL session guard
// (frontend/src/lib/api-cache-identity.ts) rather than a fake fetch (#6014).
//
// The guard broke four of these flows in five days and no test saw it,
// because the screens' own tests hand them a plain fake fetch: an invite link
// showing the waitlist pitch (#5931), adding a phone cutting off reads and
// reloading other tabs (#5934), a waiting room with no countries (#5936), and
// guest Discover saying it could not load after a sign-out (#5951). Here the
// page's fetch is the guard over a scripted server (tests/lib/guarded-page.js)
// and, while each screen's read is on its way, the session moves the way the
// shell moves it: a signed-out /api/auth/me, a sign-out, a sign-in, and a
// sign-out or sign-in whose round trip spans the read. Every screen still
// ends with its data, never an error or the wrong screen.
//
// The decision this file pins: the public reads whose answer is the same for
// anyone (PUBLIC_READS_FOR_ANYONE in the guard) are NOT fenced by a session
// boundary, since no boundary can have changed them. Fenced, a logout round
// trip that spanned a read and its one retry left an invite link on the
// waitlist pitch and the waiting room with no countries. Every other read is
// still fenced, /api/public/ ones included: a public route may still read the
// session (GET /api/public/profiles/:username answers the viewer's own
// friendship). A scan of src/routes below keeps any route that reads a
// session off the list. The two fixes that narrowed WHEN reads are fenced
// (#5931, #5934) are pinned here through the same page.
//
// Run with: node --test tests/session-guard-screens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { guardedPage, flush } = require('./lib/guarded-page');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const TOKEN = 'YigKXxtTzBB_TFZVTkjEtg';
const INVITE = `/api/public/invites/${TOKEN}`;
const LIVE = {
  live: true, reason: null,
  project: { name: 'Flat 4B Chores', iconEmoji: '🧹', iconUrl: null, description: null, picture: null },
  inviter: 'jordan_t1004', inviterName: 'jordan_t1004', inviterMadeIt: true, note: null, memberCount: 1,
};
const OPTIONS_PATH = '/api/public/waitlist/options';
const OPTIONS = { countries: { NL: 'Netherlands' }, discovery_sources: { friend: 'A friend' } };
const APPS_PATH = '/api/public/apps';
const APPS = [{
  slug: 'game-corner', name: 'Game Corner', description: 'Classic games.', category: 'games',
  featured: false, active_users: 4, open_votes: 0, created_at: '2026-06-19T00:00:00.000Z',
  member_count: 3, merged_count: 2, contributors: [{}], guest_ready: true, requires_login: false,
  url: 'https://game-corner.example',
}];

// The session moving under a read. `run` delivers it whole; `start` sends its
// request and returns the round trip, whose reply `land()` delivers later.
const EVENTS = [
  { name: 'a signed-out /api/auth/me', signedIn: false, run: (page) => page.signedOutMe() },
  { name: 'a sign-out', signedIn: true, run: (page) => page.signOut() },
  { name: 'a sign-in', signedIn: false, run: (page) => page.signIn() },
  { name: 'a sign-out spanning the read', signedIn: true, start: (page) => page.signOut({ hold: true }) },
  { name: 'a sign-in spanning the read', signedIn: false, start: (page) => page.signIn({ hold: true }) },
];

/**
 * For each event: open a page, start the screen's read of `path` (held by
 * the server), move the session, answer the read with `body`, and hand the
 * screen and the page to `check`.
 */
async function acrossEvents({ pathname = '/', path, body, routes = {}, open, check }) {
  for (const event of EVENTS) {
    const page = guardedPage({ pathname, signedIn: event.signedIn, routes: { [path]: () => body, ...routes } });
    try {
      const read = page.hold(path);
      const screen = open();
      await read.arrived;
      if (event.run) await event.run(page);
      const round = event.start ? await event.start(page) : null;
      // A read made again before the round trip lands waits for it too:
      // that is the read a fence on the first one would leave exposed.
      const again = page.hold(path);
      read.answer(body);
      await flush();
      if (round) await round.land();
      again.answer(body);
      await flush();
      await check(screen, page, event.name);
    } finally {
      page.restore();
    }
  }
}

const readsOf = (page, path) => page.requests.filter((p) => p === path).length;

// ── A React small enough to step through: useState and useEffect ─────────

function steppedReact() {
  const slots = [];
  let cursor = 0, renderFn = null, passive = [];
  const render = () => { cursor = 0; passive = []; renderFn(); for (const run of passive) run(); };
  const React = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) {
        const state = { value: typeof initial === 'function' ? initial() : initial };
        state.set = (next) => {
          const value = typeof next === 'function' ? next(state.value) : next;
          if (!Object.is(value, state.value)) { state.value = value; render(); }
        };
        slots[i] = state;
      }
      return [slots[i].value, slots[i].set];
    },
    useEffect(effect) {
      const i = cursor++;
      if (i in slots) return;
      slots[i] = {};
      passive.push(() => { slots[i].cleanup = effect(); });
    },
  };
  return { React, mount(fn) { renderFn = fn; render(); } };
}

// ── invite-card.tsx: the invite link's card ───────────────────────────────

test('an invite link keeps its card whatever the session does while the preview is read', async () => {
  await acrossEvents({
    pathname: `/invite/${TOKEN}`, path: INVITE, body: LIVE,
    open() {
      const fake = steppedReact();
      const card = loadTsx('frontend/src/features/auth/invite-card.tsx', {
        stubs: {
          react: fake.React,
          '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t, Message: () => null, RichMessage: () => null },
        },
      });
      let latest = null;
      fake.mount(() => { latest = card.useInvitePreview(); });
      return { read: () => latest };
    },
    check(screen, page, name) {
      assert.equal(screen.read().pending, false, name);
      assert.equal(screen.read().preview?.live, true, `${name}: the card, not the waitlist pitch`);
      assert.equal(readsOf(page, INVITE), 1, `${name}: read once, never cut off`);
    },
  });
});

// ── waitlist-shared.tsx: the options the sign-in sheet and waiting room read ─

test('the waitlist options arrive whatever the session does while they are read', async () => {
  await acrossEvents({
    path: OPTIONS_PATH, body: OPTIONS,
    open() {
      // A fresh module per page: the options are memoised for the document.
      const { waitlistOptions } = loadTsx('frontend/src/features/auth/waitlist-shared.tsx');
      const result = {};
      waitlistOptions().then((options) => { result.options = options; });
      return result;
    },
    check(screen, page, name) {
      assert.deepEqual(screen.options, OPTIONS, `${name}: the countries are there`);
      assert.equal(readsOf(page, OPTIONS_PATH), 1, name);
    },
  });
});

// ── landing.tsx + guest-discover.tsx: the public directory ───────────────

const LANDING = 'frontend/src/features/auth/landing.tsx';

/** The landing's directory read, recording what it shows; retries do not wait. */
function appsReader() {
  const { createAppsReader } = loadTsx(LANDING);
  const shown = { failed: [], apps: null, waits: [] };
  const read = createAppsReader({
    failed: (failed) => shown.failed.push(failed),
    apps: (list) => { shown.apps = list; },
  }, async (ms) => { shown.waits.push(ms); });
  return { read, shown };
}

const FAILED_LINE = message('auth:guest.loadFailed');
/** Guest Discover as the landing draws it from what the read showed, as text. */
const discover = (shown) => renderComponent('frontend/src/features/guest/guest-discover.tsx', 'GuestDiscover', {
  apps: shown.apps, failed: shown.failed.at(-1) === true, hero: null, primaryClass: 'pill', onOpenInside() {},
}).replace(/&#x27;/g, "'");

test('guest Discover shows the directory whatever the session does while it is read', async () => {
  await acrossEvents({
    path: APPS_PATH, body: { apps: APPS },
    open() {
      const reader = appsReader();
      reader.done = reader.read();
      return reader;
    },
    async check({ done, shown }, page, name) {
      await done;
      assert.deepEqual(shown.apps, APPS, name);
      assert.deepEqual(shown.failed, [false, false], `${name}: never "could not load"`);
      assert.equal(readsOf(page, APPS_PATH), 1, name);
      const html = discover(shown);
      assert.match(html, /Game Corner/, name);
      assert.ok(!html.includes(FAILED_LINE), `${name}: ${FAILED_LINE}`);
    },
  });
});

test('a directory read that fails twice is tried again, and only a third failure is reported', async () => {
  const { APPS_ATTEMPTS, APPS_RETRY_MS } = loadTsx(LANDING);
  assert.equal(APPS_ATTEMPTS, 3);
  assert.equal(APPS_RETRY_MS, 1000);
  let answers = [500, 500, 200];
  const route = () => {
    const status = answers.shift() ?? 500;
    return status === 200 ? { apps: APPS } : new Response('{}', { status });
  };
  let page = guardedPage({ routes: { [APPS_PATH]: route } });
  try {
    const { read, shown } = appsReader();
    await read();
    assert.deepEqual(shown.apps, APPS);
    assert.deepEqual(shown.failed, [false, false], 'the two failures are never shown');
    assert.deepEqual(shown.waits, [1000, 1000], 'a second apart');
    assert.equal(readsOf(page, APPS_PATH), 3);
    assert.ok(!discover(shown).includes(FAILED_LINE));
    // A later read that fails outright keeps the list read before it, for
    // the anon-back shot and a shared link's lookup.
    answers = [500, 500, 500];
    await read();
    assert.deepEqual(shown.apps, APPS);
    assert.equal(shown.failed.at(-1), true);
  } finally { page.restore(); }

  answers = [500, 500, 500, 200];
  page = guardedPage({ routes: { [APPS_PATH]: route } });
  try {
    const { read, shown } = appsReader();
    await read();
    assert.deepEqual(shown.failed, [false, true], 'the third failure is reported');
    assert.equal(shown.apps, null, 'and no list is invented');
    assert.ok(discover(shown).includes(FAILED_LINE));
    // Try again reads it once more, and the list comes in.
    await read();
    assert.deepEqual(shown.apps, APPS);
    assert.deepEqual(shown.failed, [false, true, false, false]);
  } finally { page.restore(); }
});

test('Try again pressed while the directory is being read joins that read', async () => {
  const page = guardedPage({ routes: { [APPS_PATH]: () => ({ apps: APPS }) } });
  try {
    const held = page.hold(APPS_PATH);
    const { read, shown } = appsReader();
    const first = read();
    await held.arrived;
    const again = read();
    assert.equal(again, first, 'the same read');
    held.answer({ apps: APPS });
    await first;
    assert.equal(readsOf(page, APPS_PATH), 1);
    assert.deepEqual(shown.apps, APPS);
    // Once it is over, Try again reads again.
    await read();
    assert.equal(readsOf(page, APPS_PATH), 2);
  } finally { page.restore(); }
});

// ── The guard itself, under the same page: what is fenced and what is not ─

/** Start a read of `path`, move the session with `move`, then answer it. */
async function readAcross(page, path, move) {
  const held = page.hold(path);
  const pending = page.win.fetch(path).then((res) => res.json()).catch((err) => err);
  await held.arrived;
  await move();
  held.answer({ fake: 'body' });
  return pending;
}

test('a read for anyone is not fenced by a sign-out or a sign-in; any other read still is', async () => {
  for (const [name, signedIn, move] of [
    ['sign-out', true, (page) => page.signOut()],
    ['sign-in', false, (page) => page.signIn()],
  ]) {
    for (const path of [OPTIONS_PATH, APPS_PATH, INVITE]) {
      const page = guardedPage({ signedIn });
      try {
        assert.deepEqual(await readAcross(page, path, () => move(page)), { fake: 'body' }, `${name}: ${path}`);
      } finally { page.restore(); }
    }
    // A public profile answers the viewer's own friendship, and a public
    // route nobody listed is fenced like any read with a session.
    for (const path of ['/api/public/profiles/x', '/api/public/apps/x/overview', '/api/me/anything']) {
      const page = guardedPage({ signedIn });
      try {
        const fenced = await readAcross(page, path, () => move(page));
        assert.equal(fenced?.name, 'AbortError', `${name}: ${path} is still cut off`);
      } finally { page.restore(); }
    }
  }
});

// Every GET route under /api/public/ in src/routes, with its handler's text:
// from its `router.get(` to the next route of the file.
function publicGetRoutes() {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'routes');
  const routes = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const starts = [...src.matchAll(/\brouter\.(?:get|post|put|patch|delete|all|use)\(/g)].map((m) => m.index);
    for (const [i, start] of starts.entries()) {
      const handler = src.slice(start, starts[i + 1] ?? src.length);
      const route = /^router\.(?:get|all)\(\s*'(\/api\/public\/[^']*)'/.exec(handler);
      if (route) routes.push({ file, route: route[1], handler });
    }
  }
  return routes;
}

const READS_A_SESSION = /optionalSessionAuth|optionalAuth|requireAuth|req\.user|req\.cookies|req\.session|req\.headers\.cookie/;

test('no public route that reads a session is on the list of reads for anyone', () => {
  const { PUBLIC_READS_FOR_ANYONE, publicReadIsForAnyone } = loadTsx('frontend/src/lib/api-cache-identity.ts');
  const routes = publicGetRoutes();
  const sample = (route) => route.replace(/:[A-Za-z]+/g, 'x');
  const viewers = routes.filter((r) => READS_A_SESSION.test(r.handler));
  assert.ok(viewers.some((r) => r.route === '/api/public/profiles/:username'),
    'the scan finds the public profile, which reads the session');
  for (const r of viewers) {
    assert.equal(publicReadIsForAnyone(sample(r.route)), false,
      `${r.file} ${r.route} reads a session, so a sign-in or sign-out must still fence it`);
  }
  // And every listed read is a real route whose handler reads none.
  for (const listed of PUBLIC_READS_FOR_ANYONE) {
    const r = routes.find((x) => x.route === listed);
    assert.ok(r, `${listed} is a GET route in src/routes`);
    assert.doesNotMatch(r.handler, READS_A_SESSION, `${listed} reads no session`);
  }
});

test('#5931: a signed-out boot\'s /api/auth/me does not fence a document that never had a session', async () => {
  const page = guardedPage({ signedIn: false });
  try {
    assert.deepEqual(await readAcross(page, '/api/me/anything', () => page.signedOutMe()), { fake: 'body' });
  } finally { page.restore(); }
});

test('#5934: adding a phone does not fence the reads on their way or reload other tabs', async () => {
  const page = guardedPage({ signedIn: true, routes: { '/api/auth/phone-link/request': () => ({ ok: true }) } });
  const announced = [];
  page.win.localStorage.setItem = (key) => announced.push(key);
  try {
    const body = await readAcross(page, '/api/me/anything',
      () => page.win.fetch('/api/auth/phone-link/request', { method: 'POST' }));
    assert.deepEqual(body, { fake: 'body' });
    assert.deepEqual(announced, [], 'no other tab is told to reload');
  } finally { page.restore(); }
});
