#!/usr/bin/env node
// Where a workflow machine still depends on something a restart erases, or
// bends the workflow contract (docs/workflows.md), traced from source.
//
// A release, a crash or a restart can happen at any moment, and a machine
// resumes its work right after a boot, when process memory is empty. So
// nothing a machine runs may depend on process memory, and what anyone
// relies on must be durable work or a message. This script finds where that
// does not hold yet, mechanically, so the answer does not depend on someone
// reading the code. It parses every module under src/ (and server.js),
// builds a call graph of functions, walks it from each part of each machine
// under src/workflow/, and lists what the walk meets:
//
//   state     a module-level binding that changes after load (a reassigned
//             `let`, a Map/Set/array/object changed at run time, in its own
//             module or another, a factory's locals when it runs at load);
//   timer     a timer that defers work (its callback is not followed);
//   wait      a timer that only bounds or paces something awaited;
//   detached  a promise nobody waits for (not followed either);
//   hook      a listener on `process` or on a module-level emitter;
//   io        outside I/O: network, other programs, the local disk;
// and, per part of a machine (see FORBIDDEN): each notifier, each table a
// work handler writes itself, each legacy function a transition calls, and
// each other writer of a column the machine owns (schema.sql's
// wf_guard_owned_columns triggers).
//
// The walk over-approximates where it must guess: a function defined inside
// a reached one counts as reached, and a method called on a value it cannot
// type (`d.closeRequests()`, `d` a parameter) is matched by name against the
// modules the caller imports or that the reached code hands around. What it
// cannot resolve is printed (`--unresolved`), never dropped silently.
// tests/workflow-state-trace.test.js pins each rule on a small source tree.
//
// Used by tests/workflow-process-state.test.js: the list per machine is
// checked in (tests/baselines/workflow-process-state.json) and may only
// shrink. From the command line:
//
//   node scripts/workflow-state-trace.mjs              the list per machine
//         --paths                                      with how each is reached
//         --unresolved                                 and the calls not resolved
//         --repo <dir>                                 of another checkout
//   node scripts/workflow-state-trace.mjs --json       the list, as JSON
//   node scripts/workflow-state-trace.mjs --shrink     drop listed entries no
//                                                      longer reached (never adds)
//   node scripts/workflow-state-trace.mjs --roots <file>.json [--paths]
//         the informal workflows: { "<name>": ["src/x.js", "src/y.js#fn"] },
//         each one's reach, direct dependencies and tables

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const BASELINE = path.join(REPO, 'tests/baselines/workflow-process-state.json');

// ── Which functions belong to which machine ─────────────────────────────

// A machine is the code under its directory. The wiring (platform.ts) is the
// web process's side and is traced as its own group; github-work.ts is shared
// by the machines and reached through their imports. The kernel is the
// mechanism every machine runs on, traced too, so it cannot gain state either.
export function machineGroups(root = REPO) {
  const dir = path.join(root, 'src/workflow');
  const groups = new Map();
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = listFiles(path.join(dir, entry.name)).map((f) => rel(root, f));
    if (files.length) groups.set(entry.name, { files });
  }
  groups.set('platform', { files: ['src/workflow/platform.ts'] });
  return groups;
}

// ── Parsing ─────────────────────────────────────────────────────────────

const SOURCE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts']);

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (SOURCE_EXT.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

const MUTATING_METHODS = new Set([
  'set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
]);
// `new X()` of these makes a value, not a store of changing state.
const VALUE_CLASSES = new Set([
  'RegExp', 'URL', 'URLSearchParams', 'Date', 'TextEncoder', 'TextDecoder', 'Error', 'TypeError', 'RangeError',
  'Intl.NumberFormat', 'Intl.DateTimeFormat', 'Intl.PluralRules', 'Intl.RelativeTimeFormat', 'Intl.Collator',
  'Intl.ListFormat', 'Intl.Segmenter', 'Intl.DisplayNames', 'Proxy', 'Symbol', 'Function',
]);
const ALWAYS_STATE_CLASSES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'EventEmitter', 'AbortController']);
// Packages that reach outside the process: the network, other programs,
// the local disk. A call into one from a transition is outside I/O.
const IO_PACKAGES = /^(node:)?(child_process|http|https|http2|net|tls|dns|dgram|fs|fs\/promises)$|^@kubernetes\/|^@octokit\/|^@anthropic-ai\/|^firebase-admin|^minio$|^ws$|^node-fetch$|^undici$/;
const ioPackage = (spec) => (IO_PACKAGES.test(spec) ? spec.replace(/^node:/, '') : null);

const TIMER_FUNCTIONS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick']);
const CHAIN_METHODS = new Set(['then', 'catch', 'finally']);
const TEST_SEAM = /(ForTests?|ForTesting)\b|(^|[./])_?_(set|reset|clear|stub|inject|override|arm)[A-Z_]|(^|[./])__/;
const HOOK_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);

// Method names too common to match by name: the built-in prototypes' and
// the request, response and database objects every module passes around.
const GENERIC_METHODS = new Set([
  ...[Object, Array, Map, Set, String, Number, Promise, Date, RegExp, Function, EventEmitter, Buffer, WeakMap]
    .flatMap((c) => Object.getOwnPropertyNames(c.prototype)),
  'query', 'connect', 'release', 'end', 'json', 'status', 'send', 'sendStatus', 'redirect', 'render', 'write',
  'writeHead', 'header', 'cookie', 'type', 'next', 'get', 'post', 'put', 'patch', 'use', 'run', 'close', 'start',
  'stop', 'init', 'abort', 'debug', 'info', 'warn', 'error', 'log', 'emit', 'on', 'once', 'destroy', 'pipe', 'read',
  'then', 'catch', 'finally', 'exec', 'spawn', 'kill', 'unref', 'ref',
]);
const GLOBAL_OBJECTS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'Promise', 'Number', 'String', 'Boolean', 'Date', 'Reflect', 'console', 'Buffer',
  'Symbol', 'Intl', 'BigInt', 'Atomics', 'crypto', 'globalThis', 'Error', 'URL', 'Map', 'Set',
]);

let unitSeq = 0;

class Unit {
  constructor(mod, node, name, parent) {
    this.id = ++unitSeq;
    this.mod = mod;
    this.node = node;
    this.name = name;
    this.parent = parent;
    this.children = [];
    this.top = parent ? parent.top : this;   // the top-level declaration it is written in
    this.locals = new Map();                 // name -> { alias?: Target, unit?: Unit }
    this.refs = [];                          // { kind, ... } gathered from its own body
    this.line = mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1;
  }
  get label() { return `${this.mod.file}#${this.name}`; }
}

class Module {
  constructor(root, file) {
    this.file = file;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    this.sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
      file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    this.top = new Map();      // top-level name -> Binding
    this.exports = new Map();  // export name -> Target
    this.exportAll = [];       // modules re-exported whole (`...require('./x')`)
    this.units = [];
    this.topUnit = null;       // the module body itself
    this.imports = new Set();  // every module it requires, imports or reaches by legacy()
    this.crossWrites = [];     // { module, member, reason }: another module's export it changes
  }
}

// A binding at module level.
//   kind: 'function' | 'class' | 'value' | 'alias'
//   unit: the function or class body, for 'function' / 'class'
//   alias: the module (and member) it stands for, for 'alias'
//   object: property name -> Target, for an object literal initializer
//   state: why it is mutable state, or null

function nameOf(node, sf) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return `[${node.expression.getText(sf)}]`;
  return node.getText(sf);
}

const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
  || ts.isConstructorDeclaration(n);

// The module a require/legacy/import names, or null for a package.
function resolveSpecifier(root, fromFile, spec, viaLegacy) {
  let base;
  if (viaLegacy) base = path.join(root, 'src', spec);
  else if (spec.startsWith('.')) base = path.join(root, path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [base, `${base}.js`, `${base}.ts`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && SOURCE_EXT.has(path.extname(candidate))) return rel(root, candidate);
  }
  return null;
}

// What an expression stands for, when it is a module: `require('./x')`,
// `legacy('services/x')`, `require('./x').y`, or a thunk returning one.
function moduleTarget(ctx, expr) {
  const { root, mod } = ctx;
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression?.(expr) || ts.isNonNullExpression(expr)) return moduleTarget(ctx, expr.expression);
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.arguments.length >= 1
    && ts.isStringLiteralLike(expr.arguments[0])) {
    const fn = expr.expression.text;
    if (fn === 'require' || fn === 'legacy' || fn === 'load') {
      const target = resolveSpecifier(root, mod.file, expr.arguments[0].text, fn === 'legacy');
      if (target) mod.imports.add(target);
      return target ? { module: target } : { external: expr.arguments[0].text };
    }
  }
  // `deps.x || require('./x')`: the module, when nothing is injected.
  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken
    || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return moduleTarget(ctx, expr.right);
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const inner = moduleTarget(ctx, expr.expression);
    if (inner?.module && !inner.member) return { module: inner.module, member: expr.name.text };
  }
  return null;
}

