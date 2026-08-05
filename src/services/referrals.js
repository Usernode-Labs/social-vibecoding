'use strict';

// Attribution-only referrals for issue #587. A referral is deliberately not
// an invite or a capability: it cannot grant app/platform access and has no
// reward consequence. The service therefore exposes only aggregate counts.
const crypto = require('crypto');
const { productionHostname, USERNODE_DOMAIN } = require('./caddy');

const CODE_RE = /^[a-f0-9]{32}$/;
const CODE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ATTRIBUTION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const COOKIE = 'usernode_referral';
const SECURE_COOKIE = process.env.NODE_ENV === 'production';

function validRawCode(raw) {
  return typeof raw === 'string' && CODE_RE.test(raw);
}

async function cleanup(pool) {
  // Both statements are bounded by indexed timestamps / small product tables.
  // Cleanup is opportunistic on authenticated lifecycle writes; anonymous
  // link traffic never gets to trigger database churn.
  await pool.query('DELETE FROM referral_attributions WHERE delete_after < NOW()');
  await pool.query('DELETE FROM referral_codes WHERE delete_after < NOW()');
}

async function validCode(pool, rawCode) {
  if (!validRawCode(rawCode)) return null;
  const { rows } = await pool.query(
    `SELECT id, owner_user_id
       FROM referral_codes
      WHERE code = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [rawCode]
  );
  return rows[0] || null;
}

async function validCodeId(pool, rawCode) {
  const row = await validCode(pool, rawCode);
  return row?.id || null;
}

async function getOrCreateCode(pool, ownerUserId, { rotate = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent opens/rotations for one owner. Otherwise the first
    // caller could receive a code that a racing upsert invalidates instantly.
    await client.query('SELECT pg_advisory_xact_lock($1)', [587000000 + Number(ownerUserId)]);
    await cleanup(client);
    if (!rotate) {
      const { rows } = await client.query(
        `SELECT id, code, expires_at
           FROM referral_codes
          WHERE owner_user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
        [ownerUserId]
      );
      if (rows[0]) {
        await client.query('COMMIT');
        return rows[0];
      }
    }

    // Retain the old row as revoked instead of overwriting it. Waitlist
    // first-touch rows reference the exact code version they accepted; this
    // makes rotation invalidate those pending attributions too.
    await client.query(
      `UPDATE referral_codes
          SET revoked_at = COALESCE(revoked_at, NOW()),
              delete_after = LEAST(delete_after, NOW() + INTERVAL '30 days')
        WHERE owner_user_id = $1 AND revoked_at IS NULL`,
      [ownerUserId]
    );

    const code = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    const deleteAfter = new Date(expiresAt.getTime() + CODE_RETENTION_MS);
    const { rows } = await client.query(
      `INSERT INTO referral_codes
         (owner_user_id, code, created_at, expires_at, revoked_at, delete_after)
       VALUES ($1, $2, NOW(), $3, NULL, $4)
       RETURNING id, code, expires_at`,
      [ownerUserId, code, expiresAt, deleteAfter]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function revokeCode(pool, ownerUserId) {
  await cleanup(pool);
  const { rowCount } = await pool.query(
    `UPDATE referral_codes
        SET revoked_at = COALESCE(revoked_at, NOW()),
            delete_after = LEAST(delete_after, NOW() + INTERVAL '30 days')
      WHERE owner_user_id = $1 AND revoked_at IS NULL`,
    [ownerUserId]
  );
  return rowCount > 0;
}

async function recordAttributionByCodeId(pool, codeId, inviteeUserId) {
  if (!Number.isInteger(Number(codeId)) || Number(codeId) <= 0
      || !Number.isInteger(Number(inviteeUserId)) || Number(inviteeUserId) <= 0) return false;
  await cleanup(pool);
  const deleteAfter = new Date(Date.now() + ATTRIBUTION_TTL_MS);
  const { rowCount } = await pool.query(
    `INSERT INTO referral_attributions
       (invitee_user_id, inviter_user_id, referral_code_id, delete_after)
     SELECT $2, c.owner_user_id, c.id, $3
       FROM referral_codes c
      WHERE c.id = $1
        AND c.owner_user_id <> $2
        AND c.revoked_at IS NULL
        AND c.expires_at > NOW()
     ON CONFLICT (invitee_user_id) DO NOTHING`,
    [codeId, inviteeUserId, deleteAfter]
  );
  return rowCount > 0;
}

async function recordAttribution(pool, rawCode, inviteeUserId) {
  const row = await validCode(pool, rawCode);
  if (!row) return false;
  return recordAttributionByCodeId(pool, row.id, inviteeUserId);
}

function clearPendingCookie(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: '/',
  });
}

