'use strict';

/**
 * THE HOMEROOM BOT TAB'S SEARCH, IN WHAT WAS SAID (13 Nov 2026).
 *
 * The tab's search box narrowed the rows on the page by title, number and
 * project (frontend/src/features/ai/lines.ts). A tester typed "improve" and
 * was told nothing matched, although they had written "I want to improve my
 * app." to the bot: what was said in the chat was never searched, here or
 * anywhere. This reads it.
 *
 * WHOSE MESSAGES. The signed-in person's own chat with Homeroom bot, and
 * nothing else: the one direct conversation of the pair (them, the bot's
 * account), found on the server from who is signed in. No conversation id is
 * taken from the request, so there is none to forge.
 *
 * WHICH MESSAGES. What either of the two said there, in the chat itself and
 * in its threads: a person looks for the bot's answer ("what did it say
 * about the calendar?") as often as for their own words, and each row says
 * who wrote it. Left out:
 *   - a deleted message, and one moderation hid;
 *   - a system line;
 *   - the line the bot writes to open a thread ("New thread…", metadata kind
 *     `opened_…`): it is the thread's door, not something said in it;
 *   - a request's news in the chat itself (conversations.js REQUEST_NEWS),
 *     which the chat no longer draws, so there is no message to land on;
 *   - a reply under a deleted first message.
 *
 * WHAT COMES BACK. The newest MAX_HITS matches, each with where it is (its
 * thread's first message and that thread's title as the tab's list names it,
 * or neither for the chat itself), who wrote it, when, and a short snippet
 * of plain text round the first match with where the match is in it. The
 * client marks those ranges by splitting the text; no markup is sent.
 */

const aiWork = require('./ai-work');
const conversations = require('./conversations');

/** A shorter query matches too much to be an answer (the board search's floor, routes/issues.js). */
const MIN_CHARS = 2;
/** The longest query read; the rest is cut. */
const MAX_CHARS = 100;
/** The newest matches a search answers with. */
const MAX_HITS = 20;
/**
 * The snippet: a word or two before the match and the rest of the line
 * after it, about eighty characters in all. Short before, so the match is
 * still on the line where a row is cut to a phone's width (about thirty
 * characters).
 */
const LEAD = 16;
const TAIL = 64;
/** Fewer characters than this before the lead are kept, not swapped for an "…". */
const LEAD_SLACK = 8;

/** Pure: what was typed, as the search reads it: one line, trimmed, MAX_CHARS at most. */
function cleanQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS).trim();
}

/** Pure: the query as a LIKE pattern. It is data, so its wildcards are escaped, not read. */
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const ESCAPED = 0xe000;

/**
 * Pure: one line of plain text from a message's markdown, as the tab's
 * previews read one (frontend/src/features/messages/plain-text.ts plainText,
 * which this follows rule for rule; tests/ai-search.test.js holds the two to
 * the same answers).
 */
function plainText(markdown) {
  let text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, c) => String.fromCharCode(ESCAPED + c.charCodeAt(0)));
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, '');
  text = text.replace(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, '$2');
  text = text.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');
  text = text.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1');
  text = text.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1');
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/^[ \t]*[-*+][ \t]+(?:\[[ xX]\][ \t]+)?/gm, '');
  text = text.replace(/^[ \t]*\d{1,9}[.)][ \t]+/gm, '');
  text = text.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = text.replace(/\+\+(?=\S)([\s\S]*?\S)\+\+(?!\+)/g, '$1');
  text = text.replace(/(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])/g, '$1$2');
  text = text.replace(/(^|[^\w])_([^\s_](?:[^_\n]*?[^\s_])?)_(?!\w)/g, '$1$2');
  text = text.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - ESCAPED));
  return text.replace(/\s+/g, ' ').trim();
}

/** Pure: a test for the query in plain text, in either case, its spaces any run of them. */
function matcher(q) {
  const source = q.split(/\s+/).filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  if (!source) return null;
  try { return new RegExp(source, 'giu'); } catch { /* a lone surrogate: without Unicode case folding */ }
  try { return new RegExp(source, 'gi'); } catch { return null; }
}

/** Whether cutting `text` at `at` would split a character that takes two code units. */
function splitsPair(text, at) {
  const c = text.charCodeAt(at);
  return at > 0 && at < text.length && c >= 0xdc00 && c <= 0xdfff;
}

/**
 * Pure: a message's snippet for a query: its plain text round the first
 * match, cut at whole words with "…" where it was cut, and where every
 * match is in it (`ranges`: [start, end) pairs of string offsets, in order,
 * never overlapping). A message whose match is in its markup only (a link's
 * address, say) gives its opening words and no ranges.
 */
function snippetOf(content, q) {
  const text = plainText(content);
  if (!text) return { snippet: '', ranges: [] };
  const find = matcher(q);
  const first = find ? find.exec(text) : null;
  const found = !!first && first[0].length > 0;
  // No match in the words themselves: the message's opening, the same length.
  const at = found ? first.index : 0;
  const hitEnd = found ? at + first[0].length : 0;
  let start = found && at > LEAD + LEAD_SLACK ? at - LEAD : 0;
  let end = Math.min(text.length, found ? hitEnd + TAIL : LEAD + TAIL);
  if (start > 0 && text[start - 1] !== ' ') {
    // Forward to the first whole word, when one starts before the match.
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < at) start = space + 1;
    else if (splitsPair(text, start)) start += 1;
  }
  if (end < text.length && text[end] !== ' ') {
    // Back to the last whole word, when one ends after the match.
    const space = text.lastIndexOf(' ', end);
    if (space > Math.max(hitEnd, start)) end = space;
    else if (splitsPair(text, end)) end -= 1;
  }
  const head = start > 0 ? '…' : '';
  const cut = end < text.length;
  const body = cut ? text.slice(start, end).replace(/[\s,;:]+$/, '') : text.slice(start, end);
  const snippet = `${head}${body}${cut ? '…' : ''}`;
  const ranges = [];
  if (found) {
    find.lastIndex = 0;
    for (let m = find.exec(body); m; m = find.exec(body)) {
      if (!m[0]) { find.lastIndex += 1; continue; }
      ranges.push([head.length + m.index, head.length + m.index + m[0].length]);
    }
  }
  return { snippet, ranges };
}

