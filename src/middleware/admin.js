function adminMiddleware(req, res, next) {
  if (!req.user?.isAdmin) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return res.redirect('/');
  }
  next();
}

// Privileged-write gate (issue #311). `adminMiddleware` lets any admin —
// full OR view-only — through (they share the same read/visibility access).
// This stricter gate requires a FULL admin (`canAdminWrite`, derived in
// src/middleware/auth.js as is_admin AND NOT admin_readonly). Apply it to
// the mutating admin routes so a view-only admin reaching them gets a 403,
// while the GET reads on the same router stay reachable.
function requireAdminWrite(req, res, next) {
  if (!req.user?.canAdminWrite) {
    return res.status(403).json({ error: 'Full admin access required' });
  }
  next();
}

module.exports = { adminMiddleware, requireAdminWrite };
