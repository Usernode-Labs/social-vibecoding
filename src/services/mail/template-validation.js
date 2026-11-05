'use strict';

// What an email template or layout must be before the store keeps it: it
// parses, uses only the placeholders its action allows, prints every one the
// action requires in both the HTML and the text version (so a sign-in mail can
// never lose its code), has a subject and a text version, and its HTML passes
// ./html-safety.js. Every problem comes back as `{ field, message }`, a
// sentence the console shows beside that field.
//
// Placeholders are also checked for WHERE they sit in the HTML. A value is
// escaped where it lands, which makes it safe as text and inside a quoted
// attribute, but not everywhere:
// - Inside a tag but outside a quoted value (`<a href={{url}}>`, `<p {{x}}>`),
//   a value could add attributes, so nothing may go there, conditions included.
// - In href or src, only a link placeholder may go: its value has been checked
//   to be an http(s) address. In a style attribute or a <style> block, none.
// - Wording built in code (`fromCode`) and anything inserted as HTML (an
//   action's `htmlValues`, a layout's {{content}}, {{why}} and {{preheader}})
//   is not escaped for an attribute, so none of it may go in one.
// - A condition inside an attribute could splice a value together, so
//   conditions go around whole tags.

const { actionFor } = require('./actions');
const { parse, render } = require('./template-language');
const { validateEmailHtml, scanHtml, URL_ATTRIBUTES, MAX_EMAIL_HTML_BYTES } = require('./html-safety');

const LAYOUT_PLACEHOLDERS = {
  content: { description: 'Where each email\'s own HTML or text goes', kind: 'html' },
  why: { description: 'The email\'s "why you got this" line', kind: 'html' },
  preheader: { description: 'The email\'s preview line', kind: 'html' },
};

const LABELS = {
  name: 'name',
  subject: 'subject',
  preheader: 'preview line',
  why: '"why you got this" line',
  html: 'HTML version',
  text: 'text version',
};
const HTML_FIELDS = ['html', 'why', 'preheader'];
const SUBJECT_MAX = 500;

const asText = (value) => (typeof value === 'string' ? value : value == null ? '' : null);
const listOf = (names) => names.map((name) => `{{${name}}}`).join(', ');

// The tree of `source`, or null with the problem added to `errors`.
function parsed(field, source, errors) {
  try {
    return parse(source).nodes;
  } catch (err) {
    const at = Number.isInteger(err.offset) ? ` (at character ${err.offset + 1})` : '';
    errors.push({ field, message: `The ${LABELS[field] || field} does not read as a template: ${err.message}${at}.` });
    return null;
  }
}

// Every name a tree uses, as a printed value or as a condition.
function namesIn(nodes, out = new Set()) {
  for (const n of nodes) {
    if (n.name) out.add(n.name);
    if (n.then) namesIn(n.then, out);
    if (n.else) namesIn(n.else, out);
  }
  return out;
}

// The names a tree prints. A condition alone prints nothing, so `{{#if code}}`
// does not count as carrying the code.
function printedIn(nodes, out = new Set()) {
  for (const n of nodes) {
    if (n.type === 'var') out.add(n.name);
    if (n.then) printedIn(n.then, out);
    if (n.else) printedIn(n.else, out);
  }
  return out;
}

const printedAtTop = (nodes, name) => nodes.some((n) => n.type === 'var' && n.name === name);

// The names an action's htmlValues insert as HTML, read once per action.
const rawNamesCache = new Map();
function rawNames(kind, action) {
  if (!rawNamesCache.has(kind)) {
    let names = [];
    try {
      names = action.htmlValues ? Object.keys(action.htmlValues(action.sample || {})) : [];
    } catch {
      // A catalog that cannot be read now: every fromCode name is refused in an
      // attribute anyway, and htmlValues only ever covers fromCode wording.
      names = Object.entries(action.placeholders).filter(([, info]) => info.fromCode).map(([name]) => name);
    }
    rawNamesCache.set(kind, new Set(names));
  }
  return rawNamesCache.get(kind);
}

