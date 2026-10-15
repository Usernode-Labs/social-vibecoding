'use strict';

// N6 and N7: what a first version's card shows while it is built, tested
// and reviewed. Newcomer run four (Club Votes, 12 October 2026): Live was
// offered at 21:48 but its watcher started only with the build turn at
// 21:52:31, so for about 14 minutes it said "Starting the app…" over an
// empty phone, switching to the first look and back every 10 s (the App
// tab's recheck remounted the card); its first frame was the app's own
// error state; the replay looked near blank; the watcher restarted the app
// 19 times (10 not kept); and once it was tested the card dropped the live
// app it had shown for 35 minutes for the first look drawn from the plan.
//
//   (a) Live is offered once the watcher has a good frame (liveStatusOf).
//   (b) The App tab updates the card in place (AppView._repaintFirstVersion,
//       appStatusBridge.update) instead of remounting it every 10 s.
//   (c) A stylesheet not loaded at the snapshot is kept as an empty <style>
//       that its later text fills; the recording starts from a snapshot of
//       the settled page, its stylesheets loaded.
//   (d) A good frame is a settled page: no uncaught error, none of its own
//       requests failed, nothing changing and nothing of its own pending.
//   (e) Restarts: only when the app's own files changed (what git would
//       commit), once they are quiet; a marker only with a change; the old
//       app gone and its port free before the next boot; why each restart
//       was not kept is counted.
//   N7  From Testing it without real screens, the build's last frame stays.
//
// Run with: node --test tests/first-version-live-hold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const live = require('../src/services/first-version-live');
const watch = require('../worker/usernode-live-watch');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── (c) The replay keeps the app's own styles ───────────────────────────

test('(c) a stylesheet not loaded yet at the snapshot stays as an empty <style>, which its text fills when it loads', () => {
  const head = (children) => ({
    type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'html', attributes: {}, childNodes: [
      { type: 2, id: 3, tagName: 'head', attributes: {}, childNodes: children },
    ] }],
  });
  const [, snap] = live.sanitizeEvents([
    { type: 4, timestamp: 1, data: { href: 'http://localhost:3300/?demo=1', width: 390, height: 760 } },
    { type: 2, timestamp: 2, data: { initialOffset: { top: 0, left: 0 }, node: head([
      { type: 2, id: 10, tagName: 'link', attributes: { rel: 'stylesheet', href: '/tailwind.css' }, childNodes: [] },
      { type: 2, id: 11, tagName: 'link', attributes: { rel: 'preload', as: 'style', href: '/usernode-native/v1/native.css' }, childNodes: [] },
      { type: 2, id: 12, tagName: 'link', attributes: { rel: 'icon', href: '/favicon.ico' }, childNodes: [] },
      { type: 2, id: 13, tagName: 'link', attributes: { rel: 'Alternate Stylesheet', href: 'http://x/a.css' }, childNodes: [] },
    ]) } },
  ]);
  const nodes = snap.data.node.childNodes[0].childNodes[0].childNodes;
  assert.deepEqual(nodes[0], { type: 2, id: 10, tagName: 'style', attributes: {}, childNodes: [] }, 'nothing to fetch, a place for its text');
  assert.deepEqual(nodes[1], { type: 2, id: 11, tagName: 'style', attributes: {}, childNodes: [] });
  assert.deepEqual(nodes[2], { type: 2, id: 12, tagName: 'meta', attributes: {}, childNodes: [] }, 'any other link goes');
  assert.equal(nodes[3].tagName, 'style');
  assert.doesNotMatch(JSON.stringify(snap), /tailwind\.css|native\.css|favicon|http:\/\/x/);
  // rrweb sends the sheet's text once it loads, as an attribute change on
  // the same node (StylesheetManager.attachLinkElement); the player fills a
  // <style> with it. It is cleaned like any other CSS.
  const [later] = live.sanitizeEvents([{ type: 3, timestamp: 3, data: {
    source: 0, texts: [], removes: [], adds: [],
    attributes: [{ id: 10, attributes: { _cssText: '.row{color:#123;background:url(http://x/b.png)}', crossorigin: 'anonymous' } }],
  } }]);
  assert.deepEqual(later.data.attributes, [{ id: 10, attributes: { _cssText: '.row{color:#123;background:url()}', crossorigin: 'anonymous' } }]);
  assert.equal(live.isStylesheetLink({ rel: 'preload', href: '/a.css?v=2' }), true);
  assert.equal(live.isStylesheetLink({ rel: 'preload', as: 'font', href: '/f.woff2' }), false);
  assert.equal(live.isStylesheetLink(null), false);
  // The player swaps a <style> or <link> for its text: rrweb 2.1.3 itself.
  const player = fs.readFileSync(path.join(path.dirname(require.resolve('rrweb')), 'rrweb.cjs'), 'utf8');
  assert.match(player, /attributeName === "_cssText" && \(target\.nodeName === "LINK" \|\| target\.nodeName === "STYLE"\)/);
});

