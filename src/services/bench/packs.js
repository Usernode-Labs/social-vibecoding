'use strict';

// The App bench studio's CONTEXT PACKS (services/bench/studio.js): what an
// admin adds to what the Homeroom bot is told when it builds a first
// version, so a change to that context can be tried on the benchmark before
// anything in production changes.
//
// A pack has two parts, each put where production's own context already
// goes, so a pack that wins becomes an ordinary change to those places:
//
//   guidance  text, added to the end of the reference part of the bot's
//             first-version prompts: the triage's (homeroom-bot.js
//             triagePromptFor), the spec's (homeroom-bot-live.js specPrompt)
//             and the build's (buildPrompt), under one heading
//             (homeroom-bot-live.js guidanceLines). `stageGuidance` adds text
//             for one of the three only.
//   files     files in the new app's first commit, beside the starter's
//             (services/bench/scaffold.js): a theme as a skill under
//             `.claude/skills/<name>/SKILL.md`, a section of CLAUDE.md, an
//             example. A file with a starter file's path replaces it.
//
// Versions. Saving a pack makes the next version of its name; a version is
// never edited. `used_at` is stamped when a run is launched with it, and the
// gallery and the report name the exact version every trial was given.
// Saving with `parentId` starts from that version: what the call leaves out
// is the parent's.
//
// Everything here is admin-written text for a benchmark: validated for size
// and shape, stored as data, and never interpreted.

const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const STAGES = Object.freeze(['triage', 'spec', 'build']);
const MAX_GUIDANCE_CHARS = 32000;
const MAX_STAGE_CHARS = 16000;
const MAX_FILES = 40;
const MAX_FILE_CHARS = 48000;
// Everything a pack carries, together: it is read on every turn of every
// trial it is given to, so it competes with the model's own context.
const MAX_TOTAL_CHARS = 96000;
const MAX_NOTES_CHARS = 2000;
const MAX_PATH_CHARS = 200;
const PATH_RE = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+/-]*$/;
const DIFF_MAX_LINES = 400;

function httpError(status, error) {
  return { ok: false, status, error };
}

/**
 * Whether a file path is one a pack may write into a new app's first
 * commit. Pure. Relative, no `..`, no empty segment, nothing under `.git/`
 * or `.github/` (CI is out of scope for a benchmark, as for a proposal).
 */
function validPath(path) {
  const p = String(path || '');
  if (!p || p.length > MAX_PATH_CHARS || !PATH_RE.test(p)) return false;
  const parts = p.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return false;
  if (parts[0] === '.git' || parts[0] === '.github') return false;
  return true;
}

function cleanText(value, max, field) {
  if (value == null) return { ok: true, value: '' };
  if (typeof value !== 'string') return httpError(400, `${field} must be text`);
  const text = value.replace(/\r\n/g, '\n');
  if (text.length > max) return httpError(400, `${field} is ${text.length} characters, over the ${max} it can be`);
  return { ok: true, value: text };
}

/**
 * A pack's parts, checked and cleaned. Pure. `raw` is
 * { name, guidance, stageGuidance: { triage?, spec?, build? }, files: [{ path, content }], notes }.
 */
function validate(raw = {}) {
  const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(name)) return httpError(400, 'A pack name is 1 to 80 letters, digits, spaces, dots, dashes or underscores');
  const guidance = cleanText(raw.guidance, MAX_GUIDANCE_CHARS, 'guidance');
  if (!guidance.ok) return guidance;
  const stageGuidance = {};
  const sg = raw.stageGuidance && typeof raw.stageGuidance === 'object' ? raw.stageGuidance : {};
  for (const key of Object.keys(sg)) {
    if (!STAGES.includes(key)) return httpError(400, `stageGuidance takes ${STAGES.join(', ')}`);
    const t = cleanText(sg[key], MAX_STAGE_CHARS, `stageGuidance.${key}`);
    if (!t.ok) return t;
    if (t.value.trim()) stageGuidance[key] = t.value;
  }
  const list = raw.files == null ? [] : raw.files;
  if (!Array.isArray(list)) return httpError(400, 'files must be a list of { path, content }');
  if (list.length > MAX_FILES) return httpError(400, `A pack has at most ${MAX_FILES} files`);
  const files = [];
  const seen = new Set();
  for (const f of list) {
    const path = String(f?.path || '').trim();
    if (!validPath(path)) return httpError(400, `${path || '(no path)'} is not a path a pack can write: relative, no "..", nothing under .git/ or .github/`);
    if (seen.has(path)) return httpError(400, `${path} is in the pack twice`);
    seen.add(path);
    const content = cleanText(f?.content, MAX_FILE_CHARS, path);
    if (!content.ok) return content;
    files.push({ path, content: content.value });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const notes = cleanText(raw.notes, MAX_NOTES_CHARS, 'notes');
  if (!notes.ok) return notes;
  const total = guidance.value.length + Object.values(stageGuidance).reduce((s, t) => s + t.length, 0)
    + files.reduce((s, f) => s + f.content.length + f.path.length, 0);
  if (total > MAX_TOTAL_CHARS) return httpError(400, `The pack is ${total} characters in all, over the ${MAX_TOTAL_CHARS} a pack can be`);
  if (!guidance.value.trim() && !Object.keys(stageGuidance).length && !files.length) {
    return httpError(400, 'A pack needs guidance, stage guidance or a file');
  }
  return { ok: true, pack: { name, guidance: guidance.value, stageGuidance, files, notes: notes.value.trim() || null } };
}

