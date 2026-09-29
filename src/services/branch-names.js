'use strict';

// ──────────────────────────────────────────────────────────────────────
// Dev-session branch names — one generator, one validator
// ──────────────────────────────────────────────────────────────────────
//
// Session branches are minted as `dev/<who>-<timestamp>` and pushed by
// the platform-side proxy (worker.execPushFromWorker), which re-derives
// the name from the session row and refuses anything outside a strict
// charset. Those two halves used to live apart: the routes interpolated
// `req.user.username` raw, the proxy allowed `[A-Za-z0-9._/-]`.
//
// 194 of 303 production usernames are email addresses. Any of them
// starting a dev session got a branch with `@` (and often `+`) in it —
// git accepted it, `git checkout -b` worked, the agent committed, and
// then EVERY push attempt failed `bad_branch`, heal included, with the
// only copy of the work left inside a warm worker (issue #1376: a
// 47-minute Opus-5 build stranded exactly that way).
//
// So both halves are here now. `devBranchName` is the only supported way
// to mint one and it can only emit names `isValidBranchName` accepts;
// the proxy validates through the same module. Widening the charset to
// `@` and `+` is deliberate and also retroactive — it unblocks branches
// already minted the old way, whose commits are still recoverable.
//
// The charset stays an allowlist because the name reaches a `bash -c`
// via the k8s exec path (shell-quoted) and a `docker exec -e` env var
// (not shell-interpreted at all). Neither is injectable today; the
// allowlist is the belt to their braces.

// Characters allowed in a branch name. Every one is legal in a git ref
// and inert in single-quoted shell.
const BRANCH_SAFE_CHARS_RE = /^[A-Za-z0-9._/+@-]+$/;

// Characters allowed inside ONE segment (no `/` — segments never nest).
const SEGMENT_UNSAFE_RE = /[^A-Za-z0-9._+@-]+/g;

const MAX_SEGMENT_LEN = 64;

/**
 * git check-ref-format's rules, for the subset of them that a name built
 * from user input can plausibly trip. Returns true when `name` is both
 * within the safe charset and a legal git branch ref.
 */
function isValidBranchName(name) {
  if (typeof name !== 'string' || !name) return false;
  if (!BRANCH_SAFE_CHARS_RE.test(name)) return false;
  if (name.length > 255) return false;
  if (name.includes('..')) return false;          // no double dot
  if (name.includes('@{')) return false;          // reflog syntax
  if (name.includes('//')) return false;          // empty component
  if (name.startsWith('/') || name.endsWith('/')) return false;
  if (name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name === '@') return false;
  // No component may start with '.' or end with '.lock'.
  for (const part of name.split('/')) {
    if (!part) return false;
    if (part.startsWith('.')) return false;
    if (part.endsWith('.lock')) return false;
  }
  // A leading '-' makes the ref indistinguishable from a git flag.
  if (name.startsWith('-')) return false;
  return true;
}

/**
 * Collapse an arbitrary string (a username, typically) into one branch
 * segment that `isValidBranchName` will accept when joined under a
 * prefix. Never returns an empty string.
 */
function sanitizeBranchSegment(raw) {
  let out = String(raw == null ? '' : raw)
    .trim()
    .replace(SEGMENT_UNSAFE_RE, '-')
    // `..` and `@{` are charset-legal but ref-illegal; break them up.
    .replace(/\.{2,}/g, '.')
    .replace(/@+\{/g, '@-')
    // Collapse runs of separators the substitution may have produced.
    .replace(/-{2,}/g, '-');

  if (out.length > MAX_SEGMENT_LEN) out = out.slice(0, MAX_SEGMENT_LEN);

  // Trim leading/trailing characters git rejects at a component edge.
  out = out.replace(/^[.\-]+/, '').replace(/[.\-]+$/, '');
  while (out.endsWith('.lock')) out = out.slice(0, -'.lock'.length).replace(/[.\-]+$/, '');

  return out || 'user';
}

/**
 * The single supported way to mint a dev-session branch name.
 * `dev/<sanitized who>-<timestamp>`.
 */
function devBranchName(who, timestamp = Date.now()) {
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  return `dev/${sanitizeBranchSegment(who)}-${ts}`;
}

/**
 * Mint a dev-session branch name from the session's readable title
 * (#3229). The slug is derived from the same words the session is
 * called, lowercased, with the existing millisecond timestamp kept for
 * uniqueness. A `#\d+ · ` prefix (the headlessTitle shape clones
 * inherit) is stripped so it does not become a meaningless leading
 * number. Titles that survive sanitization as nothing usable fall back
 * to today's `devBranchName(who)` shape, so untitled sessions and
 * emoji-only titles keep every existing guarantee.
 */
function devBranchNameFromTitle(title, who, timestamp = Date.now()) {
  const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const slug = sanitizeBranchSegment(
    String(title == null ? '' : title)
      .toLowerCase()
      .replace(/^#\d+\s*·\s*/, '')
      .replace(/\s+/g, '-')
  );
  // `sanitizeBranchSegment` answers 'user' when nothing survived —
  // an empty title, or one made only of characters the branch charset
  // cannot carry. Either way today's username-based name is the fallback.
  if (!slug || slug === 'user') return devBranchName(who, timestamp);
  return `dev/${slug}-${ts}`;
}

module.exports = {
  BRANCH_SAFE_CHARS_RE,
  MAX_SEGMENT_LEN,
  isValidBranchName,
  sanitizeBranchSegment,
  devBranchName,
  devBranchNameFromTitle,
};
