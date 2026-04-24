function adminMiddleware(req, res, next) {
  if (!req.user?.isAdmin) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return res.redirect('/');
  }
  next();
}

module.exports = { adminMiddleware };
