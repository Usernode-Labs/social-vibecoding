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
// tests/baselines/workflow-process-state.json, which holds only what was
// reviewed (allowed, io, handOff).
//   node tests/lib/workflow-boundary.js            what is not reviewed, per machine
//   node tests/lib/workflow-boundary.js --all      everything, per machine
//   node tests/lib/workflow-boundary.js --shrink   drop reviewed entries that
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

// The tables (and the columns an UPDATE sets) a SQL text writes. An UPDATE
// (or an INSERT's ON CONFLICT DO UPDATE) also carries what each column is set
// to (`sets`, column -> its assignment's text) and its WHERE text, which the
// other-writer check reads (a write that leaves the machine's rows alone).
function sqlWrites(text) {
  if (!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(text)) return [];
  const out = [];
  const setList = (set) => {
    const cols = new Set();
    const sets = new Map();
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= set.length; i++) {
      const ch = set[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ',' && depth === 0) || i === set.length) {
        const piece = set.slice(start, i);
        const col = /^\s*(?:[a-z_]+\.)?([a-z_][a-z0-9_]*)\s*=([\s\S]*)$/i.exec(piece);
        if (col) { cols.add(col[1].toLowerCase()); sets.set(col[1].toLowerCase(), col[2]); }
        else if (/^\s*\$x/.test(piece)) cols.add('(dynamic)');
        start = i + 1;
      }
    }
    return { cols, sets };
  };
  for (const m of text.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi)) out.push({ table: m[1].toLowerCase(), cols: null });
  for (const m of text.matchAll(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)[^;]*?\bON\s+CONFLICT\b[^;]*?\bDO\s+UPDATE\s+SET\s+([\s\S]*?)(\bWHERE\b|\bRETURNING\b|;|$)/gi)) {
    const after = text.slice(m.index + m[0].length);
    const where = /^WHERE$/i.test(m[3]) ? after.split(/\bRETURNING\b|;/i)[0] : '';
    out.push({ table: m[1].toLowerCase(), ...setList(m[2]), where });
  }
  for (const m of text.matchAll(/(?<!\bDO\s+)\bUPDATE\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?[a-z_]+)?\s+SET\s+([\s\S]*?)(\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/gi)) {
    const after = text.slice(m.index + m[0].length);
    const where = /^WHERE$/i.test(m[3]) ? after.split(/\bRETURNING\b|;/i)[0] : '';
    out.push({ table: m[1].toLowerCase(), ...setList(m[2]), where });
  }
  return out;
}

