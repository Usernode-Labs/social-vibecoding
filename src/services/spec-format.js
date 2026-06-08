// Spec-text normalization shared by the spec-capture path (routes/sessions.js)
// and the one-time backfill (db/migrate.js).

// A scout / spec-author LLM sometimes wraps its ENTIRE markdown spec in a
// single ```markdown … ``` fence — it reads "produce a markdown document" as
// "emit one fenced markdown block". Stored verbatim, that makes the whole spec
// render as one big code block instead of formatted markdown (session 153;
// ~13% of specs in prod). This unwraps that case so spec_md holds raw markdown.
//
// Deliberately conservative — it only strips when the document is EXACTLY one
// fenced block: the first non-empty line is an opening fence whose info string
// is empty or markdown-ish (markdown/md/gfm), and the matching closing fence
// (same marker char, length ≥ opener per CommonMark) is the LAST non-empty
// line with nothing after it. A spec that merely starts with a code block, has
// content after the fence, or is fenced as another language (```json, ```js,
// …) is returned unchanged. When inner triple-backtick fences make the wrapper
// boundary ambiguous (the F6 case), the closing fence won't be last → we leave
// it alone rather than guess.
function stripSpecWrapperFence(content) {
  if (typeof content !== 'string') return content;
  const text = content.trim();
  if (!text) return content;

  const lines = text.split('\n');
  const open = /^([`~]{3,})(.*)$/.exec(lines[0]);
  if (!open) return content;
  const fence = open[1];
  const marker = fence[0];
  const info = open[2].trim().toLowerCase();
  // A valid opener's info string can't contain the fence char, and we only
  // unwrap markdown-ish (or unlabeled) wrappers.
  if (info.includes(marker)) return content;
  if (info !== '' && info !== 'markdown' && info !== 'md' && info !== 'gfm') return content;

  // Closing fence: a line that is only the marker char repeated ≥ opener len.
  const closeRe = new RegExp(`^\\${marker}{${fence.length},}\\s*$`);
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) { closeIdx = i; break; }
  }
  if (closeIdx === -1) return content;
  // Any real content after the (first) closing fence means this isn't a
  // whole-document wrapper — bail.
  for (let i = closeIdx + 1; i < lines.length; i++) {
    if (lines[i].trim()) return content;
  }

  const inner = lines.slice(1, closeIdx).join('\n').trim();
  return inner || content;
}

module.exports = { stripSpecWrapperFence };
