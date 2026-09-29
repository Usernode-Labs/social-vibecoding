'use strict';

// #249: meaningful default session names — the display-name layer over
// machine-generated branch names. Sessions are titled:
//   1. From their first interactive message (maybeTitleFirstMessage).
//   2. At pre-PR turn ends, from the full request history + latest
//      spec draft (refreshFromHistory) so the name sharpens as the
//      session's focus develops.
//   3. Once a PR exists, applyPrMetadata (pr-metadata.js) mirrors
//      pr_title into session_title and owns the name from then on —
//      every UPDATE here is guarded on `pr_number IS NULL` so a slow
//      in-flight early-title call can never clobber a PR-mirrored one.
//      A manual proposal rename also sets `proposed_pr_title`; that is an
//      author choice, so the same guard keeps later automatic refreshes from
//      replacing it before the PR is created.
//   4. Headless auto sessions get the deterministic, LLM-free
//      "#N · issue title" at creation (headlessTitle), inherited by
//      clones.
//   5. OpenRouter sessions (#1949) are named the moment their first ask
//      arrives, without a helper-model call, by titleFromFirstMessage —
//      the same trim pr-metadata.js gives their PR title, so the name a
//      session shows before its PR is the name it keeps after. Since
//      #2500 that is a FIRST name, not the final one: their turn end
//      goes through refreshFromHistory like every other in-platform
//      session, so the helper model gets to describe what the change
//      actually does.
//   6. #2500: every path above shares one scaffolding rule. A session
//      started from an issue card opens with the seed
//      `Please implement GitHub issue #N: "<title>".…`, and naming a
//      change after the instruction to make it is useless. parseIssueSeed
//      peels the wrapper off, so the deterministic name is the issue
//      title and the model is handed that title as its issueTitle input.
//      When no helper model is reachable at all, generateAndApply falls
//      back to the same deterministic name rather than leaving the
//      session showing its branch.
//
// Every entry point is fire-and-forget: the returned promise ALWAYS
// resolves (with the new title, or null on failure/skip) and never
// rejects, so callers can ignore it without risking an unhandled
// rejection — title generation must never fail or block a turn.

const log = require('./logger');
const llm = require('./llm');
const limits = require('./limits');

// Deterministic headless display name: "#N · <issue title>", truncated
// to fit the VARCHAR(256) column. Returns null when the issue fetch
// degraded to number-only (no title to show — the branch-name fallback
// is better than a bare "#N · ").
function headlessTitle(issueNumber, issueTitle) {
  const n = parseInt(issueNumber, 10);
  const t = String(issueTitle || '').replace(/\s+/g, ' ').trim();
  if (!Number.isInteger(n) || n <= 0 || !t) return null;
  return `#${n} · ${t}`.slice(0, 256);
}

// The deterministic, LLM-free trim an OpenRouter session's display name
// and its PR title (deterministicPrMetadataDraft in pr-metadata.js) share:
// fenced code and markdown punctuation dropped, whitespace collapsed, and
// a hard 72-character ceiling with an ellipsis on truncation. Returns ''
// when nothing readable survives so each caller picks its own fallback.
// One derivation on purpose — the session name and the PR title stay
// identical only while they come from the same function.
const DETERMINISTIC_TITLE_MAX = 72;

// #2500: the issue card's "Create proposal" button seeds the composer with
// scaffolding around the issue (public/js/app-view.js createPrForIssue):
//
//   Please implement GitHub issue #N: "<issue title>".<issue body>
//   Open a PR that closes this issue (include "Closes #N" so it links …).
//
// Left alone that wrapper IS the name: the trim below strips the `#` along
// with the rest of the markdown punctuation and cuts at 72, which is how a
// session came to be called `Please implement GitHub issue 2496: "Add
// claimed issues to workshop cur…`. Peel the wrapper off wherever a title
// is derived, so the deterministic name is the ISSUE TITLE the scaffolding
// was wrapping, and hand that same title to the model as the issue-title
// signal generateSessionTitle already accepts.
const ISSUE_SEED_RE = /^\s*Please implement GitHub issue #(\d+):\s*"([\s\S]*?)"\.[ \t]*/;
// The closing instruction the same seed appends. It is guidance for the
// agent, never a description of the change, so it is dropped from the model
// prompt too.
const ISSUE_SEED_TAIL_RE = /\s*Open a PR that closes this issue \(include "Closes #\d+"[^)]*\)\.?\s*$/;

