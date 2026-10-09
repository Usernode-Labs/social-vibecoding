'use strict';

// The boundary between each workflow machine and the code not migrated yet,
// read from the source text. For each part of each machine under
// src/workflow/ (transitions and domain writes, work handlers, notifiers,
// the shared workflow modules they import, the routes' side in platform.ts,
// the kernel), it lists:
//   uses       each place its code names code outside src/workflow/, as it
//              is written: `legacy('services/x').fn` is
//              `uses src/services/x.js:fn`, a module handed on whole is
//              `(whole module)`, a member chosen at run time is `[computed]`;
//   <kind>     what its own code does that the part may not: module state
//              that changes after load, timers, process listeners, and
//              outside I/O from a transition;
//   notifier   each notifier still declared;
//   writes     each table a work handler's own code writes;
//   ownership  each other writer of a column a machine owns (schema.sql's
//              wf_guard_owned_columns triggers): SQL anywhere under src/,
//              and triggers that assign it.
// It reads only the workflow code (and SQL text), never what lies behind a
// call: the two-process and restart tests show that.
//
// tests/workflow-process-state.test.js gates on it against
// tests/baselines/workflow-process-state.json, which may only shrink.
//   node tests/lib/workflow-boundary.js            the list, per machine
//   node tests/lib/workflow-boundary.js --shrink   drop listed entries that
//                                                  are gone (never adds)

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const REPO = path.resolve(__dirname, '..', '..');
const BASELINE = path.join(REPO, 'tests/baselines/workflow-process-state.json');
const WORKFLOW = 'src/workflow/';

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
const parse = (root, file) => ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true,
  file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

function listFiles(root, dir) {
  const out = [];
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, child));
    else if (/\.(c|m)?[jt]s$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(child);
  }
  return out.sort();
}

// The module a specifier names, from a workflow file: legacy() paths are
// relative to src/, the rest to the file.
function resolve(root, from, spec, viaLegacy) {
  if (!viaLegacy && !spec.startsWith('.')) return null;
  const base = viaLegacy ? path.join(root, 'src', spec) : path.join(root, path.dirname(from), spec);
  for (const c of [base, `${base}.js`, `${base}.ts`, path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(root, c);
  }
  return null;
}

// The top-level declaration a node is written in, and its name.
function topOf(node) {
  let n = node;
  while (n.parent && n.parent.kind !== ts.SyntaxKind.SourceFile) n = n.parent;
  if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) return n.name.text;
  if (ts.isVariableStatement(n)) return n.declarationList.declarations.map((d) => d.name.getText()).join(',');
  return '<module>';
}

// ── One workflow file: what it names outside, and what it does itself ──

