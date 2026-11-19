'use strict';

// The native-offline proposal (18 Nov 2026), screen by screen. Measured on
// production with the iPhone app's web view routed through a proxy that could
// go off, quiet or slow:
//
//   - after a cold launch with no network, Communities said "You are not in a
//     community yet": the pins store set `ready` with empty lists on a read
//     that had no answer;
//   - an offline change link dropped the reader on the Workshop: no answer
//     from /changes/<n> read as "no such change";
//   - Messages stacked three offline notices (the shell's strip, its own
//     strip, a red error) over nothing;
//   - nothing said how old the Workshop's vote counts were.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const STORE = 'frontend/src/features/home/home-pins-store.ts';

function fakeWindow() {
  globalThis.window = {
    App: { user: { id: 1 } },
    UsernodeReact: undefined,
    location: { search: '', hash: '' },
    addEventListener() {},
    removeEventListener() {},
  };
}

test.afterEach(() => {
  delete globalThis.window;
  delete globalThis.fetch;
});

/** The pins store with its kept copies held in a map. */
function loadStore(kept = new Map()) {
  return loadTsx(STORE, {
    stubs: {
      '../workshop/community-scope': { loadCommunities: async () => {} },
      '../../lib/kept-copies': {
        keepCopy: (name, data) => kept.set(name, data),
        keptCopy: (name) => kept.get(name) ?? null,
        keptLoaded: async () => {},
      },
    },
  });
}

const offline = async () => { throw new TypeError('Load failed'); };

test('a read with no answer and nothing saved is not "no communities"', async () => {
  fakeWindow();
  globalThis.fetch = offline;
  const store = loadStore();
  await store.loadHomePins();
  const state = store.homePinsStore.get();
  assert.equal(state.ready, true);
  assert.equal(state.failed, true, 'the screen knows the empty lists say nothing');
});

test('a read with no answer draws the communities this phone saved', async () => {
  fakeWindow();
  const kept = new Map();
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => (String(url) === '/api/me/home-pins' ? { pins: [{ slug: 'p', name: 'P' }] }
      : String(url) === '/api/apps?scope=joined' ? { apps: [{ slug: 'j', is_member: true }] } : { counts: {} }),
  });
  const online = loadStore(kept);
  await online.loadHomePins();
  assert.deepEqual(kept.get('home:pins').joined.map((c) => c.slug), ['j'], 'an answer is kept');

  fakeWindow();
  globalThis.fetch = offline;
  const cold = loadStore(kept);
  await cold.loadHomePins();
  const state = cold.homePinsStore.get();
  assert.equal(state.failed, false);
  assert.deepEqual(state.pins.map((p) => p.slug), ['p']);
  assert.deepEqual(state.joined.map((c) => c.slug), ['j']);
});

test('a joined list that failed keeps the one this phone saved, even when the pins answered', async () => {
  fakeWindow();
  const kept = new Map([['home:pins', { pins: [], joined: [{ slug: 'j' }], owed: {} }]]);
  globalThis.fetch = async (url) => {
    if (String(url) === '/api/apps?scope=joined') throw new TypeError('Load failed');
    return { ok: true, json: async () => (String(url) === '/api/me/home-pins' ? { pins: [] } : { counts: {} }) };
  };
  const store = loadStore(kept);
  await store.loadHomePins();
  assert.deepEqual(store.homePinsStore.get().joined.map((c) => c.slug), ['j']);
  assert.deepEqual(kept.get('home:pins').joined.map((c) => c.slug), ['j'], 'and a failed list is not kept over it');
});