// Problems with where placeholders and conditions sit in one HTML field.
// `info(name)` is the placeholder's description, or null for one the field may
// not use (reported elsewhere); `raw` holds the names inserted as HTML.
function placementProblems(field, source, info, raw) {
  const problems = [];
  const add = (message) => problems.push({ field, message });
  if (/<[!/?]?\{\{/.test(source)) add('A tag cannot start with a placeholder or condition. Put the condition around the whole tag.');
  const scan = scanHtml(source);
  if (!scan.ok) return problems;
  const re = /\{\{([^}]*)\}\}/g;
  let m;
  while ((m = re.exec(source))) {
    const at = m.index;
    const body = m[1].trim();
    const isVar = !/^[#/]/.test(body) && body !== 'else';
    const shown = m[0];
    const tag = scan.tags.find((t) => at >= t.start && at < t.end);
    if (tag) {
      const attr = tag.attributes.find((a) => a.quote && at >= a.valueStart && at < a.valueEnd);
      if (!attr) {
        add(`${shown} sits inside a tag, outside a quoted attribute value. Put a placeholder in a quoted value, and a condition around the whole tag.`);
      } else if (!isVar) {
        add(`A condition cannot go inside the ${attr.name} attribute. Put it around the whole tag instead.`);
      } else {
        const about = info(body);
        if (!about) continue;
        if (raw.has(body) || about.kind === 'html') {
          add(`${shown} is inserted as HTML, so it cannot go inside an attribute.`);
        } else if (about.fromCode) {
          add(`${shown} is wording built in code and is not escaped for an attribute, so it cannot go in ${attr.name}. Use it as text.`);
        } else if (attr.name === 'style') {
          add(`Placeholders cannot go inside a style attribute: ${shown} could change the styling rules.`);
        } else if (URL_ATTRIBUTES.has(attr.name) && about.kind !== 'url') {
          add(`Only a link placeholder can go in ${attr.name}, and ${shown} is not a link.`);
        }
      }
      continue;
    }
    const style = scan.rawTexts.find((r) => r.name === 'style' && at >= r.start && at < r.end);
    if (style) {
      add(`Placeholders and conditions cannot go inside a <style> block, and ${shown} does.`);
      continue;
    }
    // A condition in a title or textarea could close it in one branch only.
    const rawText = scan.rawTexts.find((r) => at >= r.start && at < r.end);
    if (rawText && !isVar) add(`A condition cannot go inside a <${rawText.name}>, and ${shown} does. Put it around the whole element.`);
  }
  problems.push(...rawTextTagsInBranches(field, source));
  const branch = branchProblem(source);
  if (branch && !problems.length) add(branch);
  return problems;
}

const RAW_TEXT_TAG = /<\/?(style|title|textarea|script)(?=[\s/>]|$)/i;

// A raw-text element's start or end tag inside a conditional branch would
// open or close it in one branch only, so the rest of the HTML would be read as
// markup in one render and as text in another.
function rawTextTagsInBranches(field, source) {
  let nodes;
  try { nodes = parse(source).nodes; } catch { return []; }
  const found = new Set();
  const walk = (list, inBranch) => {
    for (const n of list) {
      if (n.type === 'text') {
        const m = inBranch && RAW_TEXT_TAG.exec(n.value);
        if (m) found.add(m[1].toLowerCase());
      } else if (n.then) {
        walk(n.then, true);
        walk(n.else, true);
      }
    }
  };
  walk(nodes, false);
  return [...found].map((name) => ({
    field,
    message: `A <${name}> tag cannot start or end inside a condition. Put the condition around the whole element.`,
  }));
}

// Every combination of the conditions, up to this many names; past it, each
// name is flipped on its own against all-true and all-false.
const MAX_BRANCH_NAMES = 8;

/**
 * Renders `source` once for each true/false combination of the names its
 * conditions test (every placeholder printing a short word) and checks each
 * result, so what a real send renders is what was checked. The first refusal's
 * reason, or null.
 */
function branchProblem(source) {
  let nodes;
  try { nodes = parse(source).nodes; } catch { return null; }
  const conditions = new Set();
  const vars = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.type === 'var') vars.add(n.name);
      else if (n.then) { conditions.add(n.name); walk(n.then); walk(n.else); }
    }
  };
  walk(nodes);
  if (!conditions.size) return null;
  const names = [...conditions];
  const paths = [];
  if (names.length <= MAX_BRANCH_NAMES) {
    for (let mask = 0; mask < 2 ** names.length; mask++) paths.push(names.map((_, i) => !!(mask & (1 << i))));
  } else {
    paths.push(names.map(() => true), names.map(() => false));
    names.forEach((_, i) => {
      paths.push(names.map((__, j) => j === i), names.map((__, j) => j !== i));
    });
  }
  for (const path of paths) {
    const values = {};
    for (const name of vars) values[name] = 'x';
    names.forEach((name, i) => { values[name] = path[i] ? (vars.has(name) ? 'x' : true) : ''; });
    let html;
    try { html = render(source, values, { raw: [...vars] }); } catch { return null; }
    const result = validateEmailHtml(html);
    if (!result.ok) {
      const when = names.map((name, i) => `${name} ${path[i] ? 'true' : 'false'}`).join(', ');
      return `When ${when}: ${result.reason}`;
    }
  }
  return null;
}