// ── Building the units of one module ────────────────────────────────────

function collectDeclaredNames(nameNode, out) {
  if (!nameNode) return;
  if (ts.isIdentifier(nameNode)) { out.push(nameNode.text); return; }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) if (!ts.isOmittedExpression(el)) collectDeclaredNames(el.name, out);
  }
}

function buildModule(root, file) {
  const mod = new Module(root, file);
  const ctx = { root, mod };
  const body = new Unit(mod, mod.sf, '<module>', null);
  mod.topUnit = body;
  mod.units.push(body);

  // Pass 1: the units (one per function-like node), named by where they sit.
  const unitOf = new Map();
  const walk = (node, unit, nameHint) => {
    if (isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      let name = nameHint;
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)
        || ts.isClassExpression(node)) && node.name) name = node.name.text;
      if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
        name = nameHint ? `${nameHint}` : nameOf(node.name, mod.sf);
      }
      if (ts.isConstructorDeclaration(node)) name = 'constructor';
      if (!name) name = `<fn@${mod.sf.getLineAndCharacterOfPosition(node.getStart(mod.sf)).line + 1}>`;
      const full = unit.parent || unit !== body ? `${unit === body ? '' : `${unit.name}/`}${name}` : name;
      const u = new Unit(mod, node, unit === body ? name : full, unit === body ? null : unit);
      u.deferred = isTimerArgument(node) || isDetachedCallback(node);
      if (unit !== body) unit.children.push(u);
      mod.units.push(u);
      unitOf.set(node, u);
      ts.forEachChild(node, (child) => walk(child, u, childHint(child, null, mod)));
      return;
    }
    ts.forEachChild(node, (child) => walk(child, unit, childHint(child, nameHint, mod)));
  };
  ts.forEachChild(mod.sf, (child) => walk(child, body, childHint(child, null, mod)));

  // Pass 2: module-level bindings.
  for (const stmt of mod.sf.statements) topLevelBinding(ctx, stmt, unitOf);
  // Pass 3: exports.
  for (const stmt of mod.sf.statements) exportsOf(ctx, stmt, unitOf);
  // Pass 4: what each unit references, and which module bindings change.
  const writes = new Map();   // top-level name -> Set of reasons
  for (const u of mod.units) collectRefs(ctx, u, unitOf, writes);
  for (const [name, reasons] of writes) {
    const b = mod.top.get(name);
    if (!b || b.kind === 'function' || b.kind === 'class' || b.kind === 'alias') continue;
    // Writers that only tests call (`_setX`, `_resetForTests`, …) are seams,
    // not state a flow keeps.
    const runtime = [...reasons].filter(([w]) => !TEST_SEAM.test(w.top.name) && !TEST_SEAM.test(w.name)).map(([, reason]) => reason);
    if (runtime.length && !b.regex) b.state = b.state?.startsWith('new-') ? `${b.state.replace(/^new-\w+ /, 'new ')}, ${runtime[0]}` : runtime[0];
  }
  // A Map or Set filled as the module loads and never changed after is a
  // table, unless another module changes it (Program applies those).
  for (const b of mod.top.values()) {
    if (b.kind === 'value' && /^new-(filled|empty) /.test(b.state || '')) { b.tentative = b.state.replace(/^new-\w+ /, 'new '); b.state = null; }
  }
  return mod;
}

// A function handed to setTimeout/setInterval/setImmediate runs later, as a
// flow of its own: the timer is recorded where it is set, and what the
// callback does is not the caller's.
function isTimerArgument(node) {
  let p = node.parent;
  let child = node;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression?.(p))) { child = p; p = p.parent; }
  if (!p || !ts.isCallExpression(p) || p.expression === child) return false;
  const callee = p.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  return TIMER_FUNCTIONS.has(name);
}

// A promise nobody waits for: the call is `void`ed, or it starts a
// `.then/.catch/.finally` chain whose end is a statement of its own, or it is
// itself a statement (whether that drops a promise is decided once the callee
// is known: only an async callee does). What runs after is work in this
// process's memory that a restart loses, recorded where it starts and not
// followed.
function detachedCall(call) {
  let top = call;
  let p = call.parent;
  for (;;) {
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression?.(p))) { top = p; p = p.parent; }
    if (p && ts.isPropertyAccessExpression(p) && p.expression === top && CHAIN_METHODS.has(p.name.text)
      && ts.isCallExpression(p.parent) && p.parent.expression === p) {
      top = p.parent;
      p = top.parent;
      continue;
    }
    // Promise.resolve(f()).catch(...)
    if (p && ts.isCallExpression(p) && p.arguments.includes(top) && ts.isPropertyAccessExpression(p.expression)
      && p.expression.getText() === 'Promise.resolve') {
      top = p;
      p = p.parent;
      continue;
    }
    break;
  }
  if (p && ts.isVoidExpression(p)) return 'void';
  if (p && ts.isExpressionStatement(p)) return top === call ? 'statement' : 'chain';
  return null;
}

function isDetachedCallback(node) {
  let child = node;
  let p = node.parent;
  while (p && ts.isParenthesizedExpression(p)) { child = p; p = p.parent; }
  if (!p || !ts.isCallExpression(p) || !p.arguments.includes(child)) return false;
  const callee = p.expression;
  if (!ts.isPropertyAccessExpression(callee) || !CHAIN_METHODS.has(callee.name.text)) return false;
  return detachedCall(p) === 'chain' || detachedCall(p) === 'void';
}

// The member names a factory's returned object literal has.
function returnedNames(u) {
  const names = [];
  const visit = (n) => {
    if (n !== u.node && isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
      for (const p of n.expression.properties) if (p.name) names.push(nameOf(p.name, u.mod.sf));
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(u.node, visit);
  if (ts.isArrowFunction(u.node) && ts.isParenthesizedExpression(u.node.body) && ts.isObjectLiteralExpression(u.node.body.expression)) {
    for (const p of u.node.body.expression.properties) if (p.name) names.push(nameOf(p.name, u.mod.sf));
  }
  return names;
}

// A timer that only bounds or paces something the caller awaits: it settles
// a promise (`new Promise((r) => setTimeout(r, ms))`, a reject on timeout)
// or aborts or kills what is being waited for. A restart ends the wait with
// the work, which is retried as a whole; it is not deferred work of its own.
const SETTLERS = /^(resolve|reject|res|rej|r|done|finish|settle|wake|abort|kill|cancel|destroy|timeout|onTimeout|fail)$/i;
function isWait(call, u) {
  const cb = call.arguments[0];
  if (!cb) return false;
  if (ts.isIdentifier(cb) && SETTLERS.test(cb.text)) return true;
  if (isFunctionLike(cb)) {
    const body = cb.body;
    const calls = [];
    const visit = (n) => { if (ts.isCallExpression(n)) calls.push(n); ts.forEachChild(n, visit); };
    visit(body);
    const names = calls.map((c) => (ts.isIdentifier(c.expression) ? c.expression.text
      : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : ''));
    if (names.length && names.every((n) => SETTLERS.test(n) || n === 'Error')) return true;
  }
  // Inside a Promise executor whose resolver the callback uses.
  for (let p = call.parent; p && p !== u.node.parent; p = p.parent) {
    if (ts.isNewExpression(p) && p.expression.getText() === 'Promise') return true;
  }
  return false;
}

// A name for the function a node is, from where it is written.
function childHint(node, inherited, mod) {
  const sf = mod.sf;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node) || ts.isPropertyDeclaration(node)) {
    const own = nameOf(node.name, sf);
    return inherited ? `${inherited}.${own}` : own;
  }
  if (ts.isShorthandPropertyAssignment(node)) return null;
  if (ts.isObjectLiteralExpression(node) || isFunctionLike(node) || ts.isClassExpression(node)) return inherited;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return node.left.getText(sf).replace(/^module\.exports\.|^exports\./, '');
  }
  if (ts.isExportAssignment(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression?.(node)
    || ts.isSatisfiesExpression?.(node) || ts.isReturnStatement(node)) return inherited;
  if (ts.isCallExpression(node)) return null;
  return inherited && (ts.isExpressionStatement(node) || ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) ? inherited : null;
}

function objectTargets(ctx, obj, unitOf) {
  const out = new Map();
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) continue;
    const name = nameOf(p.name, ctx.mod.sf);
    if (ts.isShorthandPropertyAssignment(p)) { out.set(name, { name: p.name.text }); continue; }
    if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
      out.set(name, { unit: unitOf.get(p) }); continue;
    }
    if (ts.isPropertyAssignment(p)) out.set(name, valueTarget(ctx, p.initializer, unitOf));
  }
  return out;
}

