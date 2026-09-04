const crypto = require('node:crypto');
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
// `skipSuccessfulRequests` is the mirror of skipFailedRequests: it refunds
// anything that finishes < 400, so the bucket counts only FAILURES. Right
// where the abuse being bounded is itself a stream of failures (guessing an
// unguessable token) and honest traffic essentially never produces one.
//
// `key` overrides how a request is bucketed — return a string to use it, or
// a falsy value to fall through to the keyByUser / IP default below. That
// fallthrough is load-bearing: the waitlist token bucket keys on the path
// token, and one route in the same family carries no token.
function makeLimiter({ windowMs, max, name, keyByUser = false, message, skipFailedRequests = false, skipSuccessfulRequests = false, exemptAdmins = false, key = null }) {
  const options = {
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipFailedRequests,
    skipSuccessfulRequests,
    // `ipKeyGenerator` collapses IPv6 to a subnet prefix so a single client
    // can't bypass the limit by rotating addresses within its /56.
    keyGenerator: (req, res) => {
      if (key) {
        const custom = key(req, res);
        if (custom) return String(custom);
      }
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
  message: 'You\'ve created a lot of apps recently. Try again in a bit',
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
  message: 'Too many chat messages. Slow down for a minute.',
});

// Native app/group-chat JSON writes: 60 / minute / user. Browser clients
// normally use the WebSocket path, while CLI/MCP clients use
// POST /api/apps/:slug/messages. Keep this bucket separate from chatLimiter:
// posting native discussion replies must not consume the budget for agent
// turns (which can incur an LLM spend), or vice versa.
const groupChatWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'group-chat-write',
  keyByUser: true,
  message: 'Too many discussion messages. Slow down for a minute.',
});

// Platform Messages has separate safety buckets from app group chat. Failed
// consent/membership attempts intentionally count: refunding them would turn
// these endpoints into an unbounded user/conversation enumeration oracle.
const conversationMessageLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'conversation-message',
  keyByUser: true,
  message: 'Too many messages. Slow down for a minute.',
});

const conversationActionLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'conversation-action',
  keyByUser: true,
  message: 'Too many conversation or invitation changes. Try again later.',
});

// Consent exits must never share a bucket with invitation churn: a user who
// just created or edited many groups must still be able to decline, leave, or
// block immediately.
const conversationSafetyLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 120,
  name: 'conversation-safety',
  keyByUser: true,
  message: 'Too many consent changes. Slow down and try again.',
});

// express-rate-limit increments once per request. Group APIs batch recipients,
// so consume one unit per distinct requested recipient (and one for an empty
// group/direct create) rather than letting a 100-person request cost one.
const conversationInviteWindows = new Map();
function conversationInviteLimiter(req, res, next) {
  const raw = req.body?.kind === 'group' ? req.body?.member_ids : req.body?.user_ids;
  const cost = Math.max(1, Math.min(101, Array.isArray(raw) ? new Set(raw.map(String)).size : 1));
  const key = req.user?.id ? `user:${req.user.id}` : `ip:${clientIp(req)}`;
  const now = Date.now();
  let window = conversationInviteWindows.get(key);
  if (!window || window.resetAt <= now) {
    window = { used: 0, resetAt: now + 60 * 60 * 1000 };
    conversationInviteWindows.set(key, window);
  }
  if (window.used + cost > 100) {
    const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    log.warn('rate-limit', 'Throttled', {
      name: 'conversation-invite', ip: clientIp(req), userId: req.user?.id, path: req.path,
    });
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many conversation invitations. Try again later.',
      retryAfterSeconds,
    });
  }
  window.used += cost;
  return next();
}

const conversationReactionLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'conversation-reaction',
  keyByUser: true,
  message: 'Too many reactions. Slow down for a minute.',
});

// #1280: saving/unsaving a group-chat message. Sized like the reaction
// limiter above — the honest gesture is one tap, but a user skimming a
// backlog may save a dozen in a few seconds, and toggling one message off
// and on again must not feel rate-limited. Per-user keyed for shared-NAT
// fairness.
const messageBookmarkLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'message-bookmark',
  keyByUser: true,
  message: 'Too many saves. Slow down for a minute.',
});

const conversationReportLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: 'conversation-report',
  keyByUser: true,
  message: 'Too many reports. Try again later.',
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
  message: 'Too many title previews. Slow down for a minute.',
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
  message: 'Too many file uploads. Slow down for a minute.',
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
  message: 'Too many file uploads. Slow down for a minute.',
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
  message: 'Too many screenshot uploads. Slow down for a few minutes.',
});

// Profile customization writes (issue #982): PATCH /api/me/profile plus
// the avatar upload/delete pair share ONE bucket at 20 / minute / user.
// Honest editing is a handful of saves per sitting — even fiddling with a
// display name and re-cropping a photo a few times stays well under it —
// while a scripted loop of ≤1 MB bytea upserts bounces off quickly. Shared
// rather than split because the avatar write is the expensive one and a
// caller who is rate-limited on it has no business hammering the text
// fields either. Per-user keyed for shared-NAT fairness.
const profileWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  name: 'profile-write',
  keyByUser: true,
  message: 'Too many profile updates. Slow down for a minute.',
});

// Username changes: 5 / hour / user. The 30-day cooldown in
// src/services/usernames.js is the real policy — this bucket exists for the
// REJECTED attempts the cooldown never reaches. Every call bcrypt-compares
// the current password, so an unthrottled endpoint is both a password
// oracle and 5 rejected-name probes worth of KDF per request. Per-user
// keyed: the caller is always authenticated here.
const usernameChangeLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: 'username-change',
  keyByUser: true,
  message: 'Too many username attempts. Try again in a little while.',
});

// Priority / assignee attribute votes: 60 / minute / user. Loose enough
// that switching your pick a few times never bumps it, tight enough to
// stop a scripted vote-spam loop. Per-user keyed for shared-NAT fairness.
const attributeVoteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'attribute-vote',
  keyByUser: true,
  message: 'Too many updates. Slow down for a minute.',
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
  message: 'Too many reorder updates. Slow down for a minute.',
});

// #911: per-user show/hide of a home-screen panel. A checkbox flip is a
// single small write and nobody legitimately toggles one more than a few
// times a minute; per-user keyed, mirroring boardOrderLimiter.
const homePanelPrefLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'home-panel-pref',
  keyByUser: true,
  message: 'Too many changes. Slow down for a minute.',
});

// Free-form home-grid placement: one PUT per completed drag, and a drag is a
// deliberate gesture rather than a keystroke. The ceiling is much higher than
// the panel-pref limiter above because rearranging a home screen is genuinely
// bursty — someone tidying their grid can easily land twenty drops in a
// minute, and each also has to survive a breakpoint switch re-persisting.
// Per-user keyed; the layout is per-user by definition.
const homeLayoutLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'home-layout',
  keyByUser: true,
  message: 'Too many layout changes. Slow down for a minute.',
});

// #940: saved dev-chat drafts, now server-backed. One write per deliberate
// save / trash / send, plus a burst when a device that was offline flushes
// its local mirror on reconcile (bounded by MAX_SAVED_DRAFTS = 20 posts +
// its tombstones). 60/min per user clears that flush with room to spare and
// still bounds a runaway client. Per-user keyed, mirroring boardOrderLimiter
// — drafts belong to the account, not to an IP.
const draftWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'chat-drafts',
  keyByUser: true,
  message: 'Too many draft updates. Slow down for a minute.',
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

// Authenticated device-state synchronization. Normal lifecycle traffic is a
// handful of writes; this prevents a stolen bearer from churning encrypted
// registrations and delivery FKs in a tight loop.
const topochainMobilePushRegistrationLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'topochain-mobile-push-registration',
  keyByUser: true,
  message: 'Too many push registration updates. Slow down for a minute.',
});

const WAITLIST_WINDOW_MS = 15 * 60 * 1000;
const MORE_TOKEN_RE = /^[a-f0-9]{48}$/;