/**
 * `fields`: { name?, subject, preheader, why, html, text }. `layout`: the
 * layout row it wears ({ html, text }), or null for complete HTML. A `name`
 * of undefined is not checked (a translation has none). `{ ok: true }` or
 * `{ ok: false, errors: [{ field, message }] }`.
 */
function validateTemplate(kind, fields, layout) {
  const action = actionFor(kind);
  if (!action) return { ok: false, errors: [{ field: 'action', message: 'Choose what this email is for from the list of actions.' }] };
  const f = fields || {};
  const errors = [];
  const text = {};
  for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
    const value = asText(f[field]);
    if (value === null) errors.push({ field, message: `The ${LABELS[field]} must be text.` });
    text[field] = value || '';
  }
  if (f.name !== undefined && !(asText(f.name) || '').trim()) errors.push({ field: 'name', message: 'The name cannot be empty.' });
  for (const field of ['subject', 'html', 'text']) {
    if (!text[field].trim()) errors.push({ field, message: `The ${LABELS[field]} cannot be empty.` });
  }
  if (text.subject.length > SUBJECT_MAX) errors.push({ field: 'subject', message: `The subject is over ${SUBJECT_MAX} characters.` });
  if (Buffer.byteLength(text.text, 'utf8') > MAX_EMAIL_HTML_BYTES) errors.push({ field: 'text', message: 'The text version is over 100 KB.' });

  const allowed = Object.keys(action.placeholders);
  const trees = {};
  for (const field of ['subject', 'preheader', 'why', 'html', 'text']) {
    trees[field] = parsed(field, text[field], errors);
    if (!trees[field]) continue;
    const unknown = [...namesIn(trees[field])].filter((name) => !allowed.includes(name));
    for (const name of unknown) {
      errors.push({
        field,
        message: allowed.length
          ? `{{${name}}} is not something this email can use. It can use ${listOf(allowed)}.`
          : `{{${name}}} is not something this email can use. It has no placeholders.`,
      });
    }
  }

  const raw = rawNames(kind, action);
  const info = (name) => (Object.hasOwn(action.placeholders, name) ? action.placeholders[name] : null);
  for (const field of HTML_FIELDS) {
    if (!text[field]) continue;
    const safety = validateEmailHtml(text[field]);
    if (!safety.ok) {
      errors.push({ field, message: safety.reason });
      continue;
    }
    errors.push(...placementProblems(field, text[field], info, raw));
  }

  // Required placeholders, counted where they are printed in the finished mail:
  // the template's own HTML or text, and its why and preheader lines only where
  // the layout prints those.
  const layoutTrees = layout ? { html: safeTree(layout.html), text: safeTree(layout.text) } : null;
  for (const form of ['html', 'text']) {
    if (!trees[form]) continue;
    const printed = printedIn(trees[form]);
    if (layoutTrees && layoutTrees[form]) {
      const framed = printedIn(layoutTrees[form]);
      for (const part of ['why', 'preheader']) {
        if (framed.has(part) && trees[part]) printedIn(trees[part], printed);
      }
    }
    for (const name of action.required[form]) {
      if (printed.has(name)) continue;
      const about = info(name);
      errors.push({
        field: form,
        message: `The ${LABELS[form]} must include {{${name}}}${about ? ` (${about.description.charAt(0).toLowerCase()}${about.description.slice(1)})` : ''}, or this email cannot do its job.`,
      });
    }
  }

  if (!errors.length) {
    const framed = framedProblem(kind, text, layout);
    if (framed) errors.push({ field: 'html', message: framed });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function safeTree(source) {
  try { return parse(typeof source === 'string' ? source : '').nodes; } catch { return null; }
}

// The finished mail, with sample values, inside its layout, must pass as a
// whole: the size limit is the whole message's.
function framedProblem(kind, text, layout) {
  try {
    const { renderMessage } = require('./render');
    const action = actionFor(kind);
    const message = renderMessage(kind, { template: text, layout: layout || null }, action.sample || {});
    const safety = validateEmailHtml(message.html);
    return safety.ok ? null : `With its layout, the finished email is refused: ${safety.reason}`;
  } catch (err) {
    return `The email could not be put together with sample values: ${err.message}.`;
  }
}

/**
 * A translation of a template version: the same rules as the template, with
 * no name. `layout` is the layout (in that language, if translated) it wears.
 */
function validateTranslation(kind, fields, layout) {
  const { name, ...rest } = fields || {}; // eslint-disable-line no-unused-vars
  return validateTemplate(kind, rest, layout);
}

/**
 * `fields`: { name?, html, text }. `liveTemplates`: the live template rows that
 * wear this layout; each must still validate inside the new version. A broken
 * one is named in an error and listed in `templates`.
 */
function validateLayout(fields, liveTemplates = []) {
  const f = fields || {};
  const errors = [];
  if (f.name !== undefined && !(asText(f.name) || '').trim()) errors.push({ field: 'name', message: 'The name cannot be empty.' });
  const text = {};
  for (const field of ['html', 'text']) {
    const value = asText(f[field]);
    if (value === null) errors.push({ field, message: `The ${LABELS[field]} must be text.` });
    text[field] = value || '';
    if (value !== null && !text[field].trim()) errors.push({ field, message: `The ${LABELS[field]} cannot be empty.` });
  }
  if (Buffer.byteLength(text.text, 'utf8') > MAX_EMAIL_HTML_BYTES) errors.push({ field: 'text', message: 'The text version is over 100 KB.' });
  const allowed = Object.keys(LAYOUT_PLACEHOLDERS);
  for (const field of ['html', 'text']) {
    if (!text[field].trim()) continue;
    const tree = parsed(field, text[field], errors);
    if (!tree) continue;
    for (const name of namesIn(tree)) {
      if (!allowed.includes(name)) errors.push({ field, message: `{{${name}}} is not something a layout can use. A layout can use ${listOf(allowed)}.` });
    }
    if (!printedAtTop(tree, 'content')) {
      errors.push({
        field,
        message: printedIn(tree).has('content')
          ? `The ${LABELS[field]} must include {{content}} outside any condition, so every email's own words always appear.`
          : `The ${LABELS[field]} must include {{content}}, where each email's own words go.`,
      });
    }
  }
  if (text.html.trim()) {
    const safety = validateEmailHtml(text.html);
    if (!safety.ok) errors.push({ field: 'html', message: safety.reason });
    else errors.push(...placementProblems('html', text.html, (name) => LAYOUT_PLACEHOLDERS[name] || null, new Set(allowed)));
  }
  if (errors.length) return { ok: false, errors };

  const broken = [];
  for (const template of liveTemplates || []) {
    const result = validateTemplate(template.action, template, { html: text.html, text: text.text });
    if (result.ok) continue;
    const first = result.errors[0];
    const label = actionFor(template.action)?.label || template.action;
    broken.push({ id: template.id, action: template.action, name: template.name });
    errors.push({
      field: first.field === 'text' ? 'text' : 'html',
      message: `This change would break "${template.name}" (${label}): ${first.message}`,
    });
  }
  return errors.length ? { ok: false, errors, templates: broken } : { ok: true };
}

module.exports = { validateTemplate, validateLayout, validateTranslation, branchProblem, LAYOUT_PLACEHOLDERS };