// { number, title, body } for a message that is the issue-card seed, or
// null for anything a user wrote themselves.
function parseIssueSeed(text) {
  const raw = String(text || '');
  const m = ISSUE_SEED_RE.exec(raw);
  if (!m) return null;
  const number = parseInt(m[1], 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    number,
    title: m[2].replace(/\s+/g, ' ').trim(),
    body: raw.slice(m[0].length).replace(ISSUE_SEED_TAIL_RE, '').trim(),
  };
}

// #2653: a session named "just the first line of what I typed". The trim
// below used to be a blind prefix — collapse the message, cut at 72, add an
// ellipsis — which spends the whole budget on whatever the person happened
// to write first. For anyone who opens with a greeting, or whose first
// sentence runs long, that is a severed quotation rather than a name.
//
// Three rules, in order, all of which USE MORE OF THE MESSAGE rather than
// more of its opening:
//
//   1. Drop the conversational lead-in. "Hey, could you please " is 21 of
//      the 72 characters and says nothing about the change.
//   2. Prefer a WHOLE sentence. If one or more complete sentences fit, take
//      as many as fit — two short ones say more than one truncated one —
//      and drop the closing period, because a title has none.
//   3. Only then truncate, and at a word boundary rather than mid-word.
//
// A session started from an issue card keeps skipping all of this: its
// issue title is already a name, and re-phrasing a name is how you lose it.
const DETERMINISTIC_TITLE_MIN = 24;

// Openers worth spending no characters on. Matched repeatedly from the
// front, so "Hey — could you please …" loses all three pieces.
//
// The `(?![\w-])` after the alternation is load-bearing: without it the
// trailing punctuation class eats the hyphen in "Right-click the account
// menu" and "Hi-res image uploads", leaving "click the account menu" and
// "res image uploads". A hyphen glued to the next word is part of that
// word, not conversational punctuation.
// Openers that are filler wherever they appear. None of these begins an
// ordinary sentence about software.
const ALWAYS_LEAD_IN = [
  '(?:hi|hey|hello)\\b',
  '(?:thanks|thank you)\\b',
  '(?:please|pls|plz|kindly)\\b',
  '(?:can|could|would|will)(?:n.?t)?\\s+(?:you|we|i)\\b',
  'i.?d\\s+like\\s+(?:you\\s+)?to\\b',
  'i\\s+(?:want|need|would\\s+like)\\s+(?:you\\s+)?to\\b',
  'we\\s+(?:should|need\\s+to|want\\s+to)\\b',
  'let.?s\\b',
  '(?:go\\s+ahead\\s+and|try\\s+to|help\\s+me|i\\s+think\\s+we\\s+should)\\b',
];

// Openers that are ALSO ordinary words. "OK button remains disabled" and
// "Right sidebar overlaps the content" are not greetings, and stripping the
// first word takes the name of the control or the side of the screen with
// it. These only count as filler when punctuation follows, which is what a
// real greeting has: "OK, " / "Right — " / "Actually: ".
//
// The cost is missing an unpunctuated "OK so I need you to …", which leaves
// two words of filler in a title. That is the right way round: leaving
// filler is untidy, eating the subject is wrong.
const AMBIGUOUS_LEAD_IN = [
  '(?:ok|okay|so|right|alright|actually|yo|cheers|quick one)\\b',
];