function scanFile(root, file) {
  const sf = parse(root, file);
  const uses = [];      // { module, what, top }
  const own = [];       // { kind, name, top, detail }
  const writes = [];    // { table, top }
  const outside = (m) => m && !m.startsWith(WORKFLOW);

  // A module named by legacy('x'), require('./x') or import('./x').
  const moduleOf = (expr) => {
    while (expr && (ts.isParenthesizedExpression(expr) || ts.isAwaitExpression(expr) || ts.isAsExpression(expr))) expr = expr.expression;
    if (!expr || !ts.isCallExpression(expr) || !expr.arguments[0] || !ts.isStringLiteralLike(expr.arguments[0])) return null;
    const spec = expr.arguments[0].text;
    if (ts.isIdentifier(expr.expression) && expr.expression.text === 'legacy') return resolve(root, file, spec, true);
    if (ts.isIdentifier(expr.expression) && expr.expression.text === 'require') return resolve(root, file, spec, false);
    if (expr.expression.kind === ts.SyntaxKind.ImportKeyword) return resolve(root, file, spec, false);
    return null;
  };
  // Names bound to a module (const gh = legacy('x')) or to a function that
  // returns one (const github = () => legacy('x')), and import bindings.
  const aliases = new Map();
  const thunks = new Map();
  const visitDecls = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      const m = moduleOf(init);
      if (m && ts.isIdentifier(n.name)) aliases.set(n.name.text, m);
      if (m && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const member = (el.propertyName || el.name).getText();
          if (outside(m)) uses.push({ module: m, what: `:${member}`, top: topOf(n) });
        }
      }
      if (ts.isArrowFunction(init) && !ts.isBlock(init.body) && moduleOf(init.body) && ts.isIdentifier(n.name)) {
        thunks.set(n.name.text, moduleOf(init.body));
      }
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
      const m = resolve(root, file, n.moduleSpecifier.text, false);
      const c = n.importClause;
      if (m && outside(m)) {
        if (c.name) aliases.set(c.name.text, m);
        if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) aliases.set(c.namedBindings.name.text, m);
        if (c.namedBindings && ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) uses.push({ module: m, what: `:${(el.propertyName || el.name).text}`, top: '<module>' });
        }
      }
    }
    ts.forEachChild(n, visitDecls);
  };
  visitDecls(sf);

  // Module-level bindings, and which ones change after load.
  const topNames = new Map();   // name -> 'let' | 'const'
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const kind = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && !aliases.has(d.name.text) && !thunks.has(d.name.text)) topNames.set(d.name.text, kind);
    }
  }
  const changed = new Set();
  const MUTATE = new Set(['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice']);
  const baseName = (e) => {
    while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
  };
  const insideFunction = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p)) return true;
    }
    return false;
  };

  const visit = (n) => {
    // A module expression: its member, a computed member, or the whole of it.
    const m = moduleOf(n);
    if (m && outside(m)) {
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === n) uses.push({ module: m, what: `:${p.name.text}`, top: topOf(n) });
      else if (ts.isElementAccessExpression(p) && p.expression === n) {
        uses.push({ module: m, what: ts.isStringLiteralLike(p.argumentExpression) ? `:${p.argumentExpression.text}` : '[computed]', top: topOf(n) });
      } else if (!ts.isVariableDeclaration(p) && !(ts.isArrowFunction(p) && ts.isVariableDeclaration(p.parent))) {
        uses.push({ module: m, what: ' (whole module)', top: topOf(n) });
      }
    }
    if (ts.isIdentifier(n) && isReference(n)) {
      const p = n.parent;
      const isDecl = false;
      if (!isDecl && aliases.has(n.text) && outside(aliases.get(n.text))) {
        const mod = aliases.get(n.text);
        if (ts.isPropertyAccessExpression(p) && p.expression === n) uses.push({ module: mod, what: `:${p.name.text}`, top: topOf(n) });
        else if (ts.isElementAccessExpression(p) && p.expression === n) {
          uses.push({ module: mod, what: ts.isStringLiteralLike(p.argumentExpression) ? `:${p.argumentExpression.text}` : '[computed]', top: topOf(n) });
        } else uses.push({ module: mod, what: ' (whole module)', top: topOf(n) });
      }
      if (!isDecl && thunks.has(n.text) && outside(thunks.get(n.text)) && ts.isCallExpression(p) && p.expression === n) {
        const mod = thunks.get(n.text);
        const after = p.parent;
        if (ts.isPropertyAccessExpression(after) && after.expression === p) uses.push({ module: mod, what: `:${after.name.text}`, top: topOf(n) });
        else if (ts.isVariableDeclaration(after) && ts.isIdentifier(after.name)) aliases.set(after.name.text, mod);
        else uses.push({ module: mod, what: ' (whole module)', top: topOf(n) });
      }
    }
    // Module state that changes after load.
    if (insideFunction(n)) {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const b = baseName(n.left);
        if (b && topNames.has(b) && (topNames.get(b) === 'let' || !ts.isIdentifier(n.left))) changed.add(b);
      }
      if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && ts.isIdentifier(n.operand) && topNames.get(n.operand.text) === 'let') changed.add(n.operand.text);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && MUTATE.has(n.expression.name.text)) {
        const b = baseName(n.expression.expression);
        if (b && topNames.has(b)) changed.add(b);
      }
    }
    // Timers, process listeners, outside I/O.
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^(globalThis\.|global\.)?(setTimeout|setInterval|setImmediate|queueMicrotask)$|^process\.nextTick$/.test(callee)) {
        own.push({ kind: 'timer', name: `${topOf(n)} ${callee.replace(/^(globalThis|global)\./, '')}` });
      }
      if (/^process\.(on|once|addListener)$/.test(callee)) own.push({ kind: 'hook', name: `${topOf(n)} ${callee}` });
      if (/^(globalThis\.)?fetch$/.test(callee)) own.push({ kind: 'io', name: `${topOf(n)} fetch` });
    }
    // SQL a function writes: INSERT INTO / UPDATE / DELETE FROM <table>.
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const text = ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' $x ') : n.text;
      for (const w of sqlWrites(text)) writes.push({ table: w.table, top: topOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const name of changed) own.push({ kind: 'state', name });
  return { file, sf, uses, own, writes };
}

