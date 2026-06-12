// Spec-text normalization shared by the spec-capture path (routes/sessions.js)
// and the one-time backfill (db/migrate.js).
//
// A scout / spec-author LLM sometimes wraps its ENTIRE markdown spec in a
// single fenced block — it reads "produce a markdown document" as "emit one
// fenced markdown block". Two shapes show up in prod:
//   1. ```markdown … ```            (session 153; ~13% of specs)
//   2. ```filepath:SPEC.md … ```    (session 230 — Claude Code / file-citation
//                                     convention: the fence info string is the
//                                     path of the file it's "writing")
// Stored verbatim, either makes the whole spec render as one big code block
// instead of formatted markdown. This unwraps both so spec_md holds raw
// markdown.
//
// Still conservative — it only strips when the document is EXACTLY one fenced
// block:
//   • the first non-empty line is an opening fence whose info string is empty,
//     markdown-ish (markdown/md/gfm), or a file path pointing at a markdown
//     file (foo.md / filepath:SPEC.md / file:notes.markdown);
//   • the LAST non-empty line is a bare closing fence (same marker char,
//     length ≥ opener per CommonMark) with nothing after it;
//   • every code fence in between is balanced, so that final fence truly
//     closes the OUTER wrapper and not an inner block. A spec that opens with
//     ```json / ```js, has trailing content after the wrapper, or leaves an
//     inner fence unterminated is returned unchanged rather than guessing.
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
  // A valid opener's info string can't contain the fence char.
  if (info.includes(marker)) return content;
  // Only unwrap markdown-ish or markdown-file-path wrappers. A spec author who
  // opens with ```json / ```js etc. means a real code block, not a doc wrapper.
  if (!isMarkdownWrapperInfo(info)) return content;

  // The wrapper closer is the document's last non-empty line, and it must be a
  // bare closing fence (only the marker char repeated ≥ opener length).
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && !lines[lastIdx].trim()) lastIdx--;
  if (lastIdx === 0) return content;
  const bareCloseRe = new RegExp(`^\\${marker}{${fence.length},}\\s*$`);
  if (!bareCloseRe.test(lines[lastIdx])) return content;

  // Walk the inner region [1, lastIdx) and require inner code fences to be
  // balanced. CommonMark code fences don't nest, so a single in/out toggle is
  // enough: an inner fence opens a block; a later bare fence with the same
  // marker (length ≥) closes it. If we're still "inside" a block at the end,
  // the document's last fence was closing that inner block — not the wrapper —
  // so the boundary is ambiguous and we leave the content untouched.
  let insideInner = false;
  let innerMarker = '';
  let innerLen = 0;
  for (let i = 1; i < lastIdx; i++) {
    const m = /^([`~]{3,})(.*)$/.exec(lines[i]);
    if (!m) continue;
    const lm = m[1][0];
    const llen = m[1].length;
    const linfo = m[2].trim();
    if (!insideInner) {
      insideInner = true;
      innerMarker = lm;
      innerLen = llen;
    } else if (lm === innerMarker && llen >= innerLen && linfo === '') {
      insideInner = false;
    }
    // A fence line that doesn't close (different marker, or carries an info
    // string) is literal content inside the current inner block.
  }
  if (insideInner) return content;

  const inner = lines.slice(1, lastIdx).join('\n').trim();
  return inner || content;
}

// True when a fence info string marks a whole-document markdown wrapper rather
// than a real (other-language) code block. `info` is already lowercased and
// known not to contain the fence character.
function isMarkdownWrapperInfo(info) {
  if (info === '' || info === 'markdown' || info === 'md' || info === 'gfm') return true;
  // File-emission wrappers: ```filepath:SPEC.md, ```file:notes.md, or a bare
  // ```path/to/spec.md — an LLM citing the file it's writing. Treat as a
  // markdown wrapper only when the referenced file is itself markdown.
  let path = info;
  if (path.startsWith('filepath:')) path = path.slice('filepath:'.length);
  else if (path.startsWith('file:')) path = path.slice('file:'.length);
  return /\.(md|markdown)$/.test(path.trim());
}

module.exports = { stripSpecWrapperFence };
