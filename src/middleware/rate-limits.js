const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const log = require('../services/logger');

// A tiny wrapper that standardizes JSON responses + logs throttled hits.
// Keys auth routes by IP (user is anonymous) and write routes by userId
// when available so a single abusive account can't exhaust the limit for
// everyone behind the same NAT.
function makeLimiter({ windowMs, max, name, keyByUser = false, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // `ipKeyGenerator` collapses IPv6 to a subnet prefix so a single client
    // can't bypass the limit by rotating addresses within its /56.
    keyGenerator: (req) => {
      if (keyByUser && req.user?.id) return `user:${req.user.id}`;
      return ipKeyGenerator(req.ip);
    },
    handler: (req, res) => {
      log.warn('rate-limit', 'Throttled', {
        name,
        ip: req.ip,
        userId: req.user?.id,
        path: req.path,
      });
      res.status(429).json({
        error: message || 'Too many requests, please slow down',
      });
    },
  });
}

// Auth: 10 attempts / 15 min / IP. Tight because it's the primary brute-
// force surface.
const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: 'auth',
  message: 'Too many login attempts, try again in a few minutes',
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

// Issue / rename proposals: 20 / hour / user. Loose enough for normal
// use but stops spam creation of proposals.
const issueCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'issue-create',
  keyByUser: true,
  message: 'Too many issues/proposals — take a breather',
});

module.exports = { authLimiter, appCreateLimiter, issueCreateLimiter };
