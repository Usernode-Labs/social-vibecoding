'use strict';

// The app-host gate: who may load an app at its own address, and as whom.
//
// Every request to an app host (<slug>.<apps domain>) or a preview host
// (<slug>--s<id>.<apps domain>) is checked here before it reaches the app.
// Two edges ask:
//
//   * Caddy (the standalone deployment) forward_auths each request to
//     GET /__caddy/access (src/routes/internal.js mounts handleAccess).
//   * On Kubernetes, the app-host gate proxy (scripts/app-gate.js) sits in
//     front of every app's Service and asks the same route over the cluster
//     network, adding `X-Usernode-Gate: kubernetes` so the answer also names
//     the app's Service (`X-Usernode-Upstream`).
//
// One decision, two transports. A 2xx answer lets the request through; any
// other answer (a redirect that sets a cookie, a 404) is what the visitor
// gets instead, verbatim.
//
// ── Signing in at the app's own address (#3657) ─────────────────────────
//
// The platform's session cookie is host-only on the platform host, and must
// stay so: an app runs code its community wrote, and must never see the
// platform credential. So a top-level visit to a production app host with no
// app-host cookie is sent to the apex (/__access/authorize, routes/apps.js),
// where the session IS readable:
//
//   * signed in and allowed to view the app: the apex sends the browser back
//     to https://<host>/__usernode_access with a sign-in CODE. The code is an
//     EDGE_JWT_SECRET token good for one minute, bound to the host, the app,
//     the user and the platform session (`sid`, a SHA-256 of the session
//     token), and SINGLE-USE: its `jti` is recorded the first time it is
//     redeemed (edge_grant_redemptions) and refused after that. The gate
//     trades it for an HttpOnly, Secure, host-only (`__Host-`), SameSite=Lax
//     cookie and redirects to the same-host path the visitor asked for, with
//     the code gone from the address.
//   * not signed in, public app: the apex sends the browser back with a
//     one-minute "anonymous" token instead, which the gate turns into a
//     ten-minute marker so it stops asking; the visitor sees what they see
//     today.
//   * not signed in (private app), or not allowed: the platform's chromeless
//     view of the app, exactly as before.
//
// With a live cookie the gate hands the app the identity it already knows how
// to read: a fresh RS256 app identity token (the same one /api/iframe-token
// mints), in `X-Usernode-Identity` on the 2xx. The edge copies it onto the
// request as `x-usernode-token` (Caddyfile; scripts/app-gate.js), and strips
// the gate's own cookies from what the app receives. The cookie is only good
// while the platform session it came from is: signing out of Homeroom signs
// out of every app host.
//
// ── Identity only where it is safe ──────────────────────────────────────
//
// Sibling apps share a registrable domain, so SameSite=Lax does not stop a
// sibling app's page from making the browser send this cookie. Identity is
// therefore added only for requests the app's own page made, or a person
// made by navigating (identityAllowed): same-origin or user-initiated
// fetches, top-level GET navigations, WebSocket handshakes whose Origin is
// the app host itself, and writes whose Origin is the app host itself. A
// write to a private app that carries only the cookie and comes from
// anywhere else is refused outright.
//
// Previews never get identity from the cookie: a preview runs unreviewed
// code, and the token it would receive is good for the production app too.
// Previews keep the behaviour they had (members-only for private apps).
//
// ── Guests (P15) ────────────────────────────────────────────────────────
//
// Every view-public app (a public community's, or a public app with
// invite-only building) is open to people with no Homeroom account, at its
// own production address only:
//
//   * a visitor counts as a guest only when the request carries no
//     credential at all: one that carries the iframe token, the
//     `x-usernode-token` header or an Authorization header goes to the app
//     untouched, as it always did, valid or not;
//   * such a visitor's requests carry a GUEST token (platform-jwt
//     signGuestToken: audience `usernode:app:<id>:guest`, `pur: 'guest'`,
//     `guest: true`, no id or username), under the same same-origin rules
//     as a person's identity. No verifier written for a person's token
//     accepts it, so an app that has not learned about guests treats them
//     as the signed-out visitor it already saw;
//   * every write they make from a browser (POST, PUT, PATCH, DELETE with
//     an Origin or Sec-Fetch-Site) is refused here with 401 and JSON
//     `{ error: 'account_required' }`, which the bridge turns into a
//     "Make an account to continue" sheet. A server-to-server call (a
//     webhook: neither header) is the app's to answer, as before;
//   * a readable, host-only hint cookie tells the bridge to show its
//     "You're looking around" strip. It grants nothing.
//
// Never on a preview and never on a private app.
// `/__usernode_access?account=signup|signin&next=` sends the visitor to the
// platform's sign-up or sign-in, which brings them back through the
// authorize hop, signed in.
//
// APP_HOST_SIGNIN=off turns the sign-in half off (no hop for public apps, no
// identity from the cookie, no guests, the chromeless view for a direct visit
// to a private app) while keeping everything else.

