'use strict';

// #4449: LIVE, a first version's app shown taking shape while it is built.
// The sanitiser (nothing a viewer could fetch), the stream's storage, the
// watcher's controller and guards, the setting, the member-only routes and
// the build turn's hook. The player is covered by
// tests/app-status-placeholder.test.js (the switch) and the pure helpers
// below.
//
// Run with: node --test tests/first-version-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const live = require('../src/services/first-version-live');
const watch = require('../worker/usernode-live-watch');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── The sanitiser ────────────────────────────────────────────────────────

test('CSS: every URL but data: is blanked, @import is removed, escapes cannot hide one', () => {
  assert.equal(live.sanitizeCss('a{background:url(http://x/y.png)}'), 'a{background:url()}');
  assert.equal(live.sanitizeCss("a{b:url( '//evil' )}"), 'a{b:url()}');
  assert.equal(live.sanitizeCss('a{b:url("/api/me")}'), 'a{b:url()}');
  assert.equal(live.sanitizeCss('a{b:url("data:image/png;base64,AA")}'), 'a{b:url("data:image/png;base64,AA")}');
  assert.equal(live.sanitizeCss('a{b:url(data:text/html,<p>)}'), 'a{b:url()}');
  assert.equal(live.sanitizeCss('@import url(x.css); b{c:d}'), ' b{c:d}');
  assert.equal(live.sanitizeCss('a{b:image-set("x.png" 1x)}'), 'a{b:none}');
  assert.equal(live.sanitizeCss('a{b:src("//e")}'), 'a{b:url()}');
  assert.equal(live.sanitizeCss('a{background:url(#x)}'), 'a{background:url()}', 'it could resolve against the viewer\'s page');
  // \75 is "u": the browser reads url(…); the escape is dropped, so it reads nothing.
  assert.doesNotMatch(live.sanitizeCss('a{b:\\75 rl(http://e/f)}'), /\burl\(http/);
  assert.doesNotMatch(live.sanitizeCss('@\\69mport "x";'), /@import/);
  // An ordinary escape (a curly quote) is left alone.
  assert.equal(live.sanitizeCss('a{content:"\\201C"}'), 'a{content:"\\201C"}');
});

const doc = (body) => ({
  type: 0, id: 1, childNodes: [
    { type: 1, id: 2, name: 'html', publicId: '-//x', systemId: 'http://x/dtd' },
    { type: 2, id: 3, tagName: 'html', attributes: {}, childNodes: [
      { type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: [
        { type: 2, id: 5, tagName: 'link', attributes: { rel: 'stylesheet', href: 'http://x/a.css', _cssText: 'h1{background:url(http://x/b.png)}' }, childNodes: [] },
        { type: 2, id: 6, tagName: 'link', attributes: { rel: 'icon', href: 'http://x/i.png' }, childNodes: [] },
        { type: 2, id: 7, tagName: 'script', attributes: { src: 'http://x/t.js' }, childNodes: [{ type: 3, id: 8, textContent: 'alert(1)' }] },
        { type: 2, id: 9, tagName: 'style', attributes: {}, childNodes: [{ type: 3, id: 10, textContent: 'p{cursor:url(/c.cur)}', isStyle: true }] },
        { type: 2, id: 11, tagName: 'meta', attributes: { 'http-equiv': 'refresh', content: '0;url=http://x' }, childNodes: [] },
        { type: 2, id: 12, tagName: 'base', attributes: { href: 'http://x/' }, childNodes: [] },
      ] },
      { type: 2, id: 13, tagName: 'body', attributes: {}, childNodes: body },
    ] },
  ],
});

test('a full snapshot: links inlined or gone, scripts and frames emptied, URLs kept only as data:', () => {
  const out = live.sanitizeEvents([
    { type: 4, timestamp: 1, data: { href: 'http://localhost:3300/?token=secret&demo=1', width: 390, height: 760 } },
    { type: 2, timestamp: 2, data: { initialOffset: { top: 0, left: 0 }, node: doc([
      { type: 2, id: 20, tagName: 'img', attributes: { src: 'http://x/p.gif', srcset: 'http://x/a.png 1x', rr_dataURL: 'data:image/png;base64,AAAA', alt: 'a' }, childNodes: [] },
      { type: 2, id: 21, tagName: 'img', attributes: { src: 'data:image/png;base64,BB', rr_dataURL: 'http://x/q' }, childNodes: [] },
      { type: 2, id: 22, tagName: 'a', attributes: { href: 'http://x/', onclick: 'steal()', style: 'background:url(//x/z)' }, childNodes: [{ type: 3, id: 23, textContent: 'go' }] },
      { type: 2, id: 24, tagName: 'iframe', attributes: { src: 'http://x/', srcdoc: '<p>' }, childNodes: [] },
      { type: 2, id: 25, tagName: 'svg', attributes: {}, isSVG: true, childNodes: [
        { type: 2, id: 26, tagName: 'use', attributes: { href: '#icon', 'xlink:href': 'http://x/s.svg#i' }, isSVG: true, childNodes: [] },
        { type: 2, id: 31, tagName: 'image', attributes: { href: '#top' }, isSVG: true, childNodes: [] },
        { type: 2, id: 27, tagName: 'rect', attributes: { fill: 'url(#grad)', stroke: 'url(http://x/s.svg#a)', 'clip-path': 'url(#c)' }, isSVG: true, childNodes: [] },
      ] },
      { type: 2, id: 30, tagName: 'img', attributes: { src: '#top' }, childNodes: [] },
      { type: 2, id: 28, tagName: 'form', attributes: { action: '/api/delete' }, childNodes: [] },
      { type: 2, id: 29, tagName: 'object', attributes: { data: 'http://x/o' }, childNodes: [] },
    ]) } },
    { type: 5, timestamp: 3, data: { tag: 'x', payload: {} } },
    { type: 6, timestamp: 4, data: { plugin: 'console', payload: {} } },
  ]);
  assert.equal(out.length, 2, 'custom and plugin events are dropped');
  assert.deepEqual(out[0].data, { href: '', width: 390, height: 760 }, 'the page address (and its sign-in) is not kept');
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /http:\/\/x|\/\/x\/|\/api\/delete|\/c\.cur|alert\(1\)|steal|secret|<p>/);
  const flat = [];
  const walk = (n) => { flat.push(n); (n.childNodes || []).forEach(walk); };
  walk(out[1].data.node);
  const byId = new Map(flat.map((n) => [n.id, n]));
  assert.deepEqual(byId.get(5), { type: 2, id: 5, tagName: 'style', attributes: { _cssText: 'h1{background:url()}' }, childNodes: [] }, 'a stylesheet stays, inlined');
  assert.equal(byId.get(6).tagName, 'meta', 'an icon link goes');
  assert.equal(byId.get(7).tagName, 'div', 'a script is an empty placeholder');
  assert.equal(byId.has(8), false, 'with no text');
  assert.equal(byId.get(10).textContent, 'p{cursor:url()}');
  assert.deepEqual(byId.get(11).attributes, {}, 'no refresh');
  assert.equal(byId.get(12).tagName, 'div', 'no base');
  assert.deepEqual(byId.get(20).attributes, { rr_dataURL: 'data:image/png;base64,AAAA', alt: 'a' }, 'an image keeps its inlined picture');
  assert.deepEqual(byId.get(21).attributes, { src: 'data:image/png;base64,BB' });
  assert.deepEqual(byId.get(22).attributes, { style: 'background:url()' });
  assert.equal(byId.get(24).tagName, 'div');
  assert.deepEqual(byId.get(26).attributes, { href: '#icon' }, 'a local SVG reference stays');
  assert.deepEqual(byId.get(27).attributes, { fill: 'url(#grad)', stroke: 'none', 'clip-path': 'url(#c)' }, 'SVG\'s own references stay');
  assert.deepEqual(byId.get(28).attributes, {});
  assert.deepEqual(byId.get(31).attributes, {}, 'an SVG image would load it');
  assert.deepEqual(byId.get(30).attributes, {}, 'a fragment in src= would fetch the viewer\'s own page');
  assert.equal(byId.get(29).tagName, 'div');
  assert.deepEqual(byId.get(2), { type: 1, id: 2, name: 'html', publicId: '', systemId: '' });
});

