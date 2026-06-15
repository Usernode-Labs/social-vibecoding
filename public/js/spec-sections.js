// splitSpecSections (#196) — pure splitter for the platform's two-half
// spec convention. A conforming spec contains exactly two H2 marker
// headings, "## User-facing changes" and "## Technical implementation"
// (mandated by the scout prompt in src/routes/sessions.js); the
// dev-chat spec viewer renders the two halves as tabs so non-technical
// readers can stay on the plain-language half.
//
// Tabbed mode requires BOTH markers: if either is missing the function
// returns null and the caller renders the document untabbed, exactly as
// legacy specs always rendered — a miss degrades to today's behaviour,
// never to hidden content.
//
// Matching is deliberately lenient (heading level 1-3, case-insensitive,
// optional trailing colon, "User facing"/"User-facing", singular
// "change") so slight scout drift from the mandate still splits; marker
// lines inside fenced code blocks are ignored (e.g. a spec quoting the
// convention itself). The marker heading lines are dropped from the
// returned halves — the tab labels replace them.
//
// Loaded as a plain script before dev-chat.js (see public/index.html);
// the module.exports guard lets tests/spec-sections.test.js require it
// directly instead of mirroring the logic.
function splitSpecSections(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;

  const USER_RE = /^#{1,3}\s+user[- ]facing changes?\s*:?\s*$/i;
  const TECH_RE = /^#{1,3}\s+technical implementation\s*:?\s*$/i;

  const lines = markdown.split('\n');
  let userIdx = -1;
  let techIdx = -1;

  // Fence tracking mirrors src/services/spec-format.js: CommonMark code
  // fences don't nest, so a single in/out toggle suffices — a fence line
  // opens a block; a later bare fence with the same marker char (length
  // ≥ opener) closes it.
  let insideFence = false;
  let fenceMarker = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const fence = /^([`~]{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const info = fence[2].trim();
      if (!insideFence) {
        insideFence = true;
        fenceMarker = marker;
        fenceLen = len;
      } else if (marker === fenceMarker && len >= fenceLen && info === '') {
        insideFence = false;
      }
      continue;
    }
    if (insideFence) continue;
    if (userIdx === -1 && USER_RE.test(lines[i])) { userIdx = i; continue; }
    if (techIdx === -1 && TECH_RE.test(lines[i])) techIdx = i;
  }

  if (userIdx === -1 || techIdx === -1) return null;

  // Each half runs from just after its marker to the other marker or
  // EOF, whichever comes first — this also handles markers emitted in
  // reverse order. The preamble (title + summary before the first
  // marker) is always visible above the tabs, so nothing is hidden.
  const firstIdx = Math.min(userIdx, techIdx);
  const sliceHalf = (ownIdx, otherIdx) => {
    const end = otherIdx > ownIdx ? otherIdx : lines.length;
    return lines.slice(ownIdx + 1, end).join('\n').trim();
  };

  return {
    preamble: lines.slice(0, firstIdx).join('\n').trim(),
    userFacing: sliceHalf(userIdx, techIdx),
    technical: sliceHalf(techIdx, userIdx),
  };
}

if (typeof window !== 'undefined') window.splitSpecSections = splitSpecSections;
if (typeof module !== 'undefined' && module.exports) module.exports = { splitSpecSections };
