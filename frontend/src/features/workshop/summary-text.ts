/**
 * A proposal's summary is Markdown written for its own page. On a card it is
 * a paragraph: headings, emphasis, code ticks and list markers go, a fenced
 * block goes whole (an `explain` fence included, and one a length cap cut
 * before its close), a link keeps its words, and the whitespace collapses.
 * The Description sheet has it rendered.
 */
export function plainSummary(md: string | null | undefined): string {
  return String(md || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