test('incremental events: mutations cleaned, canvas, fonts, media and logs dropped', () => {
  const out = live.sanitizeEvents([
    { type: 3, timestamp: 5, data: {
      source: 0,
      texts: [{ id: 9, value: 'p{background:url(http://x)}' }, { id: 10, value: 'plain' }],
      attributes: [{ id: 3, attributes: { src: 'http://x/a.png', class: 'row', style: { background: 'url(http://x)', color: ['red', 'important'], margin: false } } }],
      removes: [{ parentId: 1, id: 4 }],
      adds: [{ parentId: 1, nextId: null, node: { type: 2, id: 30, tagName: 'img', attributes: { src: '//x/b.png' }, childNodes: [] } },
        { parentId: 1, nextId: null, node: { type: 2, id: 31, tagName: 'script', attributes: {}, childNodes: [] } }],
    } },
    { type: 3, timestamp: 6, data: { source: 8, id: 2, adds: [{ rule: 'a{b:url(//x)}', index: 0 }] } },
    { type: 3, timestamp: 7, data: { source: 13, id: 2, index: [0], set: { property: 'background', value: 'url(//x)' } } },
    { type: 3, timestamp: 8, data: { source: 15, id: 2, styleIds: [1], styles: [{ styleId: 1, rules: [{ rule: '@import "x.css";' }] }] } },
    { type: 3, timestamp: 9, data: { source: 9, id: 5, type: 0, commands: [] } },
    { type: 3, timestamp: 10, data: { source: 10, family: 'f', fontSource: 'http://x/f.woff' } },
    { type: 3, timestamp: 11, data: { source: 7, id: 5, type: 0 } },
    { type: 3, timestamp: 12, data: { source: 11, level: 'log', payload: [] } },
    { type: 3, timestamp: 13, data: { source: 3, id: 1, x: 0, y: 40 } },
    { type: 3, data: { source: 3, id: 1, x: 0, y: 40 } },
    null,
  ]);
  assert.deepEqual(out.map((e) => e.data.source), [0, 8, 13, 15, 3]);
  const m = out[0].data;
  assert.deepEqual(m.texts, [{ id: 9, value: 'p{background:url()}' }, { id: 10, value: 'plain' }]);
  assert.deepEqual(m.attributes, [{ id: 3, attributes: { src: null, class: 'row', style: { background: 'url()', color: ['red', 'important'], margin: false } } }]);
  assert.deepEqual(m.adds[0].node.attributes, {});
  assert.equal(m.adds[1].node.tagName, 'div');
  assert.equal(out[1].data.adds[0].rule, 'a{b:url()}');
  assert.equal(out[2].data.set.value, 'url()');
  assert.equal(out[3].data.styles[0].rules[0].rule, '');
});

