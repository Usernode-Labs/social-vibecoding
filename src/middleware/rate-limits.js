const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const log = require('../services/logger');
const { clientIp } = require('../services/client-ip');

// Retry-delay phrase for throttle messages: minutes rounded up, with
// anything ≤ 60s collapsing to "in under a minute".
function retryPhrase(seconds) {
  if (seconds <= 60) return 'in under a minute';
  return `in about ${Math.ceil(seconds / 60)} minutes`;
}

// A tiny wrapper that standardizes JSON responses + logs throttled hits.
// Keys auth routes by IP (user is anonymous) and write routes by userId
// when available so a single abusive account can't exhaust the limit for
// everyone behind the same NAT.
//
// `message` is either a plain string or a builder (retryAfterSeconds) =>
// string, so throttle responses can say when a retry will succeed.
// `skipFailedRequests` refunds requests that finish ≥ 400 (validation
// errors and dedupe rejections shouldn't burn the budget). `exemptAdmins`
// skips the limiter entirely for FULL admins — gated on canAdminWrite,
// not isAdmin, so view-only admins stay limited like regular users (same
// gate as the app-quota bypass, issue #311).
function makeLimiter({ windowMs, max, name, keyByUser = false, message, skipFailedRequests = false, exemptAdmins = false }) {
  const options = {
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipFailedRequests,
    // `ipKeyGenerator` collapses IPv6 to a subnet prefix so a single client
    // can't bypass the limit by rotating addresses within its /56.
    keyGenerator: (req) => {
      if (keyByUser && req.user?.id) return `user:${req.user.id}`;
      return ipKeyGenerator(clientIp(req));
    },
    handler: (req, res) => {
      const resetTime = req.rateLimit?.resetTime;
      const retryAfterSeconds = resetTime
        ? Math.max(0, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000);
      log.warn('rate-limit', 'Throttled', {
        name,
        ip: clientIp(req),
        userId: req.user?.id,
        path: req.path,
      });
      // No `code` field here — clients discriminate billing 429s by
      // their code tag (#463), so throttles must stay code-free.
      res.status(429).json({
        error: typeof message === 'function'
          ? message(retryAfterSeconds)
          : (message || 'Too many requests, please slow down'),
        retryAfterSeconds,
      });
    },
  };
  if (exemptAdmins) options.skip = (req) => !!req.user?.canAdminWrite;
  return rateLimit(options);
}

// Auth: 10 attempts / 15 min / IP. Tight because it's the primary brute-
// force surface (password POSTs + signed-challenge submission).
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: 'auth',
  message: 'Too many login attempts, try again in a few minutes',
});

// Wallet pre-check: 60 / min / IP. /api/auth/wallet-check is a read-only
// lookup that fires on every login-page load to decide whether to show
// "Sign in with wallet" vs "Link / register". Reusing authLimiter here
// caused legitimate users (esp. mobile webview refreshes) to bounce off
// after 10 page loads in 15 min and see a misleading "not linked" UI.
// The endpoint can't be used to brute-force credentials — verification
// still goes through wallet-verify with a server-issued ECDSA challenge,
// which IS gated by authLimiter.
const walletCheckLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'wallet-check',
  message: 'Too many wallet checks, slow down for a minute',
});

// App creation: 5 / hour / user. Each create provisions a container, DB,
// and repo — so expensive.
const appCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: 'app-create',
  keyByUser: true,
  message: 'You\'ve created a lot of apps recently — try again in a bit',
});

// Issue / rename / visibility proposals: 20 / hour / user. Loose enough
// for normal use but stops spam creation of proposals. Only successful
// creations count, and full admins are exempt.
const issueCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'issue-create',
  keyByUser: true,
  skipFailedRequests: true,
  exemptAdmins: true,
  message: (s) => `Rate limit reached: up to 20 issues and proposals per hour. You can try again ${retryPhrase(s)}.`,
});