async function consumeCookie(pool, req, res, inviteeUserId) {
  const rawCode = req.cookies?.[COOKIE];
  try {
    if (!validRawCode(rawCode)) return false;
    return await recordAttribution(pool, rawCode, inviteeUserId);
  } finally {
    // Invalid/expired/self/duplicate is terminal too: never leave a stale
    // pending marker to be retried against another account on this browser.
    clearPendingCookie(res);
  }
}

function setPendingCookie(res, rawCode) {
  if (!validRawCode(rawCode)) throw new Error('Invalid referral code');
  res.cookie(COOKIE, rawCode, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: '/',
    maxAge: PENDING_TTL_MS,
  });
}

async function publicAppDestination(pool, slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return null;
  const { rows } = await pool.query(
    `SELECT slug, name
       FROM apps
      WHERE slug = $1 AND status = 'running'
        AND view_visibility = 'public' AND self_hosted = FALSE`,
    [slug]
  );
  if (!rows[0]) return null;
  return {
    slug: rows[0].slug,
    name: rows[0].name,
    url: `https://${productionHostname(rows[0].slug)}`,
  };
}

function consentKey(config) {
  if (!config?.sessionSecret) throw new Error('SESSION_SECRET is required for referral consent');
  return config.sessionSecret;
}

function signConsent(config, rawCode, appSlug, now = Date.now()) {
  if (!validRawCode(rawCode)) throw new Error('Invalid referral code');
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    code: rawCode,
    app: appSlug,
    exp: now + CONSENT_TTL_MS,
    nonce: crypto.randomBytes(12).toString('hex'),
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', consentKey(config)).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyConsent(config, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', consentKey(config)).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (value.v !== 1 || !validRawCode(value.code)) return null;
    if (typeof value.app !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(value.app)) return null;
    if (!Number.isFinite(value.exp) || value.exp < now || value.exp > now + CONSENT_TTL_MS + 1000) return null;
    return value;
  } catch {
    return null;
  }
}

function sameOriginRequest(req) {
  const expected = platformOrigin(req);
  const origin = req.get('origin');
  if (origin) return origin === expected;
  const referer = req.get('referer');
  if (!referer) return false;
  try { return new URL(referer).origin === expected; } catch { return false; }
}

// Never reflect an arbitrary Host into a share link or CSRF comparison. In
// production/staging, only the configured platform domain and its managed
// subdomains are accepted. Local development keeps its explicit localhost
// port. Unexpected hosts fall back to the canonical platform origin.
function platformOrigin(req) {
  const rawHost = String(req.get('host') || '').toLowerCase();
  const hostname = rawHost.split(':')[0];
  if (hostname === USERNODE_DOMAIN || hostname.endsWith(`.${USERNODE_DOMAIN}`)) {
    return `https://${rawHost}`;
  }
  if (process.env.NODE_ENV !== 'production'
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')) {
    return `${req.protocol}://${rawHost}`;
  }
  return `https://${USERNODE_DOMAIN}`;
}

async function ownerSummary(pool, ownerUserId) {
  const [{ rows: codes }, { rows: totals }] = await Promise.all([
    pool.query(
      `SELECT expires_at FROM referral_codes
        WHERE owner_user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [ownerUserId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM referral_attributions
        WHERE inviter_user_id = $1 AND delete_after > NOW()`,
      [ownerUserId]
    ),
  ]);
  return {
    active: !!codes[0],
    expiresAt: codes[0]?.expires_at || null,
    attributedSignups: Number(totals[0]?.count || 0),
  };
}

async function adminAggregates(pool) {
  const { rows } = await pool.query(
    `SELECT u.username AS referrer, COUNT(*)::int AS attributed_signups,
            MIN(ra.attributed_at) AS first_attribution,
            MAX(ra.attributed_at) AS latest_attribution
       FROM referral_attributions ra
       JOIN users u ON u.id = ra.inviter_user_id
      WHERE ra.delete_after > NOW()
      GROUP BY u.id, u.username
      ORDER BY attributed_signups DESC, u.username ASC`
  );
  return rows.map((r) => ({
    referrer: r.referrer,
    attributedSignups: Number(r.attributed_signups),
    firstAttribution: r.first_attribution,
    latestAttribution: r.latest_attribution,
  }));
}

module.exports = {
  COOKIE,
  CODE_TTL_MS,
  PENDING_TTL_MS,
  ATTRIBUTION_TTL_MS,
  CONSENT_TTL_MS,
  validRawCode,
  validCode,
  validCodeId,
  getOrCreateCode,
  revokeCode,
  recordAttribution,
  recordAttributionByCodeId,
  consumeCookie,
  setPendingCookie,
  clearPendingCookie,
  publicAppDestination,
  signConsent,
  verifyConsent,
  sameOriginRequest,
  platformOrigin,
  ownerSummary,
  adminAggregates,
};