// ── The stream ───────────────────────────────────────────────────────────

test('the stream is read in whole lines, counted in bytes', () => {
  const a = `${JSON.stringify({ t: 'fail', why: 'é' })}\n`;
  const { lines, bytes } = live.splitLines(`${a}not json\n{"t":"inc","eve`);
  assert.deepEqual(lines, [{ t: 'fail', why: 'é' }]);
  assert.equal(bytes, Buffer.byteLength(`${a}not json\n`), 'a partial line waits; é is two bytes');
  assert.deepEqual(live.splitLines('{"t":"x"'), { lines: [], bytes: 0 });
});

function fakePool() {
  const calls = [];
  let seq = 1;
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/RETURNING next_seq - 1 AS seq/.test(sql)) return { rows: [{ seq: seq++ }] };
      if (/FROM platform_settings/.test(sql)) return { rows: this.setting ? [{ value: this.setting }] : [] };
      return { rows: [] };
    },
  };
}

const stats = () => ({ bytes: 0, base: null, kept: 0, failed: 0, goodFrame: false, memoryStop: false, stoppedWhy: null, dropped: 0, minHeadroomMb: null });
const meta = { type: 4, timestamp: 1, data: { href: 'http://x', width: 390, height: 760 } };
const full = { type: 2, timestamp: 2, data: { node: doc([]), initialOffset: { top: 0, left: 0 } } };

