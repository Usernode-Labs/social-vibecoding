'use strict';

// What the catalogs do not hold yet, and whether the code and the catalogs
// agree about what they do hold.
//
//   node scripts/language-inventory.js --ids       message ids used in code
//   node scripts/language-inventory.js --literals  English still written in code
//
// --ids is exact and is an authoring check: an id the code asks for that no
// catalog defines is a mistake in the change, so tests/language-packs.test.js
// fails on it. Entries nothing asks for are listed, not failed.
//
// --literals is a REPORT, never a gate. It reads the client sources and lists
// text that looks like interface English: JSX text, the attributes a person
// sees or hears (aria-label, title, placeholder, alt), and prose-like string
// literals, less the entries in frontend/locales/literal-allowlist.json. It
// is a heuristic over syntax: it is how the extraction was driven and how the
// remainder is counted, and it would be wrong often enough as a build
// failure to teach people to silence it.
//
// The admin console is outside the language runtime (frontend/locales/README.md),
// so frontend/src/features/admin is not read.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TREES = ['frontend/src', 'frontend/@/components/ui', 'public/js'];
const SKIP = [
  /^frontend\/src\/features\/admin\//,
  /^frontend\/src\/lib\/i18n\//,
  /\.generated\./,
  /\.d\.ts$/,
  /\.test\.[jt]sx?$/,
];
const SOURCE = /\.(tsx?|jsx?|mjs|cjs)$/;

function walk(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (SOURCE.test(entry.name)) found.push(full);
  }
  return found;
}

function sourceFiles(root = ROOT) {
  const files = [];
  for (const tree of TREES) {
    const directory = path.join(root, tree);
    if (!fs.existsSync(directory)) continue;
    for (const file of walk(directory)) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (!SKIP.some((pattern) => pattern.test(relative))) files.push(relative);
    }
  }
  return files.sort();
}