const crypto = require('crypto');
const platformJwt = require('./platform-jwt');
const appAccess = require('./app-access');
const log = require('./logger');
const { USERNODE_DOMAIN } = require('./caddy');

const CALLBACK_PATH = '/__usernode_access';
// Appended when the gate redirects to itself to set a cookie from an iframe
// token, or to stop a loop: a request that carries it is never redirected
// again.
const RETRY_MARKER = '__ua';
// How long a "no Homeroom session here" answer is believed.
const ANON_TTL_S = 10 * 60;
// Identity tokens are minted per (app, user) and reused for this long; each
// lives an hour, so a reused one always has most of its life left.
const IDENTITY_REUSE_MS = 5 * 60 * 1000;
// A live session is believed for this long, so logging out takes effect
// on every app host within it.
const SESSION_CACHE_MS = 30 * 1000;
const CACHE_MAX = 5000;

// The non-admin capture fixture (services/visuals.js CAPTURE_USERNAME):
// screenshots of a private app's PREVIEW sign in as it. Pinned to the same
// literal by tests/edge-gate.test.js.
const CAPTURE_USERNAME = 'usernode-capture';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// How long the readable guest hint lasts. Signing in clears it.
const GUEST_HINT_TTL_S = 12 * 60 * 60;

const ACCOUNT_REQUIRED = Object.freeze({
  error: 'account_required',
  message: 'Make an account to continue.',
});

function secureCookies() {
  return process.env.NODE_ENV === 'production';
}

// `__Host-` cookies can only be set by the host itself, over HTTPS, for
// path `/`, with no Domain attribute, so a sibling app cannot plant one
// ("cookie tossing"). Plain HTTP dev boxes cannot use the prefix.
function cookieNames() {
  return secureCookies()
    ? { access: '__Host-usernode_access', anon: '__Host-usernode_anon', guest: '__Host-usernode_guest' }
    : { access: '__usernode_access', anon: '__usernode_anon', guest: '__usernode_guest' };
}

function signinEnabled() {
  return String(process.env.APP_HOST_SIGNIN || 'on').trim().toLowerCase() !== 'off';
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseUriQuery(uri) {
  try { return new URL('http://x' + uri).searchParams; } catch { return new URLSearchParams(); }
}

function uriPath(uri) {
  const q = String(uri || '/').indexOf('?');
  return q === -1 ? String(uri || '/') : String(uri).slice(0, q);
}

// Where to send the browser after a sign-in hop: a same-host relative path,
// never absolute or protocol-relative, so the hop is never an open redirect.
// No backslashes (some browsers read them as `/`), no control characters, no
// fragment, bounded, and never the callback itself.
function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.length > 2048 || /[\\\u0000-\u001f\u007f\s]/.test(raw)) return '/';
  const next = raw.split('#')[0];
  if (uriPath(next) === CALLBACK_PATH) return '/';
  return next || '/';
}

function authorizeUrl(host, next) {
  return `https://${USERNODE_DOMAIN}/__access/authorize`
    + `?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
}

// The platform shell's chromeless view of the app: where a visitor the app
// host cannot sign in has always been sent. The path rides as the
// fragment's final `?path=`, verbatim, which the shell validates (the same
// shape the Caddyfile's 401 rescue writes).
function chromelessUrl(slug, next = '/') {
  const base = `https://${USERNODE_DOMAIN}/#app/${slug}/full`;
  return next && next !== '/' ? `${base}?path=${next}` : base;
}

function withRetryMarker(uri) {
  return `${uri}${uri.includes('?') ? '&' : '?'}${RETRY_MARKER}=1`;
}

function header(headers, name) {
  const v = headers?.[name];
  return typeof v === 'string' ? v : '';
}

function isWebSocketUpgrade(headers) {
  return header(headers, 'upgrade').toLowerCase() === 'websocket'
    || !!headers?.['sec-websocket-key'];
}

