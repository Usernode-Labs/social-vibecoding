'use strict';

// Existing structural source tests also pin English copy. Resolve just the
// localization boundary for those assertions: the surrounding handlers,
// selectors and expressions remain the shipped source. Runtime and translated
// rendering are tested separately; this is never passed to vm or eval.
const fs = require('node:fs');
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../../frontend')] }));
const directory = path.join(__dirname, '../../frontend/locales/en');
const catalogs = Object.fromEntries(fs.readdirSync(directory).filter(f => f.endsWith('.json'))
  .map(f => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8'))]));
function message(key) {
  const [namespace, name] = key.includes(':') ? key.split(':') : ['core', key];
  return catalogs[namespace]?.[name] ?? catalogs[namespace]?.[name + '_other'];
}
const quote = value => value.includes("'") ? JSON.stringify(value) : "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";

const cache = new Map();
function englishUiSource(source) {
  if (cache.has(source)) return cache.get(source);
  if (typeof source !== 'string' || !/(?:Message|Localized|catalogText|PlatformI18n|\btr\()/.test(source)) return source;
  const tree = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const attr = (node, key) => {
    const a = node.attributes.properties.find(p => p.name?.getText(tree) === key);
    if (!a?.initializer) return null;
    return ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
  };
  const value = node => node && ts.isStringLiteral(node) ? node.text : '';
  const params = node => node && ts.isObjectLiteralExpression(node)
    ? Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).map(p => [p.name.getText(tree), render(p.initializer)])) : {};
  const interpolate = (text, options, jsx) => text.replace(/{{\s*(\w+)\s*}}/g, (all, key) => options[key]
    ? (jsx ? '{' + options[key] + '}' : '${' + options[key] + '}') : all);
  function render(node) {
    if (ts.isTemplateExpression(node)) {
      let changed = false;
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const expression = render(span.expression);
        changed ||= expression !== span.expression.getText(tree);
        const literal = ts.createSourceFile('literal.js', expression, ts.ScriptTarget.Latest).statements[0]?.expression;
        if (literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) text += literal.text;
        else if (expression.startsWith('`') && expression.endsWith('`')) text += expression.slice(1, -1);
        else text += '${' + expression + '}';
        text += span.literal.text;
      }
      if (changed) return '`' + text + '`';
    }
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isArrowFunction(node.initializer)
        && node.initializer.parameters.length === 0 && ts.isCallExpression(node.initializer.body)) {
      const rendered = render(node.initializer.body);
      if (rendered !== node.initializer.body.getText(tree)) return node.name.getText(tree) + ' = ' + rendered;
    }
    // Display constants became getters so they follow language changes. Only
    // project a getter consisting of one translated return; never rewrite a
    // getter with logic, side effects, or a non-message return value.
    if (ts.isGetAccessorDeclaration(node) && node.body?.statements.length === 1) {
      const statement = node.body.statements[0];
      if (ts.isReturnStatement(statement) && statement.expression) {
        const text = render(statement.expression);
        if (text !== statement.expression.getText(tree)) return node.name.getText(tree) + ': ' + text;
      }
    }
    if (ts.isCallExpression(node) && /^(?:tr|catalogText|(?:globalThis|window)\.PlatformI18n\.(?:t|htmlText))$/.test(node.expression.getText(tree))
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const text = message(node.arguments[0].text);
      if (text != null) {
        const template = interpolate(text, params(node.arguments[1]), false);
        return template.includes('${') ? '`' + template + '`' : quote(template);
      }
    }
    if (ts.isJsxExpression(node) && node.expression && ts.isJsxAttribute(node.parent)) {
      const rendered = render(node.expression);
      if (rendered !== node.expression.getText(tree)) {
        const literal = ts.createSourceFile('literal.js', rendered, ts.ScriptTarget.Latest).statements[0]?.expression;
        if (literal && ts.isStringLiteral(literal)) return JSON.stringify(literal.text);
      }
    }
    if (ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(tree);
      if (name === 'Localized' || name === 'LocalizedDynamic') {
        const element = attr(node, 'element');
        if (element) return render(element);
      }
      if (name === 'LocalizedValue') {
        const fn = attr(node, 'render');
        if (fn && ts.isArrowFunction(fn)) return '{' + render(ts.isParenthesizedExpression(fn.body) ? fn.body.expression : fn.body) + '}';
      }
      if (name === 'Message') {
        const text = message(value(attr(node, 'id')));
        if (text != null) return value(attr(node, 'before')) + interpolate(text, params(attr(node, 'values')), true) + value(attr(node, 'after'));
      }
      if (name === 'RichMessage') {
        const text = message(value(attr(node, 'id')));
        if (text != null) {
          const components = attr(node, 'components');
          const elements = components && ts.isArrayLiteralExpression(components) ? components.elements : [];
          let result = interpolate(text, params(attr(node, 'values')), true);
          for (let i = elements.length - 1; i >= 0; i--) {
            const element = elements[i];
            result = result.replace(new RegExp('<' + i + '>([\\s\\S]*?)</' + i + '>', 'g'), (_, content) => {
              if (ts.isJsxSelfClosingElement(element)) return render(element).replace(/\s*\/>$/, '>') + content + '</' + element.tagName.getText(tree) + '>';
              return content ? render(element).replace(/>[\s\S]*<\//, '>' + content + '</') : render(element);
            });
          }
          return result;
        }
      }
    }
    const edits = [];
    ts.forEachChild(node, child => {
      const replacement = render(child);
      if (replacement !== child.getText(tree)) edits.push({ start: child.getStart(tree), end: child.end, replacement });
    });
    let out = node.getText(tree);
    const start = node.getStart(tree);
    for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start - start) + edit.replacement + out.slice(edit.end - start);
    return out;
  }
  const result = source.slice(0, tree.getStart(tree)) + render(tree);
  cache.set(source, result);
  return result;
}
module.exports = { englishUiSource };