test('(c, d) the recording starts from a snapshot of the settled page, taken on the watcher\'s word', () => {
  const s = watch.initScript('/* rrweb */');
  assert.match(s, /document\.addEventListener\('__usernode_live_checkout', function \(\) \{\n {2}try \{ rr\.record\.takeFullSnapshot\(true\); \} catch \(err\) \{\}\n\}\);/);
  assert.doesNotMatch(s, /window\.__usernodeLiveCheckout|window\.rr\b/, 'nothing new on window');
  const ev = (type) => JSON.stringify({ type, data: {}, timestamp: 1 });
  // Meta, Full from DOMContentLoaded, then changes, then the checkout's Meta and Full.
  const events = [ev(4), ev(2), ev(3), ev(3), ev(4), ev(2), ev(3)];
  assert.equal(watch.checkoutStart(events, 2), 4);
  assert.equal(watch.checkoutStart(events, 5), -1, 'its Meta came before');
  assert.equal(watch.checkoutStart([ev(3), ev(3)], 0), -1);
  assert.equal(watch.checkoutStart(['{"data":{},"type":4}', '{"data":{},"type":2}'], 0), 0, 'read whatever the key order');
  const src = read('worker/usernode-live-watch.js');
  assert.match(src, /document\.dispatchEvent\(new Event\('__usernode_live_checkout'\)\)/);
  assert.match(src, /if \(at >= 0\) \{ rec\.events\.splice\(0, at\); return true; \}/);
});

// ── (d) A good frame ─────────────────────────────────────────────────────

test('(d) a good frame: settled, no error, none of its own requests failed', () => {
  const { STABLE_MS } = watch;
  const rec = (over = {}) => ({ errors: 0, failed: 0, inflight: 0, lastAt: 10_000, events: ['a', 'b'], ...over });
  // Quiet for STABLE_MS with nothing of its own pending: settled.
  assert.equal(watch.settledNow(rec(), 10_000 + STABLE_MS), true);
  assert.equal(watch.settledNow(rec(), 10_000 + STABLE_MS - 1), false, 'still changing');
  assert.equal(watch.settledNow(rec({ inflight: 1 }), 10_000 + STABLE_MS), false, 'its data still loading');
  // At the limit: an app holding a request open, or one that animates, is settled.
  assert.equal(watch.settledNow(rec({ inflight: 1 }), 10_000 + STABLE_MS, { limitReached: true }), true);
  assert.equal(watch.settledNow(rec(), 10_001, { limitReached: true }), true);
  // Still changing with a request pending at the limit: still loading.
  assert.equal(watch.settledNow(rec({ inflight: 1 }), 10_001, { limitReached: true }), false);

  const ok = { settled: true, text: 40, size: 1000 };
  assert.equal(watch.frameProblem(rec(), ok), null);
  assert.equal(watch.frameProblem(rec({ errors: 1 }), ok), 'the page threw an error');
  // "Couldn't load the decisions": the app's own request answered an error.
  assert.equal(watch.frameProblem(rec({ failed: 1 }), ok), 'a request of the page failed');
  assert.equal(watch.frameProblem(rec(), { ...ok, settled: false }), 'the page was still loading');
  assert.equal(watch.frameProblem(rec(), { ...ok, text: 0 }), 'the page was empty');
  assert.equal(watch.frameProblem(rec({ events: ['a'] }), ok), 'nothing was recorded');
  assert.equal(watch.frameProblem(rec(), { ...ok, size: 10 * 1024 * 1024 }), 'the page was too large to stream');
});