test('ingest: a good restart replaces the run\'s recording; what follows is added to it', async () => {
  const pool = fakePool();
  const s = stats();
  await live.ingest(pool, 7, { t: 'inc', events: [meta] }, s);
  assert.equal(pool.calls.length, 0, 'nothing is kept before a good restart');
  await live.ingest(pool, 7, { t: 'full', events: [meta, full] }, s);
  assert.equal(s.base, 1);
  assert.equal(s.kept, 1);
  assert.equal(s.goodFrame, true);
  const insert = pool.calls.find((c) => /INSERT INTO first_version_live_chunks/.test(c.sql));
  assert.equal(insert.params[2], 'full');
  assert.doesNotMatch(insert.params[3], /http:\/\/x/, 'kept sanitised');
  assert.ok(pool.calls.some((c) => /DELETE FROM first_version_live_chunks WHERE bot_run_id = \$1 AND seq < \$2/.test(c.sql) && c.params[1] === 1));
  await live.ingest(pool, 7, { t: 'inc', events: [{ type: 3, timestamp: 3, data: { source: 3, id: 1, x: 0, y: 1 } }] }, s);
  assert.ok(s.bytes > insert.params[4]);
  await live.ingest(pool, 7, { t: 'fail', why: 'the page threw an error' }, s);
  await live.ingest(pool, 7, { t: 'mem', headroomMb: 900 }, s);
  await live.ingest(pool, 7, { t: 'mem', headroomMb: 700 }, s);
  await live.ingest(pool, 7, { t: 'stop', why: 'memory' }, s);
  assert.equal(s.failed, 1);
  assert.equal(s.minHeadroomMb, 700);
  assert.equal(s.memoryStop, true);
  assert.equal(s.stoppedWhy, 'memory');
});

test('ingest: at about 2 MB a run takes nothing more until its next good restart', async () => {
  const pool = fakePool();
  const s = { ...stats(), base: 1, bytes: live.MAX_STORED_BYTES - 10 };
  await live.ingest(pool, 7, { t: 'inc', events: [{ type: 3, timestamp: 3, data: { source: 3, id: 1, x: 0, y: 1 } }] }, s);
  assert.equal(s.dropped, 1);
  assert.equal(pool.calls.length, 0);
  const huge = { type: 3, timestamp: 4, data: { source: 0, texts: [{ id: 1, value: 'x'.repeat(live.MAX_STORED_BYTES) }], attributes: [], removes: [], adds: [] } };
  await live.ingest(pool, 7, { t: 'full', events: [meta, huge] }, s);
  assert.equal(s.failed, 1, 'a recording too large to keep counts as a failed restart');
});

test('the pill\'s state: starting, live, a failed restart, or stopped before any frame', () => {
  assert.equal(live.liveState(null), 'starting');
  assert.equal(live.liveState({ base_seq: null, stopped_why: null }), 'starting');
  assert.equal(live.liveState({ base_seq: null, stopped_why: 'memory' }), 'stopped');
  assert.equal(live.liveState({ base_seq: 3, good_at: '2026-10-08T10:00:00Z', failed_at: null }), 'live');
  assert.equal(live.liveState({ base_seq: 3, good_at: '2026-10-08T10:00:00Z', failed_at: '2026-10-08T10:01:00Z' }), 'failed');
  assert.equal(live.liveState({ base_seq: 3, good_at: '2026-10-08T10:02:00Z', failed_at: '2026-10-08T10:01:00Z' }), 'live');
});

test('liveOf: a viewer behind the latest good restart starts over from it', async () => {
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/homeroom_bot_first_versions/.test(sql)) return { rows: [{ id: 7 }] };
      if (/FROM first_version_live WHERE/.test(sql)) return { rows: [{ base_seq: 4, good_at: '2026-10-08T10:00:00Z', failed_at: null, age: 3.4 }] };
      if (/FROM first_version_live_chunks/.test(sql)) {
        return { rows: params[1] === 4 ? [{ seq: 4, events: [meta] }, { seq: 5, events: [full] }] : [{ seq: 6, events: [meta] }] };
      }
      return { rows: [] };
    },
  };
  const fresh = await live.liveOf(pool, 1, 2);
  assert.equal(fresh.reset, true);
  assert.equal(fresh.seq, 5);
  assert.equal(fresh.events.length, 2);
  assert.equal(fresh.age, 3);
  const next = await live.liveOf(pool, 1, 5);
  assert.equal(next.reset, false);
  assert.equal(next.seq, 6);
  assert.deepEqual(queries.at(-1).params, [7, 6], 'only what comes after the viewer\'s');
});

// ── The watcher and its controller ───────────────────────────────────────