// The parts of `text` split on `sep` (a keyword or a character) where no
// parenthesis, quote or CASE is open: a WHERE's top-level conjuncts.
function topLevel(text, sep) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  const re = new RegExp(`^\\s*${sep}\\b`, 'i');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (/\bCASE\b/i.test(text.slice(i, i + 5)) && /\W|^/.test(text[i - 1] || ' ')) depth++;
    else if (/^END\b/i.test(text.slice(i, i + 4)) && /\W/.test(text[i - 1] || ' ')) depth--;
    else if (depth === 0 && /\s/.test(ch) && re.test(text.slice(i))) {
      out.push(text.slice(start, i));
      i += text.slice(i).match(re)[0].length - 1;
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

// Whether an UPDATE leaves alone every row a machine's guard covers, by what
// it says itself:
//  - `@enrolled` guards cover the rows the machine holds, and the write
//    excludes them with the guard's own predicate: a top-level conjunct of
//    its WHERE that is `NOT wf_holds('<m>', '<prefix>' || <the row's id>)`,
//    or the column set to itself where it holds the row
//    (`col = CASE WHEN wf_holds('<m>', '<prefix>' ...) THEN col ...`);
//  - a guard whose `WHEN (OLD.kind IN (...))` names kinds a top-level
//    conjunct of the write's WHERE pins away from (`kind = '<other>'`);
//  - an `@enabled` guard on a move into a value (`NEW.col = 'v'`) the write
//    never sets: every value it assigns is a literal other than 'v', or the
//    row's own column, and nothing else.
// A WHERE with a top-level OR exempts nothing.
function leavesGuardAlone(w, o) {
  const where = w.where || '';
  const conjuncts = topLevel(where, 'OR').length > 1 ? [] : topLevel(where, 'AND');
  const prefixArg = (key) => new RegExp(`^'${o.prefix}'\\s*\\|\\|\\s*(?:[a-z_]+\\.)?(?:id|\\$\\d+)(?:::\\w+)?\\s*$`, 'i').test(key);
  const holdsCall = /^\s*wf_holds\(\s*'([a-z0-9-]+)'\s*,\s*(.+)\)\s*$/i;
  if (o.scope === 'enrolled' && o.prefix) {
    for (const c of conjuncts) {
      const m = /^NOT\s+(wf_holds\(.*\))$/is.exec(c);
      const call = m && holdsCall.exec(m[1]);
      if (call && call[1] === o.machine && prefixArg(call[2].trim())) return true;
    }
    const rhs = w.sets?.get(o.column);
    const self = new RegExp(`^\\s*CASE\\s+WHEN\\s+(wf_holds\\([^)]*\\))\\s+THEN\\s+(?:[a-z_]+\\.)?${o.column}\\s+ELSE\\b`, 'i').exec(rhs || '');
    const call = self && holdsCall.exec(self[1]);
    if (call && call[1] === o.machine && prefixArg(call[2].trim())) return true;
  }
  if (o.kinds) {
    for (const c of conjuncts) {
      const pinned = /^(?:[a-z_]+\.)?kind\s*=\s*'([a-z_]+)'$/i.exec(c);
      if (pinned && !o.kinds.has(pinned[1])) return true;
    }
  }
  if (o.scope === 'enabled' && o.into != null) {
    const rhs = w.sets?.get(o.column);
    if (rhs != null) {
      const plain = rhs.replace(/wf_holds\([^)]*\)/gi, 'TRUE').trim();
      // Each value it can take: the whole of a plain assignment, or each
      // THEN and ELSE of a CASE (up to the next WHEN, ELSE or END).
      const values = /^CASE\b/i.test(plain)
        ? [...plain.matchAll(/\b(?:THEN|ELSE)\s+([\s\S]*?)(?=\s+(?:WHEN|ELSE|END)\b)/gi)].map((m) => m[1].trim())
        : [plain];
      const literal = (v) => /^'([^']*)'$/.exec(v);
      const own = (v) => new RegExp(`^(?:${w.table}\\.)?${o.column}$`, 'i').test(v);
      if (values.length && values.every((v) => (literal(v) ? literal(v)[1] !== o.into : own(v)))) return true;
    }
  }
  return false;
}

