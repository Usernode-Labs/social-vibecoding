'use strict';

// Syntax-aware checks run independently of a proposal's editable dapp tests.
// Raw JSX and DOM-writer text is not made safe by an English fallback catalog.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const TEXT_PROPERTIES = new Set(['title', 'placeholder', 'alt', 'aria-label', 'aria-description',
  'aria-valuetext', 'textContent', 'innerText', 'label', 'description', 'message', 'error']);
const literalText = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
  ? node.text : null;
const human = value => typeof value === 'string' && /\p{L}/u.test(value);

function scanFile(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const add = (node, text, kind) => {
    if (!human(text)) return;
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    findings.push({ file, line: line + 1, text: text.replace(/\s+/g, ' ').trim(), kind });
  };
  function visit(node) {
    if (ts.isJsxElement(node) && ['code', 'pre', 'script', 'style'].includes(node.openingElement.tagName.getText(tree))) return;
    if (ts.isJsxText(node)) add(node, node.text, 'JSX text');
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      const text = literalText(node.expression);
      if (text != null) add(node.expression, text, 'JSX text expression');
    }
    if (ts.isJsxAttribute(node) && TEXT_PROPERTIES.has(node.name.getText(tree))) {
      const value = node.initializer && (ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer);
      if (value) add(value, literalText(value), 'UI attribute');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && TEXT_PROPERTIES.has(node.left.name.text)) {
      add(node.right, literalText(node.right), 'DOM text assignment');
    }
    if (ts.isCallExpression(node) && ['alert', 'confirm', 'prompt'].includes(node.expression.getText(tree))) {
      if (node.arguments[0]) add(node.arguments[0], literalText(node.arguments[0]), 'dialog text');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

function scanTree(root) {
  const findings = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (relative.startsWith('frontend/src/features/admin/')) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (/\.[jt]sx?$/.test(entry.name)) findings.push(...scanFile(relative, fs.readFileSync(absolute, 'utf8')));
    }
  }
  for (const directory of ['frontend/src', 'frontend/@/components/ui', 'public/js']) walk(path.join(root, directory));
  return findings;
}

if (require.main === module) {
  const findings = scanTree(path.join(__dirname, '..'));
  if (process.argv.includes('--inventory')) console.log(JSON.stringify(findings, null, 2));
  else {
    for (const row of findings) console.error(`${row.file}:${row.line}: Unregistered ${row.kind}: ${row.text}`);
    if (findings.length) process.exitCode = 1;
    console.log(`${findings.length} untranslated UI literals`);
  }
}
module.exports = { scanFile, scanTree };
