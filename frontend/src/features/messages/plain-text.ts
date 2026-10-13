/** Where an escaped character waits: the start of Unicode's private use area. */
const ESCAPED = 0xe000;

/**
 * One line of plain text from a message's markdown, for the places that show
 * a message in passing rather than render it: the quote above a reply
 * (message-row.tsx's `.messages-quote`), the composer's "Replying to" bar
 * (composer.tsx's `.messages-reply-draft`) and an inbox row's preview
 * (api.ts's `latestSummary`, drawn as `.messages-row-preview`).
 *
 * Those used to print the source as it was typed, so a Homeroom bot message,
 * which opens with `**Project** · request #12: …`, showed its asterisks. This
 * keeps the words and drops the markup: emphasis, strike-through and inline
 * code markers, heading, list and quote markers at the start of a line,
 * fences and rules, and a link or an image becomes its text. What is left is
 * folded onto one line, since every caller shows one or two lines of it.
 *
 * Not a markdown parser, and not trying to be one: anything it does not
 * recognise stays as it was, which is the old behaviour. A word with an
 * underscore inside it (`snake_case`) and a lone `*` in arithmetic are left
 * alone.
 */
export function plainText(markdown: string | null | undefined): string {
  let text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  // A backslash escape keeps the character it escapes, and that character is
  // never markup: it is set aside (as a private-use character) until the end.
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, c: string) => String.fromCharCode(ESCAPED + c.charCodeAt(0)));
  // Code fences: the code stays, the fence lines go.
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, '');
  // Inline code keeps its text and loses its ticks: a run of N ticks closes
  // at the next run of exactly N, so ``a `tick` inside`` keeps its one.
  text = text.replace(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, '$2');
  // An image or a link becomes its text; an autolink its address.
  text = text.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  text = text.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1');
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1');
  // What opens a line: a quote, a heading, a bullet (with its checkbox), a
  // number. Then a rule, which is all markup.
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');
  text = text.replace(/^[ \t]*\d{1,9}[.)][ \t]+/gm, '');
  // Emphasis, strongest first, so `***both***` loses all three.
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = text.replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1$2');
  text = text.replace(/(^|[^\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, '$1$2');
  text = text.replace(/[\uE000-\uE07F]/g, (c) => String.fromCharCode(c.charCodeAt(0) - ESCAPED));
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The Homeroom bot's DM row, read in passing. Its news about a request opens
 * with the request's line, `**Flat 4B Chores** · request #7: Fix mark as
 * done` (services/homeroom-bot-dm.js requestLine), so the row read "Flat 4B
 * Chores · request #7: Fix mark as done Filed. …". The row keeps the
 * project and the title and drops the number (first-session run-through,
 * 5 Oct 2026); the message itself keeps it. A line with no title keeps its
 * number, which is then all it names the request by. Takes `plainText`'s
 * output.
 */
export function botRowPreview(summary: string): string {
  return summary.replace(/ · request #\d+: /, ' · ');
}
