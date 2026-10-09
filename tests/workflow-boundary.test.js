'use strict';

// tests/lib/workflow-boundary.js against a small source tree written for it:
// each way workflow code can name code outside src/workflow/, what its own
// code may not do, notifiers, handler writes, and other writers of owned
// columns. The list tests/workflow-process-state.test.js gates on is only as
// complete as this.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boundary } = require('./lib/workflow-boundary');

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
  'src/services/helper.js': 'module.exports = { helped() {}, other() {} };',
  'src/services/store.js': 'module.exports = { remember() {}, forget() {} };',
  'src/services/writer.js': `
async function write(pool) {
  await pool.query("UPDATE things SET status = 'done', note = $2 WHERE id = $1", [1, 'n']);
  await pool.query(\`UPDATE things SET \${'note = 1'} WHERE id = 1\`);
}
async function noteOnly(pool) { await pool.query("UPDATE things SET note = 'x'"); }
module.exports = { write, noteOnly };
`,
  'src/workflow/legacy.ts': `
import { createRequire } from 'node:module';
const load = createRequire(new URL('../', import.meta.url));
export function legacy(path: string): any { return load('./' + path); }
`,
  'src/workflow/shared.ts': `
import { legacy } from './legacy.ts';
export function closeWith(close: (m: any) => unknown) { const gh = legacy('services/helper'); return close(gh); }
`,
  'src/workflow/demo/machine.ts': `
import { legacy } from '../legacy.ts';
import { closeWith } from '../shared.ts';
const memo = new Map();
const TABLE = new Map([['a', 1]]);
let version = 0;
export function decide(): number { return legacy('services/helper').helped(); }
export function remembers(k: string): void { memo.set(k, 1); version += 1; void TABLE.get(k); }
export async function fetched(): Promise<unknown> { return fetch('https://example.com'); }
export function shared(): unknown { return closeWith((m) => m.other()); }
const credits = (x: unknown) => ({ votes: x });   // a property named like nothing outside
`,
  'src/workflow/demo/services.ts': `
import { legacy } from '../legacy.ts';
const store = () => legacy('services/store');
export function demoServices(pool: any) {
  return {
    'demo.write': { async run() { await legacy('services/writer').write(pool); } },
    'demo.own': { async run() { await pool.query("UPDATE things SET note = 'x' WHERE id = 1"); await pool.query('INSERT INTO logs DEFAULT VALUES'); } },
    'demo.computed': { async run(ctx: any) { return legacy('services/helper')[ctx.input.fn](); } },
    'demo.thunk': { async run() { return store().remember(); } },
    'demo.handed': { async run() { return use(store()); } },
    'demo.timer': { async run() { setTimeout(() => {}, 10); } },
  };
}
function use(m: any) { return m.forget(); }
export function demoNotifiers() {
  return {
    kick: () => legacy('services/helper').other(),
    async late() { const m = await import('../../services/store.js'); return m.remember(); },
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-boundary-'));
  for (const [file, text] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const list = boundary(root);
  made = { root, demo: [...list.get('demo').keys()], platform: [...list.get('platform').keys()] };
  return made;
}
test.after(() => { if (made) fs.rmSync(made.root, { recursive: true, force: true }); });

const has = (list, e) => assert.ok(list.includes(e), `${e}\nin:\n${list.join('\n')}`);

test('each place workflow code names code outside src/workflow/, as written', () => {
  const { demo } = fixture();
  has(demo, 'decider | uses src/services/helper.js:helped');
  has(demo, 'services | uses src/services/writer.js:write');
  has(demo, 'services | uses src/services/helper.js[computed]');
  has(demo, 'services | uses src/services/store.js:remember');            // through a thunk
  has(demo, 'services | uses src/services/store.js (whole module)');      // handed on whole
  has(demo, 'shared | uses src/services/helper.js (whole module)');       // a shared module hands it to a callback
  has(demo, 'notifiers | uses src/services/helper.js:other');
  has(demo, 'notifiers | uses src/services/store.js (whole module)');     // a dynamic import
  assert.ok(!demo.some((e) => /writer\.js:(noteOnly)/.test(e)), 'only what the workflow code names');
  assert.ok(!demo.some((e) => e.includes('votes')), 'a property name is not a use');
});

test('what the workflow code does itself, per part', () => {
  const { demo, platform } = fixture();
  has(demo, 'decider | state src/workflow/demo/machine.ts#memo');
  has(demo, 'decider | state src/workflow/demo/machine.ts#version');
  has(demo, 'decider | io src/workflow/demo/machine.ts#fetched fetch');
  has(demo, 'services | timer src/workflow/demo/services.ts#demoServices setTimeout');
  assert.ok(!demo.some((e) => e.endsWith('#TABLE')), 'a table filled at load is not state');
  has(demo, 'services | writes things');
  has(demo, 'services | writes logs');
  assert.deepEqual(platform, ['web | state src/workflow/platform.ts#runtime']);
});

test('notifiers, and other writers of owned columns', () => {
  const { demo } = fixture();
  has(demo, 'notifiers | notifier kick');
  has(demo, 'notifiers | notifier late');
  has(demo, 'ownership | things.status ← src/services/writer.js#write');
  has(demo, 'ownership | things.status ← src/services/writer.js#write (dynamic SET)');
  has(demo, 'ownership | things.status ← trigger things_fill');
  assert.ok(!demo.some((e) => e.includes('noteOnly')), 'a writer of another column');
  assert.ok(!demo.some((e) => e.startsWith('ownership | things.note')), 'only owned columns');
});