/** The hash a pack's content is stored under: the same content, the same hash. Pure. */
function hashOf(pack) {
  const sg = Object.fromEntries(STAGES.filter((s) => pack.stageGuidance?.[s]).map((s) => [s, pack.stageGuidance[s]]));
  const files = [...(pack.files || [])].map((f) => ({ path: f.path, content: f.content })).sort((a, b) => a.path.localeCompare(b.path));
  return crypto.createHash('sha256').update(JSON.stringify({ guidance: pack.guidance || '', stageGuidance: sg, files })).digest('hex');
}

/** What a pack adds to one stage's prompt: its guidance, then the stage's own. Pure; '' for none. */
function guidanceFor(pack, stage) {
  if (!pack) return '';
  const parts = [String(pack.guidance || '').trim(), String(pack.stage_guidance?.[stage] || pack.stageGuidance?.[stage] || '').trim()];
  return parts.filter(Boolean).join('\n\n');
}

/** A pack's files, as a starter's are listed. Pure. */
function filesOf(pack) {
  return (Array.isArray(pack?.files) ? pack.files : []).map((f) => ({ path: String(f.path), content: String(f.content ?? '') }));
}

/** A starter's files with a pack's on top: a pack file replaces a starter file of the same path. Pure. */
function withPackFiles(files, pack) {
  const extra = filesOf(pack);
  if (!extra.length) return files;
  const replaced = new Set(extra.map((f) => f.path));
  return [...files.filter((f) => !replaced.has(f.path)), ...extra];
}

function rowOut(r, { full = false } = {}) {
  if (!r) return null;
  const files = Array.isArray(r.files) ? r.files : [];
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    parentId: r.parent_id || null,
    sha256: r.sha256,
    notes: r.notes || null,
    createdBy: r.created_by_username || null,
    createdAt: r.created_at,
    usedAt: r.used_at || null,
    guidanceChars: String(r.guidance || '').length,
    stages: Object.keys(r.stage_guidance || {}).filter((s) => STAGES.includes(s)),
    files: files.map((f) => ({ path: f.path, chars: String(f.content || '').length })),
    ...(full ? {
      guidance: r.guidance || '',
      stageGuidance: r.stage_guidance || {},
      fileContents: files.map((f) => ({ path: f.path, content: String(f.content || '') })),
    } : {}),
  };
}

async function packRow(pool, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const { rows } = await pool.query(
    `SELECT p.*, u.username AS created_by_username
       FROM bench_context_packs p LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = $1`,
    [n],
  );
  return rows[0] || null;
}

/**
 * Save a pack: the next version of its name. With `parentId`, whatever the
 * call leaves out (name, guidance, stage guidance, files, notes) is the
 * parent's. Resolves { ok, pack } or a refusal.
 */
async function create(pool, raw = {}, { actorId = null } = {}) {
  let parent = null;
  if (raw.parentId != null) {
    parent = await packRow(pool, raw.parentId);
    if (!parent) return httpError(404, 'No such parent pack');
  }
  const pick = (key, parentValue) => (raw[key] !== undefined && raw[key] !== null ? raw[key] : parentValue);
  const v = validate({
    name: pick('name', parent?.name),
    guidance: pick('guidance', parent?.guidance),
    stageGuidance: pick('stageGuidance', parent?.stage_guidance),
    files: pick('files', parent?.files),
    notes: raw.notes !== undefined ? raw.notes : null,
  });
  if (!v.ok) return v;
  const p = v.pack;
  const { rows } = await pool.query(
    `INSERT INTO bench_context_packs (name, version, parent_id, guidance, stage_guidance, files, notes, sha256, created_by)
     VALUES ($1, COALESCE((SELECT MAX(version) FROM bench_context_packs WHERE name = $1), 0) + 1,
             $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
     RETURNING id`,
    [p.name, parent ? parent.id : null, p.guidance, JSON.stringify(p.stageGuidance), JSON.stringify(p.files), p.notes, hashOf(p), actorId],
  );
  return { ok: true, pack: rowOut(await packRow(pool, rows[0].id), { full: true }) };
}