test('the watcher runs at the lowest priority, in a group of its own, and stops when nobody reads it', () => {
  assert.match(live.START_SCRIPT, /nice -n 19/);
  assert.match(live.START_SCRIPT, /command -v ionice >\/dev\/null 2>&1 && N="\$N ionice -c 3"/);
  assert.match(live.START_SCRIPT, /command -v setsid/);
  assert.match(live.START_SCRIPT, /nohup \$S \$N node "\$D\/watch\.js" >"\$D\/watch\.log" 2>&1 &/);
  assert.match(live.READ_SCRIPT, /: > "\$D\/heartbeat"/);
  assert.match(live.READ_SCRIPT, /\[ "\$1" = 1 \] && : > "\$D\/progress"/);
  assert.match(live.STOP_SCRIPT, /kill -KILL -- "-\$p"/);
  assert.match(live.STOP_SCRIPT, /kill -KILL -- "-\$a"/);
  const src = read('worker/usernode-live-watch.js');
  assert.match(src, /now - mtimeOf\(path\.join\(DIR, 'heartbeat'\)\) > HEARTBEAT_MS\) return stop\('orphaned'\)/);
  assert.match(src, /MIN_RESTART_MS = Number\(CONFIG\.minRestartMs\) \|\| 30000/);
  // Its own port and database: never the agent's in-loop 3100 or `inloop`.
  assert.notEqual(live.PORT, require('../src/services/in-loop-browser').INLOOP_PORT);
  assert.doesNotMatch(live.DATABASE_URL, /\/inloop$/);
  assert.match(src, /name === 'inloop'\) return false/);
});

test('the watcher\'s files: its config, the capture step\'s boot helpers, and rrweb\'s UMD build', () => {
  const files = live.watcherFiles({ appId: 12 });
  assert.deepEqual(files.map((f) => f.path), ['/tmp/usernode-live/capture-lib.js', '/tmp/usernode-live/rrweb.cjs', '/tmp/usernode-live/watch.js']);
  assert.match(files[1].content, /g\["rrweb"\] = f\(\)/);
  const config = JSON.parse(/^const LIVE = (.*);$/m.exec(files[2].content)[1]);
  assert.equal(config.appId, 12);
  assert.equal(config.port, 3300);
  assert.equal(config.startHeadroomMb, 768);
  assert.equal(config.runHeadroomMb, 384);
  for (const f of files) assert.match(f.path, /^\/tmp\/usernode-live\/[a-z0-9-]{1,40}\.(js|cjs)$/, 'the paths worker.runLiveScript accepts');
});

