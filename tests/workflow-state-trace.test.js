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
module.exports = { sleep, schedule, fireAndForget, shell, web, listen };
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
export function decide(): number { return legacy('services/effects').shell(); }
export function pure(): number { return legacy('services/helper').helped(); }
`,
  'src/workflow/demo/services.ts': `
import { legacy } from '../legacy.ts';
export function demoServices() {
  return {
    'demo.write': { async run() { await legacy('services/writer').write(null); } },
    'demo.remember': { async run() { legacy('services/store').remember('a', 1); legacy('services/lifecycle').run(1); } },
  };
}
export function demoNotifiers() {
  return { kick: () => legacy('services/effects').schedule() };
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
});

test('roles: the decider, each handler, each notifier, and the owned columns', async () => {
  const { m, root } = await fixture();
  const trace = m.traceMachines(root);
  const entries = [...m.ratchetEntries(trace, new Set(), root).get('demo').keys()];
  const has = (e) => assert.ok(entries.includes(e), `${e}\nin:\n${entries.join('\n')}`);
  has('decider | io src/services/effects.js#shell child_process');
  has('decider | calls src/services/effects.js#shell');
  has('decider | calls src/services/helper.js#helped');
  has('decider | state src/services/helper.js#seen');
  has('services | state src/services/store.js#cache');
  has('services | state src/services/lifecycle.js#createThing().active');
  has('services | writes things');
  has('services | writes logs');
  has('notifiers | notifier kick');
  has('notifiers | timer src/services/effects.js#schedule setTimeout');
  has('ownership | things.status ← src/services/writer.js#write');
  has('ownership | things.status ← trigger things_fill');
  assert.ok(!entries.some((e) => e.startsWith('ownership | things.note')), 'only owned columns');
  const web = [...m.ratchetEntries(trace, new Set(), root).get('platform').keys()];
  assert.deepEqual(web, ['web | state src/workflow/platform.ts#runtime']);
});
