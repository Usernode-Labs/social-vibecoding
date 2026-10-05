'use strict';

// Syntax-aware checks run independently of a proposal's editable dapp tests.
// Raw JSX and DOM-writer text is not made safe by an English fallback catalog.
const fs = require('node:fs');
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../frontend'), __dirname] }));

const TEXT_PROPERTIES = new Set(['title', 'placeholder', 'alt', 'aria-label', 'aria-description',
  'aria-valuetext', 'textContent', 'innerText', 'label', 'description', 'message', 'error', 'subtitle', 'heading',
  'confirmLabel', 'cancelLabel', 'actionLabel', 'emptyText', 'buttonLabel', 'statusText']);
const textProperty = name => TEXT_PROPERTIES.has(name) || /(?:Label|Placeholder|Heading|Description|Message|Tooltip|HelpText|EmptyText)$/.test(name);
const literalText = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
  ? node.text : null;
const human = value => typeof value === 'string' && /\p{L}/u.test(value.replace(/&(?:[a-z]+|#(?:x[0-9a-f]+|[0-9]+));/gi, ''));
const isMessageKey = text => /^[a-z]+:[a-z0-9_.]+$/.test(text);


function scanFile(file, source, catalogs) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const add = (node, text, kind) => {
    // Version identifiers use v<number> in every language, like HTTP codes.
    if (text === 'v' && ts.isTemplateExpression(node) && node.head.text === 'v'
        && node.templateSpans.length === 1 && node.templateSpans[0].literal.text === '') return;
    if (!human(text) || /^HTTP\s*$/.test(text) || isMessageKey(text) || /^[/#]/.test(text) || /^[a-z]+(?:-[a-z]+)+$/.test(text)) return;
    const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
    findings.push({ file, line: line + 1, text: text.replace(/\s+/g, ' ').trim(), kind });
  };
  function values(node, kind) {
    if (!node) return;
    const text = literalText(node);
    if (text != null) { add(node, text, kind); return; }
    if (ts.isParenthesizedExpression(node)) values(node.expression, kind);
    else if (ts.isConditionalExpression(node)) { values(node.whenTrue, kind); values(node.whenFalse, kind); }
    else if (ts.isBinaryExpression(node)) {
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) values(node.left, kind);
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) values(node.right, kind);
    } else if (ts.isTemplateExpression(node)) {
      const raw = node.head.text + node.templateSpans.map(span => span.literal.text).join('');
      add(node, raw, kind);
    }
  }
  function htmlText(node, value) {
    // Angle-bracket placeholders in agent prompts and developer errors are
    // not HTML. Require a complete element or a real void element.
    if (!/<\/[a-z][^>]*>|<(?:input|img|area|br|hr|source|track|wbr)\b[^>]*>/i.test(value)) return;
    const markup = value.replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    for (const part of markup.matchAll(/>([^<>]+)</g)) add(node, part[1], 'HTML text');
    for (const part of markup.matchAll(/\b(?:title|placeholder|aria-label|aria-description|alt)\s*=\s*["']([^"']+)["']/g)) {
      add(node, part[1], 'HTML attribute');
    }
  }
  function translationKey(node) {
    let expression = node;
    while (expression.parent && (ts.isConditionalExpression(expression.parent)
      || ts.isParenthesizedExpression(expression.parent))) expression = expression.parent;
    const parent = expression.parent;
    if (parent && ts.isCallExpression(parent) && parent.arguments[0] === expression) {
      return /^(?:tr|catalogText|(?:window|globalThis)\.PlatformI18n\.(?:t|htmlText))$/.test(parent.expression.getText(tree));
    }
    if (parent && ts.isJsxExpression(parent)) expression = parent;
    const attribute = expression.parent;
    if (attribute && ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === 'id') {
      const element = attribute.parent.parent;
      return (ts.isJsxSelfClosingElement(element) || ts.isJsxOpeningElement(element))
        && ['Message', 'RichMessage'].includes(element.tagName.getText(tree));
    }
    return false;
  }
  function visit(node) {
    if (ts.isTemplateExpression(node) && (translationKey(node)
        || (catalogs && /^[a-z]+:[a-z][a-z0-9_.]*$/.test(node.head.text) && Object.hasOwn(catalogs, node.head.text.split(':')[0])))) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      findings.push({ file, line: line + 1, text: node.getText(tree), kind: 'computed message key; use complete literal keys' });
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) htmlText(node, node.text);
    if (ts.isTemplateExpression(node)) htmlText(node, node.head.text + node.templateSpans.map(span => '0' + span.literal.text).join(''));

    if (catalogs && ts.isStringLiteral(node) && /^[a-z]+:[a-z0-9_.]+$/.test(node.text)) {
      const [namespace, key] = node.text.split(':');
      if ((!catalogs[namespace] && translationKey(node))
          || (catalogs[namespace] && !Object.hasOwn(catalogs[namespace], key)
          && !Object.hasOwn(catalogs[namespace], key + '_other'))) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        findings.push({ file, line: line + 1, text: node.text, kind: 'unknown message key' });
      }
    }
    if (ts.isJsxElement(node) && ['code', 'pre', 'script', 'style'].includes(node.openingElement.tagName.getText(tree))) return;
    if (ts.isJsxText(node)) add(node, node.text, 'JSX text');
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxElement(node.parent)) {
      values(node.expression, 'JSX text expression');
    }
    if (ts.isJsxAttribute(node) && (textProperty(node.name.getText(tree)) || node.name.getText(tree) === 'sub')) {
      const value = node.initializer && (ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer);
      values(value, 'UI attribute');
    }
    if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'render'
        && ts.isJsxSelfClosingElement(node.parent.parent)
        && node.parent.parent.tagName.getText(tree) === 'LocalizedValue') {
      const fn = node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression;
      if (fn && ts.isArrowFunction(fn)) values(fn.body, 'localized text expression');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && textProperty(node.left.name.text)) {
      values(node.right, 'DOM text assignment');
    }
    if (ts.isPropertyAssignment(node) && textProperty(node.name.getText(tree).replace(/^['"]|['"]$/g, ''))) {
      values(node.initializer, 'UI message property');
    }
    if (ts.isCallExpression(node) && /^(?:(?:window|globalThis)\.)?(?:alert|confirm|prompt|toast|showError|showMessage|setError|setMessage|setNotice|showEntry|showResult)$/.test(node.expression.getText(tree))) {
      values(node.arguments[0], 'dialog or feedback text');
    }
    if (ts.isCallExpression(node) && /^(?:tr|catalogText|(?:window|globalThis)\.PlatformI18n\.(?:t|htmlText))$/.test(node.expression.getText(tree))
        && node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const property of node.arguments[1].properties) {
        if (ts.isPropertyAssignment(property) && /^(?:value\d+|label|kind|message)$/.test(property.name.getText(tree))) {
          values(property.initializer, 'message parameter text');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

function scanTree(root) {
  const findings = [];
  const directory = path.join(root, 'frontend/locales/en');
  const catalogs = Object.fromEntries(fs.readdirSync(directory).filter(name => name.endsWith('.json'))
    .map(name => [name.slice(0, -5), JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))]));
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (relative.startsWith('frontend/src/features/admin/')) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (/\.[jt]sx?$/.test(entry.name)) findings.push(...scanFile(relative, fs.readFileSync(absolute, 'utf8'), catalogs));
    }
  }
  for (const directory of ['frontend/src', 'frontend/@/components/ui', 'public/js']) walk(path.join(root, directory));
  for (const file of ['public/cli-authorize.html', 'public/connect-authorize.html']) {
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute)) findings.push(...scanHtml(file, fs.readFileSync(absolute, 'utf8'), catalogs));
  }
  return findings;
}