function readEnglish(root = ROOT) {
  const directory = path.join(root, 'frontend/locales/en');
  const english = {};
  for (const name of fs.readdirSync(directory).filter((file) => file.endsWith('.json')).sort()) {
    english[name.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  }
  return english;
}

// ── --ids ────────────────────────────────────────────────────────────────

const PLURAL = /_(zero|one|two|few|many|other)$/;

/**
 * Every `namespace:key` literal in the client sources. A message id is always
 * written whole, with its namespace and at least one dot in the key, so it
 * can be found here and never collides with an event name such as
 * `home:refresh`.
 */
function usedIds(root = ROOT, files = sourceFiles(root)) {
  const namespaces = Object.keys(readEnglish(root));
  if (!namespaces.length) return [];
  const pattern = new RegExp(
    `(['"\`])((?:${namespaces.join('|')}):[A-Za-z][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9_-]+)+)\\1`, 'g',
  );
  const used = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(pattern)) {
      used.push({ id: match[2], file, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return used;
}

function checkIds(root = ROOT) {
  const english = readEnglish(root);
  const defined = (id) => {
    const [namespace, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const catalog = english[namespace] || {};
    return key in catalog || (`${key}_one` in catalog && `${key}_other` in catalog);
  };
  const used = usedIds(root);
  const unknown = used.filter(({ id }) => !defined(id));
  // The runtime's own: lib/i18n is not read above, and core.ts joins lists with it.
  const asked = new Set([...used.map(({ id }) => id), 'core:list.pair']);
  const unused = [];
  for (const [namespace, catalog] of Object.entries(english)) {
    for (const key of Object.keys(catalog)) {
      if (!asked.has(`${namespace}:${key}`) && !asked.has(`${namespace}:${key.replace(PLURAL, '')}`)) {
        unused.push(`${namespace}:${key}`);
      }
    }
  }
  return { used: used.length, unknown, unused };
}

// ── --literals ───────────────────────────────────────────────────────────

const SPOKEN_ATTRIBUTES = new Set([
  'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder', 'aria-valuetext',
  'title', 'placeholder', 'alt', 'label',
]);
// Calls whose string arguments are never shown to a person.
const SILENT_CALLS = /^(console\.\w+|require|import|Error|TypeError|RangeError|querySelector|querySelectorAll|getElementById|closest|matches|getAttribute|setAttribute|removeAttribute|hasAttribute|addEventListener|removeEventListener|dispatchEvent|CustomEvent|Event|classList\.\w+|getItem|setItem|removeItem|createElement|createElementNS|log\.\w+|fetch|test|it|describe|Symbol|RegExp|includes|startsWith|endsWith|indexOf|split|replace|replaceAll|match|cn|clsx|cva|t|translate|htmlText|htmlRich|useMessages|getFixedT|registerNamespace|ensureNamespace)$/;
const SILENT_ATTRIBUTES = /^(class|className|id|key|href|src|style|type|role|name|value|d|viewBox|fill|stroke|points|transform|width|height|rel|target|method|action|autoComplete|autoCapitalize|inputMode|htmlFor|for|lang|dir|slot|variant|size|ink|layout|tone|as|data-.*|aria-(controls|labelledby|describedby|haspopup|expanded|current|hidden|live|pressed|selected|checked|owns|activedescendant|modal|busy|atomic|relevant|orientation|sort|invalid|required|disabled|readonly|multiline|autocomplete))$/;

const WORD = /[A-Za-z]{2,}/;
/** Prose, as opposed to an identifier, a selector, a class list or a URL. */
function looksLikeProse(text) {
  const value = text.trim();
  if (!WORD.test(value)) return false;
  if (/^(https?:|\/|#|\.|data:|--)/.test(value)) return false;
  if (/^[a-z0-9_.:/#@[\]=>~+*,()'"|^$\\-]+$/.test(value) && !/\s/.test(value)) return false;
  // Class lists and other space-separated identifiers: no capital, no sentence end.
  if (!/[A-Z]/.test(value) && !/[.!?…:]$/.test(value)) return false;
  // Starts like a sentence or a label, or ends like one.
  return /^[^A-Za-z]*[A-Z][a-z]/.test(value) || /[a-z][.!?…]$/.test(value);
}

/** The words a person would read in a string that builds HTML. */
function htmlProse(text) {
  const found = [];
  for (const match of text.matchAll(/\b(aria-label|title|placeholder|alt)="([^"$<>]*[A-Za-z]{2,}[^"<>]*)"/g)) {
    found.push(match[2]);
  }
  const stripped = text.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]*>/g, '\u0000');
  for (const part of stripped.split('\u0000')) {
    const value = part.replace(/\$\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{3,}/.test(value) && /[A-Z]|[a-z] [a-z]/.test(value)) found.push(value);
  }
  return found;
}

function literalsIn(file, text, ts) {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const report = (node, value, how) => {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    found.push({
      file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: clean, how,
    });
  };
  const calleeName = (node) => {
    const callee = node.expression;
    if (!callee) return '';
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) {
      const owner = ts.isIdentifier(callee.expression) ? callee.expression.text : '';
      return /^(console|log|classList)$/.test(owner) ? `${owner}.${callee.name.text}` : callee.name.text;
    }
    return '';
  };
  const templateText = (node) => (ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : [node.head.text, ...node.templateSpans.map((span) => `\${…}${span.literal.text}`)].join(''));

  const visit = (node, silent) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)
        || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      if (WORD.test(node.text)) report(node, node.text, 'text');
      return;
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (SILENT_ATTRIBUTES.test(name) && !SPOKEN_ATTRIBUTES.has(name)) return;
      const spoken = SPOKEN_ATTRIBUTES.has(name);
      const value = node.initializer;
      if (value && ts.isStringLiteral(value)) {
        if (spoken ? WORD.test(value.text) : looksLikeProse(value.text)) report(value, value.text, name);
        return;
      }
      if (value) visit(value, false);
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const quiet = SILENT_CALLS.test(calleeName(node));
      visit(node.expression, silent);
      for (const argument of node.arguments || []) visit(argument, silent || quiet);
      return;
    }
    if (ts.isThrowStatement(node)) return;
    if (ts.isBinaryExpression(node) && /^(===|!==|==|!=)$/.test(node.operatorToken.getText(source))) return;
    // A component's name for React DevTools, not for a person.
    if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)
        && node.left.name.text === 'displayName') return;
    if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
      if (node.initializer) visit(node.initializer, silent);
      return;
    }
    if (ts.isCaseClause(node)) {
      for (const statement of node.statements) visit(statement, silent);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      visit(node.expression, silent);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      if (!silent) {
        const value = ts.isStringLiteral(node) ? node.text : templateText(node);
        if (value.includes('<') && /<\/?[a-z][^>]*>/i.test(value)) {
          for (const prose of htmlProse(value)) report(node, prose, 'html');
        } else if (looksLikeProse(value)) report(node, value, 'string');
      }
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) visit(span.expression, silent);
      }
      return;
    }
    ts.forEachChild(node, (child) => visit(child, silent));
  };
  visit(source, false);
  return found;
}

