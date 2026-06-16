// Pixel Cup Mini — minimal static server.
//
// The game is fully client-side (single-player vs AI): there is no
// database and there are no /api routes. The server's only jobs are to
// serve the built static bundle and to enforce the platform's canonical
// iframe-token auth gate so the app isn't exposed on its bare subdomain.

const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Canonical auth gate (see platform conventions "Auth — iframe token
// injection"). /health is public so the platform health-check works.
const PUBLIC_API_PATHS = new Set(['/health']);
const PUBLIC_PREFIXES = [];

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      /* invalid/expired token → treated as unauthenticated */
    }
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// The HTML shell is also auth-gated (per conventions) so a direct visit
// to the staging subdomain without a token doesn't reveal the app. Only
// authenticated GETs reach the static handler below; everything else was
// already short-circuited by the gate for non-GET / /api paths. For the
// document root and other GETs we still require a verified user.
app.use((req, res, next) => {
  if (!req.user && JWT_SECRET) {
    return res.status(401).send('Not authenticated');
  }
  next();
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // The bundle is content-addressed by deploy; allow short caching of
      // assets but always revalidate the HTML entry.
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`Pixel Cup Mini listening on :${PORT}`);
});