// Is this identifier a read of a binding (not a declaration, a property
// name, an import or export specifier, or a type)?
function isReference(id) {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)
    || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isParameter(p)
    || ts.isFunctionExpression(p) || ts.isBindingElement(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

// ── SQL ────────────────────────────────────────────────────────────────

// The tables (and the columns an UPDATE sets) a SQL text writes.
function sqlWrites(text) {
  if (!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(text)) return [];
  const out = [];
  for (const m of text.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi)) out.push({ table: m[1].toLowerCase(), cols: null });
  for (const m of text.matchAll(/\bUPDATE\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?[a-z_]+)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/gi)) {
    const cols = new Set();
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
        if (col) cols.add(col[1].toLowerCase());
        else if (/^\s*\$x/.test(piece)) cols.add('(dynamic)');
        start = i + 1;
      }
    }
    out.push({ table: m[1].toLowerCase(), cols });
  }
  return out;
}

// SQL text a template interpolates by name: a module's string constant
// (`const INVALIDATE_SQL = \`...\``) or a function that returns one template
// (`function invalidateHeadMoveSql(p) { ... return \`...\`; }`). An UPDATE's
// SET list built from one is read with the fragment's own columns rather than
// as "every column". A name defined twice with different text is not resolved.
function templateText(node, fragments = null) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return fragments ? withFragments(node, fragments) : [node.head.text, ...node.templateSpans.map((x) => x.literal.text)].join(' $x ');
  return null;
}
function sqlFragments(root, files) {
  const found = new Map();
  const add = (name, text) => {
    if (text == null) return;
    found.set(name, found.has(name) && found.get(name) !== text ? null : text);
  };
  for (const file of files) {
    const text = read(root, file);
    if (!/\b(SET|UPDATE)\b|=/.test(text)) continue;
    const sf = parse(root, file);
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && /^[A-Z][A-Z0-9_]*$/.test(d.name.text) && d.initializer) add(d.name.text, templateText(d.initializer));
        }
      }
      if (ts.isFunctionDeclaration(st) && st.name && st.body) {
        const last = [...st.body.statements].reverse().find((x) => ts.isReturnStatement(x));
        if (last && last.expression) add(st.name.text, templateText(last.expression));
      }
    }
  }
  return found;
}
// A template's text, its spans replaced by the fragment they name, else $x.
function withFragments(node, fragments) {
  const nameOf = (e) => {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isCallExpression(e)) return nameOf(e.expression);
    return null;
  };
  let out = node.head.text;
  for (const span of node.templateSpans) {
    const frag = fragments.get(nameOf(span.expression));
    out += (frag != null ? ` ${frag} ` : ' $x ') + span.literal.text;
  }
  return out;
}