// What an initializer or exported value stands for.
function valueTarget(ctx, expr, unitOf) {
  if (!expr) return { opaque: true };
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression?.(expr) || ts.isSatisfiesExpression?.(expr)) expr = expr.expression;
  if (isFunctionLike(expr) || ts.isClassExpression(expr)) return { unit: unitOf.get(expr) };
  if (ts.isIdentifier(expr)) return { name: expr.text };
  const m = moduleTarget(ctx, expr);
  if (m) return m;
  if (ts.isObjectLiteralExpression(expr)) return { object: objectTargets(ctx, expr, unitOf), node: expr };
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)
    && expr.expression.getText(ctx.mod.sf) === 'Object.freeze' && expr.arguments[0]) {
    const inner = valueTarget(ctx, expr.arguments[0], unitOf);
    return { ...inner, frozen: true };
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { name: expr.expression.text, member: expr.name.text };
  }
  return { opaque: true, node: expr };
}

function initialState(ctx, init) {
  if (!init) return null;
  let e = init;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression?.(e) || ts.isSatisfiesExpression?.(e)) e = e.expression;
  if (ts.isNewExpression(e)) {
    const cls = e.expression.getText(ctx.mod.sf);
    // `new Set([...])`: a table unless something changes it after load
    // (collectRefs then marks it mutated). An empty one is there to be filled.
    if (ALWAYS_STATE_CLASSES.has(cls)) return e.arguments?.length ? `new-filled ${cls}` : `new-empty ${cls}`;
    if (!VALUE_CLASSES.has(cls)) return `new ${cls}`;
  }
  return null;
}

function topLevelBinding(ctx, stmt, unitOf) {
  const { mod } = ctx;
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    mod.top.set(stmt.name.text, { kind: 'function', unit: unitOf.get(stmt), node: stmt });
    return;
  }
  if (ts.isClassDeclaration(stmt) && stmt.name) {
    mod.top.set(stmt.name.text, { kind: 'class', unit: unitOf.get(stmt), node: stmt });
    return;
  }
  if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
    const target = resolveSpecifier(ctx.root, mod.file, stmt.moduleSpecifier.text, false);
    const io = ioPackage(stmt.moduleSpecifier.text);
    if (io && stmt.importClause) {
      const c = stmt.importClause;
      if (c.name) mod.top.set(c.name.text, { kind: 'external', io });
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) mod.top.set(c.namedBindings.name.text, { kind: 'external', io });
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) mod.top.set(el.name.text, { kind: 'external', io });
      return;
    }
    if (target) mod.imports.add(target);
    const clause = stmt.importClause;
    if (!clause || !target) return;
    if (clause.name) mod.top.set(clause.name.text, { kind: 'alias', alias: { module: target, member: 'default' } });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) mod.top.set(nb.name.text, { kind: 'alias', alias: { module: target } });
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        mod.top.set(el.name.text, { kind: 'alias', alias: { module: target, member: (el.propertyName || el.name).text } });
      }
    }
    return;
  }
  if (!ts.isVariableStatement(stmt)) return;
  const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
  for (const decl of stmt.declarationList.declarations) {
    const init = decl.initializer;
    if (ts.isIdentifier(decl.name)) {
      const name = decl.name.text;
      const m = moduleTarget(ctx, init);
      if (m?.module) { mod.top.set(name, { kind: 'alias', alias: m }); continue; }
      if (m?.external && ioPackage(m.external)) { mod.top.set(name, { kind: 'external', io: ioPackage(m.external) }); continue; }
      // `const x = () => require('./x')`: a thunk for a module.
      if (init && ts.isArrowFunction(init) && !ts.isBlock(init.body)) {
        const inner = moduleTarget(ctx, init.body);
        if (inner?.module) { mod.top.set(name, { kind: 'alias', alias: inner, thunk: true }); continue; }
      }
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isClassExpression(init))) {
        mod.top.set(name, { kind: 'function', unit: unitOf.get(init), node: decl, isConst });
        continue;
      }
      let target = valueTarget(ctx, init, unitOf);
      if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        const f = mod.top.get(init.expression.text);
        if (f?.kind === 'function' && f.unit) {
          f.unit.factoryAtLoad = true;
          target = { instance: f.unit };
        }
      }
      mod.top.set(name, {
        kind: 'value', node: decl, isConst, target,
        regex: !!(init && init.kind === ts.SyntaxKind.RegularExpressionLiteral),
        object: target.object || null,
        state: initialState(ctx, init),
        callInit: !!(init && ts.isCallExpression(init) && !target.module && !target.frozen),
      });
    } else {
      // const { a, b: c } = require('./x')
      const m = moduleTarget(ctx, init);
      if (m?.external && ioPackage(m.external) && ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) if (ts.isIdentifier(el.name)) mod.top.set(el.name.text, { kind: 'external', io: ioPackage(m.external) });
        continue;
      }
      if (m?.module && ts.isObjectBindingPattern(decl.name)) {
        for (const el of decl.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const member = el.propertyName ? nameOf(el.propertyName, mod.sf) : el.name.text;
          mod.top.set(el.name.text, { kind: 'alias', alias: { module: m.module, member: m.member ? `${m.member}.${member}` : member } });
        }
        continue;
      }
      const names = [];
      collectDeclaredNames(decl.name, names);
      for (const n of names) mod.top.set(n, { kind: 'value', node: decl, isConst, target: { opaque: true }, state: null });
    }
  }
}

function exportsOf(ctx, stmt, unitOf) {
  const { mod } = ctx;
  const sf = mod.sf;
  // ESM
  const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
  const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (exported) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) mod.exports.set(stmt.name.text, { name: stmt.name.text });
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const names = [];
        collectDeclaredNames(d.name, names);
        for (const n of names) mod.exports.set(n, { name: n });
      }
    }
  }
  if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
    const from = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
      ? resolveSpecifier(ctx.root, mod.file, stmt.moduleSpecifier.text, false) : null;
    for (const el of stmt.exportClause.elements) {
      const local = (el.propertyName || el.name).text;
      mod.exports.set(el.name.text, from ? { module: from, member: local } : { name: local });
    }
  }
  if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamespaceExport?.(stmt.exportClause) && stmt.moduleSpecifier) {
    const from = resolveSpecifier(ctx.root, mod.file, stmt.moduleSpecifier.text, false);
    if (from) mod.exports.set(stmt.exportClause.name.text, { module: from });
  }
  if (ts.isExportDeclaration(stmt) && !stmt.exportClause && stmt.moduleSpecifier) {
    const from = resolveSpecifier(ctx.root, mod.file, stmt.moduleSpecifier.text, false);
    if (from) mod.exportAll.push(from);
  }
  if (ts.isExportAssignment(stmt)) mod.exports.set('default', valueTarget(ctx, stmt.expression, unitOf));
  // CommonJS
  if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) return;
  const { left, right, operatorToken } = stmt.expression;
  if (operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const lhs = left.getText(sf);
  if (lhs === 'module.exports') {
    const target = valueTarget(ctx, right, unitOf);
    if (target.object) {
      for (const [k, v] of target.object) mod.exports.set(k, v);
      for (const p of target.node.properties) {
        if (ts.isSpreadAssignment(p) && ts.isCallExpression(p.expression) && ts.isIdentifier(p.expression.expression)) {
          // `{ ...createLifecycle() }`: one instance, made as the module loads.
          const f = mod.top.get(p.expression.expression.text);
          if (f?.kind === 'function') {
            f.unit.factoryAtLoad = true;
            for (const name of returnedNames(f.unit)) if (!mod.exports.has(name)) mod.exports.set(name, { factory: f.unit, name });
          }
        }
        if (ts.isSpreadAssignment(p)) {
          const m = moduleTarget(ctx, p.expression);
          const b = ts.isIdentifier(p.expression) ? mod.top.get(p.expression.text) : null;
          if (m?.module) mod.exportAll.push(m.module);
          else if (b?.kind === 'alias' && !b.alias.member) mod.exportAll.push(b.alias.module);
        }
      }
    } else {
      mod.exports.set('default', target);
      // `module.exports = api` with `const api = { ... }`: its properties.
      if (target.name) {
        const b = mod.top.get(target.name);
        if (b?.object) for (const [k, v] of b.object) mod.exports.set(k, v);
        if (b?.kind === 'class' || b?.kind === 'function') mod.exports.set('*', { name: target.name });
      }
    }
    return;
  }
  const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(lhs);
  if (m) mod.exports.set(m[1], valueTarget(ctx, right, unitOf));
}