// A person navigating the whole tab: a typed address, a link, a bookmark.
// `Sec-Fetch-Dest: document` is only ever sent on a top-level navigation
// (iframe loads say `iframe`, assets `script`/`style`/`image`, fetches
// `empty`; tools send nothing), which is the same test the Caddyfile's 401
// rescue uses.
function isTopLevelNavigation(headers, method) {
  return SAFE_METHODS.has(method)
    && header(headers, 'sec-fetch-dest').toLowerCase() === 'document';
}

function selfOrigins(host) {
  const origins = [`https://${host}`];
  if (!secureCookies()) origins.push(`http://${host}`);
  return origins;
}

// May this request carry the visitor's identity to the app? See the header.
function identityAllowed({ method, headers, host }) {
  const site = header(headers, 'sec-fetch-site').toLowerCase();
  const origin = header(headers, 'origin');
  const own = selfOrigins(host);
  if (isWebSocketUpgrade(headers)) return own.includes(origin);
  if (SAFE_METHODS.has(method)) {
    if (site === 'same-origin' || site === 'none') return true;
    if (isTopLevelNavigation(headers, method)) return true;
    if (!site) return !origin || own.includes(origin);
    return false;
  }
  if (!own.includes(origin)) return false;
  return !site || site === 'same-origin';
}

// A write that comes from the app's own page.
function sameOriginWrite({ headers, host }) {
  const origin = header(headers, 'origin');
  if (!selfOrigins(host).includes(origin)) return false;
  const site = header(headers, 'sec-fetch-site').toLowerCase();
  return !site || site === 'same-origin';
}

// Every gate cookie name, in either spelling, for stripping before the app.
const GATE_COOKIE_RE = /^(?:__Host-usernode|__usernode)_(?:access|anon)$/;

// The Cookie header minus the gate's own cookies (scripts/app-gate.js; the
// Caddyfile does the same with a header_up replacement).
function stripGateCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return '';
  return cookieHeader.split(';')
    .map((part) => part.trim())
    .filter((part) => part && !GATE_COOKIE_RE.test(part.split('=')[0].trim()))
    .join('; ');
}

// ── Bounded TTL caches ────────────────────────────────────────────────────
function boundedSet(map, key, value) {
  if (map.size >= CACHE_MAX) map.clear();
  map.set(key, value);
}

const liveSessions = new Map();      // `${sid}:${uid}` -> at
const guestTokens = new Map();       // appId -> { at, token }
const identities = new Map();        // `${appId}:${uid}` -> { at, token }
const upstreams = new Map();         // host -> { at, name }
let captureId = { at: 0, id: null };

function resetCachesForTest() {
  liveSessions.clear(); identities.clear(); upstreams.clear();
  guestTokens.clear();
  captureId = { at: 0, id: null };
}

