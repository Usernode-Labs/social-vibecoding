// Read-only dev-chat transcript sharing (chat_sessions.transcript_shared_at).
//
// When an owner opts a visible session's TRANSCRIPT into being readable,
// every message row leaving the server goes through sanitizeTranscriptMessage
// below. This module is the whole privacy contract for that surface, kept
// dependency-free (no pg, no express) so tests/transcript-sanitize.test.js can
// exercise it directly.
//
// DENY-BY-DEFAULT, ALWAYS. Both the row shape and the metadata bag are built
// from explicit allowlists — a key nobody thought about (including one added
// by a future feature) is dropped, not forwarded. A blocklist here would leak
// the next thing someone adds to metadata; that failure mode is exactly what
// this file exists to prevent, so do NOT invert these lists.
//
// The same sanitiser runs on the FORK path (POST /api/sessions/:id/fork), so a
// forked session can never carry content its owner wasn't allowed to read in
// the first place. That is why the function is shared rather than duplicated:
// "what the fork's agent knows" is bounded by "what the reader could see".

// Row-level columns that may be served. token_count / cost_cents are
// deliberately absent — a reader must not be able to derive the owner's spend
// (nor the platform's per-turn pricing) from a shared chat.
const ROW_FIELDS = ['id', 'role', 'content', 'model', 'created_at'];

// metadata keys that may be served. Each one is content the reader can already
// see rendered in the owner's timeline (progress logs, the agent's own summary
// text, the "Changes ready" card, spec snippets) or is needed for rendering
// (inheritedFrom drives the collapsed-by-default agent disclosures).
//
// NOT here, on purpose:
//   ccLog             raw CC stderr — can contain env/file contents lifted
//                     straight out of the repo checkout.
//   platformIssueDraft  an owner-only ACTION card (Report / Dismiss buttons
//                     hitting owner-scoped endpoints); useless and misleading
//                     to a reader.
//   suggestions / quickReplies  interactive composer affordances — a reader
//                     has no composer to prefill.
//   apiKeySwitch etc. billing-path notices, same reasoning as cost_cents.
//   stagingUrl        withheld: shared-session viewers reach the preview
//                     through the card's Preview pill (which routes via
//                     ensure-staging and rebuilds a GC'd container), not via
//                     a raw URL embedded in history that may be long dead.
const METADATA_KEYS = [
  'progressLog',
  'ccOutput',
  'ccOutcome',
  'durationMs',
  'changesReady',
  'stagingFailed',
  'stagingErrorName',
  'stagingMissingKeys',
  'prNumber',
  'prUrl',
  'specPreview',
  'specVersion',
  'specLines',
  'inheritedFrom',
  // Safe runtime identity only. These let a shared transcript distinguish
  // Claude from Codex without exposing credentials, pricing, or billing
  // details; agentModel is the already-public catalog id pinned to the run.
  'agentBackend',
  'agentModel',
];

// Attachment entries are reduced to a NAME CHIP: filename/kind/size only.
// The 32-hex `id` is dropped so a reader cannot construct
// /api/sessions/:id/attachments/:attId — that route stays owner-scoped, and
// without the id there is nothing to guess at.
const ATTACHMENT_FIELDS = ['filename', 'kind', 'sizeBytes'];

// Hard ceiling on how many rows one transcript read returns. The largest
// shared session in production carries ~110 messages, so this is headroom
// rather than a real constraint; the route reports `truncated` when it bites.
const MAX_TRANSCRIPT_MESSAGES = 400;

function pick(src, keys) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of keys) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

// Sanitize ONE chat_session_messages row for a non-owner reader.
// Returns a fresh object — never a mutated reference to the input row, so a
// caller that also holds the raw row (the fork path does) can't accidentally
// serve the unsanitized one.
function sanitizeTranscriptMessage(row) {
  if (!row || typeof row !== 'object') return null;
  const out = pick(row, ROW_FIELDS);

  const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  const safeMeta = pick(meta, METADATA_KEYS);

  // Attachments: names only, ids stripped. An entry that isn't an object at
  // all is dropped rather than passed through.
  if (meta && Array.isArray(meta.attachments)) {
    const atts = meta.attachments
      .filter((a) => a && typeof a === 'object')
      .map((a) => pick(a, ATTACHMENT_FIELDS));
    if (atts.length) safeMeta.attachments = atts;
  }

  out.metadata = safeMeta;
  return out;
}

// Sanitize a whole list, dropping rows that sanitize to nothing.
function sanitizeTranscript(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(sanitizeTranscriptMessage)
    .filter(Boolean);
}

// ── Fork orientation message ───────────────────────────────────────────
//
// The assistant message a FORKED chat opens with (POST /api/sessions/:id/fork).
// It lives here rather than in routes/sessions.js because the staging fixture
// in db/migrate.js seeds a pre-made fork and must show the SAME text — a
// second hand-written copy there would silently drift from the real thing.
//
// Deliberately does NOT start with DevChat._CLONE_FOLLOWUP_PREFIX: that string
// is the legacy boundary heuristic for auto-session clones, applied only when
// no row carries metadata.inheritedFrom. Fork copies stamp every row, so the
// marker path wins and this text is free to read naturally.
//
// The load-bearing sentence is the memory caveat. Unlike a clone-headless
// clone, a fork does NOT inherit the agent's Claude Code volume (that would
// hand it everything the sanitiser above withholds), so the model knows only
// what the copied transcript says. Telling the new owner that up front is what
// stops them assuming a shared memory that isn't there.
//
// `src` is the source session row: { session_title, pr_title, branch_name,
// spec_md, owner_username }.
function buildForkFollowUpMessage(src) {
  const s = src || {};
  const owner = s.owner_username || 'another user';
  const label = s.session_title || s.pr_title || s.branch_name || 'their dev chat';
  const spec = (s.spec_md || '').trim()
    ? ' Their spec came across too, so open the spec viewer to read it.'
    : '';
  return `You forked ${owner}'s dev chat ("${label}"). Everything above is their conversation, copied in as history. You're now on your own branch, forked off theirs, so any code they had already pushed is here to build on. Their session is untouched and keeps running independently.${spec}

One thing to know: I have the transcript above, but not the coding agent's own memory of that work, so if a detail from their chat matters, say it again rather than assuming I remember it. Tell me what you want to change and I'll take it from here.`;
}

// Static next-step pills for the fork follow-up, so the pill row above the
// message box is populated from the first screen instead of empty (same
// reasoning as buildHeadlessFollowUpQuickReplies in routes/sessions.js). Kept
// to 3 short first-person replies, matching sanitizeQuickReplies' invariant —
// the route runs them through it anyway.
const FORK_FOLLOWUP_REPLIES = Object.freeze([
  'Explain where this got to',
  'Continue this work',
  'Take it a different way',
]);

module.exports = {
  sanitizeTranscriptMessage,
  sanitizeTranscript,
  MAX_TRANSCRIPT_MESSAGES,
  buildForkFollowUpMessage,
  FORK_FOLLOWUP_REPLIES,
  // Exported for the tests' deny-by-default assertions.
  ROW_FIELDS,
  METADATA_KEYS,
  ATTACHMENT_FIELDS,
};