test('(d) the page\'s own requests: its fetch and XHR to the app, never the platform\'s assets', () => {
  const req = (url, type = 'fetch') => ({ url: () => url, resourceType: () => type });
  const origin = 'http://localhost:3300';
  assert.equal(watch.ownRequest(req('http://localhost:3300/api/decisions'), origin), true);
  assert.equal(watch.ownRequest(req('http://localhost:3300/api/me', 'xhr'), origin), true);
  assert.equal(watch.ownRequest(req('http://localhost:3300/tailwind.css', 'stylesheet'), origin), false);
  assert.equal(watch.ownRequest(req('http://localhost:3300/usernode-bridge/v1/x.json'), origin), false);
  assert.equal(watch.ownRequest(req('https://fonts.example/x'), origin), false);
  assert.equal(watch.ownRequest({}, origin), false);
  const src = read('worker/usernode-live-watch.js');
  assert.match(src, /page\.on\('response', \(r\) => \{ if \(ownRequest\(r\.request\(\), origin\) && r\.status\(\) >= 400\) rec\.failed \+= 1; \}\);/);
  assert.match(src, /if \(!\/ERR_ABORTED\/i\.test\(why\)\) rec\.failed \+= 1;/, 'a request the page called off is no failure');
});

// ── (e) Restarts ─────────────────────────────────────────────────────────

test('(e) a restart: the first boot; a change once quiet, at most every 30 s; a marker only with a change', () => {
  const { QUIET_MS, MIN_RESTART_MS, MARKER_MIN_MS, MAX_PENDING_MS } = watch;
  const t = 1_000_000;
  const base = { now: t, changed: true, changedAt: t - QUIET_MS, pendingSince: t - QUIET_MS, lastRestart: t - MIN_RESTART_MS };
  assert.equal(watch.restartDue({ first: true, now: t }), 'first');
  assert.equal(watch.restartDue(base), 'change');
  assert.equal(watch.restartDue({ ...base, changed: false }), null, 'nothing new');
  assert.equal(watch.restartDue({ ...base, changedAt: t - 1000 }), null, 'still being written: wait for it to be quiet');
  assert.equal(watch.restartDue({ ...base, changedAt: t - 1000, pendingSince: t - MAX_PENDING_MS }), 'change', 'but not forever');
  assert.equal(watch.restartDue({ ...base, lastRestart: t - 1000 }), null, 'at most once every 30 s');
  // A marker: a point of the plan is done.
  assert.equal(watch.restartDue({ ...base, changedAt: t - 1000, lastRestart: t - MARKER_MIN_MS, marker: true }), 'marker');
  assert.equal(watch.restartDue({ ...base, marker: true, lastRestart: t - 1000 }), null, 'not right after a restart');
  assert.equal(watch.restartDue({ ...base, marker: true, changed: false }), null, 'nothing new to show');
});