// Is the platform session this cookie came from still live? Signing out
// deletes the session row, so the answer turns false within SESSION_CACHE_MS.
async function sessionLive(pool, sid, uid) {
  if (typeof sid !== 'string' || !/^[0-9a-f]{64}$/.test(sid) || !Number.isInteger(uid)) return false;
  const key = `${sid}:${uid}`;
  const at = liveSessions.get(key);
  if (at && Date.now() - at < SESSION_CACHE_MS) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM sessions
      WHERE encode(sha256(token::bytea), 'hex') = $1
        AND user_id = $2
        AND expires_at > NOW()
      LIMIT 1`,
    [sid, uid]
  );
  if (!rows.length) { liveSessions.delete(key); return false; }
  boundedSet(liveSessions, key, Date.now());
  return true;
}

// Record a code's jti. True only for the first redemption, on any process.
async function redeemOnce(pool, jti, expSeconds) {
  if (typeof jti !== 'string' || !/^[0-9a-f]{32}$/.test(jti)) return false;
  if (!Number.isFinite(expSeconds)) return false;
  const { rows } = await pool.query(
    `WITH purge AS (
       DELETE FROM edge_grant_redemptions
        WHERE jti IN (SELECT jti FROM edge_grant_redemptions
                       WHERE expires_at < NOW() LIMIT 100)
     )
     INSERT INTO edge_grant_redemptions (jti, expires_at)
     VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING
     RETURNING jti`,
    [jti, expSeconds]
  );
  return rows.length === 1;
}

// The app identity token for this user and app: the same claims
// /api/iframe-token signs (server.js), reused for a few minutes. None for a
// PROVISIONAL handle on a public app (`publicApp`): the person has not
// picked the username a public place shows (services/usernames.js), so the
// app sees a visitor until they do, as /api/iframe-token's refusal does.
async function mintIdentity(pool, appId, uid, { publicApp = false } = {}) {
  const key = `${appId}:${uid}`;
  const hit = identities.get(key);
  if (hit && Date.now() - hit.at < IDENTITY_REUSE_MS) return hit.token;
  const { rows } = await pool.query(
    `SELECT id, username, usernode_pubkey, locale, is_synthetic,
            username_provisional_since IS NOT NULL AS provisional
       FROM users WHERE id = $1`,
    [uid]
  );
  const user = rows[0];
  if (!user || user.is_synthetic) return null;
  if (publicApp && user.provisional === true) return null;
  const token = platformJwt.signAppIdentityToken({
    appId,
    user: {
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey || null,
      locale: user.locale || null,
    },
  });
  boundedSet(identities, key, { at: Date.now(), token });
  return token;
}

// One guest token per app, reused like a person's identity.
function guestToken(appId) {
  const hit = guestTokens.get(appId);
  if (hit && Date.now() - hit.at < IDENTITY_REUSE_MS) return hit.token;
  const token = platformJwt.signGuestToken({ appId });
  boundedSet(guestTokens, appId, { at: Date.now(), token });
  return token;
}

// A request a browser made: browsers send Origin on every write and
// Sec-Fetch-Site on every request; a server-to-server call sends neither.
function browserRequest(headers) {
  return !!header(headers, 'origin') || !!header(headers, 'sec-fetch-site');
}

// The platform's sign-up or sign-in, coming back through the authorize hop
// to the same page of the app, signed in (auth-screens.js RETURN_TO_PATHS).
function accountUrl(kind, host, next) {
  const back = `/__access/authorize?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
  return `https://${USERNODE_DOMAIN}/?return_to=${encodeURIComponent(back)}#${kind === 'signup' ? 'signup' : 'login'}`;
}

async function isCaptureIdentity(pool, uid) {
  if (!Number.isInteger(uid)) return false;
  if (!captureId.at || Date.now() - captureId.at > 5 * 60 * 1000) {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [CAPTURE_USERNAME]);
    captureId = { at: Date.now(), id: rows[0]?.id ?? null };
  }
  return captureId.id != null && captureId.id === uid;
}

// The Kubernetes Service an app host's requests go to (scripts/app-gate.js).
// The runtime name the platform deployed under, or the name it would have
// derived (services/kubernetes.js appResourceName).
const SERVICE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
async function upstreamFor(pool, parsed, vis) {
  const hit = upstreams.get(parsed.host);
  if (hit && Date.now() - hit.at < 10_000) return hit.name;
  const { appResourceName } = require('./kubernetes');
  let name = null;
  const preview = parsed.label.match(/^[a-z0-9-]+?--s(\d+)(?:--[a-z0-9]+)?$/);
  if (preview) {
    const sessionId = Number(preview[1]);
    const { rows } = await pool.query(
      'SELECT staging_runtime_name FROM chat_sessions WHERE id = $1 AND app_id = $2',
      [sessionId, vis.appId]
    );
    if (!rows.length) return null;
    name = rows[0].staging_runtime_name
      || appResourceName({ id: vis.appId, slug: parsed.slug }, 'staging', sessionId);
  } else {
    const { rows } = await pool.query('SELECT runtime_name FROM apps WHERE id = $1', [vis.appId]);
    name = rows[0]?.runtime_name || appResourceName({ id: vis.appId, slug: parsed.slug }, 'production');
  }
  if (!SERVICE_NAME_RE.test(String(name || ''))) return null;
  boundedSet(upstreams, parsed.host, { at: Date.now(), name });
  return name;
}

function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

function readAccessCookie(req, { host, appId }) {
  const raw = req.cookies?.[cookieNames().access];
  if (!raw) return null;
  const claims = platformJwt.orNull(() => platformJwt.verifyEdgeCookie(raw));
  if (!claims || claims.host !== host || claims.appId !== appId || !Number.isInteger(claims.uid)) return null;
  return claims;
}

function anonMarked(req) {
  return req.cookies?.[cookieNames().anon] === '1';
}

