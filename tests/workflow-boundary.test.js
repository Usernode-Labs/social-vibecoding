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
CREATE TABLE asks (id SERIAL PRIMARY KEY, kind TEXT, state TEXT);
CREATE TRIGGER things_wf_owned BEFORE UPDATE ON things FOR EACH ROW
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=demo/thing:', 'status');
CREATE TRIGGER asks_wf_owned BEFORE UPDATE ON asks FOR EACH ROW
  WHEN (OLD.kind IN ('vote', 'poll'))
  EXECUTE FUNCTION wf_guard_owned_columns('@enrolled=demo/ask:', 'state');
CREATE TRIGGER things_wf_done BEFORE UPDATE ON things FOR EACH ROW
  WHEN (NEW.status = 'done')
  EXECUTE FUNCTION wf_guard_owned_columns('@enabled=coowner', 'status');
CREATE OR REPLACE FUNCTION things_fill() RETURNS TRIGGER AS $$
BEGIN NEW.status := 'x'; RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER things_fill BEFORE UPDATE ON things FOR EACH ROW EXECUTE FUNCTION things_fill();
CREATE TRIGGER things_new BEFORE INSERT ON things FOR EACH ROW EXECUTE FUNCTION things_fill();
CREATE TRIGGER things_gone BEFORE UPDATE ON things FOR EACH ROW EXECUTE FUNCTION things_fill();
DROP TRIGGER IF EXISTS things_gone ON things;
`,
  'src/services/helper.js': 'module.exports = { helped() {}, other() {} };',
  // Writes that leave the guarded rows alone by what they say themselves,
  // and the same shapes that do not.
  'src/services/seeds.js': `
async function seed(pool) {
  await pool.query("UPDATE things SET status = 'x' WHERE id = $1 AND NOT wf_holds('demo', 'thing:' || id)");
  await pool.query("UPDATE things SET status = CASE WHEN wf_holds('demo', 'thing:' || id) THEN status ELSE 'x' END WHERE id = 1");
  await pool.query("UPDATE asks SET state = 'closed' WHERE id = $1 AND kind = 'general'");
}
async function careless(pool) { await pool.query("UPDATE things SET status = 'x' WHERE id = $1 AND NOT wf_holds('other', 'thing:' || id)"); }
async function voteKind(pool) { await pool.query("UPDATE asks SET state = 'closed' WHERE id = $1 AND kind = 'vote'"); }
async function upsert(pool) {
  await pool.query("INSERT INTO asks (id, kind, state) VALUES (1, 'vote', 'open') ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state");
}
// Shapes that look like they leave the rows alone and do not (review, 2026-10-17).
async function orHolds(pool) { await pool.query("UPDATE things SET status = 'x' WHERE id = $1 OR NOT wf_holds('demo', 'thing:' || id)"); }
async function holdsOther(pool) { await pool.query("UPDATE things SET status = 'x' WHERE id = $1 AND NOT wf_holds('other', 'thing:' || id) AND wf_holds('demo', 'thing:' || id)"); }
async function laterStatement(pool) { await pool.query("UPDATE things SET status = 'x' WHERE id = 1; UPDATE things SET note = 'y' WHERE id = 1 AND NOT wf_holds('demo', 'thing:' || id)"); }
async function orKind(pool) { await pool.query("UPDATE asks SET state = 'closed' WHERE kind = 'general' OR id = $1"); }
async function intoParam(pool) { await pool.query("UPDATE things SET status = CASE WHEN wf_holds('demo', 'thing:' || id) THEN $1 ELSE 'open' END WHERE id = 2"); }
async function intoExcluded(pool) { await pool.query("INSERT INTO things (id, status) VALUES (2, 'done') ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status"); }
async function intoOther(pool) { await pool.query("UPDATE things SET status = CASE WHEN wf_holds('demo', 'thing:' || id) THEN status ELSE 'open' END WHERE id = 2"); }
async function intoDone(pool) { await pool.query("UPDATE things SET status = 'done' WHERE id = 2 AND NOT wf_holds('demo', 'thing:' || id)"); }
module.exports = { seed, careless, voteKind, upsert, intoOther, intoDone, orHolds, holdsOther, laterStatement, orKind, intoParam, intoExcluded };
`,
  'src/services/store.js': 'module.exports = { remember() {}, forget() {} };',
  'src/services/writer.js': `