// The scopes a unit's body sees, innermost first: its own locals, then each
// enclosing unit's.
function declareLocals(ctx, u, unitOf) {
  const { mod } = ctx;
  const node = u.node;
  if (node === mod.sf) return;
  const add = (name, info = {}) => { if (!u.locals.has(name)) u.locals.set(name, info); };
  if (node.parameters) {
    for (const p of node.parameters) {
      const names = [];
      collectDeclaredNames(p.name, names);
      for (const n of names) add(n, { param: true });
    }
  }
  if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) add(node.name.text, { unit: u });
  const visit = (n) => {
    if (n !== node && (isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n))) {
      if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) add(n.name.text, { unit: unitOf.get(n) });
      return;
    }
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) {
        const init = n.initializer;
        const m = moduleTarget(ctx, init);
        const thunkCall = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.arguments.length === 0
          ? (lookup(u, init.expression.text)?.local.thunk ? lookup(u, init.expression.text).local.alias
            : (mod.top.get(init.expression.text)?.thunk ? mod.top.get(init.expression.text).alias : null)) : null;
        if (m?.module) add(n.name.text, { alias: m });
        else if (m?.external && ioPackage(m.external)) add(n.name.text, { io: ioPackage(m.external) });
        else if (thunkCall) add(n.name.text, { alias: thunkCall });
        else if (init && ts.isArrowFunction(init) && !ts.isBlock(init.body) && moduleTarget(ctx, init.body)?.module) {
          add(n.name.text, { alias: moduleTarget(ctx, init.body), thunk: true });
        } else if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) add(n.name.text, { unit: unitOf.get(init) });
        else {
          // What a closure made by this function keeps: a container, or a
          // `let`. It counts only for a factory that runs as its module loads.
          const isLet = ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Let) !== 0;
          const container = !!init && (!!initialState(ctx, init) || ts.isArrayLiteralExpression(init));
          add(n.name.text, { init, factoryState: isLet || container });
        }
      } else {
        const m = moduleTarget(ctx, n.initializer);
        if (m?.external && ioPackage(m.external) && ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name)) add(el.name.text, { io: ioPackage(m.external) });
        } else if (m?.module && ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const member = el.propertyName ? nameOf(el.propertyName, mod.sf) : el.name.text;
            add(el.name.text, { alias: { module: m.module, member: m.member ? `${m.member}.${member}` : member } });
          }
        } else {
          const names = [];
          collectDeclaredNames(n.name, names);
          for (const x of names) add(x, {});
        }
      }
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      const names = [];
      collectDeclaredNames(n.variableDeclaration.name, names);
      for (const x of names) add(x, {});
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
}

function lookup(u, name) {
  for (let s = u; s; s = s.parent) {
    if (s.locals.has(name)) return { local: s.locals.get(name), scope: s };
  }
  return null;
}

const ASSIGN_OPS = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
]);

// The base identifier of `a`, `a.b`, `a[b].c`, and the first member.
function baseOf(expr) {
  let e = expr;
  let first = null;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNonNullExpression(e)
    || ts.isParenthesizedExpression(e)) {
    if (ts.isPropertyAccessExpression(e)) first = e.name.text;
    else if (ts.isElementAccessExpression(e)) first = null;
    e = e.expression;
  }
  return ts.isIdentifier(e) ? { id: e.text, first } : null;
}

function collectRefs(ctx, u, unitOf, writes) {
  const { mod } = ctx;
  const sf = mod.sf;
  declareLocals(ctx, u, unitOf);
  const node = u.node;
  const isTopModuleBinding = (name) => !lookup(u, name) && mod.top.has(name);
  const noteWrite = (target, reason) => {
    const b = baseOf(target);
    if (!b) return;
    // Into another module's export: `other.cache.set(…)`, `other._x = …`.
    const hit = lookup(u, b.id);
    const alias = hit ? hit.local.alias : (mod.top.get(b.id)?.kind === 'alias' ? mod.top.get(b.id).alias : null);
    if (alias && (alias.member || b.first) && !(ts.isIdentifier(target) && !alias.member)) {
      const member = alias.member ? alias.member.split('.')[0] : b.first;
      if (!TEST_SEAM.test(u.top.name)) mod.crossWrites.push({ module: alias.module, member, reason: `${reason} by ${mod.file}` });
      return;
    }
    if (!isTopModuleBinding(b.id)) return;
    // Writing the binding itself (x = ...) or into it (x.y = ..., x[k] = ...).
    const bare = ts.isIdentifier(target);
    const binding = mod.top.get(b.id);
    if (bare && binding.isConst && reason === 'reassigned') return;
    if (!writes.has(b.id)) writes.set(b.id, new Map());
    // Written while the module loads (its top-level code) is built the same
    // way in every process: a table, not state.
    if (u !== mod.topUnit) writes.get(b.id).set(u, reason);
  };
  const atLoad = node === sf;
  const visit = (n) => {
    if (n !== node && unitOf.has(n)) return;                 // a nested unit: its own refs
    // At load only calls run; `module.exports = { a, b }` and the like name
    // functions without running them.
    if (atLoad && ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression)
      && /^(module\.)?exports\b/.test(n.expression.left.getText(sf))) return;
    if (atLoad && (ts.isExportAssignment(n) || ts.isExportDeclaration(n))) return;
    if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind)) {
      noteWrite(n.left, ts.isIdentifier(n.left) ? 'reassigned' : 'mutated');
    }
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      noteWrite(n.operand, ts.isIdentifier(n.operand) ? 'reassigned' : 'mutated');
    }
    if (ts.isDeleteExpression(n)) noteWrite(n.expression, 'mutated');
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && MUTATING_METHODS.has(callee.name.text)) {
        noteWrite(callee.expression, 'mutated');
      }
      if (ts.isIdentifier(callee) && TIMER_FUNCTIONS.has(callee.text) && !lookup(u, callee.text)) {
        u.refs.push({ kind: isWait(n, u) ? 'wait' : 'timer', fn: callee.text, line: lineOf(sf, n) });
      }
      if (ts.isPropertyAccessExpression(callee) && TIMER_FUNCTIONS.has(callee.name.text)
        && ['global', 'globalThis', 'timers', 'process'].includes(callee.expression.getText(sf))) {
        u.refs.push({ kind: isWait(n, u) ? 'wait' : 'timer', fn: callee.name.text, line: lineOf(sf, n) });
      }
      if (ts.isPropertyAccessExpression(callee) && HOOK_METHODS.has(callee.name.text)) {
        const b = baseOf(callee.expression);
        if (b && (b.id === 'process' && !lookup(u, 'process'))) {
          u.refs.push({ kind: 'hook', on: 'process', event: eventName(n), line: lineOf(sf, n) });
        } else if (b && isTopModuleBinding(b.id) && mod.top.get(b.id).kind !== 'alias') {
          u.refs.push({ kind: 'hook', on: b.id, event: eventName(n), line: lineOf(sf, n) });
        }
      }
      if (ts.isIdentifier(callee) && callee.text === 'fetch' && !lookup(u, 'fetch') && !mod.top.has('fetch')) {
        u.refs.push({ kind: 'io', io: 'fetch', line: lineOf(sf, n) });
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const ext = moduleTarget(ctx, callee.expression);
        if (ext?.external && ioPackage(ext.external)) u.refs.push({ kind: 'io', io: ioPackage(ext.external), line: lineOf(sf, n) });
      }
      // require('./x') / legacy('x') with no member: the whole module.
      const m = moduleTarget(ctx, n);
      if (m?.module && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n)) {
        if (!isAliasInit(n)) u.refs.push({ kind: 'module', module: m.module, line: lineOf(sf, n) });
      }
    }
    if (ts.isPropertyAccessExpression(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && false)) {
      refMember(ctx, u, n);
    }
    if (ts.isIdentifier(n) && isReference(n)) refIdentifier(ctx, u, n);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) sqlOf(u, n.text);
    if (ts.isTemplateExpression(n)) sqlOf(u, [n.head.text, ...n.templateSpans.map((sp) => ` $x ${sp.literal.text}`)].join(''));
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  // What a module does as it loads is the same in every process, except the
  // timers and listeners it starts: those are kept, and its calls are not
  // followed (server.js's body is the whole boot).
  if (atLoad) u.refs = u.refs.filter((r) => r.kind === 'timer' || r.kind === 'hook');
  // A unit defined inside another is reached with it.
  for (const c of u.children) if (!c.deferred) u.refs.push({ kind: 'unit', unit: c });
}

function isAliasInit(call) {
  // `const x = require('./x')` / `const { a } = require('./x')`: resolved through the binding.
  let p = call.parent;
  while (p && (ts.isParenthesizedExpression(p) || (ts.isBinaryExpression(p) && p.right === call)
    || (ts.isBinaryExpression(p) && ts.isParenthesizedExpression(p.right) && p.right.expression === call))) { call = p; p = p.parent; }
  return ts.isVariableDeclaration(p) || (ts.isArrowFunction(p) && p.body === call && ts.isVariableDeclaration(p.parent));
}