// ── The decision ──────────────────────────────────────────────────────────

async function handleAccess(pool, req, res) {
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
  const method = String(req.headers['x-forwarded-method'] || 'GET').toUpperCase();
  const uri = typeof req.headers['x-forwarded-uri'] === 'string' && req.headers['x-forwarded-uri']
    ? req.headers['x-forwarded-uri'] : '/';
  const viaKubernetesGate = header(req.headers, 'x-usernode-gate') === 'kubernetes';
  // Caddy's custom-domain site (#4405) cannot derive the container from the
  // host the way the wildcard site's map does, so it asks for it too.
  const viaCaddyCustom = header(req.headers, 'x-usernode-gate') === 'caddy';

  res.set('Cache-Control', 'no-store');
  // A Homeroom host parses with no database work; anything else is a LIVE
  // custom domain (#4405, services/app-domains.js resolveAppHost) or 404.
  // A custom host is the app's production address: never a preview.
  const parsed = await require('./app-domains').resolveAppHost(pool, rawHost);
  if (!parsed) return res.status(404).send('Not found');
  const { slug, host } = parsed;
  const isProduction = parsed.label === slug;

  const vis = await appAccess.getHostVisibility(pool, slug);
  if (!vis) return res.status(404).send('Not found');
  if (vis.suspended) return res.status(403).send('App suspended by moderation');

  const query = parseUriQuery(uri);
  const signin = signinEnabled() && isProduction;
  const topNav = isTopLevelNavigation(req.headers, method);
  const ws = isWebSocketUpgrade(req.headers);
  const names = cookieNames();

  const redirect = (location) => {
    res.set('Referrer-Policy', 'no-referrer');
    return res.redirect(302, location);
  };

  // Every 2xx goes out through here, so what an edge copies onto the
  // request is decided in one place.
  const allow = async ({ identityFor = null, guest = false } = {}) => {
    if (identityFor != null) {
      const token = await mintIdentity(pool, vis.appId, identityFor, { publicApp: !vis.viewPrivate });
      if (token) res.set('X-Usernode-Identity', token);
    } else if (guest) {
      res.set('X-Usernode-Identity', guestToken(vis.appId));
    }
    if (viaKubernetesGate) {
      const upstream = await upstreamFor(pool, parsed, vis);
      if (!upstream) return res.status(404).send('Not found');
      res.set('X-Usernode-Upstream', upstream);
      if (isProduction) res.set('X-Usernode-Applink', chromelessUrl(slug));
    } else if (viaCaddyCustom) {
      // The docker runtime's production container name (application-runtime).
      res.set('X-Usernode-Upstream', `usernode-app-${slug}`);
      if (isProduction) res.set('X-Usernode-Applink', chromelessUrl(slug));
    }
    return res.status(200).send('ok');
  };

  // 1. Callbacks from the apex authorize hop. Handled first so a fresh code
  // always re-mints the cookie. Never reaches the app.
  if (uriPath(uri) === CALLBACK_PATH) {
    const next = safeNext(query.get('next'));
    // Did the cookie just set actually stick? A browser that refuses
    // cookies would otherwise go round the hop forever; it goes on with the
    // loop marker instead, which nothing ever redirects again.
    const check = query.get('check');
    if (check === 'access' || check === 'anon') {
      const stuck = check === 'access' ? !!req.cookies?.[names.access] : anonMarked(req);
      return redirect(stuck ? next : withRetryMarker(next));
    }
    const checkUrl = (kind) => `${CALLBACK_PATH}?check=${kind}&next=${encodeURIComponent(next)}`;
    // The bridge's "Continue with email" and "I have an account".
    const account = query.get('account');
    if (account === 'signup' || account === 'signin') {
      return redirect(isProduction
        ? accountUrl(account, host, next)
        : `https://${USERNODE_DOMAIN}/`);
    }
    const anon = query.get('anon');
    if (anon) {
      const ok = platformJwt.orNull(() => platformJwt.verifyEdgeAnon(anon));
      if (ok && ok.host === host && !vis.viewPrivate && signin) {
        res.cookie(names.anon, '1', cookieOptions(ANON_TTL_S));
        // Readable on purpose: it only tells the bridge to show its strip.
        res.cookie(names.guest, '1', { ...cookieOptions(GUEST_HINT_TTL_S), httpOnly: false });
        return redirect(checkUrl('anon'));
      }
      // Never bounce again from here: a loop-breaker, not a dead end.
      return redirect(withRetryMarker(next));
    }
    const code = query.get('code') || query.get('grant') || '';
    const claims = platformJwt.orNull(() => platformJwt.verifyEdgeGrant(code));
    let ok = !!claims
      && claims.host === host
      && claims.appId === vis.appId
      && Number.isInteger(claims.uid)
      && typeof claims.sid === 'string';
    // Cheap checks first; the redemption is last so a code that fails
    // anything else is not spent.
    if (ok) ok = await appAccess.isViewMember(pool, vis.appId, claims.uid);
    if (ok) ok = await sessionLive(pool, claims.sid, claims.uid);
    if (ok) ok = await redeemOnce(pool, claims.jti, claims.exp);
    if (ok) {
      const cookie = platformJwt.signEdgeCookie({
        uid: claims.uid, appId: vis.appId, host, sid: claims.sid,
      });
      res.cookie(names.access, cookie, cookieOptions(platformJwt.EDGE_COOKIE_TTL_S));
      res.clearCookie(names.anon, { path: '/', secure: secureCookies(), sameSite: 'lax' });
      res.clearCookie(names.guest, { path: '/', secure: secureCookies(), sameSite: 'lax' });
      return redirect(checkUrl('access'));
    }
    if (claims) {
      log.warn('edge-gate', 'Sign-in code refused', { host, reason: 'invalid_or_spent' });
    }
    // Refused (expired, spent, another host, not a member, signed out):
    // where an unsigned visitor goes, never another round of the hop.
    return redirect(isProduction ? chromelessUrl(slug, next) : `https://${USERNODE_DOMAIN}/`);
  }

  const ownToken = header(req.headers, 'x-usernode-token');
  const queryToken = query.get('token') || '';
  const cookie = readAccessCookie(req, { host, appId: vis.appId });

  // ── View-public apps ──────────────────────────────────────────────────
  if (!vis.viewPrivate) {
    // Every public app welcomes guests wherever the sign-in half is on.
    const guests = signin;
    // A request that carries a credential of its own (the iframe token, the
    // header the frontend forwards it in, or an Authorization header) is the
    // app's to authenticate, exactly as before guests existed: valid or not,
    // it passes untouched. Only a request with no credential at all can be a
    // guest, so turning guests on for every public app changes nothing for
    // a signed-in person, however an existing app sends their token.
    if (ownToken || queryToken || header(req.headers, 'authorization')) return allow();
    if (signin && cookie?.sid
        && await appAccess.isViewMember(pool, vis.appId, cookie.uid)
        && await sessionLive(pool, cookie.sid, cookie.uid)) {
      const ok = identityAllowed({ method, headers: req.headers, host });
      return allow({ identityFor: ok ? cookie.uid : null });
    }
    if (signin && topNav && !anonMarked(req) && query.get(RETRY_MARKER) !== '1') {
      return redirect(authorizeUrl(host, safeNext(uri)));
    }
    if (guests) {
      // Every write needs an account.
      if (WRITE_METHODS.has(method) && browserRequest(req.headers)) {
        return res.status(401).type('application/json').send(JSON.stringify(ACCOUNT_REQUIRED));
      }
      return allow({ guest: identityAllowed({ method, headers: req.headers, host }) });
    }
    return allow();
  }

  // ── View-private apps: a member with view access, or nothing ──────────

  // 2. An app identity token the request carries: the shell's ?token= on an
  // iframe load, or the x-usernode-token header app frontends forward.
  const iframeJwt = platformJwt.orNull(
    () => platformJwt.verifyAppIdentityToken(queryToken || ownToken || '', { appId: vis.appId })
  );
  if (iframeJwt && Number.isInteger(iframeJwt.id)
      && (await appAccess.isViewMember(pool, vis.appId, iframeJwt.id)
        || (!isProduction && await isCaptureIdentity(pool, iframeJwt.id)))) {
    // A header-credentialed fetch, a WebSocket handshake (which cannot
    // follow a redirect) or a cookie-set retry that came back cookieless.
    if (!queryToken || ws || query.get(RETRY_MARKER) === '1') return allow();
    // The first iframe document load: set the scoped cookie and bounce back
    // to the same URL so the page's assets (no token, no header) pass too.
    // It carries no platform session, so it only ever opens the door.
    const scoped = platformJwt.signEdgeCookie({ uid: iframeJwt.id, appId: vis.appId, host });
    res.cookie(names.access, scoped, cookieOptions(platformJwt.EDGE_COOKIE_TTL_S));
    return redirect(withRetryMarker(uri));
  }

  // 3. The app-host cookie.
  if (cookie && await appAccess.isViewMember(pool, vis.appId, cookie.uid)) {
    const live = cookie.sid ? await sessionLive(pool, cookie.sid, cookie.uid) : null;
    if (live !== false) {
      // A write that carries nothing but the cookie and comes from another
      // origin is refused: the cookie travels on a sibling app's requests.
      if (!SAFE_METHODS.has(method) && !ws && !sameOriginWrite({ headers: req.headers, host })) {
        return res.status(403).send('Forbidden');
      }
      if (signin && live) {
        const ok = identityAllowed({ method, headers: req.headers, host });
        return allow({ identityFor: ok ? cookie.uid : null });
      }
      // A door-only cookie (from an iframe token) on a direct visit: trade
      // it for one that signs the person in, if they are signed in.
      if (signin && topNav && query.get(RETRY_MARKER) !== '1') {
        return redirect(authorizeUrl(host, safeNext(uri)));
      }
      return allow();
    }
    // A cookie whose platform session has ended opens nothing.
  }

  // 4. Nothing valid. A visit that already went round the hop (the loop
  // marker) goes where an unsigned visitor goes rather than round again.
  if (topNav && isProduction) {
    return redirect(signin && query.get(RETRY_MARKER) !== '1'
      ? authorizeUrl(host, safeNext(uri))
      : chromelessUrl(slug));
  }
  if (method === 'GET') return redirect(authorizeUrl(host, safeNext(uri)));
  return res.status(404).send('Not found');
}