async function write(pool) {
  await pool.query("UPDATE things SET status = 'done', note = $2 WHERE id = $1", [1, 'n']);
  await pool.query(\`UPDATE things SET \${'note = 1'} WHERE id = 1\`);
}
async function noteOnly(pool) { await pool.query("UPDATE things SET note = 'x'"); }
module.exports = { write, noteOnly };
`,
  // A SET list built from a named fragment is read with the fragment's columns.
  'src/services/fragments.js': `
const NOTE_SQL = \`note = 'x'\`;
function noteFor(p) { const keep = 'k'; return \`note = \${p}\`; }
async function touch(pool) {
  await pool.query(\`UPDATE things SET \${NOTE_SQL} WHERE id = 1\`);
  await pool.query(\`UPDATE things SET \${noteFor('$1')} WHERE id = 1\`);
}
module.exports = { touch };
`,
  // The same name, meaning something else: a local built at run time, and a
  // file that does not import the fragment. Both stay "dynamic".
  'src/services/shadow.js': `
async function rewrite(pool, cols) {
  const NOTE_SQL = cols.join(', ');
  await pool.query(\`UPDATE things SET \${NOTE_SQL} WHERE id = 1\`);
}
module.exports = { rewrite };
`,
  'src/services/stranger.js': `
async function guess(pool) { await pool.query(\`UPDATE things SET \${NOTE_SQL} WHERE id = 1\`); }
module.exports = { guess };
`,
  'src/services/importer.js': `
const { touch } = require('./fragments');
const fragments = require('./fragments');
async function again(pool) { await pool.query(\`UPDATE things SET \${fragments.NOTE_SQL} WHERE id = 2\`); }
module.exports = { again, touch };
`,
  'src/workflow/legacy.ts': `
import { createRequire } from 'node:module';
const load = createRequire(new URL('../', import.meta.url));
export function legacy(path: string): any { return load('./' + path); }
`,
  'src/workflow/io-shared.ts': `
import { legacy } from './legacy.ts';
export async function readIt(): Promise<unknown> { return legacy('services/store').remember(); }
`,
  'src/workflow/shared.ts': `
import { legacy } from './legacy.ts';
export function closeWith(close: (m: any) => unknown) { const gh = legacy('services/helper'); return close(gh); }
`,
  // The decisions' own code: held to what a transition may do, and followed
  // through the rules modules it imports in turn.
  'src/workflow/rules/wording.ts': `
import { sentence } from './deeper.ts';
export function line(n: number): string { return sentence(n); }
`,
  'src/workflow/rules/deeper.ts': `
import { legacy } from '../legacy.ts';
const seen = new Set<number>();
export function sentence(n: number): string { seen.add(n); return legacy('services/helper').other(n); }
export async function lookUp(): Promise<unknown> { return fetch('https://example.com'); }
`,
  'src/workflow/demo/machine.ts': `
import { legacy } from '../legacy.ts';
import { closeWith } from '../shared.ts';
import { line } from '../rules/wording.ts';
export const said = (n: number) => line(n);
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
import { readIt } from '../io-shared.ts';
const store = () => legacy('services/store');
export function demoServices(pool: any) {
  return {
    'demo.shared': { async run() { return readIt(); } },
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
  // A second machine owning a move of the same column: each is a co-owner,
  // never the other's "other writer".
  'src/workflow/coowner/machine.ts': `
export async function finish(tx: any): Promise<void> { await tx.query("UPDATE things SET status = 'done' WHERE id = 1"); }
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
  has(demo, 'decider | uses src/services/helper.js (whole module)');      // a shared module a transition imports is the transition's
  has(demo, 'services | uses src/services/store.js:remember');            // and one only work handlers import, theirs
  assert.ok(!demo.some((e) => e.startsWith('shared | ')), 'a shared module has the roles of what imports it');
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

test('rules/ is shared decision code, not a machine, and is followed through its own imports', () => {
  const { root, demo } = fixture();
  assert.ok(!boundary(root).has('rules'), 'rules/ is not listed as a machine');
  has(demo, 'rules | uses src/services/helper.js:other');          // two imports away from the machine
  has(demo, 'rules | state src/workflow/rules/deeper.ts#seen');
  has(demo, 'rules | io src/workflow/rules/deeper.ts#lookUp fetch'); // outside I/O is a transition's, refused
});

test('notifiers, and other writers of owned columns', () => {
  const { demo } = fixture();
  has(demo, 'notifiers | notifier kick');
  has(demo, 'notifiers | notifier late');
  has(demo, 'ownership | things.status ← src/services/writer.js#write');
  has(demo, 'ownership | things.status ← src/services/writer.js#write (dynamic SET)');
  has(demo, 'ownership | things.status ← trigger things_fill');
  assert.ok(!demo.some((e) => e.includes('things_new')), 'a trigger on INSERT only fills a row no machine holds yet');
  assert.ok(!demo.some((e) => e.includes('things_gone')), 'a trigger dropped further down is gone');
  assert.ok(!demo.some((e) => e.includes('noteOnly')), 'a writer of another column');
  assert.ok(!demo.some((e) => e.includes('fragments.js')), 'a SET built from named fragments of other columns');
  assert.ok(!demo.some((e) => e.includes('importer.js')), 'a fragment of a module the file requires');
  has(demo, 'ownership | things.status ← src/services/shadow.js#rewrite (dynamic SET)');      // a local of the same name
  has(demo, 'ownership | things.status ← src/services/stranger.js#guess (dynamic SET)');     // not imported
  assert.ok(!demo.some((e) => e.startsWith('ownership | things.note')), 'only owned columns');
  assert.ok(!demo.some((e) => e.includes('src/workflow/coowner/')), 'a machine that owns the column too is no other writer');
  // A write that leaves the machine's rows alone by the guard's own terms.
  assert.ok(!demo.some((e) => e.includes('seeds.js#seed')), 'NOT wf_holds, CASE WHEN wf_holds THEN col, a kind the guard does not cover');
  has(demo, 'ownership | things.status ← src/services/seeds.js#careless');   // another machine's holds
  has(demo, 'ownership | asks.state ← src/services/seeds.js#voteKind');      // a kind the guard covers
  has(demo, 'ownership | asks.state ← src/services/seeds.js#upsert');        // ON CONFLICT DO UPDATE is a write
  // An @enabled guard on a move into one value: a write of another value
  // only is no other writer of it, a write of that value is.
  assert.ok(!demo.some((e) => /coowner.*seeds\.js#intoOther/.test(e)));
});

test('a guard only on a move into one value: another value is not that move', () => {
  const { root } = fixture();
  const list = boundary(root);
  const coowner = [...(list.get('coowner') || new Map()).keys()];
  assert.ok(!coowner.some((e) => e.includes('seeds.js#intoOther')), coowner.join('\n'));
  has(coowner, 'ownership | things.status ← src/services/seeds.js#intoDone');
  has(coowner, 'ownership | things.status ← src/services/seeds.js#intoParam');     // a value it cannot read
  has(coowner, 'ownership | things.status ← src/services/seeds.js#intoExcluded');  // the inserted row's, not the column's own
});

test('an exemption is a top-level conjunct of its own statement, naming the machine', () => {
  const { demo } = fixture();
  has(demo, 'ownership | things.status ← src/services/seeds.js#orHolds');
  has(demo, 'ownership | things.status ← src/services/seeds.js#holdsOther');
  has(demo, 'ownership | things.status ← src/services/seeds.js#laterStatement');
  has(demo, 'ownership | asks.state ← src/services/seeds.js#orKind');
});