// Public waitlist join, no integration key: 5 / 15 min / IP. Anonymous write
// endpoint on the landing page — tight enough to stop bulk email harvesting
// and spam, loose enough that a genuine visitor retrying a typo never hits
// it. This is the bucket every unkeyed caller lands in, unchanged.
const waitlistJoinAnonLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 5,
  name: 'waitlist-join',
  message: 'Too many signups from this address. Try again in a few minutes.',
});

// A trusted integrator (see services/waitlist-integrator) proxies many
// distinct people through one server address, so the IP bucket above would
// cap an entire agency at five signups per window. Two buckets replace it,
// and BOTH are charged:
//
//   * per end user, when the integrator forwards a usable visitor address —
//     the same 5 / 15 min a direct visitor gets, so a keyed request is never
//     LOOSER for the person making it;
//   * per client, always — a 200 / 15 min ceiling so a leaked key is a
//     bounded faucet rather than an open one.
//
// With no forwarded address there is nothing finer to key on, so the client
// ceiling is the only bound; that is the cost of not forwarding one.
const waitlistJoinClientLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 200,
  name: 'waitlist-join-client',
  key: (req) => `wl:${req.waitlistIntegrator?.label || 'unknown'}`,
  message: 'Too many signups from this integration. Try again in a few minutes.',
});

const waitlistJoinClientUserLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 5,
  name: 'waitlist-join-client-user',
  key: (req) => (req.waitlistEndUserIp
    ? `wl:${req.waitlistIntegrator?.label || 'unknown'}:${req.waitlistEndUserIp}`
    : null),
  message: 'Too many signups from this address. Try again in a few minutes.',
});

// Dispatch on trusted-integrator status, same shape as issueKindLimiter.
// waitlistIntegratorAuth runs earlier in the chain and only ever ATTACHES
// req.waitlistIntegrator, so an absent/expired/wrong key simply falls back
// to the anonymous bucket instead of erroring.
function waitlistJoinLimiter(req, res, next) {
  if (!req.waitlistIntegrator) return waitlistJoinAnonLimiter(req, res, next);
  return waitlistJoinClientLimiter(req, res, (err) => {
    if (err) return next(err);
    if (!req.waitlistEndUserIp) return next();
    return waitlistJoinClientUserLimiter(req, res, next);
  });
}

// Waitlist token routes (confirm link, stage-2 survey read/save): these are
// authenticated by an unguessable 48-hex token, so the bucket only has to
// bound token scanning, not stop a genuine visitor. Kept separate from
// waitlist-join on purpose — one real journey (join, survey save, emailed
// confirm click, survey reload) makes 5+ requests, which used to exhaust the
// 5/15-min join bucket and bounce the user's own confirm link (#1296).
//
// Keyed on the TOKEN, not the address: a shared exit address (an office, a
// carrier NAT, a corporate proxy) put every stage-2 visitor in one 60-request
// bucket, and the #more screen polls while it waits for a confirmation. One
// person's poll could throttle a stranger's. Falls back to the IP key when
// there is no path token, which is how POST /confirm (email + code, no token)
// stays covered by this same limiter.
const waitlistTokenLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 240,
  name: 'waitlist-token',
  key: (req) => (MORE_TOKEN_RE.test(req.params?.token || '') ? `token:${req.params.token}` : null),
  message: 'Too many requests for this link. Try again in a few minutes.',
});

// Per-token keying is not by itself an enumeration defence: a scanner
// presents a DIFFERENT token every request, so it would get a fresh bucket
// each time. This is the half that bounds scanning, and it is the reason the
// two are mounted together on every token route.
//
// skipSuccessfulRequests is what makes 40 a safe number: a scan necessarily
// 404s, while an honest visitor holding a real token essentially never fails,
// so their reads and saves are refunded and never approach the ceiling.
const waitlistTokenScanLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 40,
  name: 'waitlist-token-scan',
  skipSuccessfulRequests: true,
  message: 'Too many waitlist requests from this address. Try again in a few minutes.',
});