// The apex half: GET /__access/authorize (routes/apps.js). `req.user` is
// the platform session's user or undefined (middleware/auth.js lets this one
// path through anonymously so it can answer for a signed-out visitor).
async function handleAuthorize(pool, req, res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  // The same resolution as the gate: an unknown host is 404 here, which is
  // what keeps the redirect back to `host` from being an open redirect.
  const parsed = await require('./app-domains').resolveAppHost(pool, req.query.host);
  if (!parsed) return res.status(404).send('Not found');
  const next = safeNext(typeof req.query.next === 'string' ? req.query.next : '/');
  const isProduction = parsed.label === parsed.slug;
  const vis = await appAccess.getHostVisibility(pool, parsed.slug);
  if (!vis || vis.suspended) return res.status(404).send('Not found');
  const fallback = isProduction ? chromelessUrl(parsed.slug, next) : `https://${USERNODE_DOMAIN}/`;

  if (!req.user) {
    if (isProduction && !vis.viewPrivate && signinEnabled()) {
      const anon = platformJwt.signEdgeAnon({ host: parsed.host });
      return res.redirect(302, `https://${parsed.host}${CALLBACK_PATH}`
        + `?anon=${encodeURIComponent(anon)}&next=${encodeURIComponent(next)}`);
    }
    return res.redirect(302, fallback);
  }

  const app = await appAccess.getAppForUser(
    pool, parsed.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
  );
  // The session the code is bound to. A request authenticated some other
  // way (a CLI bearer) has none, and gets no code.
  const sessionToken = typeof req.cookies?.session === 'string' ? req.cookies.session : '';
  if (!app || app.id !== vis.appId || !sessionToken) return res.redirect(302, fallback);

  const code = appAccess.mintAccessGrant({
    uid: req.user.id, appId: app.id, host: parsed.host, sid: sha256Hex(sessionToken),
  });
  return res.redirect(302, `https://${parsed.host}${CALLBACK_PATH}`
    + `?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
}

module.exports = {
  CALLBACK_PATH,
  RETRY_MARKER,
  ANON_TTL_S,
  CAPTURE_USERNAME,
  ACCOUNT_REQUIRED,
  cookieNames,
  signinEnabled,
  sha256Hex,
  safeNext,
  authorizeUrl,
  chromelessUrl,
  isTopLevelNavigation,
  identityAllowed,
  sameOriginWrite,
  stripGateCookies,
  sessionLive,
  redeemOnce,
  mintIdentity,
  accountUrl,
  upstreamFor,
  handleAccess,
  handleAuthorize,
  _resetCachesForTest: resetCachesForTest,
};