/** Every pack, newest first: its sizes and file paths, never its text. */
async function list(pool, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT p.*, u.username AS created_by_username
       FROM bench_context_packs p LEFT JOIN users u ON u.id = p.created_by
      ORDER BY p.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
  return rows.map((r) => rowOut(r));
}

/**
 * The lines that differ between two texts, as a short unified listing:
 * each changed line with a line of context either side, `…` between runs.
 * Pure. An LCS over lines; long texts are cut to DIFF_MAX_LINES.
 */
function lineDiff(before, after) {
  const a = String(before || '').split('\n').slice(0, DIFF_MAX_LINES);
  const b = String(after || '').split('\n').slice(0, DIFF_MAX_LINES);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i] });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ op: '-', line: a[i] });
      i += 1;
    } else {
      ops.push({ op: '+', line: b[j] });
      j += 1;
    }
  }
  const keep = new Set();
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    for (const x of [k - 1, k, k + 1]) if (x >= 0 && x < ops.length) keep.add(x);
  });
  const out = [];
  let last = -2;
  for (let k = 0; k < ops.length; k += 1) {
    if (!keep.has(k)) continue;
    if (last >= 0 && k > last + 1) out.push('…');
    out.push(`${ops[k].op}${ops[k].line}`);
    last = k;
  }
  return out.join('\n');
}

/** What a version changed from its parent: the guidance's lines, and files added, removed and changed. Pure. */
function diffFrom(parent, pack) {
  if (!parent) return null;
  const files = (x) => new Map((Array.isArray(x?.files) ? x.files : []).map((f) => [f.path, String(f.content || '')]));
  const before = files(parent);
  const after = files(pack);
  const stageText = (x) => STAGES.map((s) => (x?.stage_guidance?.[s] ? `[${s}]\n${x.stage_guidance[s]}` : '')).filter(Boolean).join('\n');
  return {
    parentId: parent.id,
    parentVersion: parent.version,
    guidance: lineDiff(parent.guidance, pack.guidance),
    stageGuidance: lineDiff(stageText(parent), stageText(pack)),
    filesAdded: [...after.keys()].filter((p) => !before.has(p)),
    filesRemoved: [...before.keys()].filter((p) => !after.has(p)),
    filesChanged: [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p)),
  };
}

/** One pack in full, with what it changed from its parent. */
async function get(pool, id) {
  const row = await packRow(pool, id);
  if (!row) return httpError(404, 'No such pack');
  const parent = row.parent_id ? await packRow(pool, row.parent_id) : null;
  return { ok: true, pack: rowOut(row, { full: true }), diff: diffFrom(parent, row) };
}

/** The packs a launch names, read whole; null for 0 (no pack). Refuses an id that does not exist. */
async function loadForLaunch(pool, ids = []) {
  const out = new Map();
  for (const id of ids) {
    if (id === 0) { out.set(0, null); continue; }
    // eslint-disable-next-line no-await-in-loop
    const row = await packRow(pool, id);
    if (!row) return httpError(404, `No such pack: ${id}`);
    out.set(id, row);
  }
  return { ok: true, packs: out };
}

async function markUsed(pool, ids = []) {
  const real = ids.filter((id) => Number.isInteger(id) && id > 0);
  if (!real.length) return;
  await pool.query('UPDATE bench_context_packs SET used_at = COALESCE(used_at, NOW()) WHERE id = ANY($1::int[])', [real]);
}

module.exports = {
  STAGES,
  MAX_GUIDANCE_CHARS,
  MAX_STAGE_CHARS,
  MAX_FILES,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
  validPath,
  validate,
  hashOf,
  guidanceFor,
  filesOf,
  withPackFiles,
  rowOut,
  packRow,
  create,
  list,
  lineDiff,
  diffFrom,
  get,
  loadForLaunch,
  markUsed,
};
