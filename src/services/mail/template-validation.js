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
// - In an address attribute (href, src, ping, ...), only a link placeholder may
//   go: its value has been checked to be an http(s) address. In a style
//   attribute or a <style> block, none.
// - A link placeholder carries a one-time secret (a reset or sign-in link), so
//   in HTML it goes only in href and only as the whole value (`href="{{url}}"`),
//   or as the whole text of the link it opens (`<a href="{{url}}">{{url}}</a>`).
//   Joined to other text (`https://evil.example/?u={{url}}`, which a mail
//   client turns into a link) or in an address the client fetches by itself on
//   open (an image's src), it would hand that secret to another site. In the
//   text version, of the whole mail inside its layout, only space, punctuation
//   outside ASCII or a CJK letter may come right before it (see linkLeadOk).
// - Wording built in code (`fromCode`) and anything inserted as HTML (an
//   action's `htmlValues`, a layout's {{content}}, {{why}} and {{preheader}})
//   is not escaped for an attribute, so none of it may go in one.
// - A condition inside an attribute could splice a value together, so
//   conditions go around whole tags.

const log = require('../logger');
const { actionFor } = require('./actions');
const { parse, render } = require('./template-language');
const { validateEmailHtml, scanHtml, openAtEnd, decodeEntities, URL_ATTRIBUTES, MAX_EMAIL_HTML_BYTES } = require('./html-safety');

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

// The only attributes a link placeholder may fill: followed when the reader
// clicks, never fetched by the mail client on its own.
const LINK_ATTRIBUTES = new Set(['href']);

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

// Whether the link placeholder `shown` at `at` is the whole text of an <a>
// whose href is that same placeholder: `<a href="{{url}}">{{url}}</a>`, the
// address written out as the link that opens it.
function wholeLinkText(source, scan, at, shown) {
  const open = scan.tags.filter((t) => t.end <= at).pop();
  const close = scan.tags.find((t) => t.start >= at + shown.length);
  if (!open || !close || open.name !== 'a' || open.closing || close.name !== 'a' || !close.closing) return false;
  const href = open.attributes.find((a) => a.name === 'href');
  if (!href || !href.quote || source.slice(href.valueStart, href.valueEnd).trim() !== shown) return false;
  return source.slice(open.end, close.start).trim() === shown;
}

// Problems with where placeholders and conditions sit in one HTML field.
// `info(name)` is the placeholder's description, or null for one the field may
// not use (reported elsewhere); `raw` holds the names inserted as HTML.
function placementProblems(field, source, info, raw) {
  const problems = [];
  const add = (message) => problems.push({ field, message });
  if (/<[!/?]?\{\{/.test(source)) add('A tag cannot start with a placeholder or condition. Put the condition around the whole tag.');
  // After "&", "&#", "&#x" or "&name", a value would finish a character
  // reference: `&#{{code}}` turns the six digits into one character.
  if (/&(?:#[xX]?)?[A-Za-z0-9]*\{\{/.test(source)) add('A placeholder or condition cannot come right after "&": it would join a character reference and could vanish. Write "&amp;" or put a space between.');
  const scan = scanHtml(source);
  if (!scan.ok) return problems;
  const re = /\{\{([^}]*)\}\}/g;
  let m;
  while ((m = re.exec(source))) {
    const at = m.index;
    const body = m[1].trim();
    const isVar = !/^[#/]/.test(body) && body !== 'else';
    const shown = m[0];
    // Taking text out of a comment can move where it ends, so the comment
    // checked is not the one sent. Nothing in a comment is printed for sure,
    // either.
    if (scan.comments.some((c) => at >= c.start && at < c.end)) {
      add(`Placeholders and conditions cannot go inside an HTML comment, and ${shown} does.`);
      continue;
    }
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
        } else if (about.kind === 'url' && !LINK_ATTRIBUTES.has(attr.name)) {
          add(`${shown} is a link that may carry a one-time secret, so it can only go in href, not in ${attr.name}.`);
        } else if (about.kind === 'url' && source.slice(attr.valueStart, attr.valueEnd).trim() !== shown) {
          add(`${shown} must be the whole ${attr.name} value (${attr.name}="${shown}"): joined to other text, the link could be sent to another site.`);
        }
      }
      continue;
    }
    // A value or a condition could finish a partial end tag (`</tit{{x}}`) or
    // close the element in one branch only.
    const rawText = scan.rawTexts.find((r) => at >= r.start && at < r.end);
    if (rawText) {
      add(rawText.name === 'style'
        ? `Placeholders and conditions cannot go inside a <style> block, and ${shown} does.`
        : `Placeholders and conditions cannot go inside a <${rawText.name}>, and ${shown} does.`);
      continue;
    }
    const about = isVar ? info(body) : null;
    if (about && about.kind === 'url' && !wholeLinkText(source, scan, at, shown)) {
      add(`${shown} is a link that may carry a one-time secret, so in HTML it can only be a whole href value (href="${shown}"), or the whole text of that link. In text, a mail app could join it to the address before it.`);
    }
  }
  problems.push(...rawTextTagsInBranches(field, source));
  const names = conditionNames(source);
  if (names.length > MAX_BRANCH_NAMES) {
    add(`This has more than ${MAX_BRANCH_NAMES} different conditions (${names.join(', ')}), too many to check every combination. Use fewer.`);
  } else if (!problems.length) {
    const branch = branchProblem(source);
    if (branch) add(branch);
  }
  return problems;
}

function conditionNames(source) {
  let nodes;
  try { nodes = parse(source).nodes; } catch { return []; }
  const names = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.then) { names.add(n.name); walk(n.then); walk(n.else); }
    }
  };
  walk(nodes);
  return [...names];
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