function readAllowlist(root = ROOT) {
  const file = path.join(root, 'frontend/locales/literal-allowlist.json');
  if (!fs.existsSync(file)) return { everywhere: [], files: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    everywhere: (data.everywhere || []).map((entry) => new RegExp(entry.pattern)),
    files: Object.fromEntries(Object.entries(data.files || {}).map(([name, entry]) => [
      name, entry.all ? null : new Set((entry.texts || [])),
    ])),
  };
}

function remainingLiterals(root = ROOT, files = sourceFiles(root)) {
  // The root package's own TypeScript, or the frontend's when only that is installed.
  // eslint-disable-next-line global-require
  const ts = require(require.resolve('typescript', { paths: [root, path.join(root, 'frontend')] }));
  const allow = readAllowlist(root);
  const remaining = [];
  for (const file of files) {
    if (file in allow.files && allow.files[file] === null) continue;
    const texts = allow.files[file];
    for (const literal of literalsIn(file, fs.readFileSync(path.join(root, file), 'utf8'), ts)) {
      if (allow.everywhere.some((pattern) => pattern.test(literal.text))) continue;
      if (texts && texts.has(literal.text)) continue;
      remaining.push(literal);
    }
  }
  return remaining;
}

function summarize(literals) {
  const byFile = new Map();
  for (const literal of literals) byFile.set(literal.file, (byFile.get(literal.file) || 0) + 1);
  return [...byFile.entries()].sort((a, b) => b[1] - a[1]);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--ids')) {
    const { used, unknown, unused } = checkIds();
    for (const { id, file, line } of unknown) console.error(`${file}:${line}: no catalog entry for ${id}`);
    if (args.includes('--unused')) for (const id of unused) console.log(`unused: ${id}`);
    console.log(`[language-inventory] ${used} message id use(s); ${unknown.length} unknown; ${unused.length} entr${unused.length === 1 ? 'y' : 'ies'} nothing asks for`);
    if (unknown.length) process.exitCode = 1;
  } else if (args.includes('--literals')) {
    const only = args.filter((arg) => !arg.startsWith('--'));
    const files = sourceFiles().filter((file) => !only.length || only.some((prefix) => file.startsWith(prefix)));
    const literals = remainingLiterals(ROOT, files);
    if (args.includes('--summary')) {
      for (const [file, count] of summarize(literals)) console.log(`${String(count).padStart(5)}  ${file}`);
    } else {
      for (const { file, line, text, how } of literals) console.log(`${file}:${line}: [${how}] ${JSON.stringify(text)}`);
    }
    console.log(`[language-inventory] ${literals.length} literal(s) that look like interface English in ${files.length} file(s)`);
  } else {
    console.error('usage: node scripts/language-inventory.js --ids [--unused] | --literals [--summary] [path prefix…]');
    process.exitCode = 2;
  }
}

module.exports = { sourceFiles, usedIds, checkIds, remainingLiterals, literalsIn, looksLikeProse };