test('Communities says it is not saved yet, never that you joined nothing, after a failed read', () => {
  const screen = read('frontend/src/features/communities/index.tsx');
  assert.match(screen, /total === 0 && !state\.failed \? \(\s*<p id="communities-empty"/);
  assert.match(screen, /total === 0 && state\.failed \? \(\s*<p id="communities-not-saved"/);
  assert.equal(message('communities:page.notSaved'), 'Not saved on this phone yet. Your communities will load when you’re back online.');
});

test('a change link with no answer stays put and opens once Homeroom answers', () => {
  const view = read('public/js/app-view.js');
  assert.match(view, /CHANGE_UNREACHABLE: 'unreachable'/);
  assert.match(view, /if \(id === AppView\.CHANGE_UNREACHABLE\) \{\s*AppView\._openChangeWhenOnline\(content, ref, pending\);\s*return;/,
    'no answer is not "no such change": the Workshop fallback is not taken');
  assert.match(view, /if \(res\.status >= 500\) return saved\(\);/, 'a server error is no answer either');
  assert.match(view, /kept\?\.keep\?\.\(keptName, id\)/, 'the session a number names is saved, so it opens offline next time');
  assert.match(view, /addEventListener\('usernode:offline-change', onChange\)/, 'it opens itself when the connection is back');
  assert.match(message('changes:page.notSavedYet'), /isn’t saved on this phone yet/);
});

test('Messages draws no offline strip of its own, and says "not saved yet" in the ordinary colour', () => {
  const index = read('frontend/src/features/messages/index.tsx');
  assert.doesNotMatch(index, /messages-network-banner/);
  assert.doesNotMatch(read('frontend/src/features/messages/frame-list.tsx'), /messages:inbox\.offline/);
  assert.match(index, /snap\.errorOffline \? 'messages-state' : 'messages-state messages-state-error'/);
  assert.match(index, /snap\.threadErrorOffline \? 'messages-state' : 'messages-state messages-state-error'/);
  assert.match(message('messages:store.error.unreachableList'), /^Not saved on this phone yet\./);
  assert.doesNotMatch(read('public/css/app.css'), /messages-network-banner/);
});

test('the Workshop\'s vote figure says when it is from while it was drawn from what the phone saved', () => {
  const workshop = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(workshop, /status !== 'online' && status !== 'updating' && savedAt !== null && showsAge\(savedAt\)/);
  assert.match(workshop, /c\.key === 'votes' && asOf \? <span className="dev-ws-dash-sub" data-ws-dash-sub="asof">/);
  assert.equal(message('project:workshop.dash.asOf', { time: '12:41' }), 'as of 12:41');
});

test('the phone app reads its first screens ahead on a good connection, at most every half hour', () => {
  const warm = read('frontend/src/features/shell/warm-saved.ts');
  assert.match(warm, /WARM_EVERY_MS = 30 \* 60 \* 1000/);
  assert.match(warm, /!isNativeApp\(\)/, 'only in the phone app');
  assert.match(warm, /isOffline\(\) \|\| !goodConnection\(\) \|\| !due\(now\)/);
  assert.match(read('frontend/src/main.tsx'), /bootStep\('installWarmSaved', \(\) => installWarmSaved\(\)\)/);
});

test('a read stuck past five seconds tells the probe, and a saved answer tells the freshness', () => {
  const timeout = read('frontend/src/lib/read-timeout.ts');
  assert.match(timeout, /export const SLOW_READ_MS = 5000;/);
  assert.match(timeout, /win\.Offline\.slowRead\(\)/);
  assert.match(timeout, /res\.headers\.get\('sw-cached-at'\)/);
  assert.match(read('public/sw.js'), /const CACHED_AT_HEADER = 'sw-cached-at';/, 'the worker still stamps its saved answers');
});

test('read-timeout tells the probe the network answered, never for the worker\'s saved copy', () => {
  const timeout = read('frontend/src/lib/read-timeout.ts');
  const noteAnswer = timeout.slice(timeout.indexOf('function noteAnswer('), timeout.indexOf('function nudge('));
  assert.ok(noteAnswer.indexOf('return;') < noteAnswer.indexOf('Offline.answered()'), 'a saved copy returns before it is counted');
  assert.match(noteAnswer, /res\.status > 0 && res\.status < 500/, 'a server that is down is no answer');
  assert.match(read('frontend/src/lib/offline.ts'), /outcome === 'timeout' && !offline && !noNetwork\s*&& answeredAt > 0 && Date\.now\(\) - answeredAt < ANSWERED_RECENTLY_MS/);
});

test('offline, an item whose own read had no answer keeps its page instead of dropping to the Workshop', () => {
  const view = read('public/js/app-view.js');
  const miss = view.slice(view.indexOf('const onMiss = () => {'), view.indexOf('const settle = () => {'));
  assert.ok(miss.indexOf('AppView._noAnswerNow()') > -1 && miss.indexOf('AppView._noAnswerNow()') < miss.indexOf("App.switchTab('dev')"),
    'the offline branch comes before the Workshop fallback');
  assert.match(miss, /AppView\._openChangeWhenOnline\(content, ref, AppView\._devTopic\);/);
  assert.match(view, /_noAnswerNow\(\) \{[\s\S]*?Offline\.isOffline\(\)[\s\S]*?online === false/);
  assert.match(message('changes:page.notSavedYetThread'), /isn’t saved on this phone yet/);
});

// The second follow-up (19 Nov 2026 retest): on the slow link the worker gave
// up after its 4 s deadline and served saved copies, so the page saw no
// network answer and took the link for a dead one. The worker's late network
// answers and the events socket's frames count as the network answering.
test('the worker says when the network answered behind a saved copy, and the page counts it', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /if \(res && res\.status > 0 && res\.status < 500 && served\.fromCache\) noteNetworkAnswered\(event\);/,
    'only behind a copy it served: an answer the page received itself is counted by read-timeout');
  assert.match(sw, /const NETWORK_ANSWERED_GAP_MS = 2000;[\s\S]*?if \(now - networkAnsweredAt < NETWORK_ANSWERED_GAP_MS\) return;/, 'at most once every two seconds');
  assert.match(sw, /notifyClients\(\{ type: 'network-answered' \}\)/);
  const page = read('frontend/src/lib/service-worker.ts');
  assert.match(page, /data\.type === 'network-answered'[\s\S]*?Offline\?\.answered\?\.\(\)/);
});

// The fourth follow-up (19 Nov 2026 retest): a change page's four shots
// queued 17 s of bytes on the slow link, and the probe timed out behind them
// with no answer seen for 10 s. Bytes arriving are the network answering.
test('a network body the worker hands the page counts as the network answering while it arrives', () => {
  const sw = read('public/sw.js');
  assert.match(sw, /return fromCache \? response : reportArriving\(event, response\);/, 'an API read from the network');
  // The fifth follow-up (the retest of #6876): an <img> sends no scope header,
  // so every picture, a change's shots too, leaves through the no-scope exit.
  assert.match(sw, /if \(!context\) \{\s*return fetch\(new Request\(event\.request, \{ cache: 'no-store' \}\)\)\.then\(\(res\) => reportArriving\(event, res\)\);/,
    'a picture, which has no scope');
  assert.match(sw, /event\.waitUntil\(cache\.put\(event\.request, res\.clone\(\)\)\.catch\(\(\) => \{\}\)\);\s*\}\s*return reportArriving\(event, res\);/,
    'an icon, avatar or visual downloaded the first time');
  assert.match(sw, /transform\(chunk, controller\) \{\s*noteNetworkAnswered\(event\);\s*controller\.enqueue\(chunk\);/, 'told per chunk, through the two-second gap');
  assert.match(sw, /res\.body\.pipeThrough\(counted\)/, 'piped, so a page that drops the picture still cancels its download');
  assert.match(read('frontend/src/lib/offline.ts'), /a network body\s*\* the worker hands the page still arriving/);
});

test('a frame on the events socket counts as the network answering', () => {
  const app = read('public/js/app.js');
  const handler = app.slice(app.indexOf('App.eventsWs.onmessage = (event) => {'), app.indexOf('JSON.parse(event.data)', app.indexOf('App.eventsWs.onmessage = (event) => {')));
  assert.match(handler, /window\.Offline\?\.answered\?\.\(\)/);
});