// Every combination of the conditions is checked, so a field may test at most
// this many names: past it the combinations are too many to check, and checking
// only some of them would let an unsafe one through.
const MAX_BRANCH_NAMES = 8;

// What a placeholder prints while the branches are checked. An empty value, a
// hyphen, a space and digits are the ones that can change how text around them
// reads (a comment's end, a word joined to the next, a character reference).
const VALUE_VARIANTS = ['x', '', '-', ' ', '482913'];

/**
 * Renders `source` once for each true/false combination of the names its
 * conditions test, with every placeholder printing each of VALUE_VARIANTS, and
 * checks each result, so what a real send renders is what was checked. The
 * first refusal's reason, or null. A source with more than MAX_BRANCH_NAMES
 * names is refused outright.
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
  const names = [...conditions];
  if (names.length > MAX_BRANCH_NAMES) return `This has more than ${MAX_BRANCH_NAMES} different conditions, too many to check every combination. Use fewer.`;
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    const path = names.map((_, i) => !!(mask & (1 << i)));
    for (const variant of VALUE_VARIANTS) {
      const values = {};
      for (const name of vars) values[name] = variant;
      names.forEach((name, i) => {
        values[name] = path[i] ? (vars.has(name) ? variant || 'x' : true) : '';
      });
      let html;
      try { html = render(source, values, { raw: [...vars] }); } catch { return null; }
      const result = validateEmailHtml(html);
      // A part of a mail is followed by the next part, so it must end where
      // ordinary text could follow.
      const reason = result.ok ? openAtEnd(html) : result.reason;
      if (reason) {
        const when = names.length ? `When ${names.map((name, i) => `${name} is ${path[i] ? 'true' : 'false'}`).join(', ')}: ` : '';
        return `${when}${reason}`;
      }
    }
  }
  return null;
}

// Whether `name` is sure to print from these nodes whenever it has a value:
// printed at this level, inside a condition on itself or on a flag that means
// the same (`guards`), or in both branches of any other condition.
function surelyPrints(nodes, name, guards) {
  for (const n of nodes) {
    if (n.type === 'var' && n.name === name) return true;
    if (!n.then) continue;
    if (n.type === 'if' && guards.has(n.name) && surelyPrints(n.then, name, guards)) return true;
    if (n.type === 'unless' && guards.has(n.name) && surelyPrints(n.else, name, guards)) return true;
    if (surelyPrints(n.then, name, guards) && surelyPrints(n.else, name, guards)) return true;
  }
  return false;
}

// The names whose truth means `name` prints something.
function guardsFor(action, name) {
  const guards = new Set([name]);
  for (const [flagName, info] of Object.entries(action.placeholders)) {
    if (info.presenceOf === name) guards.add(flagName);
  }
  return guards;
}

// Two markers per value: letters, and digits only, as a code is, so a value
// that a character reference would swallow is found missing either way.
const MARKERS = [
  (name) => `zq${name}qz`,
  (name, index) => `90817263${String(index).padStart(3, '0')}54637281`,
];

// The finished mail on every path through its conditions, with each required
// value and the flags that mean it forced true (a mail without its code has no
// code to print), must print every required value. Null or a problem.
function requiredOnEveryPath(action, text, layout) {
  const required = [...new Set([...action.required.html, ...action.required.text])];
  if (!required.length) return null;
  const forced = new Set(required.flatMap((name) => [...guardsFor(action, name)]));
  const trees = {};
  const vars = new Set();
  const conditions = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.type === 'var') vars.add(n.name);
      else if (n.then) { conditions.add(n.name); walk(n.then); walk(n.else); }
    }
  };
  for (const field of ['html', 'why', 'preheader', 'text']) {
    trees[field] = safeTree(text[field]);
    if (!trees[field]) return null;
    walk(trees[field]);
  }
  const free = [...conditions].filter((name) => !forced.has(name));
  if (free.length > MAX_BRANCH_NAMES) {
    return `This email tests more than ${MAX_BRANCH_NAMES} different conditions across its parts (${free.join(', ')}), too many to check that it always carries ${required.map((n) => `{{${n}}}`).join(', ')}. Use fewer.`;
  }
  const order = [...vars];
  for (let mask = 0; mask < 2 ** free.length; mask++) for (const marker of MARKERS) {
    const MARK = (name) => marker(name, order.indexOf(name));
    const values = {};
    for (const name of vars) values[name] = MARK(name);
    for (const name of forced) values[name] = vars.has(name) ? MARK(name) : true;
    free.forEach((name, i) => {
      values[name] = mask & (1 << i) ? (vars.has(name) ? MARK(name) : true) : '';
    });
    let out;
    try {
      const html = render(text.html, values);
      const why = render(text.why, values);
      const preheader = render(text.preheader, values);
      const plain = render(text.text, values, { mode: 'text' });
      out = layout
        ? {
          html: render(layout.html, { content: html, why, preheader }, { raw: ['content', 'why', 'preheader'] }),
          text: render(layout.text, { content: plain, why: render(text.why, values, { mode: 'text' }), preheader: render(text.preheader, values, { mode: 'text' }) }, { mode: 'text' }),
        }
        : { html, text: plain };
    } catch {
      return null;
    }
    for (const form of ['html', 'text']) {
      for (const name of action.required[form]) {
        // The html as a reader sees it, references decoded.
        if ((form === 'html' ? decodeEntities(out.html) : out.text).includes(MARK(name))) continue;
        const when = free.filter((_, i) => mask & (1 << i)).map((n) => `{{${n}}}`);
        return {
          field: form,
          message: `The ${LABELS[form]} does not always include {{${name}}}: it is missing when ${when.length ? `only ${when.join(', ')} ${when.length === 1 ? 'is' : 'are'} true` : 'every other condition is false'}.`,
        };
      }
    }
  }
  return null;
}

// What may come right before a link placeholder (or, in a layout's text, the
// parts a link can open with) in the text form of a mail: the start, a space
// or line break, punctuation outside ASCII (a full-width colon, as CJK
// translations write it), or a CJK letter (`こちら{{url}}`). A "(" may, when
// the start or a space comes before it. Anything else (an ASCII letter, digit
// or sign, any other letter, a zero-width or no-break space, another value)
// could make a mail app read the text before it and the link as one address.
const LINK_SPACE = /^[ \t\n\r\f\v\u2028\u2029\u3000]$/u;
const CJK_LETTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const standsApart = (ch) => ch === '' || LINK_SPACE.test(ch) || CJK_LETTER.test(ch) || (ch > '\u007f' && /^\p{P}$/u.test(ch));

function linkLeadOk(out, at) {
  const prev = at > 0 ? out[at - 1] : '';
  if (standsApart(prev)) return true;
  return prev === '(' && (at < 2 || LINK_SPACE.test(out[at - 2]));
}

const LINK_JOINED = (name) => `{{${name}}} is a link that may carry a one-time secret, so in the text version only a space, a line break or "(" may come right before it. Joined to other text, it could become part of another site's address.`;

// Every place `marker` sits in `out` is led as linkLeadOk wants.
function markerLeadsOk(out, marker) {
  for (let at = out.indexOf(marker); at !== -1; at = out.indexOf(marker, at + marker.length)) {
    if (!linkLeadOk(out, at)) return false;
  }
  return true;
}

const textMark = (name) => `\uE010${name}\uE011`;

// The text form of the whole mail (the template's text, and its why and
// preheader as the layout's text prints them, inside that text), on every
// path through the template's conditions, must lead every link placeholder
// as linkLeadOk wants. Null or a problem.
function joinedLinkProblem(action, text, layout) {
  const links = Object.entries(action.placeholders).filter(([, info]) => info.kind === 'url').map(([name]) => name);
  if (!links.length) return null;
  const vars = new Set();
  const conditions = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.type === 'var') vars.add(n.name);
      else if (n.then) { conditions.add(n.name); walk(n.then); walk(n.else); }
    }
  };
  for (const field of ['text', 'why', 'preheader']) {
    const tree = safeTree(text[field]);
    if (!tree) return null;
    walk(tree);
  }
  const used = links.filter((name) => vars.has(name));
  if (!used.length) return null;
  const names = [...conditions];
  if (names.length > MAX_BRANCH_NAMES) {
    return `The text version tests more than ${MAX_BRANCH_NAMES} different conditions (${names.join(', ')}), too many to check where its links land. Use fewer.`;
  }
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    const values = {};
    for (const name of vars) values[name] = textMark(name);
    names.forEach((name, i) => {
      values[name] = mask & (1 << i) ? (vars.has(name) ? textMark(name) : true) : '';
    });
    let out;
    try {
      const plain = render(text.text, values, { mode: 'text' });
      out = layout
        ? render(layout.text, {
          content: plain,
          why: render(text.why, values, { mode: 'text' }),
          preheader: render(text.preheader, values, { mode: 'text' }),
        }, { mode: 'text' })
        : plain;
    } catch {
      return null;
    }
    for (const name of used) {
      if (!markerLeadsOk(out, textMark(name))) return LINK_JOINED(name);
    }
  }
  return null;
}

// A layout's text puts each email's text, why and preheader where it prints
// {{content}}, {{why}} and {{preheader}}, and any of them can open with a
// link. So on every path through its conditions, each must be led as
// linkLeadOk wants. Null or a problem.
function layoutTextLeadProblem(source) {
  const tree = safeTree(source);
  if (!tree) return null;
  const parts = Object.keys(LAYOUT_PLACEHOLDERS);
  for (let mask = 0; mask < 2 ** parts.length; mask++) {
    const values = Object.fromEntries(parts.map((name, i) => [name, mask & (1 << i) ? textMark(name) : '']));
    let out;
    try { out = render(source, values, { mode: 'text' }); } catch { return null; }
    for (const name of parts) {
      if (!markerLeadsOk(out, textMark(name))) {
        return `In the text version, only a space, a line break or "(" may come right before {{${name}}}: an email's part can open with a link, and joined to other text that link could become part of another site's address.`;
      }
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
    // The layout's why and preheader count only where the layout is sure to
    // print them, at its top level or under a condition on that same part.
    const parts = ['why', 'preheader'].filter((part) => trees[part] && layoutTrees && layoutTrees[form]
      && surelyPrints(layoutTrees[form], part, new Set([part])));
    for (const name of action.required[form]) {
      const guards = guardsFor(action, name);
      if (surelyPrints(trees[form], name, guards) || parts.some((part) => surelyPrints(trees[part], name, guards))) continue;
      const about = info(name);
      errors.push({
        field: form,
        message: `The ${LABELS[form]} must include {{${name}}}${about ? ` (${about.description.charAt(0).toLowerCase()}${about.description.slice(1)})` : ''}, or this email cannot do its job.`,
      });
    }
  }

  if (trees.text) {
    const joined = joinedLinkProblem(action, text, layout);
    if (joined) errors.push({ field: 'text', message: joined });
  }

  if (!errors.length) {
    const missing = requiredOnEveryPath(action, text, layout);
    if (typeof missing === 'string') errors.push({ field: 'html', message: missing });
    else if (missing) errors.push(missing);
  }
  if (!errors.length) {
    const framed = framedPathsProblem(text, layout) || framedProblem(kind, text, layout);
    if (framed) errors.push({ field: 'html', message: framed });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

function safeTree(source) {
  try { return parse(typeof source === 'string' ? source : '').nodes; } catch { return null; }
}

// The finished mail inside its layout, on every path through the template's
// conditions and with each of VALUE_VARIANTS for every value, must pass as a
// whole: what one part leaves open, the next part is read inside. The layout's
// own conditions test only its parts (content, why, preheader), so they follow
// from the rendered parts. Null or the first problem.
function framedPathsProblem(text, layout) {
  const trees = {};
  const vars = new Set();
  const conditions = new Set();
  const walk = (list) => {
    for (const n of list) {
      if (n.type === 'var') vars.add(n.name);
      else if (n.then) { conditions.add(n.name); walk(n.then); walk(n.else); }
    }
  };
  for (const field of HTML_FIELDS) {
    trees[field] = safeTree(text[field]);
    if (!trees[field]) return null;
    walk(trees[field]);
  }
  const names = [...conditions];
  if (names.length > MAX_BRANCH_NAMES) {
    return `The HTML, "why" and preview lines test more than ${MAX_BRANCH_NAMES} different conditions together (${names.join(', ')}), too many to check every combination. Use fewer.`;
  }
  for (let mask = 0; mask < 2 ** names.length; mask++) {
    for (const variant of VALUE_VARIANTS) {
      const values = {};
      for (const name of vars) values[name] = variant;
      names.forEach((name, i) => {
        values[name] = mask & (1 << i) ? (vars.has(name) ? variant || 'x' : true) : '';
      });
      let html;
      try {
        const parts = Object.fromEntries(HTML_FIELDS.map((field) => [field, render(text[field], values, { raw: [...vars] })]));
        html = layout
          ? render(layout.html, { content: parts.html, why: parts.why, preheader: parts.preheader }, { raw: ['content', 'why', 'preheader'] })
          : parts.html;
      } catch {
        return null;
      }
      const result = validateEmailHtml(html);
      if (!result.ok) {
        const when = names.length ? `When ${names.map((name, i) => `${name} is ${mask & (1 << i) ? 'true' : 'false'}`).join(', ')}, the` : 'The';
        return `${when} finished email with its layout is refused: ${result.reason}`;
      }
    }
  }
  return null;
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
    // Only a mistake in the template itself is the admin's to read; anything
    // else is the server's, and its detail stays in the log.
    if (err && err.name === 'TemplateSyntaxError') return `The email could not be put together: ${err.message}.`;
    log.error('email-templates', 'A template could not be put together with sample values', { message: err && err.message });
    return 'The email could not be put together with sample values. The server logged why; try again or ask a developer.';
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
  if (text.text.trim() && !errors.some((e) => e.field === 'text')) {
    const lead = layoutTextLeadProblem(text.text);
    if (lead) errors.push({ field: 'text', message: lead });
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

module.exports = { validateTemplate, validateLayout, validateTranslation, branchProblem, framedPathsProblem, requiredOnEveryPath, LAYOUT_PLACEHOLDERS };
