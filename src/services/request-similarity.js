'use strict';

// Open requests that look like the one somebody is about to file. When the
// bot offers to file a request (the DM chat's offer_request, a thread's), it
// names the project's open requests whose titles share most of their words
// with the new one, so it can offer to add the person's words to that request
// instead of a second copy for the group to sort out. It only says so: File
// it stays theirs to tap.
//
// Cheap on purpose: titles only, from the board the platform already caches
// (github.fetchPublicIssues, five minutes per repository), and plain words
// rather than a model. A title shares a word when both say it; a request
// looks the same when at least two of its words are shared and they are most
// of the shorter title's.

const MIN_SHARED = 2;
const MIN_OVERLAP = 0.6;
const MAX_SIMILAR = 3;

// Words that say nothing about what a request is for.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'there', 'their', 'when', 'what', 'which',
  'should', 'would', 'could', 'can', 'will', 'please', 'add', 'make', 'let', 'lets', 'allow', 'show', 'new', 'more',
  'app', 'page', 'screen', 'button', 'feature', 'option', 'able', 'want', 'need', 'not', 'are', 'its', 'our', 'your',
  'yang', 'dan', 'untuk', 'dengan', 'dari', 'agar', 'bisa', 'tambah', 'tambahkan', 'fitur', 'ini', 'itu',
]);

/** A title's words: lower case, three letters or more, the plain ones left out, a plural's trailing s dropped. */
function titleWords(title) {
  const words = String(title || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (const word of words) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    out.add(word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return out;
}

/**
 * Pure: the open requests in `issues` ({ number, title }) whose titles look
 * like `title`, closest first, at most `limit`. [] when the title has too few
 * words to tell.
 */
function similarRequests(issues, title, { limit = MAX_SIMILAR } = {}) {
  const mine = titleWords(title);
  if (mine.size < MIN_SHARED) return [];
  const scored = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    const number = Number(issue?.number);
    if (!Number.isInteger(number) || number <= 0) continue;
    const theirs = titleWords(issue.title);
    if (theirs.size < MIN_SHARED) continue;
    let shared = 0;
    for (const word of mine) if (theirs.has(word)) shared += 1;
    const overlap = shared / Math.min(mine.size, theirs.size);
    if (shared >= MIN_SHARED && overlap >= MIN_OVERLAP) scored.push({ number, title: String(issue.title || '').trim(), shared, overlap });
  }
  scored.sort((a, b) => b.overlap - a.overlap || b.shared - a.shared || b.number - a.number);
  return scored.slice(0, limit).map(({ number, title: t }) => ({ number, title: t }));
}

/**
 * The open requests on `app` that look like `title`, from its cached board.
 * Never throws; [] when the board cannot be read.
 */
async function openSimilar(app, title, { github = require('./github'), parseRepo = null } = {}) {
  try {
    const parse = parseRepo || require('./homeroom-bot').parseRepo;
    const repo = parse(app?.repo_url);
    if (!repo || typeof github.fetchPublicIssues !== 'function') return [];
    const { issues } = await github.fetchPublicIssues(repo.owner, repo.repo);
    return similarRequests(issues, title);
  } catch {
    return [];
  }
}

module.exports = {
  MAX_SIMILAR,
  similarRequests,
  openSimilar,
  titleWords,
};

/** The closest other open request, using the same title rule as the bot. */
function closestTwins(issues, { together = () => false } = {}) {
  const rows = (Array.isArray(issues) ? issues : []).filter((i) => i && i.state !== 'closed' && !i.title_fallback
    && Number.isSafeInteger(Number(i.number)) && Number(i.number) > 0)
    .map((i) => ({ ...i, number: Number(i.number), words: titleWords(i.title) }));
  const scored = new Map();
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const a = rows[i]; const b = rows[j];
    if (a.number === b.number || together(a, b) || Math.min(a.words.size, b.words.size) < MIN_SHARED) continue;
    let shared = 0;
    for (const word of a.words) if (b.words.has(word)) shared += 1;
    const overlap = shared / Math.min(a.words.size, b.words.size);
    if (shared < MIN_SHARED || overlap < MIN_OVERLAP) continue;
    for (const [mine, other] of [[a, b], [b, a]]) {
      const old = scored.get(mine.number);
      if (!old || overlap > old.overlap || (overlap === old.overlap && (shared > old.shared
        || (shared === old.shared && other.number > old.number)))) {
        scored.set(mine.number, { number: other.number, title: String(other.title || '').trim(), shared, overlap });
      }
    }
  }
  return new Map([...scored].map(([number, { number: twin, title }]) => [number, { number: twin, title }]));
}

/** Optional decoration, never a reason to lose the board if its read fails. */
async function boardTwins(pool, appId, issues, fallbackTitle) {
  let stored = [];
  try {
    stored = (await pool.query(
      "SELECT number, title, thread_id FROM requests WHERE app_id = $1 AND state = 'open' AND title <> $2",
      [appId, fallbackTitle])).rows;
  } catch { /* the existing board still answers without hints */ }
  const threads = new Map(stored.map((i) => [Number(i.number), i.thread_id]));
  const byNumber = new Map(stored.map((i) => [Number(i.number), i]));
  for (const issue of issues) byNumber.set(Number(issue.number), { ...issue,
    title_fallback: issue.title_fallback || issue.title === fallbackTitle });
  return closestTwins([...byNumber.values()], { together: (a, b) => {
    const thread = threads.get(a.number);
    return thread != null && thread === threads.get(b.number);
  } });
}

module.exports.closestTwins = closestTwins;
module.exports.boardTwins = boardTwins;