// Columns machines own, and the triggers that assign columns.
function readSchema(root) {
  const schema = read(root, 'src/db/schema.sql');
  const tables = new Set([...schema.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()));
  const owned = [];
  // One statement each ([^;]), so a match never reaches into the next one.
  const guard = /CREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s+BEFORE\s+(?:INSERT\s+OR\s+)?UPDATE(?:\s+OF\s+[^;]*?)?(?:\s+OR\s+INSERT)?\s+ON\s+([a-z_][a-z0-9_]*)[^;]*?EXECUTE\s+FUNCTION\s+wf_guard_owned_columns\(([^;]*?)\);/gi;
  for (const m of schema.matchAll(guard)) {
    const args = [...m[3].matchAll(/'([^']*)'/g)].map((a) => a[1]);
    const scope = /^@(?:enrolled|enabled)=([a-z0-9-]+)/.exec(args[0] || '');
    if (!scope) continue;
    for (const a of args.slice(1).filter((x) => !x.startsWith('@'))) owned.push({ machine: scope[1], table: m[2].toLowerCase(), column: a.split('.')[0] });
  }
  const fns = new Map();
  for (const m of schema.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(\s*\)\s+RETURNS\s+TRIGGER\s+AS\s+\$\$([\s\S]*?)\$\$/gi)) {
    fns.set(m[1].toLowerCase(), new Set([...m[2].matchAll(/NEW\.([a-z_][a-z0-9_]*)\s*:=/gi)].map((x) => x[1].toLowerCase())));
  }
  const assigning = [];
  for (const m of schema.matchAll(/CREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s+BEFORE\s+(?:INSERT|UPDATE)(?:\s+OF\s+[^;]*?)?(?:\s+OR\s+(?:INSERT|UPDATE))?\s+ON\s+([a-z_][a-z0-9_]*)[^;]*?EXECUTE\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)) {
    for (const col of fns.get(m[3].toLowerCase()) || []) assigning.push({ trigger: m[1], table: m[2].toLowerCase(), column: col });
  }
  return { tables, owned, assigning };
}

// ── The list ───────────────────────────────────────────────────────────

// A machine is the code under its directory; platform.ts is the routes'
// side; the kernel is the mechanism. rules/ is not a machine: it is the
// decisions' own code (gate rules, line wording, domain writes), shared by
// the machines and imported back by the code not migrated yet, and it is
// held to what a transition may do.
const RULES = `${WORKFLOW}rules/`;
function machines(root) {
  const dir = path.join(root, WORKFLOW);
  const out = new Map();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'rules') out.set(e.name, listFiles(root, `${WORKFLOW}${e.name}`));
  }
  out.set('platform', [`${WORKFLOW}platform.ts`]);
  return out;
}

// What a part may not do in its own code.
const FORBIDDEN = new Map([
  ['decider', new Set(['state', 'timer', 'hook', 'io'])],
  ['services', new Set(['state', 'timer', 'hook'])],
  ['notifiers', new Set(['state', 'timer', 'hook'])],
  ['shared', new Set(['state', 'timer', 'hook'])],
  ['rules', new Set(['state', 'timer', 'hook', 'io'])],
  ['web', new Set(['state', 'timer', 'hook', 'io'])],
  ['kernel', new Set(['state', 'timer', 'hook', 'io'])],
]);

function roleOf(name, file, top) {
  if (name === 'kernel') return 'kernel';
  if (name === 'platform') return 'web';
  if (file.startsWith(RULES)) return 'rules';
  if (!file.startsWith(`${WORKFLOW}${name}/`)) return 'shared';
  if (!file.endsWith('/services.ts')) return 'decider';
  return top.endsWith('Notifiers') ? 'notifiers' : 'services';
}

// The names a notifiers factory's returned object has.
function notifierNames(sf) {
  const names = [];
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name?.text.endsWith('Notifiers')) continue;
    const visit = (n) => {
      if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
        for (const p of n.expression.properties) if (p.name) names.push(p.name.getText(sf));
      }
      if (!(ts.isFunctionLike(n) && n !== st)) ts.forEachChild(n, visit);
    };
    ts.forEachChild(st, visit);
  }
  return names;
}