test('rrweb records only in the top frame (its own helper iframes recursed otherwise)', () => {
  const s = watch.initScript('/* rrweb */');
  assert.ok(s.startsWith("if (window === window.top && location.protocol === 'http:') {"));
  assert.match(s, /document\.addEventListener\('DOMContentLoaded'/);
  assert.match(s, /inlineStylesheet: true, inlineImages: true/);
});

test('memory: the cgroup\'s limit less its working set, else /proc/meminfo', () => {
  const files = (map) => (f) => { if (!(f in map)) throw new Error('ENOENT'); return map[f]; };
  const v2 = watch.memoryHeadroom(files({
    '/sys/fs/cgroup/memory.max': '2147483648\n',
    '/sys/fs/cgroup/memory.current': '1610612736\n',
    '/sys/fs/cgroup/memory.stat': 'anon 1\ninactive_file 268435456\n',
  }));
  assert.equal(v2.source, 'cgroup2');
  assert.equal(v2.headroom, 2147483648 - (1610612736 - 268435456));
  const unlimited = watch.memoryHeadroom(files({
    '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory.current': '1',
    '/proc/meminfo': 'MemTotal:       4000000 kB\nMemAvailable:   1000000 kB\n',
  }));
  assert.deepEqual(unlimited, { headroom: 1024000000, used: 3072000000, limit: 4096000000, source: 'meminfo' });
  assert.equal(watch.memoryHeadroom(files({})), null);
  assert.equal(watch.roomFor(768 * 1048576, files({})).ok, true, 'unknown is room');
  const low = files({ '/sys/fs/cgroup/memory.max': String(2 * 1024 ** 3), '/sys/fs/cgroup/memory.current': String(1.5 * 1024 ** 3) });
  assert.equal(watch.roomFor(768 * 1048576, low).ok, false, '512 MB left is too little to start');
});

function fakeWorker() {
  const scripts = [];
  return {
    scripts,
    async runLiveScript(name, script, opts = {}) {
      scripts.push({ name, script, opts });
      return '';
    },
  };
}

test('with the setting off no watcher starts, and the build turn is still measured', async () => {
  const pool = fakePool();
  pool.setting = 'off';
  live.forgetSetting(pool);
  const worker = fakeWorker();
  const c = live.liveController({ pool, runId: 9, appId: 3, worker });
  const turn = c.onBuildTurn({ containerName: 'w1' });
  await turn.end({ buildTurnMs: 1234, turnsMs: 1300, nudged: false });
  assert.equal(worker.scripts.length, 0);
  const recorded = pool.calls.filter((q) => /INSERT INTO events/.test(q.sql)).map((q) => [q.params[3], JSON.parse(q.params[4])]);
  assert.deepEqual(recorded, [['first_version_build_turn', { runId: 9, buildTurnMs: 1234, turnsMs: 1300, nudged: false, watcher: false, setting: false }]]);
});

test('with it on the watcher starts beside the turn, and its numbers are kept when it ends', async () => {
  const pool = fakePool();
  live.forgetSetting(pool);
  const worker = fakeWorker();
  const c = live.liveController({ pool, runId: 9, appId: 3, worker });
  const turn = c.onBuildTurn({ containerName: 'w1' });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  c.onProgress('$ usernode-progress "Adding the tier rows"');
  await turn.end({ buildTurnMs: 1000, turnsMs: 1000 });
  assert.equal(worker.scripts[0].script, live.START_SCRIPT);
  assert.equal(worker.scripts[0].opts.files.length, 3);
  assert.equal(worker.scripts.at(-1).script, live.STOP_SCRIPT, 'stopped when the turn ends');
  assert.equal(worker.scripts[1].script, live.READ_SCRIPT, 'what it wrote last is read first');
  assert.deepEqual(worker.scripts[1].opts.args, ['1', '0'], 'with the progress marker it was told of');
  const types = pool.calls.filter((q) => /INSERT INTO events/.test(q.sql)).map((q) => q.params[3]);
  assert.deepEqual(types, ['live_build_stream', 'first_version_build_turn']);
  const turnEvent = pool.calls.filter((q) => /INSERT INTO events/.test(q.sql)).map((q) => JSON.parse(q.params[4]))[1];
  assert.equal(turnEvent.watcher, true);
  // Ending twice changes nothing.
  await turn.end({});
  assert.equal(pool.calls.filter((q) => /INSERT INTO events/.test(q.sql)).length, 2);
});

test('a watcher that cannot start never fails the turn', async () => {
  const pool = fakePool();
  live.forgetSetting(pool);
  const worker = { async runLiveScript() { throw new Error('exec failed'); } };
  const turn = live.liveController({ pool, runId: 9, appId: 3, worker }).onBuildTurn({ containerName: 'w1' });
  await turn.end({ buildTurnMs: 5 });
  const recorded = pool.calls.filter((q) => /INSERT INTO events/.test(q.sql)).map((q) => JSON.parse(q.params[4]));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].watcher, false);
  assert.equal(recorded[0].setting, true);
});

// ── The setting, the routes and the build turn ───────────────────────────

test('the Admin setting: on unless switched off, and a write clears the cache', () => {
  const bot = require('../src/services/homeroom-bot');
  assert.equal(bot.KEY_LIVE_BUILD_STREAM, live.KEY);
  assert.deepEqual(bot.validateSettingsPatch({ liveBuildStream: false }).updates, [[live.KEY, 'off']]);
  assert.equal(bot.validateSettingsPatch({ liveBuildStream: 'no' }).ok, false);
  assert.equal(bot.parseSettings([]).liveBuildStream, true);
  assert.equal(bot.parseSettings([{ key: live.KEY, value: 'off' }]).liveBuildStream, false);
  assert.match(read('src/services/homeroom-bot.js'), /key === KEY_LIVE_BUILD_STREAM\)\) firstVersionLive\(\)\.forgetSetting\(pool\)/);
  const admin = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(admin, /id="admin-homeroom-bot-live-build-stream"/);
  assert.match(admin, /key === 'liveBuildStream'/);
});

