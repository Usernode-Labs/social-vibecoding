'use strict';

// scripts/workflow-state-trace.mjs against a small source tree written for
// it: each kind of entry it must find, each it must not, and each way it
// follows a call. The list of what the machines reach
// (tests/workflow-process-state.test.js) is only as complete as this.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILES = {
  'src/db/schema.sql': `
CREATE TABLE things (id SERIAL PRIMARY KEY, status TEXT, note TEXT);
CREATE TABLE logs (id SERIAL PRIMARY KEY);
CREATE TRIGGER things_wf_owned BEFORE UPDATE ON things FOR EACH ROW
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=demo/thing:', 'status');
CREATE OR REPLACE FUNCTION things_fill() RETURNS TRIGGER AS $$
BEGIN NEW.status := 'x'; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER things_fill BEFORE INSERT ON things FOR EACH ROW EXECUTE FUNCTION things_fill();
`,
  'src/services/store.js': `
const cache = new Map();                 // changed at run time: state
const TABLE = new Map();                 // filled at load: a table
for (const k of ['a', 'b']) TABLE.set(k, 1);
const KINDS = new Set(['x', 'y']);       // filled at creation: a table
const RE = /x/g;                         // a regex's lastIndex is not state
let seam = 0;                            // only a test seam writes it
let counter = 0;                         // reassigned: state
const exported = new Map();              // changed by another module: state
function remember(k, v) { cache.set(k, v); counter += 1; return TABLE.get(k) && KINDS.has(k) && RE.test(k); }
function _setSeamForTests(v) { seam = v; }
module.exports = { remember, exported, _setSeamForTests, seam: () => seam };
`,
  'src/services/other.js': `
const store = require('./store');
function poke() { store.exported.set('k', 1); }
module.exports = { poke };
`,
  'src/services/lifecycle.js': `
function createThing() {
  const active = new Map();
  function run(id) { active.set(id, true); }
  return { run };
}
module.exports = { ...createThing(), createThing };
`,
  'src/services/effects.js': `
const { spawn } = require('child_process');
const later = require('./later');
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function bg() { return 1; }
function schedule() { setTimeout(() => later.deep(), 10); }
function fireAndForget() { void bg(); bg().catch(() => {}); bg(); }
function shell() { return spawn('ls'); }
async function web() { return fetch('https://example.com'); }
function listen() { process.on('SIGTERM', () => {}); }
function inPlace() { (async () => { await later.deep(); })(); }
function each(xs) { xs.forEach(async () => { await later.deep(); }); }
function together() { Promise.all([bg(), bg()]); }
function globals() { globalThis.flag = 1; process.env.MODE = 'x'; }
const { setTimeout: delay } = require('timers/promises');
async function pace() { await delay(5); return AbortSignal.timeout(10); }
function viaGlobal() { return globalThis.fetch('https://example.com'); }
module.exports = { sleep, schedule, fireAndForget, shell, web, listen, inPlace, each, together, globals, pace, viaGlobal };
`,
  'src/services/client.js': `
const k8sClient = () => require('@kubernetes/client-node');
let api;
let kube;
async function init() { const mod = await import('@octokit/rest'); api = new mod.Octokit({}); }
function kubes() { const k8s = k8sClient(); const kc = new k8s.KubeConfig(); kube = { core: kc.makeApiClient(k8s.CoreV1Api) }; return kube; }
function viaApi() { return api.rest.issues.get({}); }
function viaKube() { return kube.core.readNamespace(); }
module.exports = { init, kubes, viaApi, viaKube };
`,
  'src/services/later.js': `
let deepState = 0;
function deep() { deepState += 1; }
module.exports = { deep };
`,
  'src/services/deps.js': `
const helper = require('./helper');
const lazy = () => require('./store');
function viaParam(d) { return d.helped(); }
function viaThunk() { return lazy().remember('a', 1); }
function viaFallback(deps = {}) { const h = deps.helper || require('./helper'); return h.helped(); }
const api = { first() { return this.second(); }, second() { return helper.helped(); } };
module.exports = { viaParam, viaThunk, viaFallback, api };
`,
  'src/services/reexport.js': `
const store = require('./store');
module.exports = { remember: store.remember };
`,
  'src/services/via-reexport.js': `
const re = require('./reexport');
function call() { return re.remember('a', 1); }
module.exports = { call };
`,
  'src/services/many.js': `
const a = require('./m1'); const b = require('./m2'); const c = require('./m3'); const d = require('./m4');
function anyOf(x) { return x.touch(); }
module.exports = { anyOf, a, b, c, d };
`,
  'src/services/m1.js': 'const s1 = new Set(); function touch() { s1.add(1); } module.exports = { touch };',
  'src/services/m2.js': 'const s2 = new Set(); function touch() { s2.add(1); } module.exports = { touch };',
  'src/services/m3.js': 'const s3 = new Set(); function touch() { s3.add(1); } module.exports = { touch };',
  'src/services/m4.js': 'const s4 = new Set(); function touch() { s4.add(1); } module.exports = { touch };',
  'src/services/helper.js': `
const seen = new Set();
function helped() { seen.add(1); }
module.exports = { helped };
`,
  'src/services/writer.js': `
async function write(pool) {
  await pool.query("UPDATE things SET status = 'done', note = $2 WHERE id = $1", [1, 'n']);
  await pool.query('INSERT INTO logs DEFAULT VALUES');
}
module.exports = { write };
`,
  'src/workflow/legacy.ts': `
import { createRequire } from 'node:module';
const load = createRequire(new URL('../', import.meta.url));
export function legacy(path: string): any { return load('./' + path); }
`,
  'src/workflow/demo/machine.ts': `
import { legacy } from '../legacy.ts';
const memo = new Map();
export function decide(): number { return legacy('services/effects').shell(); }
export function pure(): number { return legacy('services/helper').helped(); }
export function remembers(k: string): void { memo.set(k, 1); }
export async function fetched(): Promise<unknown> { return fetch('https://example.com'); }
`,
  'src/workflow/demo/services.ts': `
import { legacy } from '../legacy.ts';
export function demoServices() {
  return {
    'demo.write': { async run() { await legacy('services/writer').write(null); } },
    'demo.own': { async run(ctx: any) { await ctx.pool.query("UPDATE things SET note = 'x' WHERE id = 1"); } },
    'demo.computed': { async run(ctx: any) { return legacy('services/helper')[ctx.input.fn](); } },
    'demo.handed': { async run() { return use(legacy('services/store')); } },
    'demo.remember': { async run() { legacy('services/store').remember('a', 1); legacy('services/lifecycle').run(1); } },
  };
}
function use(m: any) { return m.remember('a', 1); }
export function demoNotifiers() {
  return {
    kick: () => legacy('services/effects').schedule(),
    async late() { const m = await import('../../services/helper.js'); return m.helped(); },
  };
}
`,
  'src/workflow/platform.ts': `
let runtime: unknown = null;
export function running(): boolean { return runtime !== null; }
export function startWorkflow(): void { runtime = {}; }
`,
};