// The tables a SQL text writes (with the columns an UPDATE sets) and reads.
// Only text that looks like a statement is read; the rest is any string.
const SQL_HINT = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;
const IDENT = '([a-z_][a-z0-9_]*)';
function sqlOf(u, text) {
  if (!SQL_HINT.test(text) || text.length < 12) return;
  const sql = text.replace(/--[^\n]*/g, ' ');
  u.sql ||= { writes: new Map(), reads: new Set() };
  const write = (t, cols = []) => {
    if (!u.sql.writes.has(t)) u.sql.writes.set(t, new Set());
    for (const c of cols) u.sql.writes.get(t).add(c);
  };
  for (const m of sql.matchAll(new RegExp(`\\bINSERT\\s+INTO\\s+${IDENT}`, 'gi'))) write(m[1].toLowerCase(), ['(insert)']);
  for (const m of sql.matchAll(new RegExp(`\\bDELETE\\s+FROM\\s+${IDENT}`, 'gi'))) write(m[1].toLowerCase(), ['(delete)']);
  for (const m of sql.matchAll(new RegExp(`\\bUPDATE\\s+${IDENT}(?:\\s+(?:AS\\s+)?[a-z_]+)?\\s+SET\\s+([\\s\\S]*?)(?:\\bWHERE\\b|\\bFROM\\b|\\bRETURNING\\b|$)`, 'gi'))) {
    const cols = [];
    let depth = 0;
    let start = 0;
    const set = m[2];
    for (let i = 0; i <= set.length; i++) {
      const ch = set[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ',' && depth === 0) || i === set.length) {
        const piece = set.slice(start, i);
        const col = /^\s*(?:[a-z_]+\.)?([a-z_][a-z0-9_]*)\s*=/i.exec(piece);
        if (col) cols.push(col[1].toLowerCase());
        else if (/^\s*\$x/.test(piece)) cols.push('(dynamic)');
        start = i + 1;
      }
    }
    write(m[1].toLowerCase(), cols);
  }
  for (const m of sql.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+${IDENT}`, 'gi'))) {
    const t = m[1].toLowerCase();
    if (!['unnest', 'jsonb_array_elements', 'jsonb_each', 'generate_series', 'jsonb_to_recordset', 'lateral', 'select', 'only'].includes(t)) u.sql.reads.add(t);
  }
}

const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const eventName = (call) => (call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : '?');

// Is this identifier a read of a binding (not a property name, a declaration
// name, a label or a type)?
function isReference(id) {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)
    || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isParameter(p)
    || ts.isFunctionExpression(p) || ts.isClassExpression(p) || ts.isBindingElement(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isTypeQueryNode?.(p)) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === id) return false;   // handled by refMember
  return true;
}

const isCallee = (n) => (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && n.parent.expression === n;

function refIdentifier(ctx, u, id) {
  const name = id.text;
  const called = isCallee(id);
  if (isTimerArgument(id)) return;
  const detached = called ? detachedCall(id.parent) : null;
  const hit = lookup(u, name);
  // `thunk().x` is resolved by refMember; `const m = thunk()` by the local.
  const thunk = hit ? hit.local.thunk : ctx.mod.top.get(name)?.thunk;
  if (thunk && called && (isCalleeOfThunk(id) || isAliasInit(id.parent))) return;
  if (hit?.local.io || (!hit && ctx.mod.top.get(name)?.kind === 'external')) {
    u.refs.push({ kind: 'io', io: hit ? hit.local.io : ctx.mod.top.get(name).io, line: lineOf(ctx.mod.sf, id) });
    return;
  }
  if (hit) {
    if (hit.scope !== u && hit.local.factoryState) u.refs.push({ kind: 'factoryState', scope: hit.scope, name, line: lineOf(ctx.mod.sf, id) });
    if (hit.local.unit && hit.local.unit !== u) u.refs.push({ kind: 'unit', unit: hit.local.unit, detached, line: lineOf(ctx.mod.sf, id) });
    else if (hit.local.alias) {
      if (hit.local.alias.member) u.refs.push({ kind: 'member', module: hit.local.alias.module, member: hit.local.alias.member, line: lineOf(ctx.mod.sf, id), called, detached });
      else if (!isCalleeOfThunk(id)) u.refs.push({ kind: 'module', module: hit.local.alias.module, line: lineOf(ctx.mod.sf, id) });
    }
    return;
  }
  if (ctx.mod.top.has(name)) u.refs.push({ kind: 'top', name, line: lineOf(ctx.mod.sf, id), called, detached });
}

const isCalleeOfThunk = (id) => ts.isCallExpression(id.parent) && id.parent.expression === id
  && ts.isPropertyAccessExpression(id.parent.parent) && id.parent.parent.expression === id.parent;

// `a.b`: a module's export, a module-level object's property, `this.b` in an
// object literal or class, or a method on something unknown.
function refMember(ctx, u, n) {
  const { mod } = ctx;
  const sf = mod.sf;
  const line = lineOf(sf, n);
  const member = n.name.text;
  const called = isCallee(n);
  const detached = called ? detachedCall(n.parent) : null;
  const obj = n.expression;
  const m = moduleTarget(ctx, obj);
  if (m?.module) {
    u.refs.push({ kind: 'member', module: m.module, member: m.member ? `${m.member}.${member}` : member, line, called, detached });
    return;
  }
  // thunk(): `const gh = () => legacy('services/github')` then `gh().x`
  if (ts.isCallExpression(obj) && ts.isIdentifier(obj.expression)) {
    const hit = lookup(u, obj.expression.text);
    const alias = hit ? (hit.local.thunk ? hit.local.alias : null)
      : (mod.top.get(obj.expression.text)?.thunk ? mod.top.get(obj.expression.text).alias : null);
    if (alias) { u.refs.push({ kind: 'member', module: alias.module, member: alias.member ? `${alias.member}.${member}` : member, line, called, detached }); return; }
  }
  if (obj.kind === ts.SyntaxKind.ThisKeyword) {
    u.refs.push({ kind: 'this', member, line, called, detached });
    return;
  }
  if (ts.isIdentifier(obj)) {
    const hit = lookup(u, obj.text);
    if (hit?.local.io || (!hit && mod.top.get(obj.text)?.kind === 'external')) {
      u.refs.push({ kind: 'io', io: hit ? hit.local.io : mod.top.get(obj.text).io, line });
      return;
    }
    if (hit) {
      if (hit.scope !== u && hit.local.factoryState) u.refs.push({ kind: 'factoryState', scope: hit.scope, name: obj.text, line });
      if (hit.local.alias) {
        const a = hit.local.alias;
        u.refs.push({ kind: 'member', module: a.module, member: a.member ? `${a.member}.${member}` : member, line, called, detached });
        return;
      }
      if (hit.local.param || hit.local.init !== undefined || Object.keys(hit.local).length === 0) {
        if (ts.isCallExpression(n.parent) && n.parent.expression === n) u.refs.push({ kind: 'byName', member, on: obj.text, line, called: true, detached });
      }
      return;
    }
    const b = mod.top.get(obj.text);
    if (b) {
      if (b.kind === 'alias') {
        u.refs.push({ kind: 'member', module: b.alias.module, member: b.alias.member ? `${b.alias.member}.${member}` : member, line, called, detached });
      } else {
        u.refs.push({ kind: 'top', name: obj.text, member, line, called, detached });
      }
      return;
    }
    if (GLOBAL_OBJECTS.has(obj.text) || obj.text === 'process' || obj.text === 'module' || obj.text === 'exports') return;
    return;
  }
  // `x.y.z(...)` on something not a module: a call by name, if it is a call.
  if (ts.isCallExpression(n.parent) && n.parent.expression === n) u.refs.push({ kind: 'byName', member, on: obj.getText(sf).slice(0, 40), line, called: true, detached });
}

// ── The program: every module, and the walk ─────────────────────────────

export class Program {
  constructor(root = REPO) {
    this.root = root;
    this.modules = new Map();
    const files = [...listFiles(path.join(root, 'src')), path.join(root, 'server.js')].filter((f) => fs.existsSync(f));
    for (const f of files) {
      const file = rel(root, f);
      try { this.modules.set(file, buildModule(root, file)); } catch (err) {
        throw new Error(`could not parse ${file}: ${err.message}`);
      }
    }
    // Writes into another module's exports make them state there.
    for (const mod of this.modules.values()) {
      for (const w of mod.crossWrites) {
        const target = this.modules.get(w.module);
        const t = target?.exports.get(w.member);
        const b = t?.name ? target.top.get(t.name) : null;
        if (b?.kind === 'value' && !b.regex && !b.state) b.state = `${b.tentative || 'value'}, ${w.reason}`;
      }
    }
    // Who exports each name, for calls on values the walk cannot type.
    this.exporters = new Map();
    for (const mod of this.modules.values()) {
      for (const [name] of mod.exports) {
        if (!this.exporters.has(name)) this.exporters.set(name, []);
        this.exporters.get(name).push(mod.file);
      }
    }
  }

  // The units and state an export of a module stands for.
  resolveExport(file, member, seen = new Set()) {
    const mod = this.modules.get(file);
    if (!mod) return [];
    const key = `${file}:${member}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const [head, ...rest] = member.split('.');
    let target = mod.exports.get(head);
    if (!target) {
      for (const other of mod.exportAll) {
        const found = this.resolveExport(other, member, seen);
        if (found.length) return found;
      }
      // A module that exports a function or class whole: its members are its own.
      if (mod.exports.has('*')) target = mod.exports.get('*');
      else if (mod.top.has(head)) target = { name: head };   // TS/ESM local re-read; harmless
      else return [];
    }
    return this.resolveTarget(mod, target, rest, seen);
  }

  resolveTarget(mod, target, rest, seen) {
    if (!target) return [];
    if (target.unit) return [{ unit: target.unit }];
    // A member of a factory's instance: the factory's local of that name.
    if (target.factory) {
      const local = target.factory.locals.get(target.name);
      return local?.unit ? [{ unit: local.unit }] : [{ unit: target.factory }];
    }
    if (target.instance) {
      if (!rest.length) return [{ unit: target.instance }];
      return this.resolveTarget(mod, { factory: target.instance, name: rest[0] }, rest.slice(1), seen);
    }
    if (target.module) return this.resolveExport(target.module, [target.member, ...rest].filter(Boolean).join('.') || '*whole', seen);
    if (target.object) {
      if (rest.length) return this.resolveTarget(mod, target.object.get(rest[0]), rest.slice(1), seen);
      return [...target.object.values()].flatMap((t) => this.resolveTarget(mod, t, [], seen));
    }
    if (target.name) {
      const b = mod.top.get(target.name);
      if (!b) return [];
      if (b.kind === 'function' || b.kind === 'class') return [{ unit: b.unit }];
      if (b.kind === 'alias') return this.resolveExport(b.alias.module, [b.alias.member, ...rest].filter(Boolean).join('.') || '*whole', seen);
      const out = [];
      if (b.state) out.push({ state: { mod, name: target.name } });
      if (b.object) {
        if (rest.length && b.object.get(rest[0])) out.push(...this.resolveTarget(mod, b.object.get(rest[0]), rest.slice(1), seen));
        else if (!rest.length) out.push(...[...b.object.values()].flatMap((t) => this.resolveTarget(mod, t, [], seen)));
      }
      if (target.member && !rest.length && b.object) out.push(...this.resolveTarget(mod, b.object.get(target.member), [], seen));
      return out;
    }
    return [];
  }

  wholeModule(file) {
    const mod = this.modules.get(file);
    if (!mod) return [];
    const out = [{ unit: mod.topUnit }];
    for (const [name] of mod.exports) out.push(...this.resolveExport(file, name));
    for (const other of mod.exportAll) out.push(...this.wholeModule(other));
    return out;
  }

  // Edges out of a unit: other units, and what it meets.
  step(u, handedSet = new Set()) {
    const edges = [];
    const meets = [];
    const unresolved = [];
    const handed = [];
    const mod = u.mod;
    const emit = (found, r, via) => this.collect(found, { edges, meets, from: u, r, via });
    // Loading a module runs its body: module-level timers and hooks count
    // as soon as anything in it is reached.
    if (u.parent === null && u !== mod.topUnit) edges.push({ unit: mod.topUnit, via: 'load' });
    for (const r of u.refs) {
      if (r.kind === 'unit') { if (r.unit) emit([{ unit: r.unit }], r, 'defines'); continue; }
      if (r.kind === 'factoryState') {
        if (r.scope.factoryAtLoad && r.scope.parent === null) {
          meets.push({ kind: 'state', mod, name: `${r.scope.name}().${r.name}`, why: 'kept by the instance made at load', line: r.line });
        }
        continue;
      }
      if (r.kind === 'timer' || r.kind === 'wait') { meets.push({ kind: r.kind, mod, name: u.top.name, fn: r.fn, line: r.line }); continue; }
      if (r.kind === 'hook') { meets.push({ kind: 'hook', mod, name: u.top.name, on: r.on, event: r.event, line: r.line }); continue; }
      if (r.kind === 'io') { meets.push({ kind: 'io', mod, name: u.top.name, io: r.io, line: r.line }); continue; }
      if (r.kind === 'top') {
        const b = mod.top.get(r.name);
        if (b.kind === 'function' || b.kind === 'class') { emit([{ unit: b.unit }], r, r.name); continue; }
        if (b.kind === 'alias') {
          if (r.member === undefined && !b.alias.member) { handed.push(b.alias.module); continue; }
          const found = r.member === undefined
            ? this.resolveExport(b.alias.module, b.alias.member)
            : this.resolveExport(b.alias.module, [b.alias.member, r.member].filter(Boolean).join('.'));
          emit(found, r, r.name);
          continue;
        }
        if (b.state) meets.push({ kind: 'state', mod, name: r.name, why: b.state, line: r.line });
        if (b.object) {
          const found = r.member !== undefined && b.object.get(r.member)
            ? this.resolveTarget(mod, b.object.get(r.member), [], new Set())
            : [...b.object.values()].flatMap((t) => this.resolveTarget(mod, t, [], new Set()));
          emit(found, r, r.name);
        }
        if (b.target?.name || b.target?.module) emit(this.resolveTarget(mod, b.target, [], new Set()), r, r.name);
        if (b.target?.instance) emit(this.resolveTarget(mod, b.target, r.member === undefined ? [] : [r.member], new Set()), r, r.name);
        continue;
      }
      if (r.kind === 'member') {
        const found = this.resolveExport(r.module, r.member);
        if (!found.length && !this.modules.get(r.module)?.exports.has(r.member.split('.')[0])) {
          unresolved.push({ kind: 'member', module: r.module, member: r.member, from: u.label, line: r.line });
        }
        emit(found, r, `${r.module}:${r.member}`);
        continue;
      }
      // A module handed around as a value: its exports become candidates for
      // calls on values the walk cannot type (below).
      if (r.kind === 'module') { handed.push(r.module); continue; }
      if (r.kind === 'this') {
        // A sibling method in the same object literal or class.
        const owner = u.parent;
        const siblings = (owner ? owner.children : mod.units.filter((x) => x.parent === null))
          .filter((x) => x.name.split(/[./]/).pop() === r.member);
        emit(siblings.map((x) => ({ unit: x })), r, `this.${r.member}`);
        continue;
      }
      if (r.kind === 'byName') {
        if (GENERIC_METHODS.has(r.member)) continue;
        // Only the modules this one imports (or itself): an object with
        // methods comes from a module its user loaded.
        const who = (this.exporters.get(r.member) || []).filter((f) => f === mod.file || mod.imports.has(f) || handedSet.has(f));
        if (!who.length) {
          if ((this.exporters.get(r.member) || []).length) unresolved.push({ kind: 'byName', member: r.member, on: r.on, from: u.label, line: r.line, exporters: 0 });
          continue;
        }
        if (who.length > 3) { unresolved.push({ kind: 'byName', member: r.member, on: r.on, from: u.label, line: r.line, exporters: who.length }); continue; }
        emit(who.flatMap((file) => this.resolveExport(file, r.member)), r, `${r.on}.${r.member} (by name)`);
      }
    }
    return { edges, meets, unresolved, handed };
  }

  // A reference's targets become edges, or state met, or, for a call whose
  // promise nobody waits for, a `detached` entry in place of the edge.
  collect(found, { edges, meets, from, r, via }) {
    for (const f of found) {
      if (f.state) {
        const b = f.state.mod.top.get(f.state.name);
        meets.push({ kind: 'state', mod: f.state.mod, name: f.state.name, why: b.state, line: r.line });
      }
      if (!f.unit) continue;
      const detached = r.detached === 'void' || r.detached === 'chain' || (r.detached === 'statement' && isAsync(f.unit));
      if (detached) {
        meets.push({ kind: 'detached', mod: from.mod, name: from.top.name, target: (f.unit.parent ? f.unit.top : f.unit).label, line: r.line });
        continue;
      }
      edges.push({ unit: f.unit, via, line: r.line });
    }
  }

  // Every unit in these files.
  unitsIn(files) {
    return files.flatMap((f) => this.modules.get(f)?.units || []);
  }

  // Breadth-first from the roots; each thing met keeps the shortest path.
  // Repeated until the set of modules handed around as values stops growing,
  // since each one widens what an untyped call may reach.
  walk(roots, stops = null) {
    let handed = new Set();
    for (;;) {
      const w = this.walkOnce(roots, handed, stops);
      if ([...w.handed].every((m) => handed.has(m))) return w;
      handed = new Set([...handed, ...w.handed]);
    }
  }

  walkOnce(roots, handedSet, stops) {
    const prev = new Map();
    const stopped = new Map();   // a unit in `stops` the walk reached -> where from
    const queue = [];
    for (const r of roots) if (r && !prev.has(r)) { prev.set(r, null); queue.push(r); }
    const met = new Map();
    const unresolved = [];
    const handed = new Set();
    for (let i = 0; i < queue.length; i++) {
      const u = queue[i];
      const step = this.step(u, handedSet);
      unresolved.push(...step.unresolved);
      for (const m of step.handed) handed.add(m);
      for (const m of step.meets) {
        const key = entryKey(m);
        if (!met.has(key)) met.set(key, { ...m, key, via: u });
      }
      for (const e of step.edges) {
        if (!e.unit || prev.has(e.unit)) continue;
        if (stops?.has(e.unit)) { if (!stopped.has(e.unit)) stopped.set(e.unit, u); continue; }
        prev.set(e.unit, u);
        queue.push(e.unit);
      }
    }
    const pathTo = (u) => {
      const out = [];
      for (let x = u; x; x = prev.get(x)) out.unshift(x.label);
      return out;
    };
    return { reached: queue, met, unresolved, handed, pathTo, stopped };
  }

  // Every function-like node by `file#name`, for roots named by hand.
  findUnit(label) {
    const [file, name] = label.split('#');
    const mod = this.modules.get(file);
    if (!mod) return null;
    return mod.units.find((u) => u.name === name) || null;
  }
}