test('(e) what counts as a change: the app\'s own files, as git would commit them', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'live-sig-'));
  try {
    fs.writeFileSync(path.join(dir, 'server.js'), 'x');
    fs.mkdirSync(path.join(dir, 'public'));
    fs.writeFileSync(path.join(dir, 'public', 'tailwind.css'), 'a{}');
    const files = ['server.js'];
    const before = watch.workspaceSignature(dir, files);
    // A build output (ignored, or excluded by the in-loop launch) changes nothing.
    fs.writeFileSync(path.join(dir, 'public', 'tailwind.css'), 'a{color:red}');
    assert.equal(watch.workspaceSignature(dir, files), before);
    fs.writeFileSync(path.join(dir, 'server.js'), 'xy');
    assert.notEqual(watch.workspaceSignature(dir, files), before, 'a change to the app');
    assert.notEqual(watch.workspaceSignature(dir, ['server.js', 'new.js']), watch.workspaceSignature(dir, files), 'a new file');
    // Without git, the whole checkout, as before.
    assert.match(watch.workspaceSignature(dir, null), /^2:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // git ls-files: tracked, and untracked but not ignored, without locks.
  const asked = [];
  const run = (cmd, args, opts) => { asked.push({ cmd, args, opts }); return { status: 0, stdout: 'a.js\0b/c.js\0a.js\0' }; };
  assert.deepEqual(watch.appFiles('/w', run), ['a.js', 'b/c.js']);
  assert.deepEqual(asked[0].args, ['-C', '/w', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  assert.equal(asked[0].opts.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(watch.appFiles('/w', () => ({ status: 128, stdout: '' })), null);
  assert.equal(watch.appFiles('/w', () => { throw new Error('no git'); }), null);
});

test('(e) the old app is gone, and its port free, before the next one boots; the copy is what the signature says', () => {
  const src = read('worker/usernode-live-watch.js');
  const restart = src.slice(src.indexOf('async function restart('), src.indexOf('function restartDue('));
  assert.match(restart, /await closePage\(\);\s+\/\/ The old app gone, and its port free, before anything boots on it\.\s+await stopApp\(\);\s+await portFree\(\);/);
  assert.ok(restart.indexOf('copiedSig = workspaceSignature();') < restart.indexOf('snapshot();'), 'the signature of what is copied');
  assert.ok(restart.indexOf('await portFree();') < restart.indexOf('bootApp(lib, identity)'));
  const stopApp = src.slice(src.indexOf('function stopApp()'), src.indexOf('async function portFree('));
  assert.match(stopApp, /child\.once\('exit', done\);/);
  assert.match(stopApp, /kill = setTimeout\(\(\) => \{ try \{ process\.kill\(-child\.pid, 'SIGKILL'\); \}/);
  assert.match(stopApp, /\n {2}return appGone;\n\}\n/);
  // Each line says what started its restart.
  assert.match(restart, /line\(\{ t: 'full', events: [^}]+, cause \}\);/);
  assert.match(restart, /return line\(\{ t: 'fail', why, cause \}\);/);
});

test('(e) why each restart was not kept, and what started it, are counted for the run', async () => {
  const s = { bytes: 0, base: null, kept: 0, failed: 0, goodFrame: false, memoryStop: false, stoppedWhy: null, dropped: 0, minHeadroomMb: null };
  const pool = { async query(sql) { return /RETURNING next_seq - 1 AS seq/.test(sql) ? { rows: [{ seq: 1 }] } : { rows: [] }; } };
  await live.ingest(pool, 7, { t: 'fail', why: 'a request of the page failed', cause: 'first' }, s);
  await live.ingest(pool, 7, { t: 'fail', why: 'a request of the page failed', cause: 'change' }, s);
  await live.ingest(pool, 7, { t: 'fail', why: 'the app exited while starting', cause: 'marker' }, s);
  const meta = { type: 4, timestamp: 1, data: { href: '', width: 390, height: 760 } };
  const full = { type: 2, timestamp: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } } };
  await live.ingest(pool, 7, { t: 'full', events: [meta, full], cause: 'change' }, s);
  assert.equal(s.failed, 3);
  assert.deepEqual(s.failWhys, { 'a request of the page failed': 2, 'the app exited while starting': 1 });
  assert.deepEqual(s.causes, { first: 1, change: 2, marker: 1 });
  // Never more than a dozen reasons, each cut short.
  const many = {};
  for (let i = 0; i < 20; i += 1) live.tally(many, 'failWhys', `why ${i} ${'x'.repeat(100)}`);
  assert.equal(Object.keys(many.failWhys).length, 12);
  assert.ok(Object.keys(many.failWhys).every((k) => k.length <= 60));
  assert.match(read('src/services/first-version-live.js'), /failWhys: stats\.failWhys \|\| \{\}, causes: stats\.causes \|\| \{\},/);
});

// ── (a) Offered once there is something to show; N7 the build's frame ───

test('(a) liveStatusOf: the newest build\'s Live, good once a restart was kept, ended once its watcher stopped', async () => {
  const pool = (row, run = { id: 7 }) => ({
    asked: [],
    async query(sql, params) {
      this.asked.push({ sql, params });
      if (/homeroom_bot_first_versions/.test(sql)) return { rows: run ? [run] : [] };
      if (/FROM first_version_live l WHERE l\.bot_run_id/.test(sql)) return { rows: row ? [row] : [] };
      return { rows: [] };
    },
  });
  assert.equal(await live.liveStatusOf(pool(null, null), 1), null, 'no build');
  assert.equal(await live.liveStatusOf(pool(null), 1), null, 'no watcher yet');
  assert.deepEqual(await live.liveStatusOf(pool({ base_seq: null, good_at: null, ended_at: null }), 1), { runId: 7, good: false, ended: false });
  assert.deepEqual(await live.liveStatusOf(pool({ base_seq: 4, good_at: new Date(), ended_at: new Date(), kept: true }), 1), { runId: 7, good: true, ended: true });
  // Its recording gone (a day after its build ended): nothing to show.
  assert.deepEqual(await live.liveStatusOf(pool({ base_seq: 4, good_at: new Date(), ended_at: new Date(), kept: false }), 1), { runId: 7, good: false, ended: true });
  // liveOf says it too, so the card stops asking every 2 s.
  const answer = await live.liveOf({
    async query(sql) {
      if (/homeroom_bot_first_versions/.test(sql)) return { rows: [{ id: 7 }] };
      if (/FROM first_version_live WHERE/.test(sql)) return { rows: [{ base_seq: 1, good_at: new Date(), failed_at: null, ended_at: new Date(), age: 600 }] };
      if (/FROM first_version_live_chunks/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  }, 1, 0);
  assert.equal(answer.ended, true);
});

test('N7: the newest BUILD, never a follow-up run on its proposal, is what the card shows', () => {
  for (const file of ['src/services/first-version-live.js', 'src/services/first-version-screens.js']) {
    const src = read(file);
    const sql = src.slice(src.indexOf('const RUN_SQL = `'), src.indexOf('`;', src.indexOf('const RUN_SQL = `')));
    assert.match(sql, /WHERE f\.app_id = \$1 AND f\.bot_builds = TRUE\s+AND r\.mode = 'live' AND r\.verdict = 'ready'\s+ORDER BY r\.id DESC/, file);
  }
  const apps = read('src/routes/apps.js');
  assert.match(apps, /mine, line: state\.line \|\| null, realScreens: showcase\.screens\?\.kind === 'real',/);
});

// ── The App tab ──────────────────────────────────────────────────────────

function makeAppView() {
  const SRC = read('public/js/app-view.js');
  const hosts = {
    'app-content': { id: 'app-content', isConnected: true },
    'app-view': { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; } },
  };
  const calls = [];
  let shown = null;
  const sandbox = {
    console,
    App: { user: { id: 1 }, currentApp: 'club-votes', currentTab: 'app', setHeaderTitle() {} },
    document: {
      visibilityState: 'visible',
      getElementById: (id) => hosts[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
    setTimeout: () => 0, clearTimeout: () => {}, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    UsernodeReact: {
      appStatus: {
        mount: (host, view) => { calls.push('mount'); shown = view; },
        update: (host, view) => { calls.push('update'); if (!shown) return false; shown = view; return true; },
        clear: () => { calls.push('clear'); shown = null; },
      },
      devBoard: { unmountAll: () => calls.push('unmountAll') },
      appFrame: { unmount: () => calls.push('frame-unmount') },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, calls, shown: () => shown, sandbox };
}

const building = (fv = {}) => ({
  slug: 'club-votes', name: 'Club Votes', status: 'running', url: 'https://club-votes.example.test',
  first_version: { building: true, mine: false, member: true, step: 4, of: 7, line: 'building', ready: false, question: false, live: true, ...fv },
});

test('(b) the 10 s recheck updates the card in place; nothing tears it down while it is still the screen', () => {
  const { AppView, calls, shown } = makeAppView();
  AppView.appData = building();
  AppView.renderAppTab();
  assert.deepEqual(calls.filter((c) => c !== 'frame-unmount'), ['update', 'unmountAll', 'clear', 'mount'], 'the first paint mounts it');
  calls.length = 0;
  AppView.appData = building({ caption: 'Adding the ballot bar' });
  AppView.renderAppTab();
  assert.deepEqual(calls.filter((c) => c !== 'frame-unmount'), ['update'], 'then only updated: no unmountAll, no remount');
  assert.equal(shown().buildNote, 'Adding the ballot bar');
  assert.deepEqual(JSON.parse(JSON.stringify(shown().live)), { slug: 'club-votes', userKey: '1' });
  // Once something else took the host (its view cleared), the full render runs.
  calls.length = 0;
  AppView._teardownDevRoots();
  calls.length = 0;
  AppView.renderAppTab();
  assert.deepEqual(calls.filter((c) => c !== 'frame-unmount'), ['update', 'unmountAll', 'clear', 'mount']);
  // And the built app is never updated into the placeholder.
  calls.length = 0;
  assert.equal(AppView._repaintFirstVersion(hosts(), { ...building(), first_version: null }), false);
  assert.equal(AppView._repaintFirstVersion(hosts(), { ...building(), status: 'creating' }), false);
  assert.deepEqual(calls, []);
  const src = read('public/js/app-view.js');
  const render = src.slice(src.indexOf('  renderAppTab() {'), src.indexOf('    if (!appData || appData.status !== \'running\' || !appData.url) {', src.indexOf('  renderAppTab() {')));
  assert.ok(render.indexOf('if (AppView._repaintFirstVersion(content, appData)) return;') < render.indexOf('AppView._teardownDevRoots();'));
  function hosts() { return { id: 'app-content', isConnected: true }; }
});

test('(b) the bridge updates only the placeholder still on its host', () => {
  const m = loadTsx('frontend/src/features/app-frame/mount.ts');
  const host = { id: 'app-content', isConnected: true, replaceChildren() {} };
  const v = (message) => ({ dot: null, message, detail: null, action: null });
  assert.equal(m.appStatusBridge.update(host, v('a')), false, 'nothing mounted');
  m.appStatusBridge.mount(host, v('a'));
  assert.equal(m.appStatusBridge.update(host, v('b')), true);
  assert.equal(m.appStatusBridge.update({ id: 'other', isConnected: true, replaceChildren() {} }, v('c')), false, 'another host');
  assert.equal(m.appStatusBridge.update({ ...host, isConnected: false }, v('c')), false);
  m.appStatusBridge.clear();
  assert.equal(m.appStatusBridge.update(host, v('d')), false, 'cleared: something else has the host');
  m.appStatusBridge.unmount(host);
});

test('N7: tested (or ready) without real screens, the build\'s last frame, and no switch', () => {
  const { AppView } = makeAppView();
  const at = (fv) => {
    AppView.appData = building(fv);
    return AppView._firstVersionLive(AppView.appData);
  };
  assert.deepEqual(JSON.parse(JSON.stringify(at({ line: 'testing', live: undefined, liveLast: true }))), { slug: 'club-votes', userKey: '1', last: true });
  assert.deepEqual(JSON.parse(JSON.stringify(at({ line: 'ready', live: undefined, liveLast: true }))), { slug: 'club-votes', userKey: '1', last: true });
  assert.equal(at({ line: 'building', live: undefined, liveLast: true }), null, 'not while it is built');
  assert.equal(at({ line: 'testing', live: true }), null, 'Live itself only while it is built');
  const api = loadTsx('tests/fixtures/app-status-api.ts');
  const view = JSON.parse(JSON.stringify(AppView._appStatusView(building({ line: 'testing', live: undefined, liveLast: true }))));
  api.appStatusStore.set({ view });
  const out = renderToHtml(createElement(api.AppStatus));
  assert.doesNotMatch(out, /data-first-version-live-switch/, 'nothing to choose');
  const status = read('frontend/src/features/app-frame/app-status.tsx');
  assert.match(status, /const lastFrame = !!live && !!live\.last && \(line === 'testing' \|\| line === 'ready'\);/);
  assert.match(status, /const watching = \(liveOffered && choice === 'live'\) \|\| lastFrame;/);
});

test('N7: the pill says it is the build\'s last screen once its watcher stopped', () => {
  const sw = loadTsx('frontend/src/features/app-frame/live-switch.tsx');
  assert.equal(sw.livePill('ended', 900), 'Last screen from the build');
  assert.equal(sw.livePill('live', 2), 'Live · just updated');
  const band = read('frontend/src/features/app-frame/live-band.tsx');
  assert.match(band, /export function phaseOf\(state: LiveAnswer\['state'\] \| null, drawn: boolean, ended = false\): LivePhase \{\s+if \(!drawn\) return 'starting';\s+if \(ended\) return 'ended';/);
  assert.match(band, /if \(answer\.ended === true && goodFrame\) wait = ENDED_POLL_MS;/);
  // A new build of it starts over from its own recording.
  assert.match(band, /answer\.runId !== runId\) \{[\s\S]{0,200}seq = 0;/);
  const en = JSON.parse(read('frontend/locales/en/agent.json'));
  assert.equal(en['appFrame.live.frame.ended'].text, '{{project}}, as it last looked while it was built');
});

test('(a) a choice remembered for the project holds when Live is offered after the card drew; else Live', () => {
  const src = read('frontend/src/features/app-frame/live-switch.tsx');
  assert.match(src, /const choice: LiveChoice = picked && picked\.key === key\s+\? picked\.choice\s+: shownChoice\(offered, offered \? readChoice\(userKey as string, slug as string\) : null\);/);
  const sw = loadTsx('frontend/src/features/app-frame/live-switch.tsx');
  assert.equal(sw.shownChoice(true, null), 'live', 'offered (it has frames), nothing picked: Live');
  assert.equal(sw.shownChoice(true, 'preview'), 'preview', 'Preview picked for the project sticks');
  assert.equal(sw.shownChoice(true, 'live'), 'live');
  assert.equal(sw.shownChoice(false, 'live'), 'preview', 'not offered: Preview, whatever was picked');
});
