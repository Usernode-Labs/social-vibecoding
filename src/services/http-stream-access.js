'use strict';

const { readSessionCookie } = require('./browser-session-cookies');
const { nativeWebSessionIsLive } = require('./web-session-auth');
const SESSION = Symbol('authenticated-stream-session');
// Staging may replace the cookie during this request. Bind the session that
// actually authenticated it, rather than the old cookie sent by the browser.
function bindStreamSession(req, token) { req[SESSION] = token; }
function streamResource(method, path) {
    path = path.replace(/\/$/, '');
    let m;
    if (method === 'POST' && (m = /^\/api\/apps\/([^/]+)\/workshop\/ask$/i.exec(path))) {
        try {
            const slug = decodeURIComponent(m[1]);
            return slug && !slug.includes('/') ? { slug } : null;
        }
        catch {
            return null;
        }
    }
    return null;
}
// The credential and target share one snapshot. No handshake admin flag or
// cached collaborator roster is authority to send another response chunk.
const AUTHORIZE_SQL = `
 SELECT EXISTS (
  SELECT 1 FROM users u
  JOIN apps a ON a.slug = $5::text
  WHERE u.id = $1 AND u.anonymised_at IS NULL
   AND (
    ($2::text = 'cookie' AND NOT u.is_synthetic
     AND (u.has_platform_access OR u.is_admin OR u.private_member_since IS NOT NULL) AND EXISTS (
      SELECT 1 FROM sessions s WHERE s.token = $3::text AND s.user_id = u.id
       AND s.expires_at > clock_timestamp() AND ${nativeWebSessionIsLive('s')}))
    OR ($2::text = 'cli' AND EXISTS (
      SELECT 1 FROM cli_access_tokens t WHERE t.id = $4::bigint AND t.user_id = u.id
       AND t.revoked_at IS NULL AND t.expires_at > clock_timestamp() AND 'api:access' = ANY(t.scopes)))
   )
   AND a.moderation_suspended_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.app_id = a.id AND b.user_id = u.id)
   AND (u.is_admin OR a.view_visibility = 'public'
    OR EXISTS (SELECT 1 FROM app_collaborators m WHERE m.app_id = a.id AND m.user_id = u.id AND m.status = 'member'))
 ) AS allowed`;
function captureStreamAuthority(req, pool) {
    const id = req.user?.id;
    const resource = streamResource(req.method, req.path);
    // Hosted connector/delegated allowlists expose none of these SSE routes.
    // Keep them closed here until streaming has an explicit credential policy.
    const cli = req.cliAuthenticated && req.cliToken ? String(req.cliToken.id) : null;
    const unsupportedBearer = req.cliAuthenticated && !cli;
    const cookie = req[SESSION] || readSessionCookie(req);
    const source = cli ? 'cli' : 'cookie';
    const params = [id, source, cookie || null, cli, resource?.slug || null];
    const check = async (db) => (await db.query(AUTHORIZE_SQL, params)).rows[0]?.allowed === true;
    return async () => {
        if (!id || !resource || unsupportedBearer || (!cli && !cookie))
            return false;
        return check(pool);
    };
}
module.exports = { bindStreamSession, captureStreamAuthority, streamResource };