const isAsync = (u) => !!(ts.canHaveModifiers(u.node) && ts.getModifiers(u.node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));

// Entries name functions without line numbers, so an edit elsewhere in a
// file does not change them: an anonymous function is `<fn>`.
export const stable = (label) => String(label).replace(/<fn@\d+>/g, '<fn>');

export function entryKey(m) {
  const at = stable(`${m.mod.file}#${m.name}`);
  if (m.kind === 'state') return `state ${at}`;
  if (m.kind === 'detached') return `detached ${at} → ${stable(m.target)}`;
  if (m.kind === 'io') return `io ${at} ${m.io}`;
  if (m.kind === 'timer') return `timer ${at} ${m.fn}`;
  if (m.kind === 'wait') return `wait ${at} ${m.fn}`;
  return `hook ${at} ${m.on}.on(${m.event})`;
}

// ── Roles: what each part of a machine may reach ────────────────────────

// A machine's code has parts the contract treats differently:
//   decider    transitions, facts, writes, projections, replies (every file
//              of the machine but services.ts): no process state and no
//              outside I/O, since it runs inside the transition's transaction;
//   services   work handlers: outside I/O is their job, but no process state,
//              and their results come back as events, so the database tables
//              they write themselves are listed too;
//   notifiers  post-commit and losable: each one still declared is listed,
//              since what a person or another system relies on must be work
//              or a message (browser pushes come from the stream instead);
//   web        the routes' side (platform.ts): appends, waits and reads.
// The kernel is the mechanism they all run on, traced as its own part.
const FORBIDDEN = new Map([
  ['decider', new Set(['state', 'timer', 'wait', 'hook', 'detached', 'io'])],
  ['services', new Set(['state', 'timer', 'hook', 'detached'])],
  ['notifiers', new Set(['state', 'timer', 'hook', 'detached', 'io'])],
  ['web', new Set(['state', 'timer', 'hook', 'detached', 'io'])],
  ['kernel', new Set(['state', 'timer', 'wait', 'hook', 'detached', 'io'])],
]);

