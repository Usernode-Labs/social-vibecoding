// A late-arrival correction re-runs the Home screen past the panels' minute
// (request #4005: "Challenge numbers stuck after I finished tasks").
//
// The service worker answers a slow GET /api/home-panels from its cache and
// posts `api-updated` when the real answer disagrees with the copy it served
// (public/sw.js). App.refreshActiveScreen then re-runs the visible screen's
// loader — its Home branch used to be a plain Home.load(), whose panels read
// is TTL-guarded (HomePanels.TTL_MS): a correction landing within a minute of
// the last read repainted the Challenges block from the copy the worker had
// just proved stale, which is exactly the reported old numbers for a while.
// Now the correction's re-run carries { forcePanels: true } through
// Home.load() → Home._loadOnce() → HomePanels.ensureLoaded({ force: true }),
// whose forced path (a join's, already shipped) announces the refresh intent
// so the worker's zero-deadlane boot lane does not answer from cache again,
// and does not share a read that left before the correction.
//
// Ordinary loads and pull-to-refresh keep the TTL: only the correction forces.
//
// home.js and home-panels.js run together in one vm context, with a fetch the
// test answers by hand — the same idiom tests/home-challenges-after-join.
// test.js runs Home.setMembership's forced read in.
//
// Run with: node --test tests/home-panels-force-on-correction.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { HOME_SRC, PANELS_SRC } = require('./helpers/home-modules');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');

const CHALLENGE_ID = 7;

