'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../frontend'), __dirname] }));

// Register server-authored error copy at the HTTP boundary. Error codes and
// arbitrary upstream/user text stay data; only these exact templates translate.
function serverMessages(root) {
  const messages = {};
  function collect(node) {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!/[A-Za-z]/.test(node.text) || /^[a-z0-9_-]+$/.test(node.text)) return;
      add(node.text);
    } else if (ts.isTemplateExpression(node)) {
      add(node.head.text + node.templateSpans.map((span, i) => `{{value${i + 1}}}${span.literal.text}`).join(''));
    } else if (ts.isParenthesizedExpression(node)) collect(node.expression);
    else if (ts.isConditionalExpression(node)) { collect(node.whenTrue); collect(node.whenFalse); }
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      collect(node.left); collect(node.right);
    }
  }
  function add(text) {
    const key = 'error_' + createHash('sha256').update(text).digest('hex').slice(0, 16);
    messages[key] = text;
  }
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('admin')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isPropertyAssignment(node) && node.name.getText(tree).replace(/['"]/g, '') === 'error') collect(node.initializer);
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
  }
  walk(path.join(root, 'src/routes'));
  walk(path.join(root, 'src/middleware'));
  return Object.fromEntries(Object.entries(messages).sort(([a], [b]) => a.localeCompare(b)));
}

function checkServerMessages(root) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'frontend/locales/en/server.json'), 'utf8'));
  const missing = Object.entries(serverMessages(root)).filter(([key, text]) => source[key] !== text);
  if (missing.length) throw new Error('Register and translate new HTTP errors in server.json:\n' + missing.map(([key, text]) => `${key}: ${text}`).join('\n'));
}
if (require.main === module) {
  const root = path.join(__dirname, '..');
  if (process.argv.includes('--extract')) {
    const file = path.join(root, 'frontend/locales/en/server.json');
    fs.writeFileSync(file, JSON.stringify(serverMessages(root), null, 2) + '\n');
  } else checkServerMessages(root);
}
module.exports = { serverMessages, checkServerMessages };
