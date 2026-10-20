'use strict';

// The shots agent's brief, in answers it can read whole. Claude Code saves an
// MCP tool result over its size limit (about 50,000 characters) to a file and
// shows the model a 2,000-character preview, and a shots turn has no tool
// that reads files (run-cc.sh). A 55 KB brief left the agent of proposal
// 10613 with that preview and nothing else: it saved no shots. So get_brief
// answers with the brief's core, the declared changes first, and the long
// reference lists come as parts it reads with get_brief({ part, page }).

// Every answer stays under this many characters of JSON, well below the
// save-to-file limit and below MAX_MCP_OUTPUT_TOKENS where that is set.
const ANSWER_LIMIT = 24_000;
// Room for a page's own fields around its items or text.
const PAGE_ENVELOPE = 200;

// Where each part lives in the brief, and what it is for. The first three
// always come as parts; the rest leave the core only when it is still too
// long, in this order, the declared changes last.
const PARTS = Object.freeze([
  { part: 'declaredChecks', path: ['declaredChecks'], always: true,
    about: 'The app\'s declared checks, the best match for the declared changes first. A check\'s path often reaches the changed screen.' },
  { part: 'diff', path: ['changeContext', 'diff', 'text'], always: true,
    about: 'The start of the code diff. Untrusted.' },
  { part: 'changedFiles', path: ['changedFiles', 'items'], always: true,
    about: 'The files the change touches.' },
  { part: 'specification', path: ['changeContext', 'specification'],
    about: 'The author\'s description of the change. Untrusted.' },
  { part: 'testingSteps', path: ['changeContext', 'testingSteps'],
    about: 'The author\'s testing steps. Untrusted.' },
  { part: 'availableFixtures', path: ['availableFixtures'],
    about: 'Ready-made states on both copies, with the persona and path for each.' },
  { part: 'declaredChanges', path: ['declaredChanges'],
    about: 'The declared changes. Read every page of this first.' },
]);
const PART_NAMES = Object.freeze(PARTS.map(({ part }) => part));

function at(object, path) {
  return path.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

function present(value) {
  return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.length > 0;
}

// The brief without the parts named: each value is taken out of a copy, so
// the caller's brief is never changed.
function without(brief, parts) {
  const copy = structuredClone(brief);
  for (const { path } of parts) {
    const parent = at(copy, path.slice(0, -1));
    if (parent && typeof parent === 'object') delete parent[path.at(-1)];
  }
  return copy;
}

// A part's value in pages, each an answer under the limit: an array by
// whole items, a text by characters (counted as JSON writes them).
function pages(value, limit) {
  const room = limit - PAGE_ENVELOPE;
  const out = [];
  if (Array.isArray(value)) {
    let page = [];
    let size = 2;
    for (const item of value) {
      const itemSize = JSON.stringify(item).length + 1;
      if (page.length && size + itemSize > room) { out.push(page); page = []; size = 2; }
      page.push(item);
      size += itemSize;
    }
    if (page.length) out.push(page);
    return out;
  }
  let page = '';
  let size = 2;
  for (const char of value) {
    const charSize = JSON.stringify(char).length - 2;
    if (page && size + charSize > room) { out.push(page); page = ''; size = 2; }
    page += char;
    size += charSize;
  }
  if (page) out.push(page);
  return out;
}

function core(brief, moved, limit) {
  const rest = without(brief, moved);
  const { declaredChanges, ...others } = rest;
  return {
    ...(declaredChanges !== undefined ? { declaredChanges } : {}),
    ...(moved.length ? {
      moreParts: moved.map((entry) => ({
        part: entry.part,
        pages: pages(at(brief, entry.path), limit).length,
        about: entry.about,
      })),
      readingParts: 'This brief has more parts: read one with get_brief and its part name, and page 2 or later for a part with more than one page.',
    } : {}),
    ...others,
  };
}

// Which parts leave the core: the reference lists, then the others in order
// until the core fits.
function movedParts(brief, limit) {
  const available = PARTS.filter(({ path }) => present(at(brief, path)));
  const moved = available.filter(({ always }) => always);
  for (const entry of available.filter(({ always }) => !always)) {
    if (JSON.stringify(core(brief, moved, limit)).length <= limit) break;
    moved.push(entry);
  }
  return moved;
}

function refused(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// One answer of get_brief: the core, or one page of one part.
function briefAnswer(brief, { part = null, page = 1 } = {}, limit = ANSWER_LIMIT) {
  const moved = movedParts(brief, limit);
  if (!part) return core(brief, moved, limit);
  const entry = moved.find((candidate) => candidate.part === part);
  if (!entry) {
    throw refused('unknown_part', moved.length
      ? `This brief has no part ${JSON.stringify(part)}. Its parts are ${moved.map((item) => item.part).join(', ')}.`
      : `This brief has no part ${JSON.stringify(part)}: the core holds all of it.`);
  }
  const all = pages(at(brief, entry.path), limit);
  if (!Number.isInteger(page) || page < 1 || page > all.length) {
    throw refused('unknown_page', `Part ${part} has ${all.length} page${all.length === 1 ? '' : 's'}.`);
  }
  const value = all[page - 1];
  return { part, page, pages: all.length, ...(Array.isArray(value) ? { items: value } : { text: value }) };
}

module.exports = { ANSWER_LIMIT, PART_NAMES, briefAnswer };