export function machineRoles(program, name, group) {
  const roles = new Map();
  const add = (key, role, units) => {
    if (!roles.has(key)) roles.set(key, { role, name: key, roots: [] });
    roles.get(key).roots.push(...units);
  };
  if (name === 'kernel') { add('kernel', 'kernel', program.unitsIn(group.files)); return roles; }
  if (name === 'platform') { add('web', 'web', program.unitsIn(group.files)); return roles; }
  for (const file of group.files) {
    const mod = program.modules.get(file);
    if (!mod) continue;
    if (!file.endsWith('/services.ts')) { add('decider', 'decider', mod.units); continue; }
    // services.ts: one factory of work handlers (…Services) and one of
    // notifiers (…Notifiers), each returning an object of them by name.
    for (const f of mod.units.filter((u) => u.parent === null && /(Services|Notifiers)$/.test(u.name))) {
      const role = f.name.endsWith('Services') ? 'services' : 'notifiers';
      for (const member of returnedNames(f)) {
        const prefix = `${f.name}/${member}`;
        const units = mod.units.filter((u) => u.name === prefix || u.name.startsWith(`${prefix}.`) || u.name.startsWith(`${prefix}/`));
        add(`${role === 'services' ? 'service' : 'notifier'} ${member}`, role, units);
      }
    }
  }
  return roles;
}

// Where a part's walk stops: another machine's code and the kernel (each
// traced as its own part), and the runtime's boot wiring in platform.ts,
// which builds every machine's handlers.
const BOOT_FUNCTIONS = new Set(['startWorkflow', 'startWorkflowLoops', 'stopWorkflow', 'syncSettings']);
function stopsFor(program, name, groups) {
  const stops = new Map();
  for (const [other, group] of groups) {
    if (other === name || other === 'platform') continue;
    for (const u of program.unitsIn(group.files)) stops.set(u, other);
  }
  for (const u of program.unitsIn(['src/workflow/platform.ts'])) if (BOOT_FUNCTIONS.has(u.top.name)) stops.set(u, 'boot');
  return stops;
}

export function traceMachines(root = REPO, program = new Program(root)) {
  const out = new Map();
  const groups = machineGroups(root);
  for (const [name, group] of groups) {
    const roles = new Map();
    const stops = stopsFor(program, name, groups);
    for (const [key, r] of machineRoles(program, name, group)) {
      const roots = r.roots.filter((u) => !stops.has(u));
      roles.set(key, { ...r, roots, ...program.walk(roots, stops) });
    }
    out.set(name, { files: group.files, roles });
  }
  return { program, machines: out, ownership: ownership(program, root) };
}

function schemaTables(root) {
  const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
  return new Set([...schema.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()));
}

// The tables a walk's code writes itself.
function writesOf(walk, tables) {
  const writes = new Map();
  for (const u of walk.reached) {
    for (const [tbl, cols] of u.sql?.writes || []) {
      if (!tables.has(tbl)) continue;
      if (!writes.has(tbl)) writes.set(tbl, { cols: new Set(), via: u });
      for (const c of cols) writes.get(tbl).cols.add(c);
    }
  }
  return writes;
}

// Columns a machine owns (schema.sql's wf_guard_owned_columns triggers),
// and everything else that writes them: SQL anywhere under src/ outside the
// machine's directory, and triggers that assign them. Each is a second
// owner, until the column has one writer and its enforcement can raise.
export function ownership(program, root = program.root) {
  const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
  const owned = [];   // { machine, table, column, trigger }
  for (const m of schema.matchAll(/CREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s+BEFORE\s+UPDATE\s+ON\s+([a-z_][a-z0-9_]*)[\s\S]*?EXECUTE\s+FUNCTION\s+wf_guard_owned_columns\(([^;]*?)\);/gi)) {
    const args = [...m[3].matchAll(/'([^']*)'/g)].map((a) => a[1]);
    const scope = /^@(?:enrolled|enabled)=([a-z0-9-]+)/.exec(args[0] || '');
    if (!scope) continue;
    for (const a of args.slice(1).filter((x) => !x.startsWith('@'))) owned.push({ machine: scope[1], table: m[2].toLowerCase(), column: a.split('.')[0], trigger: m[1] });
  }
  const out = new Map();
  const note = (machine, entry, detail) => {
    if (!out.has(machine)) out.set(machine, new Map());
    if (!out.get(machine).has(entry)) out.get(machine).set(entry, detail);
  };
  const isOwn = (machine, file) => file.startsWith(`src/workflow/${machine}/`);
  for (const mod of program.modules.values()) {
    for (const u of mod.units) {
      for (const [tbl, cols] of u.sql?.writes || []) {
        for (const o of owned) {
          if (o.table !== tbl || isOwn(o.machine, mod.file)) continue;
          const at = stable(`${mod.file}#${u.top.name}`);
          if (cols.has(o.column)) note(o.machine, `ownership ${o.table}.${o.column} ← ${at}`, `UPDATE sets it (line ${u.line})`);
          else if (cols.has('(dynamic)')) note(o.machine, `ownership ${o.table}.${o.column} ← ${at} (dynamic SET)`, `UPDATE with a SET list built at run time (line ${u.line})`);
        }
      }
    }
  }
  // Trigger functions assigning NEW.<owned column>, on the owned table.
  const fns = new Map();
  for (const m of schema.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(\s*\)\s+RETURNS\s+TRIGGER\s+AS\s+\$\$([\s\S]*?)\$\$/gi)) {
    fns.set(m[1].toLowerCase(), new Set([...m[2].matchAll(/NEW\.([a-z_][a-z0-9_]*)\s*:=/gi)].map((x) => x[1].toLowerCase())));
  }
  for (const m of schema.matchAll(/CREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s+BEFORE\s+(?:INSERT|UPDATE)(?:\s+OR\s+(?:INSERT|UPDATE))?\s+ON\s+([a-z_][a-z0-9_]*)[\s\S]*?EXECUTE\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const assigned = fns.get(m[3].toLowerCase());
    if (!assigned) continue;
    for (const o of owned) {
      if (o.table === m[2].toLowerCase() && assigned.has(o.column)) {
        note(o.machine, `ownership ${o.table}.${o.column} ← trigger ${m[1]}`, `trigger function ${m[3]} assigns NEW.${o.column}`);
      }
    }
  }
  return { owned, writers: out };
}