// $1 the person, $2 the bot's account, $3 the LIKE pattern, $4 how many.
// The conversation is the pair's one direct conversation, and the person is
// a member of it. A thread's title columns are the ones the tab's list reads
// for the same thread (ai-work.js PRIVATE_SQL), so shapePrivate names it the
// same way here. `opened_`: by LEFT, since `_` is a wildcard to LIKE.
const SEARCH_SQL = `
SELECT m.id, m.thread_root_id, m.sender_id, m.content, m.created_at,
       root.content AS root_content,
       p.id AS private_id, p.kind, p.about_kind, p.about_number,
       (SELECT f.content FROM conversation_messages f
         WHERE f.thread_root_id = root.id AND f.sender_id = $1 AND f.deleted_at IS NULL
         ORDER BY f.id LIMIT 1) AS first_own,
       COALESCE((SELECT rq.title FROM requests rq
                  WHERE p.about_kind = 'request' AND rq.app_id = p.app_id AND rq.number = p.about_number),
                root.metadata->'homeroomBot'->>'aboutTitle') AS about_title,
       (SELECT d.title FROM design_threads d WHERE d.private_thread_id = p.id) AS design_title,
       root.metadata->'homeroomBot'->>'projectIdea' AS project_idea,
       root.metadata->'homeroomBot'->>'draftTitle' AS draft_title,
       root.metadata->'homeroomBot'->>'appName' AS root_app_name,
       (SELECT a.name FROM apps a WHERE a.id = p.app_id) AS name,
       root.id AS root_id
  FROM conversation_direct_pairs pair
  JOIN conversations c ON c.id = pair.conversation_id AND c.kind = 'direct'
  JOIN conversation_members mine
    ON mine.conversation_id = c.id AND mine.user_id = $1 AND mine.status = 'member'
  JOIN conversation_messages m ON m.conversation_id = c.id
  -- 14 Nov 2026: every message is in a thread; one that is not a reply is
  -- its own thread's first message.
  JOIN conversation_messages root ON root.id = COALESCE(m.thread_root_id, m.id)
  LEFT JOIN private_threads p ON p.root_message_id = root.id AND p.user_id = $1
 WHERE pair.user_low_id = LEAST($1::int, $2::int)
   AND pair.user_high_id = GREATEST($1::int, $2::int)
   AND m.msg_type = 'message'
   AND m.deleted_at IS NULL
   AND m.moderation_hidden_at IS NULL
   AND (m.thread_root_id IS NULL OR root.deleted_at IS NULL)
   AND LEFT(COALESCE(m.metadata->'homeroomBot'->>'kind', ''), 7) <> 'opened_'
   AND NOT (m.thread_root_id IS NULL AND ${conversations.REQUEST_NEWS})
   AND m.content ILIKE $3 ESCAPE '\\'
 ORDER BY m.id DESC
 LIMIT $4`;

/** Pure: a thread's name for a match in it, as the tab's list names that thread. */
function threadTitleOf(row) {
  if (row.private_id != null) {
    return aiWork.shapePrivate({ ...row, root_id: row.root_id ?? row.thread_root_id, content: row.root_content }).title || '';
  }
  // A thread that grew from something said in the chat: its first words.
  return aiWork.firstLine(plainText(aiWork.firstLine(row.root_content, 400)));
}

/** Pure: one match as the tab draws it, or null for a message with no words to show. */
function shapeHit(row, q, userId) {
  const { snippet, ranges } = snippetOf(row.content, q);
  if (!snippet) return null;
  // The thread the match is in: its own, when it is a thread's first message.
  const rootId = Number(row.root_id ?? row.thread_root_id) || null;
  return {
    messageId: Number(row.id),
    rootId,
    threadTitle: rootId ? threadTitleOf(row) || null : null,
    mine: Number(row.sender_id) === Number(userId),
    snippet,
    ranges,
    at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/**
 * The person's own chat with Homeroom bot, searched for `q` (already
 * cleaned: cleanQuery). → { q, rows, more }: the newest MAX_HITS matches,
 * and whether there were more than that.
 */
async function searchFor(pool, { user, q, deps = {} }) {
  const out = { q, rows: [], more: false };
  if (!user?.id || q.length < MIN_CHARS) return out;
  const bot = deps.bot || await require('./homeroom-bot-dm').botAccount(pool);
  if (!bot || Number(bot.id) === Number(user.id)) return out;
  const { rows } = await pool.query(SEARCH_SQL, [user.id, bot.id, likePattern(q), MAX_HITS + 1]);
  out.more = rows.length > MAX_HITS;
  out.rows = rows.slice(0, MAX_HITS).map((row) => shapeHit(row, q, user.id)).filter(Boolean);
  return out;
}

module.exports = {
  MIN_CHARS,
  MAX_CHARS,
  MAX_HITS,
  SEARCH_SQL,
  cleanQuery,
  likePattern,
  plainText,
  snippetOf,
  threadTitleOf,
  shapeHit,
  searchFor,
};