const PUNCTUATION = '[\\s,:;.!?\\u2013\\u2014-]';
const LEAD_IN_RE = new RegExp(
  `^(?:(?:${ALWAYS_LEAD_IN.join('|')})(?![\\w-])${PUNCTUATION}*`
  + `|(?:${AMBIGUOUS_LEAD_IN.join('|')})(?![\\w-])\\s*[,:;.!?\\u2013\\u2014-]${PUNCTUATION}*)`,
  'i',
);

// Words whose trailing dot is not the end of a sentence. Without this,
// "Fix the etc. case" would be titled "Fix the etc".
const NOT_SENTENCE_END = new Set([
  'etc', 'vs', 'fig', 'no', 'approx', 'cf', 'al', 'ie', 'eg',
  'dr', 'mr', 'mrs', 'ms', 'st', 'jan', 'feb', 'mar', 'apr', 'jun',
  'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

// A dotted initialism — "e.g", "i.e", "U.S", "a.k.a" — read as a whole
// rather than listed, because the list will always be missing one. An
// allowlist got "Fix the e.g. case" right and still turned "Add filtering
// for U.S. accounts" into "Add filtering for U.S".
const DOTTED_INITIALISM_RE = /^(?:[a-z]\.)+[a-z]$/i;

function endsSentence(previousWord) {
  if (!previousWord) return false;
  if (NOT_SENTENCE_END.has(previousWord)) return false;
  if (DOTTED_INITIALISM_RE.test(previousWord)) return false;
  // A single initial: "Fix J. Random's bug".
  return !/^[a-z]$/i.test(previousWord);
}

// The other way an ambiguous word is plainly a greeting: it is followed by
// another lead-in. "OK, so I need you to …" strips "OK," and then stalls on
// "so", because "so" alone is not filler — but "so I need you to" is. The
// lookahead keeps this syntactic: a greeting chain, not a guess at meaning.
const AMBIGUOUS_BEFORE_LEAD_IN_RE = new RegExp(
  `^(?:${AMBIGUOUS_LEAD_IN.join('|')})(?![\\w-])\\s+(?=(?:${ALWAYS_LEAD_IN.join('|')}))`,
  'i',
);

function stripLeadIns(text) {
  let out = text;
  // Bounded rather than `while`: a pathological input must not spin here,
  // and no real opening stacks more than a few of these.
  for (let i = 0; i < 6; i += 1) {
    const next = out
      .replace(LEAD_IN_RE, '')
      .replace(AMBIGUOUS_BEFORE_LEAD_IN_RE, '');
    if (next === out) break;
    out = next;
  }
  out = out.trim();
  // A message that is ONLY a greeting still has to be named something, and
  // the greeting beats an empty title.
  return out || text;
}

// NOT DONE HERE: dropping URLs. An earlier revision removed them, on the
// reasoning that a link is long and is rarely what a change is called. It
// went twice: "Fix https://a.co callback" became "Fix callback", and once
// that was fixed by only removing links from over-long prose, "Allow
// https://example.com/callback as an OAuth redirect origin" became "Allow as
// an OAuth redirect origin". Both times the link was the SUBJECT.
//
// Nothing available here tells a pointer ("have a look at <url> and fix the
// header") from a subject, and the leftover-still-reads-like-a-title test
// does not: the OAuth example passes it and still loses its point. A rule
// that silently deletes what the sentence is about is worse than a title
// with a long link in it, so links are left exactly where the person put
// them and simply take their share of the budget.

// The longest run of COMPLETE sentences that fits in `max`, with the
// closing period dropped. '' when the first sentence does not fit.
function sentencesWithin(text, max) {
  let best = '';
  const re = /[.!?](?=\s|$)/g;
  let m = re.exec(text);
  while (m) {
    const end = m.index + 1;
    if (end > max) break;
    const previousWord = text.slice(0, m.index).split(/\s+/).pop().toLowerCase();
    // An abbreviation or an initialism is not a sentence boundary; keep
    // scanning for a real one.
    if (endsSentence(previousWord)) best = text.slice(0, end);
    m = re.exec(text);
  }
  // Only the full stop goes: a question keeps its mark, because "Why does
  // the avatar upload 500?" reads as the name it is.
  return best.replace(/\.+$/, '').trim();
}

// Does this read as a name rather than as a fragment? Both tests matter:
// "Two things" clears the word count and fails the length, "internationalise"
// clears the length and fails the word count.
const SENTENCE_MIN_CHARS = 16;
const SENTENCE_MIN_WORDS = 3;

function isSubstantial(sentence) {
  return sentence.length >= SENTENCE_MIN_CHARS
    && sentence.split(' ').filter(Boolean).length >= SENTENCE_MIN_WORDS;
}

// Truncate at the last word boundary before `max`, falling back to a hard
// cut when a single token is longer than the whole budget.
// A hard cut must not land between the halves of a surrogate pair. This
// file counts UTF-16 units, so an emoji is two, and slicing at an odd
// offset inside a no-space run of them leaves a lone high surrogate. That
// is not cosmetic: llm.stripLoneSurrogates exists in this codebase because
// one malformed character in old chat history poisoned a later model call,
// and this title is persisted and fed to prompts.
function sliceWholeCharacters(text, max) {
  const end = Math.min(max, text.length);
  const last = text.charCodeAt(end - 1);
  const orphanedHighSurrogate = last >= 0xD800 && last <= 0xDBFF;
  return text.slice(0, orphanedHighSurrogate ? end - 1 : end);
}

function truncateAtWord(text, max) {
  const slice = sliceWholeCharacters(text, max);
  const space = slice.lastIndexOf(' ');
  const cut = space >= DETERMINISTIC_TITLE_MIN ? slice.slice(0, space) : slice;
  // Trailing punctuation rides along with the last whole word, and
  // "groups by day,…" reads worse than "groups by day…".
  return cut.trimEnd().replace(/[\s,;:.!?–—-]+$/, '');
}

function deterministicTitle(text) {
  // A seeded message names the change after its issue, not after the
  // instruction wrapped around it. The body is the fallback for the
  // degraded seed whose issue fetch produced an empty title.
  const seed = parseIssueSeed(text);
  const source = seed ? (seed.title || seed.body) : text;
  const plain = String(source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Something that already fits is returned in the person's own words. The
  // rules below exist to spend a budget well, so they only run once there
  // is a budget to spend — rephrasing a message that fits would be taking
  // words out of someone's mouth for nothing.
  if (plain.length <= DETERMINISTIC_TITLE_MAX) return plain;

  // An issue title is already a name, so none of the prose rules may
  // rewrite it — including the sentence rule. An issue called
  // `Fix imports from foo.js. Preserve the compatibility path` must not
  // become `Fix imports from foo.js`; it is over the cap, so it gets cut,
  // and that is all.
  if (seed && seed.title) {
    return `${truncateAtWord(plain, DETERMINISTIC_TITLE_MAX - 1)}…`;
  }

  // Everything below is for prose a person typed at a chat box.
  const body = stripLeadIns(plain);
  // Dropping the lead-in can be the whole fix: "Hey, could you please …"
  // is 21 characters of nothing.
  if (body.length <= DETERMINISTIC_TITLE_MAX) return body;

  const sentences = sentencesWithin(body, DETERMINISTIC_TITLE_MAX);
  // A complete short sentence beats a truncated long one — "Fix the login
  // redirect" is a better name than "Fix the login redirect. It sends
  // people to the dash…" — but only once it says something. A fragment
  // ("Two things." / "One more thing.") is not a name, so it has to clear
  // both a length and a word count before it wins.
  if (isSubstantial(sentences)) return sentences;

  return `${truncateAtWord(body, DETERMINISTIC_TITLE_MAX - 1)}…`;
}

// Model inputs for a request history that may open with the issue-card
// seed: the scaffolding is replaced by the issue title + body it wrapped,
// and the issue title is lifted out as its own signal. Unseeded histories
// come back untouched with a null issueTitle.
function titleInputsFromRequests(requests) {
  let issueTitle = null;
  const prepared = (Array.isArray(requests) ? requests : [])
    .map((r) => String(r || ''))
    .filter((r) => r.trim())
    .map((text) => {
      const seed = parseIssueSeed(text);
      if (!seed) return text;
      if (!issueTitle && seed.title) issueTitle = seed.title;
      return [seed.title, seed.body].filter(Boolean).join('\n\n') || text;
    });
  return { requests: prepared, issueTitle };
}

// Guarded persist + broadcast shared by every title source. The
// Two guards make an explicit title authoritative: once applyPrMetadata
// mirrored a PR title in, or once an author manually chose the future PR
// title, a slower in-flight generated title must lose the race. `send` is
// the chat turn's event emitter (SSE + global WS + session bus), so open
// session lists update live via the `session_titled` event.
async function persistTitle({ pool, session, title, send }) {
  const { rowCount } = await pool.query(
    `UPDATE chat_sessions SET session_title = $1
      WHERE id = $2 AND pr_number IS NULL AND proposed_pr_title IS NULL`,
    [title, session.id]
  );
  if (!rowCount) return null;
  session.session_title = title;
  if (send) send('session_titled', { sessionTitle: title });
  return title;
}

// Core generate → debit → persist → broadcast path.
//
// #2500: the requests are prepared before they reach the model — an
// issue-card seed becomes the issue title plus the issue body, and the
// issue title rides along as its own input. An explicit `issueTitle` from
// the caller still wins; the derived one only fills the gap.
function generateAndApply({ pool, session, requests, specs, issueTitle, userId, apiKey, send }) {
  const prepared = titleInputsFromRequests(requests);
  const issue = issueTitle || prepared.issueTitle || null;
  return (async () => {
    const meta = await llm.generateSessionTitle({
      requests: prepared.requests,
      specs,
      issueTitle: issue,
      apiKey,
      telemetryContext: {
        pool,
        appId: session.app_id,
        sessionId: session.id,
      },
    });

    // Debit the Haiku call to the requesting user — BYOK bucket when
    // their own key paid for it, same as the PR-metadata call.
    if (meta.usage && userId != null && pool) {
      const costCents = llm.estimateCostCents(meta.usage, meta.model);
      await limits.recordSpend(pool, userId, costCents, { byok: !!apiKey });
    }

    return persistTitle({ pool, session, title: meta.title, send });
  })().catch((err) => {
    log.warn('session-title', 'Title generation failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    // #2500: an unavailable helper model used to leave the session showing
    // its branch name forever. Name it deterministically instead — for an
    // issue-started session that is the issue title, which is the same name
    // deterministicPrMetadataDraft will give the pull request. Only for a
    // session that has no name yet: a refresh must never trade a generated
    // title for a worse one just because this call failed.
    if (!session || session.session_title) return null;
    const fallback = deterministicTitle(issue || prepared.requests[0]);
    if (!fallback) return null;
    return persistTitle({ pool, session, title: fallback, send }).catch(() => null);
  });
}

// Hook 1 — first interactive message: only a brand-new session (no
// title yet, no PR) gets named from its opening ask. Existing untitled
// sessions also land here on their next message, which is the
// backfill story for pre-#249 rows.
function maybeTitleFirstMessage({ pool, session, message, userId, apiKey, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  const requests = [String(message || '').trim()].filter(Boolean);
  if (!requests.length) return Promise.resolve(null);
  return generateAndApply({ pool, session, requests, specs: [], userId, apiKey, send });
}

// Hook 1, OpenRouter flavour (#1949) — same entry conditions as
// maybeTitleFirstMessage (untitled, no PR), but no model call and no
// payer to resolve. Reads the session's FIRST user message rather than
// trusting the turn's own: a session whose opening turn was refused
// (worker busy) or stopped is still named from its opening ask on the
// next one, and — since deterministicPrMetadataDraft titles the PR from
// the first request too — the name the session shows now is the one it
// keeps when the PR lands. The turn's `message` is the fallback when no
// row comes back. Fire-and-forget like its siblings: always resolves.
function titleFromFirstMessage({ pool, session, message, send }) {
  if (!session || session.session_title || session.pr_number) return Promise.resolve(null);
  return (async () => {
    const { rows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC LIMIT 1`,
      [session.id]
    );
    const title = deterministicTitle((rows[0] && rows[0].content) || message);
    if (!title) return null;
    return persistTitle({ pool, session, title, send });
  })().catch((err) => {
    log.warn('session-title', 'First-message title failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 2 — pre-PR turn-end refresh: re-title from everything known so
// far (every user message plus the live spec draft). Callers gate on
// "no PR yet" and "didn't already title this turn"; the UPDATE guard
// above covers the race where a PR landed mid-generation.
function refreshFromHistory({ pool, session, userId, apiKey, send }) {
  return (async () => {
    const { rows: reqRows } = await pool.query(
      `SELECT content FROM chat_session_messages
         WHERE session_id = $1 AND role = 'user'
         ORDER BY id ASC`,
      [session.id]
    );
    const { rows: csRows } = await pool.query(
      `SELECT spec_md FROM chat_sessions WHERE id = $1`,
      [session.id]
    );
    const specMd = ((csRows[0] && csRows[0].spec_md) || '').trim();
    return generateAndApply({
      pool, session,
      requests: reqRows.map((r) => r.content).filter(Boolean),
      specs: specMd ? [specMd] : [],
      userId, apiKey, send,
    });
  })().catch((err) => {
    log.warn('session-title', 'Turn-end title refresh failed (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  });
}

// Hook 3 (#2500) — the single turn-end entry point every in-platform
// session now shares, Claude and OpenRouter alike. It owns the one decision
// the route used to make inline: which of the hooks above to run, and what
// to do when there is no payer for the helper model.
//
// `resolveBilling` is injected rather than imported so this stays a pure
// decision with no opinion about how a payer is found. Its refusal — an
// `error` on the result, or a throw — is no longer the end of the matter:
// a session with no payer gets the payer-free deterministic name, which for
// an issue-started session is the issue title, instead of showing its branch
// name forever.
//
// `firstTurn` picks the cheaper first-message path; anything else re-titles
// from the full history. Fire-and-forget like its siblings: the returned
// promise always resolves.
function titleAtTurnEnd({ pool, session, message, userId, resolveBilling, firstTurn, send }) {
  if (!session || session.pr_number) return Promise.resolve(null);
  const deterministic = () => titleFromFirstMessage({ pool, session, message, send });
  return Promise.resolve()
    .then(() => (resolveBilling ? resolveBilling() : { error: 'no_resolver' }))
    .then((billing) => {
      if (!billing || billing.error) {
        log.info('session-title', 'Turn-end title: no payer, using the deterministic name', {
          sessionId: session.id, reason: (billing && billing.reason) || null,
        });
        return deterministic();
      }
      return firstTurn
        ? maybeTitleFirstMessage({
          pool, session, message, userId, apiKey: billing.apiKey, send,
        })
        : refreshFromHistory({
          pool, session, userId, apiKey: billing.apiKey, send,
        });
    })
    .catch((err) => {
      log.warn('session-title', 'Turn-end title billing resolve failed', {
        sessionId: session.id, err: err.message,
      });
      return deterministic();
    });
}

module.exports = {
  headlessTitle, deterministicTitle, generateAndApply,
  maybeTitleFirstMessage, titleFromFirstMessage, refreshFromHistory,
  titleAtTurnEnd, parseIssueSeed, titleInputsFromRequests,
};