function boundary(root = REPO, allowed = new Set()) {
  const schema = readSchema(root);
  const groups = machines(root);
  const scans = new Map();
  const scan = (file) => { if (!scans.has(file)) scans.set(file, scanFile(root, file)); return scans.get(file); };
  const out = new Map();
  for (const [name, files] of groups) {
    const entries = new Map();
    const add = (e, from) => { if (!allowed.has(e.replace(/^\w+ \| /, '')) && !entries.has(e)) entries.set(e, from); };
    // Its files, and the shared workflow modules they import, and what
    // those import in turn.
    const all = new Set(files);
    const queue = [...files];
    while (queue.length) {
      const f = queue.shift();
      for (const st of scan(f).sf.statements) {
        if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const m = resolve(root, f, st.moduleSpecifier.text, false);
        if (m && m.startsWith(WORKFLOW) && !m.startsWith(`${WORKFLOW}kernel/`) && m !== `${WORKFLOW}platform.ts`
          && ![...groups.keys()].some((g) => m.startsWith(`${WORKFLOW}${g}/`)) && !all.has(m)) {
          all.add(m);
          queue.push(m);
        }
      }
    }
    for (const f of all) {
      const s = scan(f);
      for (const u of s.uses) add(`${roleOf(name, f, u.top)} | uses ${u.module}${u.what}`, `${f}#${u.top}`);
      for (const o of s.own) {
        const role = roleOf(name, f, o.name.split(' ')[0]);
        if (FORBIDDEN.get(role).has(o.kind)) add(`${role} | ${o.kind} ${f}#${o.name}`, f);
      }
      for (const w of s.writes) {
        if (roleOf(name, f, w.top) === 'services' && schema.tables.has(w.table)) add(`services | writes ${w.table}`, `${f}#${w.top}`);
      }
      if (f.endsWith('/services.ts')) for (const n of notifierNames(s.sf)) add(`notifiers | notifier ${n}`, f);
    }
    out.set(name, entries);
  }
  // Other writers of owned columns: SQL anywhere under src/ outside the
  // owning machine's directory, and triggers that assign them.
  const owners = new Map();
  const sources = [...listFiles(root, 'src'), ...(fs.existsSync(path.join(root, 'server.js')) ? ['server.js'] : [])];
  const fragments = sqlFragments(root, sources);
  for (const file of sources) {
    const text = read(root, file);
    if (!/\bUPDATE\b/i.test(text)) continue;
    const sf = parse(root, file);
    const visit = (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const sql = ts.isTemplateExpression(n) ? withFragments(n, fragments) : n.text;
        for (const w of sqlWrites(sql)) {
          if (!w.cols) continue;
          for (const o of schema.owned) {
            if (o.table !== w.table || file.startsWith(`${WORKFLOW}${o.machine}/`)) continue;
            const at = `${file}#${topOf(n)}`;
            if (w.cols.has(o.column)) owners.set(`${o.machine}\u0000ownership | ${o.table}.${o.column} ← ${at}`, at);
            else if (w.cols.has('(dynamic)')) owners.set(`${o.machine}\u0000ownership | ${o.table}.${o.column} ← ${at} (dynamic SET)`, at);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const t of schema.assigning) {
    for (const o of schema.owned) {
      if (o.table === t.table && o.column === t.column) owners.set(`${o.machine}\u0000ownership | ${o.table}.${o.column} ← trigger ${t.trigger}`, 'schema.sql');
    }
  }
  for (const [key, at] of owners) {
    const [machine, entry] = key.split('\u0000');
    if (!out.has(machine)) out.set(machine, new Map());
    out.get(machine).set(entry, at);
  }
  for (const [name, entries] of out) out.set(name, new Map([...entries].sort(([a], [b]) => a.localeCompare(b))));
  return out;
}

const readBaseline = () => JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

module.exports = { boundary, readBaseline, scanFile, sqlWrites, BASELINE, REPO };

if (require.main === module) {
  const baseline = readBaseline();
  const now = boundary(REPO, new Set(Object.keys(baseline.allowed)));
  if (process.argv.includes('--shrink')) {
    let removed = 0;
    for (const [name, list] of Object.entries(baseline.machines)) {
      const kept = list.filter((e) => now.get(name)?.has(e));
      removed += list.length - kept.length;
      baseline.machines[name] = kept;
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`removed ${removed} entr${removed === 1 ? 'y' : 'ies'} no longer there`);
  } else {
    for (const [name, entries] of now) {
      console.log(`\n## ${name} (${entries.size})`);
      for (const [e, from] of entries) console.log(`- ${e}  [${from}]`);
    }
  }
}