// Close-issue proposals (#522): own 20 / hour / user bucket, so proposing
// to close stale issues can't be starved by issue creation (or vice
// versa) — the shared bucket was why "Propose to close" 429'd for users
// who had merely been filing issues or saving agent files. The route's
// per-issue dedupe already caps open close proposals at one per target.
const closeProposalLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'close-proposal',
  keyByUser: true,
  skipFailedRequests: true,
  exemptAdmins: true,
  message: (s) => `Rate limit reached: up to 20 close proposals per hour. You can try again ${retryPhrase(s)}.`,
});

// POST /api/apps/:slug/issues serves several proposal kinds — route
// close_issue bodies to their own bucket, everything else (general,
// secret_change) to issue-create. req.body is already parsed here: the
// global express.json() mounts before any router (see server.js). A
// missing/non-JSON body falls through to the default bucket.
function issueKindLimiter(req, res, next) {
  const limiter = req.body?.kind === 'close_issue' ? closeProposalLimiter : issueCreateLimiter;
  return limiter(req, res, next);
}

// Agent instruction/skill file saves (#460): 30 / minute / user, split
// off the issues bucket so an editing session (many saves in a row) can
// never lock the user out of governance actions. Same shape and
// reasoning as attachmentUploadLimiter below: honest editing never
// bites, scripted loops bounce quickly.
const agentFileWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'agent-file-write',
  keyByUser: true,
  exemptAdmins: true,
  message: (s) => `Rate limit reached: up to 30 file saves per minute. You can try again ${retryPhrase(s)}.`,
});

// Chat: 30 / minute / user. Loose enough that no honest user notices
// during normal back-and-forth, tight enough that scripted abuse
// (looping POSTs to drain the daily LLM cap) bounces off well before
// hitting the daily limit. Per-user keying so a single abusive account
// behind shared NAT can't degrade other users on the same IP.
const chatLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'chat',
  keyByUser: true,
  message: 'Too many chat messages — slow down for a minute.',
});

// #556: live title previews for the feedback modal (POST /api/feedback/
// title). Same sizing rationale as chatLimiter — each call is a Haiku
// spend against the daily LLM budget, so this must not become a faster
// drain path. The FE debounces to ~1–3 calls per modal in honest use
// (plus its own per-open cap), so 20/min never bites, while a scripted
// loop bounces quickly. Per-user keyed for shared-NAT fairness.
const feedbackTitleLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  name: 'feedback-title',
  keyByUser: true,
  message: 'Too many title previews — slow down for a minute.',
});

// Dev-chat attachment uploads (#450): 30 / minute / user. Each upload is
// a ≤20 MB bytea INSERT; honest use is a handful per message, so 30/min
// never bites, while a scripted loop trying to balloon the DB bounces
// off quickly (per-session totals are additionally capped at 50 MB in
// the route itself). Per-user keyed for shared-NAT fairness.
const attachmentUploadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'attachment-upload',
  keyByUser: true,
  message: 'Too many file uploads — slow down for a minute.',
});

// App file-storage uploads via the shell relay (#752): 20 / minute /
// user. Honest use is a photo or two per action, so 20/min never bites,
// while a scripted loop trying to fill an app's quota bounces quickly
// (per-app and per-user byte caps are additionally enforced in the
// route). Per-user keyed for shared-NAT fairness; matches the 20/min
// the server-side /api/app-storage path applies per (app, user).
const appFileUploadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  name: 'app-file-upload',
  keyByUser: true,
  message: 'Too many file uploads — slow down for a minute.',
});

// #683: feedback-modal screenshot uploads. Each is a ≤4 MB bytea INSERT;
// honest use is one per filed issue, so 10 / 10 min never bites, while a
// scripted loop trying to balloon the DB bounces off quickly (orphans are
// additionally GC'd after 24h). Per-user keyed for shared-NAT fairness.
const issueScreenshotLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  name: 'issue-screenshot-upload',
  keyByUser: true,
  message: 'Too many screenshot uploads — slow down for a few minutes.',
});