// SQL text a template interpolates by name: a module's string constant
// (`const INVALIDATE_SQL = \`...\``) or a function that returns one template
// (`function invalidateHeadMoveSql(p) { ... return \`...\`; }`). An UPDATE's
// SET list built from one is read with the fragment's own columns rather than
// as "every column", but only where the name can only mean that fragment:
// defined in the same file or in a module the file requires or imports, and
// not declared anywhere else in the file (a local of the same name is not
// the fragment). Anything else stays "dynamic", counted as every column.
function templateText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((x) => x.literal.text)].join(' $x ');
  return null;
}
function sqlFragments(root, files) {
  const found = new Map();   // name -> Map(file -> text)
  const add = (name, text) => {
    if (text == null) return;
    if (!found.has(name)) found.set(name, new Map());
    found.get(name).set(currentFile, text);
  };
  let currentFile = null;
  for (const file of files) {
    const text = read(root, file);
    if (!/\b(SET|UPDATE)\b|=/.test(text)) continue;
    currentFile = file;
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
// What one file can mean by a fragment's name: the modules it requires or
// imports, and the names it declares locally other than as a top-level
// fragment or a binding from one of those modules.
function fragmentScope(root, file, sf) {
  const modules = new Set([file]);
  const locals = new Set();
  const fromModule = (init) => {
    let e = init;
    while (e && (ts.isPropertyAccessExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
    return !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require';
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require'
      && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const m = resolve(root, file, n.arguments[0].text, false);
      if (m) modules.add(m);
    }
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const m = resolve(root, file, n.moduleSpecifier.text, false);
      if (m) modules.add(m);
    }
    const top = n.parent && ts.isVariableDeclarationList(n.parent) && n.parent.parent && ts.isVariableStatement(n.parent.parent)
      && n.parent.parent.parent === sf;
    if (ts.isVariableDeclaration(n) && !(top && ts.isIdentifier(n.name) && n.initializer && (templateText(n.initializer) != null || fromModule(n.initializer)))
      && !(n.initializer && fromModule(n.initializer))) {
      const names = ts.isIdentifier(n.name) ? [n.name.text] : [];
      for (const x of names) locals.add(x);
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) locals.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { modules, locals };
}

// A template's text, its spans replaced by the fragment they name, else $x.
function withFragments(node, fragments, scope) {
  const nameOf = (e) => {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isCallExpression(e)) return nameOf(e.expression);
    return null;
  };
  const fragment = (name) => {
    if (!name || !scope || scope.locals.has(name)) return null;
    const texts = [...(fragments.get(name) || new Map())].filter(([file]) => scope.modules.has(file)).map(([, t]) => t);
    return texts.length && texts.every((t) => t === texts[0]) ? texts[0] : null;
  };
  let out = node.head.text;
  for (const span of node.templateSpans) {
    const frag = fragment(nameOf(span.expression));
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
    const scope = /^@(enrolled|enabled)=([a-z0-9-]+)(?:\/([a-z_:]+))?/.exec(args[0] || '');
    if (!scope) continue;
    // What the guard's WHEN limits it to: kinds, or a move into one value.
    const when = /\bWHEN\s*\(([\s\S]*?)\)\s*EXECUTE\b/i.exec(m[0])?.[1] || '';
    const kindList = /\bOLD\.kind\s+IN\s*\(([^)]*)\)/i.exec(when);
    const kinds = kindList ? new Set([...kindList[1].matchAll(/'([^']*)'/g)].map((k) => k[1])) : null;
    for (const a of args.slice(1).filter((x) => !x.startsWith('@'))) {
      const column = a.split('.')[0];
      const into = new RegExp(`\\bNEW\\.${column}\\s*=\\s*'([^']*)'`, 'i').exec(when)?.[1] ?? null;
      owned.push({ machine: scope[2], table: m[2].toLowerCase(), column, scope: scope[1], prefix: scope[3] || null, kinds, into });
    }
  }
  const fns = new Map();
  for (const m of schema.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(\s*\)\s+RETURNS\s+TRIGGER\s+AS\s+\$\$([\s\S]*?)\$\$/gi)) {
    fns.set(m[1].toLowerCase(), new Set([...m[2].matchAll(/NEW\.([a-z_][a-z0-9_]*)\s*:=/gi)].map((x) => x[1].toLowerCase())));
  }
  // Triggers that assign a column on an UPDATE. One that fires on INSERT only
  // fills a new row, which no machine holds yet and no guard covers (the
  // guards are BEFORE UPDATE): it is not another writer of an owned column.
  // A trigger dropped further down the schema is gone.
  const assigning = [];
  for (const m of schema.matchAll(/CREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s+BEFORE\s+(INSERT|UPDATE)(?:\s+OF\s+[^;]*?)?(?:\s+OR\s+(INSERT|UPDATE))?\s+ON\s+([a-z_][a-z0-9_]*)[^;]*?EXECUTE\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(/gi)) {
    if (![m[2], m[3]].some((e) => e && e.toUpperCase() === 'UPDATE')) continue;
    const dropped = new RegExp(`DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${m[1]}\\s+ON\\s+${m[4]}\\s*;(?![\\s\\S]*CREATE\\s+TRIGGER\\s+${m[1]}\\b)`, 'i');
    if (dropped.test(schema.slice(m.index + m[0].length))) continue;
    for (const col of fns.get(m[5].toLowerCase()) || []) assigning.push({ trigger: m[1], table: m[4].toLowerCase(), column: col });
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

// A shared workflow module (outside every machine's folder, not rules/) has
// the roles of the parts that import it, through any chain of shared
// modules: a GitHub helper only work handlers import is their I/O, held to
// what a work handler may do; one a transition imports is held to what a
// transition may do.
function roleOf(name, file, top, inherited = null) {
  if (name === 'kernel') return ['kernel'];
  if (name === 'platform') return ['web'];
  if (file.startsWith(RULES)) return ['rules'];
  if (!file.startsWith(`${WORKFLOW}${name}/`)) return [...(inherited?.get(file) || ['shared'])];
  if (!file.endsWith('/services.ts')) return ['decider'];
  return [top.endsWith('Notifiers') ? 'notifiers' : 'services'];
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
    const inherited = new Map();   // shared module -> the roles of its importers
    const fileRoles = (f) => (f.startsWith(`${WORKFLOW}${name}/`) || name === 'platform' || name === 'kernel' || f.startsWith(RULES)
      ? roleOf(name, f, '').map((r) => (r === 'notifiers' ? 'services' : r)) : [...(inherited.get(f) || [])]);
    const queue = [...files];
    while (queue.length) {
      const f = queue.shift();
      for (const st of scan(f).sf.statements) {
        if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const m = resolve(root, f, st.moduleSpecifier.text, false);
        if (m && m.startsWith(WORKFLOW) && !m.startsWith(`${WORKFLOW}kernel/`) && m !== `${WORKFLOW}platform.ts`
          && ![...groups.keys()].some((g) => m.startsWith(`${WORKFLOW}${g}/`))) {
          if (!m.startsWith(RULES)) {
            if (!inherited.has(m)) inherited.set(m, new Set());
            const had = inherited.get(m).size;
            for (const r of fileRoles(f)) inherited.get(m).add(r);
            if (all.has(m) && inherited.get(m).size > had) queue.push(m);
          }
          if (!all.has(m)) { all.add(m); queue.push(m); }
        }
      }
    }
    for (const f of all) {
      const s = scan(f);
      for (const u of s.uses) for (const role of roleOf(name, f, u.top, inherited)) add(`${role} | uses ${u.module}${u.what}`, `${f}#${u.top}`);
      for (const o of s.own) {
        for (const role of roleOf(name, f, o.name.split(' ')[0], inherited)) {
          if (FORBIDDEN.get(role).has(o.kind)) add(`${role} | ${o.kind} ${f}#${o.name}`, f);
        }
      }
      for (const w of s.writes) {
        if (roleOf(name, f, w.top, inherited).includes('services') && schema.tables.has(w.table)) add(`services | writes ${w.table}`, `${f}#${w.top}`);
      }
      if (f.endsWith('/services.ts')) for (const n of notifierNames(s.sf)) add(`notifiers | notifier ${n}`, f);
    }
    out.set(name, entries);
  }
  // Other writers of owned columns: SQL anywhere under src/ outside the
  // owning machine's directory, and triggers that assign them. A machine
  // whose own guard owns the same column is a co-owner, not another writer
  // (proposal and merge-followups each own a move of chat_sessions.status).
  const owners = new Map();
  const ownsToo = (file, table, column) => schema.owned.some((x) => x.table === table && x.column === column
    && file.startsWith(`${WORKFLOW}${x.machine}/`));
  const sources = [...listFiles(root, 'src'), ...(fs.existsSync(path.join(root, 'server.js')) ? ['server.js'] : [])];
  const fragments = sqlFragments(root, sources);
  for (const file of sources) {
    const text = read(root, file);
    if (!/\bUPDATE\b/i.test(text)) continue;
    const sf = parse(root, file);
    const scope = fragmentScope(root, file, sf);
    const visit = (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
        const sql = ts.isTemplateExpression(n) ? withFragments(n, fragments, scope) : n.text;
        for (const w of sqlWrites(sql)) {
          if (!w.cols) continue;
          for (const o of schema.owned) {
            if (o.table !== w.table || file.startsWith(`${WORKFLOW}${o.machine}/`) || ownsToo(file, o.table, o.column)) continue;
            if (leavesGuardAlone(w, o)) continue;
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

module.exports = { boundary, readBaseline, scanFile, sqlWrites, leavesGuardAlone, BASELINE, REPO };

if (require.main === module) {
  const baseline = readBaseline();
  const now = boundary(REPO, new Set(Object.keys(baseline.allowed)));
  if (process.argv.includes('--shrink')) {
    let removed = 0;
    for (const section of ['io', 'handOff']) {
      for (const [name, entries] of Object.entries(baseline[section] || {})) {
        for (const entry of Object.keys(entries)) {
          if (now.get(name)?.has(entry)) continue;
          delete entries[entry];
          removed += 1;
        }
        if (!Object.keys(entries).length) delete baseline[section][name];
      }
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`removed ${removed} entr${removed === 1 ? 'y' : 'ies'} no longer there`);
  } else {
    // What is not reviewed yet: the entries neither io nor handOff names.
    const reviewed = (name, e) => ['io', 'handOff'].some((k) => Object.prototype.hasOwnProperty.call(baseline[k]?.[name] || {}, e));
    for (const [name, entries] of now) {
      const open = [...entries].filter(([e]) => process.argv.includes('--all') || !reviewed(name, e));
      if (!open.length) continue;
      console.log(`\n## ${name} (${open.length})`);
      for (const [e, from] of open) console.log(`- ${e}  [${from}]`);
    }
  }
}