let made = null;
function fixture() {
  if (made) return made;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-trace-'));
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  made = import('../scripts/workflow-state-trace.mjs').then((m) => {
    const program = new m.Program(root);
    const reach = (label) => {
      const u = program.findUnit(label);
      assert.ok(u, `no function ${label}`);
      return new Set(program.walk([u]).met.keys());
    };
    return { m, root, program, reach };
  });
  return made;
}

test.after(async () => { if (made) fs.rmSync((await made).root, { recursive: true, force: true }); });

test('state: what changes after load, wherever it is changed from', async () => {
  const { reach } = await fixture();
  const met = reach('src/services/store.js#remember');
  assert.ok(met.has('state src/services/store.js#cache'));
  assert.ok(met.has('state src/services/store.js#counter'));
  for (const table of ['TABLE', 'KINDS', 'RE', 'seam']) assert.ok(!met.has(`state src/services/store.js#${table}`), table);
  assert.ok(reach('src/services/other.js#poke').has('state src/services/store.js#exported'), 'changed by another module');
  assert.ok(reach('src/services/lifecycle.js#createThing/run').has('state src/services/lifecycle.js#createThing().active'),
    "a factory's instance made at load");
});

test('timers, waits, unawaited work, hooks and outside I/O', async () => {
  const { reach } = await fixture();
  assert.ok(reach('src/services/effects.js#sleep').has('wait src/services/effects.js#sleep setTimeout'));
  const scheduled = reach('src/services/effects.js#schedule');
  assert.ok(scheduled.has('timer src/services/effects.js#schedule setTimeout'));
  assert.ok(!scheduled.has('state src/services/later.js#deepState'), 'a timer callback is its own flow, not followed');
  const detached = reach('src/services/effects.js#fireAndForget');
  assert.ok(detached.has('detached src/services/effects.js#fireAndForget → src/services/effects.js#bg'));
  assert.ok(reach('src/services/effects.js#shell').has('io src/services/effects.js#shell child_process'));
  assert.ok(reach('src/services/effects.js#web').has('io src/services/effects.js#web fetch'));
  assert.ok(reach('src/services/effects.js#listen').has('hook src/services/effects.js#listen process.on(SIGTERM)'));
  const iife = reach('src/services/effects.js#inPlace');
  assert.ok(iife.has('detached src/services/effects.js#inPlace → src/services/effects.js#inPlace (async function nobody awaits)'));
  assert.ok(!iife.has('state src/services/later.js#deepState'), 'what it runs is its own flow');
  assert.ok(reach('src/services/effects.js#each').has('detached src/services/effects.js#each → src/services/effects.js#each (async function nobody awaits)'));
  assert.ok(reach('src/services/effects.js#together').has('detached src/services/effects.js#together → src/services/effects.js#bg'));
  const globals = reach('src/services/effects.js#globals');
  assert.ok(globals.has('state src/services/effects.js#globalThis.flag') && globals.has('state src/services/effects.js#process.env'));
  const paced = reach('src/services/effects.js#pace');
  assert.ok(paced.has('wait src/services/effects.js#pace delay') && paced.has('wait src/services/effects.js#pace AbortSignal.timeout'));
  assert.ok(reach('src/services/effects.js#viaGlobal').has('io src/services/effects.js#viaGlobal fetch'));
  // Through a client an outside service's library made, kept in a module binding.
  assert.ok(reach('src/services/client.js#viaApi').has('io src/services/client.js#viaApi @octokit/rest'));
  assert.ok(reach('src/services/client.js#viaKube').has('io src/services/client.js#viaKube @kubernetes/client-node'));
});