// Priority / assignee attribute votes: 60 / minute / user. Loose enough
// that switching your pick a few times never bumps it, tight enough to
// stop a scripted vote-spam loop. Per-user keyed for shared-NAT fairness.
const attributeVoteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'attribute-vote',
  keyByUser: true,
  message: 'Too many updates — slow down for a minute.',
});

// #613: drag-and-drop reorder of Dev-board cards. Dragging is bursty (a
// tester can reshuffle a column several times in a few seconds), so the
// window is generous but still caps a scripted write loop. Per-user keyed,
// mirroring attributeVoteLimiter.
const boardOrderLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'board-order',
  keyByUser: true,
  message: 'Too many reorder updates — slow down for a minute.',
});

// Platform database export tickets: 3 / 24h / full admin. Each ticket
// authorizes ONE full, unredacted pg_dump of the platform database — every
// password hash, every live session token, every app credential — so the
// budget is deliberately tiny and the window is a whole day.
//
// exemptAdmins IS DELIBERATELY OMITTED AND MUST STAY OMITTED. The option
// skips the limiter for anyone with canAdminWrite (see makeLimiter above),
// which is EXACTLY the population this limiter exists to bound — the route
// is already full-admin-only, so setting it would disable the limit
// entirely. Do not "make it consistent" with its neighbours.
//
// skipFailedRequests refunds anything ≥ 400, so a mistyped confirmation
// password doesn't burn one of the three slots (the denied attempt is
// still written to the db_exports audit table either way). Per-user keyed:
// the budget belongs to the admin, not to their IP.
const dbExportLimiter = makeLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  name: 'db-export',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Rate limit reached: up to 3 database exports per day. You can try again ${retryPhrase(s)}.`,
});

// Topochain mobile auth (plan Task 3; SPEC 1588-1599): the four PUBLIC
// mobile-auth endpoints (`check-email`, `login`, `otp/request`,
// `otp/verify`) share ONE bucket, 10 requests / minute / client IP — the
// route path is not part of the key, matching SPEC 1597 exactly ("the
// four public auth endpoints share one bucket of 10 requests per minute
// per client IP"). Route modules apply this same limiter instance to all
// four paths rather than building four separate limiters.
//
// DEVIATION from SPEC 1597/1599: the source throttle responds with
// `429` + `Retry-After`/`X-RateLimit-*` headers and no particular JSON
// body; the v4 contract otherwise unifies every error into the single
// `{success, error, ...}` envelope (SPEC §4.8). This limiter is built on
// `makeLimiter`, whose `handler` (above) owns the 429 response shape for
// EVERY limiter in this file — it replies with the platform's standard
// `{error, retryAfterSeconds}` body, not the v4 envelope. Reimplementing
// just this one limiter's handler to match §4.8 would fork the shared
// wrapper for one route group; left as-is and documented rather than
// special-cased.
const topochainMobileAuthLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  name: 'topochain-mobile-auth',
  message: 'Too many requests — slow down for a minute.',
});

// Public waitlist join: 5 / 15 min / IP. Anonymous write endpoint on the
// landing page — tight enough to stop bulk email harvesting/spam, loose
// enough that a genuine visitor retrying a typo never hits it.
const waitlistJoinLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  name: 'waitlist-join',
  message: 'Too many signups from this address — try again in a few minutes.',
});

module.exports = { dbExportLimiter, authLimiter, walletCheckLimiter, appCreateLimiter, issueCreateLimiter, closeProposalLimiter, issueKindLimiter, agentFileWriteLimiter, chatLimiter, attributeVoteLimiter, attachmentUploadLimiter, appFileUploadLimiter, feedbackTitleLimiter, boardOrderLimiter, issueScreenshotLimiter, topochainMobileAuthLimiter, waitlistJoinLimiter };