// The ratchet's entries: per machine, `<role> | <entry>`, minus what the
// baseline allows (process resources every module shares).
export function ratchetEntries(trace, allowed = new Set(), root = REPO) {
  const tables = schemaTables(root);
  const out = new Map();
  for (const [name, t] of trace.machines) {
    const set = new Map();   // entry -> detail
    for (const r of t.roles.values()) {
      const forbidden = FORBIDDEN.get(r.role);
      for (const m of r.met.values()) {
        if (!forbidden.has(m.kind) || allowed.has(m.key)) continue;
        const e = `${r.role} | ${m.key}`;
        if (!set.has(e)) set.set(e, { from: r.name, meet: m, walk: r });
      }
      if (r.role === 'notifiers') set.set(`notifiers | ${r.name}`, { from: r.name });
      // Each function outside the workflow code a transition or a domain
      // write calls: checked once, and listed so a new one is a decision.
      if (r.role === 'decider') {
        for (const u of r.reached) {
          if (!u.mod.file.startsWith('src/workflow/')) continue;
          for (const e of trace.program.step(u).edges) {
            if (!e.unit || e.unit.mod.file.startsWith('src/workflow/') || e.via === 'load') continue;
            const target = e.unit.parent ? e.unit.top : e.unit;
            const k = `decider | calls ${stable(target.label)}`;
            if (!set.has(k)) set.set(k, { detail: `from ${u.label}` });
          }
        }
      }
      if (r.role === 'services') {
        for (const [tbl, w] of writesOf(r, tables)) {
          const e = `services | writes ${tbl}`;
          if (!set.has(e)) set.set(e, { from: r.name, write: { tbl, ...w }, walk: r });
          else set.get(e).also = [...(set.get(e).also || []), r.name];
        }
      }
    }
    for (const [e, detail] of trace.ownership.writers.get(name) || []) set.set(`ownership | ${e.replace(/^ownership /, '')}`, { detail });
    out.set(name, new Map([...set].sort(([a], [b]) => a.localeCompare(b))));
  }
  return out;
}

export function readBaseline(file = BASELINE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── Command line ────────────────────────────────────────────────────────

function describe(m) {
  if (m.kind === 'state') return `${m.why}`;
  if (m.kind === 'detached') return `not awaited (line ${m.line})`;
  if (m.kind === 'io') return `outside I/O (line ${m.line})`;
  if (m.kind === 'timer') return `${m.fn} (line ${m.line})`;
  if (m.kind === 'wait') return `${m.fn} bounding an awaited operation (line ${m.line})`;
  return `${m.on}.on('${m.event}') (line ${m.line})`;
}

function report(trace, allowed, opts, root) {
  const lines = [];
  const entries = ratchetEntries(trace, allowed, root);
  for (const [name, list] of entries) {
    const t = trace.machines.get(name);
    const reached = new Set([...t.roles.values()].flatMap((r) => r.reached)).size;
    lines.push(`\n## ${name} (${reached} functions reached, ${list.size} entries)`);
    for (const [e, d] of list) {
      let why = '';
      if (d.meet) why = `  [${describe(d.meet)}; from ${d.from}]`;
      else if (d.write) why = `  [${[...d.write.cols].sort().join(', ')}; from ${[d.from, ...(d.also || [])].join(', ')}]`;
      else if (d.detail) why = `  [${d.detail}]`;
      lines.push(`- ${e}${why}`);
      if (opts.paths && d.meet) lines.push(`    via ${d.walk.pathTo(d.meet.via).join(' → ')}`);
      if (opts.paths && d.write) lines.push(`    via ${d.walk.pathTo(d.write.via).join(' → ')}`);
    }
    if (opts.unresolved) {
      const seen = new Set();
      for (const r of t.roles.values()) {
        for (const u of r.unresolved) {
          const k = `${u.kind} ${u.module || u.on}.${u.member}`;
          if (seen.has(k)) continue;
          seen.add(k);
          lines.push(`  ? ${k} (from ${u.from}:${u.line}${u.exporters ? `, ${u.exporters} exporters` : ''})`);
        }
      }
    }
  }
  return lines.join('\n');
}

function rootsFor(program, labels) {
  return labels.flatMap((l) => {
    // `file`: every function the module exports; `file#name`: one.
    if (!l.includes('#')) {
      const mod = program.modules.get(l);
      if (!mod) throw new Error(`no module ${l}`);
      const found = [...mod.exports.keys()].flatMap((name) => program.resolveExport(l, name)).filter((f) => f.unit).map((f) => f.unit);
      return found.length ? found : mod.units.filter((u) => u.parent === null && u !== mod.topUnit);
    }
    const u = program.findUnit(l);
    if (!u) throw new Error(`no function ${l}`);
    return [u];
  });
}

// The informal workflows: each one's walk from its entry functions, the
// workflows it calls into directly, and the tables it writes and reads.
function informal(program, spec, allowed, args, root) {
  const tables = schemaTables(root);
  const rootsOf = new Map(Object.entries(spec).map(([name, labels]) => [name, rootsFor(program, labels)]));
  const lines = [];
  for (const [name, roots] of rootsOf) {
    const own = new Set(roots);
    const stops = new Map();
    for (const [other, list] of rootsOf) if (other !== name) for (const u of list) if (!own.has(u)) stops.set(u, other);
    const whole = program.walk(roots);
    const alone = program.walk(roots, stops);
    const deps = new Map();
    for (const [u, from] of alone.stopped) {
      const other = stops.get(u);
      if (!deps.has(other)) deps.set(other, []);
      deps.get(other).push(`${from.label} → ${u.label}`);
    }
    const entries = [...alone.met.values()].filter((m) => !allowed.has(m.key)).sort((a, b) => a.key.localeCompare(b.key));
    lines.push(`\n## ${name}`);
    lines.push(`reaches ${whole.reached.length} functions in all; ${alone.reached.length} before another workflow's entry points; ${entries.length} entries on its own`);
    for (const [other, via] of [...deps].sort()) lines.push(`calls ${other} (${via.length}): ${via.slice(0, 3).join('; ')}${via.length > 3 ? '; …' : ''}`);
    const writes = writesOf(alone, tables);
    const reads = new Set(alone.reached.flatMap((u) => [...(u.sql?.reads || [])]).filter((r) => tables.has(r) && !writes.has(r)));
    lines.push(`writes: ${[...writes].sort().map(([tbl, w]) => `${tbl}(${[...w.cols].sort().join(', ')})`).join('; ')}`);
    lines.push(`reads: ${[...reads].sort().join(', ')}`);
    for (const m of entries) {
      lines.push(`- ${m.key}  [${describe(m)}]`);
      if (args.has('--paths')) lines.push(`    via ${alone.pathTo(m.via).join(' → ')}`);
    }
  }
  return lines.join('\n');
}

async function main(argv) {
  const args = new Set(argv);
  const rootIdx = argv.indexOf('--repo');
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : REPO;
  const baseline = fs.existsSync(BASELINE) ? readBaseline() : { allowed: {}, machines: {} };
  const allowed = new Set(Object.keys(baseline.allowed || {}));
  const program = new Program(root);
  const rootsIdx = argv.indexOf('--roots');
  if (rootsIdx >= 0) {
    // { "<workflow>": ["src/services/x.js", "src/services/y.js#fn", ...], ... }
    const spec = JSON.parse(fs.readFileSync(argv[rootsIdx + 1], 'utf8'));
    process.stdout.write(`${informal(program, spec, allowed, args, root)}\n`);
    return;
  }
  const trace = traceMachines(root, program);
  if (args.has('--shrink')) {
    const now = ratchetEntries(trace, allowed, root);
    let removed = 0;
    for (const [name, list] of Object.entries(baseline.machines)) {
      const reached = now.get(name) || new Map();
      const kept = list.filter((e) => reached.has(e));
      removed += list.length - kept.length;
      baseline.machines[name] = kept;
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`removed ${removed} entr${removed === 1 ? 'y' : 'ies'} no longer reached\n`);
    return;
  }
  if (args.has('--json')) {
    const now = ratchetEntries(trace, allowed, root);
    process.stdout.write(`${JSON.stringify(Object.fromEntries([...now].map(([n, l]) => [n, [...l.keys()]])), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report(trace, allowed, { paths: args.has('--paths'), unresolved: args.has('--unresolved') }, root)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
