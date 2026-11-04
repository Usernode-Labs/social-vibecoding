'use strict';

// Settings › Linked devices (#5974): the browsers signed in to your account
// on the web, and a way to sign one out.
//
// A linked browser is one row of `sessions` that is not a phone's: the
// Homeroom app's web session is restored from a native credential
// (native_session_incarnation_id) and is already the phone's row in
// services/linked-phones.js, so it is left out here, or one phone would be
// two rows. What the list can say about a browser is what the platform keeps
// on the row: a short class of what it is (`user_agent_class`, written at
// sign-in from the User-Agent header and never the header itself), when it
// signed in, and when it last authenticated a request (`last_seen_at`, which
// middleware/auth.js writes at most once per 15 minutes).
//
// The id a row carries is a prefix of the token's digest, never the token:
// it names the row to the person and to the route, and is no authority by
// itself. The route only ever acts on the signed-in account's own rows.

const BROWSERS = new Set(['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung', 'other']);
const SYSTEMS = new Set(['mac', 'windows', 'linux', 'android', 'ios', 'ipad', 'chromeos', 'other']);

// A closed vocabulary, so the stored class can never carry a version, a
// device model, a language or anything else the header says.
function classifyUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!ua) return null;

  let os = 'other';
  if (/iPhone|iPod/.test(ua)) os = 'ios';
  else if (/iPad/.test(ua)) os = 'ipad';
  else if (/Android/.test(ua)) os = 'android';
  else if (/CrOS/.test(ua)) os = 'chromeos';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'mac';
  else if (/Linux|X11/.test(ua)) os = 'linux';

  let browser = 'other';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) browser = 'edge';
  else if (/\bOPR\/|\bOpera\b/.test(ua)) browser = 'opera';
  else if (/SamsungBrowser\//.test(ua)) browser = 'samsung';
  else if (/\bFirefox\/|\bFxiOS\//.test(ua)) browser = 'firefox';
  else if (/\bCriOS\/|\bChrome\//.test(ua)) browser = 'chrome';
  else if (/\bSafari\//.test(ua) && /\bVersion\/|iPhone|iPad|iPod/.test(ua)) browser = 'safari';

  return `${browser}/${os}`;
}

// The stored class back into its two words, or nulls for a row written
// before the column existed or a class this build does not know.
function parseUserAgentClass(value) {
  if (typeof value !== 'string') return { browser: null, os: null };
  const [browser, os] = value.split('/');
  return {
    browser: BROWSERS.has(browser) && browser !== 'other' ? browser : null,
    os: SYSTEMS.has(os) && os !== 'other' ? os : null,
  };
}

const SESSION_ID = /^[0-9a-f]{16}$/;

function isBrowserSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

// The first 16 hex digits of the token's SHA-256: enough to tell an
// account's own rows apart, and nothing a holder could turn back into the
// token. Computed in SQL so the token itself never leaves the row.
const ID_SQL = "left(encode(sha256(convert_to(token, 'UTF8')), 'hex'), 16)";

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// `currentToken` is the caller's own session cookie, when there is one: that
// row is the browser the page is open in, and the list says so and puts it
// first.
async function listLinkedBrowsers(db, userId, { currentToken = null } = {}) {
  const { rows } = await db.query(
    `SELECT ${ID_SQL} AS id,
            user_agent_class,
            created_at,
            COALESCE(last_seen_at, created_at) AS last_used_at,
            (token = $2) IS TRUE AS current
       FROM sessions
      WHERE user_id = $1
        AND expires_at > NOW()
        AND native_session_incarnation_id IS NULL
      ORDER BY (token = $2) IS TRUE DESC,
               COALESCE(last_seen_at, created_at) DESC,
               created_at DESC,
               ${ID_SQL}`,
    [userId, currentToken]
  );
  return rows.map((row) => ({
    id: row.id,
    ...parseUserAgentClass(row.user_agent_class),
    signedInAt: toIso(row.created_at),
    lastUsedAt: toIso(row.last_used_at),
    current: row.current === true,
  }));
}

// Sign one of the account's own browsers out: its session row goes, so its
// next request carries a cookie that names nothing. Answers how many rows
// went (0 when the account has no such browser, which the route says as a
// 404: another account's browser and one already signed out look the same)
// and whether the caller's own session was among them, so the route can
// clear the cookies it is holding.
async function signOutBrowser(db, userId, sessionId, { currentToken = null } = {}) {
  if (!isBrowserSessionId(sessionId)) return { signedOut: 0, current: false };
  const { rows } = await db.query(
    `DELETE FROM sessions
      WHERE user_id = $1
        AND native_session_incarnation_id IS NULL
        AND ${ID_SQL} = $2
      RETURNING (token = $3) IS TRUE AS current`,
    [userId, sessionId, currentToken]
  );
  return { signedOut: rows.length, current: rows.some((row) => row.current === true) };
}

module.exports = {
  classifyUserAgent,
  parseUserAgentClass,
  isBrowserSessionId,
  listLinkedBrowsers,
  signOutBrowser,
};