// POST /api/public/waitlist/confirm carries an email and a six-digit code
// and no token, so the scan limiter above is its only per-address bound —
// and 40 failures is far too much room for a 6-digit code against one known
// address. Bucket per address instead: 10 attempts / 15 min.
//
// The key is a SHA-256 of the normalized email, never the address itself:
// limiter keys live in memory keyed by string and show up in nothing that is
// logged, and a hash keeps it that way while still bucketing exactly.
const waitlistCodeConfirmLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 10,
  name: 'waitlist-code-confirm',
  key: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return null;
    return `email:${crypto.createHash('sha256').update(email).digest('hex')}`;
  },
  message: 'Too many code attempts for that address. Try again in a few minutes.',
});

// Exact public-profile reads deliberately have no directory/search endpoint;
// this IP bucket additionally bounds brute-force username enumeration.
const publicProfileReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'public-profile-read',
  message: 'Too many profile lookups. Slow down for a minute.',
});

const profileReportLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: 'profile-report',
  keyByUser: true,
  skipFailedRequests: true,
  message: 'Too many profile reports. Try again later.',
});

// Admin "send a test email": 10 / hour / full admin. This is the one
// route where an authenticated operator can aim platform mail at an
// address of their choosing, so it gets its own small budget on top of
// the per-recipient rule in services/mail/rate-limit.js — that one bounds
// how often ONE address can be tested, this one bounds how many addresses
// one admin can work through.
//
// exemptAdmins is deliberately omitted, for the same reason as the export
// limiter above: the route is already full-admin-only, so exempting
// admins would disable the limit entirely. keyByUser, because the budget
// belongs to the operator rather than to the office they sit in.
// skipFailedRequests refunds the 400 a malformed address earns, so
// fixing a typo doesn't cost a slot.
const mailTestLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: 'mail-test',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Rate limit reached: up to 10 test emails per hour. You can try again ${retryPhrase(s)}.`,
});

// AI progress report generation (Reporting tab): each click is a paid LLM
// call debited to the clicking user, and report-ai.js already serializes
// real work per app — this only stops a stuck client from hammering the
// button. Per-user keyed: the spend belongs to the account, not to an IP.
const reportAiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 4,
  name: 'report-ai',
  keyByUser: true,
  message: 'Please wait a minute before regenerating the report.',
});

// Locking a report writes a multi-hundred-KB row per click; share and
// unshare are cheap but share the same per-user budget so a stuck client
// can't hammer any of the three verbs. Per-user keyed like report-ai.
const reportSnapshotLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  name: 'report-snapshot',
  keyByUser: true,
  message: 'Please wait a minute before locking or sharing more reports.',
});

// App-directory reads relayed through the shell bridge (#1195): 120 /
// min / user, shared across lookup and search. A typeahead fires per
// keystroke, so the ceiling is generous; keyed per user (not per IP) so
// one office NAT can't throttle a building, and matched to the
// per-(app,user) budget the app-token twin of these endpoints uses in
// routes/app-platform-api.js.
const userDirectoryLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'user-directory',
  keyByUser: true,
  message: 'Too many directory lookups. Please slow down.',
});

module.exports = { userDirectoryLimiter, dbExportLimiter, authLimiter, homePanelPrefLimiter, homeLayoutLimiter, draftWriteLimiter, walletCheckLimiter, appCreateLimiter, issueCreateLimiter, closeProposalLimiter, issueKindLimiter, agentFileWriteLimiter, chatLimiter, groupChatWriteLimiter, conversationMessageLimiter, conversationActionLimiter, conversationSafetyLimiter, conversationInviteLimiter, conversationReactionLimiter, conversationReportLimiter, messageBookmarkLimiter, attributeVoteLimiter, attachmentUploadLimiter, appFileUploadLimiter, feedbackTitleLimiter, boardOrderLimiter, issueScreenshotLimiter, profileWriteLimiter, usernameChangeLimiter, publicProfileReadLimiter, profileReportLimiter, topochainMobilePushRegistrationLimiter, reportAiLimiter, reportSnapshotLimiter, waitlistJoinLimiter, waitlistJoinAnonLimiter, waitlistJoinClientLimiter, waitlistJoinClientUserLimiter, waitlistTokenLimiter, waitlistTokenScanLimiter, waitlistCodeConfirmLimiter, mailTestLimiter };