// The two consent documents are ordinary user surfaces outside React. Their
// text must have an explicit catalog owner; arbitrary DOM or user content is
// never searched/replaced. Keep this separate from the generated shell.
function scanHtml(file, source, catalogs) {
  const findings = [], stack = [];
  const masked = source.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    match => match.replace(/[^\n]/g, ' '));
  const add = (index, text, kind) => findings.push({ file, line: source.slice(0, index).split('\n').length, text: text.trim(), kind });
  for (const token of masked.matchAll(/<[^>]*>|[^<]+/g)) {
    const value = token[0];
    if (value.startsWith('</')) { stack.pop(); continue; }
    if (value.startsWith('<!')) continue;
    if (value.startsWith('<')) {
      const name = /^<([\w-]+)/.exec(value)?.[1];
      if (!name) continue;
      const key = /\bdata-message=["']([^"']+)["']/.exec(value)?.[1];
      if (key) {
        const [ns, id] = key.split(':');
        if (!catalogs?.[ns]?.[id]) add(token.index, key, 'unknown message key');
      }
      for (const attribute of value.matchAll(/\b(?:title|placeholder|aria-label|aria-description|alt)=["']([^"']+)["']/g)) {
        if (human(attribute[1])) add(token.index, attribute[1], 'HTML attribute');
      }
      if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)
          && !value.endsWith('/>')) stack.push({ name, key });
    } else if (human(value) && !stack.some(parent => parent.key || ['pre', 'code'].includes(parent.name))) {
      add(token.index, value.replace(/\s+/g, ' '), 'HTML text');
    }
  }
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
function checkMessages(root) {
  const findings = scanTree(root);
  if (findings.length) throw new Error(findings.map(row => `${row.file}:${row.line}: Unregistered ${row.kind}: ${row.text}`).join('\n'));
  return findings;
}
module.exports = { scanFile, scanHtml, scanTree, checkMessages };