test('calls are followed through parameters, thunks, injected defaults and this', async () => {
  const { reach } = await fixture();
  const seen = 'state src/services/helper.js#seen';
  assert.ok(reach('src/services/deps.js#viaParam').has(seen), 'a method on a parameter, by name among the imports');
  assert.ok(reach('src/services/deps.js#viaThunk').has('state src/services/store.js#cache'), 'a thunk for a module');
  assert.ok(reach('src/services/deps.js#viaFallback').has(seen), 'an injected dependency or its default');
  assert.ok(reach('src/services/deps.js#api.first').has(seen), 'this.method');
  assert.ok(reach('src/services/via-reexport.js#call').has('state src/services/store.js#cache'), 're-exported as { x: mod.x }');
  // However many imported modules export the name: an import added elsewhere
  // must not make a dependency disappear from the list.
  const many = reach('src/services/many.js#anyOf');
  for (const n of [1, 2, 3, 4]) assert.ok(many.has(`state src/services/m${n}.js#s${n}`), `m${n}`);
});

test('the list is the boundary, as the workflow code writes it, and what transitions reach', async () => {
  const { m, root, program } = await fixture();
  const trace = m.traceMachines(root);
  const entries = [...m.ratchetEntries(trace, new Set(), root).get('demo').keys()];
  const has = (e) => assert.ok(entries.includes(e), `${e}\nin:\n${entries.join('\n')}`);
  // Each place the workflow code names code outside src/workflow/.
  has('decider | uses src/services/effects.js:shell');
  has('decider | uses src/services/helper.js:helped');
  has('services | uses src/services/writer.js:write');
  has('services | uses src/services/store.js:remember');
  has('services | uses src/services/lifecycle.js:run');
  has('services | uses src/services/helper.js[computed]');
  has('services | uses src/services/store.js (whole module)');
  has('notifiers | uses src/services/effects.js:schedule');
  has('notifiers | uses src/services/helper.js (whole module)');
  // What its own code does; for transitions, also behind their calls.
  has('decider | state src/workflow/demo/machine.ts#memo');
  has('decider | io src/workflow/demo/machine.ts#fetched fetch');
  has('decider | io src/services/effects.js#shell child_process');
  has('decider | state src/services/helper.js#seen');
  has('services | writes things');
  has('notifiers | notifier kick');
  has('ownership | things.status ← src/services/writer.js#write');
  has('ownership | things.status ← trigger things_fill');
  assert.ok(!entries.some((e) => e.startsWith('ownership | things.note')), 'only owned columns');
  // Behind a handler's or a notifier's call: the report's, not the list's.
  for (const behind of ['services | state src/services/store.js#cache', 'notifiers | timer src/services/effects.js#schedule setTimeout', 'services | writes logs']) {
    assert.ok(!entries.includes(behind), behind);
  }
  assert.ok(program.walk([program.findUnit('src/services/store.js#remember')]).met.has('state src/services/store.js#cache'));
  const web = [...m.ratchetEntries(trace, new Set(), root).get('platform').keys()];
  assert.deepEqual(web, ['web | state src/workflow/platform.ts#runtime']);
});