// GET /api/home-panels with one "This week" challenge in it, done or not —
// the shape a finished task corrects.
function panelsPayload(done) {
  return {
    registry: [{ key: 'challenges', title: 'Challenges', removable: false }],
    hidden: [],
    panels: [{
      key: 'challenges',
      title: 'Challenges',
      season: { id: 2, name: 'Season 2' },
      total: 1,
      done: done ? 1 : 0,
      points_remaining: done ? 0 : 500,
      challenges: [{
        id: CHALLENGE_ID,
        label: 'This week',
        goal: 'Ship a change',
        task: 'Finish the tasks.',
        reward: '500 pts',
        cta: null,
        metric: null,
        progress: { done, current: null, target: null },
        earned_points: done ? 500 : 0,
      }],
    }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// `holdPanels` / `holdApps`: the named GET waits until the test lets it
// answer. Holding the catalog read is what keeps Home._loadInFlight set, so
// the calls fired behind it really do queue.
function makeHome({ holdPanels = false, holdApps = false } = {}) {
  const bus = new EventTarget();
  // One ordered log of what reached the network and the service worker.
  const log = [];
  const server = { done: false };
  const held = [];
  const sandbox = {
    console,
    App: {
      user: { id: 7 },
      _announceRefreshIntent: () => log.push('refresh-intent'),
    },
    PlatformUI: { toast: () => {} },
    document: {
      addEventListener: bus.addEventListener.bind(bus),
      removeEventListener: bus.removeEventListener.bind(bus),
      dispatchEvent: bus.dispatchEvent.bind(bus),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    CustomEvent,
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      log.push(`${method} ${url}`);
      if (url === '/api/home-panels') {
        const answer = panelsPayload(server.done);
        if (holdPanels) {
          const gate = deferred();
          held.push(gate);
          await gate.promise;
        }
        return { ok: true, status: 200, json: async () => answer };
      }
      if (url === '/api/apps') {
        if (holdApps) {
          const gate = deferred();
          held.push(gate);
          await gate.promise;
        }
        return { ok: true, status: 200, json: async () => ({ apps: [] }) };
      }
      if (url === '/api/home-layout') {
        return { ok: true, status: 200, json: async () => ({ layouts: {} }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    setTimeout, clearTimeout,
    URLSearchParams,
    location: { search: '', hash: '' },
    Date,
    addEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  vm.runInContext(`${PANELS_SRC}\n;globalThis.__HP = HomePanels;`, sandbox);
  const Home = sandbox.__Home;
  const HP = sandbox.__HP;
  // The launcher's own paint and its /api/apps read are not under test:
  // the real Home.load runs (the option threading is), only render is counted.
  const counts = { render: 0 };
  Home.render = () => { counts.render += 1; };

  const challengeCard = () => {
    const view = sandbox.panelsStore.get().challenges;
    return view && view.rows.find((r) => r.id === String(CHALLENGE_ID));
  };
  const panelReads = () => log.filter((l) => l.startsWith('GET /api/home-panels'));
  // Wait for every load and read Home or the block has started or queued.
  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      const pending = Home._loadQueued || Home._loadInFlight
        || HP._queued || HP._inflight;
      if (pending) await pending;
      await new Promise((r) => setImmediate(r));
    }
  };
  return {
    Home, HP, sandbox, log, server, held, counts, challengeCard, panelReads, settle,
  };
}

test('a correction\'s re-run reads the block again inside its minute', async () => {
  const h = makeHome();
  // The boot-lane answer the worker served: the challenge is not done.
  await h.Home.load();
  await h.settle();
  assert.deepEqual(h.panelReads(), ['GET /api/home-panels'], 'the boot read');
  assert.equal(h.challengeCard().done, false);
  assert.equal(h.challengeCard().stateLabel, 'Not started');

  // The late answer disagrees, so the worker corrects and re-runs Home —
  // within the TTL. The re-run must not be answered by the copy it just
  // proved stale.
  h.server.done = true;
  h.log.length = 0;
  await h.Home.load({ forcePanels: true });
  await h.settle();

  assert.deepEqual(h.log.slice(0, 2), ['refresh-intent', 'GET /api/home-panels'],
    'the re-run re-reads the panels inside the minute, and tells the worker first');
  assert.deepEqual(h.panelReads(), ['GET /api/home-panels'], 'exactly one more read');
  assert.equal(h.challengeCard().done, true);
  assert.equal(h.challengeCard().state, 'done');
  assert.equal(h.challengeCard().earned, 'Earned 500 pts');

  // The unchanged guard, in the same context: an ordinary load inside the
  // same minute still reads nothing, so only the correction's path forces.
  h.log.length = 0;
  await h.Home.load();
  await h.settle();
  assert.deepEqual(h.panelReads(), [], 'the TTL holds for Home.load()\'s dozen callers');
  assert.ok(h.counts.render > 0, 'the grid itself still re-ran');
});

test('a forced call behind a running load marks the queued rerun forced', async () => {
  const h = makeHome({ holdPanels: true, holdApps: true });
  // A read left before the correction (a warm boot's panels read, say), with
  // its load still running.
  h.Home.load();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.held.length, 2,
    'the first load\'s panels read and its catalog read are held open');

  // An ordinary load queues behind it, then the correction lands and forces.
  const queued = h.Home.load();
  assert.equal(queued, h.Home._loadQueued, 'the ordinary call queues, as before');
  const forced = h.Home.load({ forcePanels: true });
  assert.equal(forced, h.Home._loadQueued, 'the forced call shares the queued rerun');

  // The early read answers with what the server said before the correction
  // (its payload was fixed when the fetch was issued), moments before the
  // queued rerun starts.
  h.held[0].resolve();
  await new Promise((r) => setImmediate(r));
  h.server.done = true;
  h.held[1].resolve();

  // The queued rerun goes, and ITS panels read is forced: a second read even
  // though the first answer just landed inside the minute.
  for (let i = 0; i < 20 && h.held.length < 3; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(h.held.length >= 3, 'one more read is out (held may batch with the rerun\'s catalog read)');
  assert.ok(h.log.indexOf('refresh-intent') > h.log.indexOf('GET /api/home-panels'),
    'the rerun tells the worker first');
  h.held[2].resolve();
  // The rerun's own catalog read is held by holdApps too; let it through so
  // the rerun can settle.
  for (let i = 0; i < 20 && h.held.length < 4; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  h.held[3].resolve();
  await h.settle();

  assert.deepEqual(h.panelReads(), ['GET /api/home-panels', 'GET /api/home-panels']);
  assert.equal(h.challengeCard().done, true, 'the corrected answer is what painted');
  assert.equal(h.Home._loadQueuedForce, false, 'the flag is spent, not sticky');
  assert.equal(h.HP._queued, null);
});