test('the routes answer the project\'s members only, as its screens do', () => {
  const src = read('src/routes/apps.js');
  const gate = src.slice(src.indexOf('const liveMember = async (req) => {'), src.indexOf("router.get('/api/apps/:slug/first-version/live'"));
  assert.match(gate, /if \(!req\.user\?\.id\) return null;/);
  assert.match(gate, /if \(!\(await fvLive\.liveEnabled\(pool\)\)\) return null;/);
  assert.match(gate, /appAccess\.getAppForUser\(pool, req\.params\.slug, req\.user, 'view'/);
  assert.match(gate, /!\(await communities\.isMember\(pool, app\.id, req\.user\.id\)\)\) return null;/);
  assert.match(src, /router\.get\('\/api\/apps\/:slug\/first-version\/live', async \(req, res\) => \{\s+try \{\s+const app = await liveMember\(req\);\s+if \(!app\) return res\.status\(404\)/);
  assert.match(src, /router\.post\('\/api\/apps\/:slug\/first-version\/live\/seen', sameOriginBrowserOnly, async \(req, res\) => \{\s+try \{\s+const app = await liveMember\(req\);\s+if \(!app\) return res\.status\(404\)/);
  assert.match(src, /'Cache-Control': 'no-store'/);
});

test('firstVersionLiveFields: offered at Building it, to the maker and members, while it is on', async () => {
  const { firstVersionLiveFields } = require('../src/routes/apps');
  const pool = (member, setting = null) => ({
    async query(sql) {
      if (/FROM platform_settings/.test(sql)) return { rows: setting ? [{ value: setting }] : [] };
      return { rows: member ? [{ ok: 1, exists: true, is_member: true }] : [] };
    },
  });
  const on = pool(false);
  assert.deepEqual(await firstVersionLiveFields(on, 1, 5, { mine: true, line: 'building' }), { live: true });
  assert.deepEqual(await firstVersionLiveFields(on, 1, 5, { mine: true, line: 'testing' }), {});
  assert.deepEqual(await firstVersionLiveFields(on, 1, null, { mine: true, line: 'building' }), {});
  const off = pool(true, 'off');
  assert.deepEqual(await firstVersionLiveFields(off, 1, 5, { mine: true, line: 'building' }), {});
});

test('the build turn: Live starts with it and ends with it (and its nudge), never waited on', () => {
  const src = read('src/services/homeroom-bot-live.js');
  const turn = src.slice(src.indexOf('// #4449: Live watches the build turn'), src.indexOf('const result = (routed && routed.result) || {};'));
  assert.match(turn, /try \{ liveTurn = onBuildTurn\(\{ containerName \}\) \|\| null; \} catch \{ liveTurn = null; \}/);
  assert.match(turn, /void Promise\.resolve\(\)\s+\.then\(\(\) => turn\.end\(/);
  assert.ok(turn.indexOf('let { routed, stopped } = await runBuildTurn(') > turn.indexOf('onBuildTurn({ containerName })'));
  assert.match(turn, /if \(skipped\) \{\s+endLive\(\);/);
  assert.match(turn, /if \(skippedAfterNudge\) endLive\(\);/);
  assert.match(turn, /\/\/ The build turn, and its nudge, are over: so is Live\.\s+endLive\(\);\s*$/);
  const bot = read('src/services/homeroom-bot.js');
  assert.match(bot, /onBuildTurn: \(turn\) => liveWatch\.onBuildTurn\(turn\)/);
  assert.match(bot, /onProgress: \(line\) => \{ caption\(line\); liveWatch\.onProgress\(line\); \}/);
});

test('measured with the platform\'s events', () => {
  const { EVENT_TYPES } = require('../src/services/events');
  assert.equal(EVENT_TYPES.FIRST_VERSION_BUILD_TURN, 'first_version_build_turn');
  assert.equal(EVENT_TYPES.LIVE_BUILD_STREAM, 'live_build_stream');
  assert.equal(EVENT_TYPES.LIVE_BUILD_OPENED, 'live_build_opened');
  assert.equal(EVENT_TYPES.LIVE_BUILD_WATCHED, 'live_build_watched');
});

test('the schema keeps a run\'s recording private, and goes with its run', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS first_version_live \(\s+bot_run_id\s+INTEGER PRIMARY KEY REFERENCES homeroom_bot_runs\(id\) ON DELETE CASCADE/);
  assert.match(schema, /COMMENT ON TABLE first_version_live IS 'staging:private';/);
  assert.match(schema, /COMMENT ON TABLE first_version_live_chunks IS 'staging:private';/);
});

test('rrweb is pinned at 2.1.3 in both lockfiles, and the player is loaded only when Live opens', () => {
  assert.equal(JSON.parse(read('package.json')).dependencies.rrweb, '2.1.3');
  assert.equal(JSON.parse(read('frontend/package.json')).dependencies.rrweb, '2.1.3');
  assert.equal(JSON.parse(read('package-lock.json')).packages['node_modules/rrweb'].version, '2.1.3');
  assert.equal(JSON.parse(read('frontend/package-lock.json')).packages['node_modules/rrweb'].version, '2.1.3');
  const status = read('frontend/src/features/app-frame/app-status.tsx');
  assert.match(status, /const LiveBand = lazy\(\(\) => import\('\.\/live-band'\)\);/);
  assert.doesNotMatch(status, /from 'rrweb'/);
  const band = read('frontend/src/features/app-frame/live-band.tsx');
  assert.match(band, /liveMode: true,/);
  assert.match(band, /useVirtualDom: false,/);
  assert.match(band, /UNSAFE_replayCanvas: false,/);
  assert.match(band, /pointer-events-none/);
});

test('the pill and the remembered choice', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const m = loadTsx('frontend/src/features/app-frame/live-switch.tsx');
  assert.equal(m.livePill('starting', null), 'Starting the app…');
  assert.equal(m.livePill('live', 2), 'Live · just updated');
  assert.equal(m.livePill('live', 12.7), 'Live · updated 12 s ago');
  assert.equal(m.livePill('live', 130), 'Live · updated 2 min ago');
  assert.equal(m.livePill('failed', 3), 'A restart failed · showing the last good screen');
  assert.equal(m.choiceKey('7'), 'usernode.firstVersionLive.v1.7');
  assert.equal(m.readChoice('7'), 'preview', 'no storage: Preview');
  const store = new Map();
  global.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  try {
    m.writeChoice('7', 'live');
    assert.equal(m.readChoice('7'), 'live');
    assert.equal(m.readChoice('8'), 'preview', 'per person');
  } finally {
    delete global.localStorage;
  }
});

// ── What glows ───────────────────────────────────────────────────────────

// Just enough of an element for the signatures: a tag, a parent, text.
function fakeEl(tagName, parent = null, text = '') {
  const el = { tagName: tagName.toUpperCase(), parentElement: parent, childNodes: text ? [{ nodeType: 3, nodeValue: text }] : [] };
  return el;
}

test('glow: only what is genuinely new lights up, and only its top-most element', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const g = loadTsx('frontend/src/features/app-frame/live-glow.ts');
  const body = fakeEl('body');
  const ul = fakeEl('ul', body);
  const a = fakeEl('li', ul, '  Milk  ');
  const b = fakeEl('li', ul, 'Eggs');
  assert.equal(g.signature(a), 'ul>li|Milk');
  assert.equal(g.directText(fakeEl('p', body, 'x'.repeat(80))).length, 60);
  // A rebuilt page (a restart): the same rows match, one more glows; a
  // new row's own children do not glow on their own.
  const before = new Map([['ul', 1], ['ul>li|Milk', 1], ['ul>li|Eggs', 1]]);
  const c = fakeEl('li', ul, 'Bread');
  const cSpan = fakeEl('span', c, 'new');
  const ul2 = fakeEl('ul', body);
  const tops = g.newTops([ul, a, b, c, cSpan], new Map([...before, ['ul|', 1]]));
  assert.deepEqual(tops, [c]);
  // A whole new list: only the list glows.
  assert.deepEqual(g.newTops([ul2, fakeEl('li', ul2, 'Tea')], new Map()), [ul2]);
  // A change: a row added beside three like it glows (the three are still
  // there); the same list drawn again matches itself.
  const row = (t) => fakeEl('div', body, t);
  const before2 = new Map([['div|', 3]]);
  const added = [row('')];
  assert.deepEqual(g.newTops(added, g.changeBudget(before2, new Map([['div|', 4]]), added)), added);
  const redrawn = [row(''), row(''), row('')];
  assert.deepEqual(g.newTops(redrawn, g.changeBudget(before2, new Map([['div|', 3]]), redrawn)), []);
  // The glow: a fade-in and a fading 4px ring, or a static outline.
  assert.equal(g.GLOW_MS, 1600);
  assert.match(g.GLOW_RULES.join('\n'), /box-shadow: 0 0 0 4px/);
  assert.match(g.GLOW_RULES.join('\n'), /@media \(prefers-reduced-motion: reduce\) \{ \[data-usernode-new\] \{ animation: none; outline: 4px solid/);
});
