'use strict';

// #3654: what a judge sees of a candidate is BLIND to the model that wrote it.
//
// A grading item never carries the model id, the vendor, the trial id, the
// run, or anything that orders items by model: it is addressed by an opaque
// token, and the queue hands items out in token order, which is random. But a
// model can also name itself in what it wrote ("As Claude…", a Codex footer,
// a commit trailer), and a judge that recognises a name grades the name. So
// every string of the CANDIDATE'S output is scrubbed of the names below
// before it is shown: model ids and their parts, vendor names, product and
// family names. The request itself is left alone: it is the task, and a
// request about Claude is about Claude.
//
// The vocabulary is built from the benchmark's own model list plus every
// model a run has used, so a model added to a run is scrubbed too.

const MASK = '[model]';

// Names a model or its maker might use for itself, beyond what the ids say.
// Not here on purpose: words ordinary code is full of ("codex", the harness
// every model runs on; "meta", "google"; short tokens such as "o3"), which
// would garble the very diff being judged and identify nobody.
const KNOWN_NAMES = Object.freeze([
  'anthropic', 'claude', 'sonnet', 'opus', 'haiku', 'fable',
  'openai', 'chatgpt', 'gpt',
  'z-ai', 'zhipu', 'glm', 'chatglm',
  'xiaomi', 'mimo',
  'deepseek',
  'qwen', 'tongyi',
  'minimax',
  'moonshot', 'moonshotai', 'kimi',
  'gemini', 'llama', 'mistral', 'grok',
]);

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The words to scrub for a set of model ids: each id whole, its vendor, its
 * model part, and the name part of the model without its version
 * (`glm-5.3-flash` gives `glm`), plus the known names. Longest first, so an
 * id is masked whole before its parts are.
 */
function vocabulary(modelIds = []) {
  const words = new Set(KNOWN_NAMES);
  for (const raw of modelIds) {
    const id = String(raw || '').toLowerCase().trim();
    if (!id) continue;
    words.add(id);
    const [vendor, model = ''] = id.split('/');
    if (vendor) words.add(vendor);
    if (model) {
      words.add(model);
      const head = model.split(/[-_.:]/)[0];
      if (head && head.length >= 3 && !/^\d/.test(head)) words.add(head);
      // `deepseek-v4.1-flash` without its size suffix, `claude-sonnet-5.5` without its version.
      words.add(model.replace(/[-_.:]?(flash|pro|mini|code|turbo|lite|instruct|chat)$/i, ''));
    }
  }
  return [...words].filter((w) => w && w.length >= 2).sort((a, b) => b.length - a.length);
}

function scrubber(modelIds) {
  const words = vocabulary(modelIds);
  // A word is matched on its own, not inside another word: "opus" in
  // "magnum opus" goes, "glm" inside "glmx" does not; "o3" only as a token.
  const re = new RegExp(`(^|[^a-z0-9])(${words.map(escapeRe).join('|')})(?=$|[^a-z0-9])`, 'gi');
  // A name and the version or second name after it are one name: "Claude
  // Sonnet 5.5" is one [model], not "[model] [model] 5.5", whose version
  // would still say which model it was.
  const run = /\[model\](?:[\s-]+(?:\[model\]|v?\d+(?:\.\d+)*[a-z]?)(?![\w.]))+/gi;
  return (text) => String(text).replace(re, (_m, lead) => `${lead}${MASK}`).replace(run, MASK);
}

/** One string, scrubbed. */
function blindText(text, modelIds = []) {
  if (text == null) return text;
  return scrubber(modelIds)(text);
}

/**
 * Every string anywhere in `value` (objects and arrays included), scrubbed.
 * Keys are kept: they are the item's own structure, not the candidate's.
 */
function blindValue(value, modelIds = []) {
  const scrub = scrubber(modelIds);
  const walk = (v) => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/** True when `text` still names any of the models: the test's own check. */
function leaks(text, modelIds = []) {
  const lower = String(text || '').toLowerCase();
  return modelIds.some((id) => {
    const full = String(id).toLowerCase();
    return lower.includes(full) || lower.includes(full.split('/')[0] + '/');
  });
}

module.exports = {
  MASK,
  KNOWN_NAMES,
  vocabulary,
  blindText,
  blindValue,
  leaks,
};
