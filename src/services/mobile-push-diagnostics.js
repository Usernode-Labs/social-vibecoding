'use strict';

const MAX_LOOKUP_LENGTH = 255;
const RECENT_NOTIFICATION_LIMIT = 30;

class MobilePushDiagnosticsInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MobilePushDiagnosticsInputError';
  }
}

function normalizeLookup(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new MobilePushDiagnosticsInputError('User lookup must be text.');
  }
  const query = raw.trim();
  if (!query) return null;
  if (query.length > MAX_LOOKUP_LENGTH) {
    throw new MobilePushDiagnosticsInputError('User lookup is too long.');
  }
  const parsed = /^\d+$/.test(query) ? Number(query) : null;
  const userId = Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647
    ? parsed
    : null;
  return { query, userId };
}

function groupNotificationRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    let notification = grouped.get(String(row.notification_id));
    if (!notification) {
      notification = {
        id: row.notification_id,
        kind: row.kind,
        category: row.push_category,
        pushEnabled: row.push_enabled === true,
        readAt: row.read_at,
        createdAt: row.notification_created_at,
        deliveries: [],
      };
      grouped.set(String(row.notification_id), notification);
    }
    if (row.delivery_id !== null && row.delivery_id !== undefined) {
      notification.deliveries.push({
        id: row.delivery_id,
        platform: row.delivery_platform || 'unknown',
        environment: row.delivery_environment,
        installationId: row.delivery_installation_id,
        status: row.delivery_status,
        attempts: row.delivery_attempts,
        availableAt: row.delivery_available_at,
        expiresAt: row.delivery_expires_at,
        sentAt: row.delivery_sent_at,
        errorCode: row.delivery_error_code,
        createdAt: row.delivery_created_at,
        updatedAt: row.delivery_updated_at,
      });
    }
  }
  return [...grouped.values()];
}

function latestPlatformDelivery(platform, notifications) {
  const deliveries = notifications.flatMap((notification) => (
    notification.deliveries
      .filter((delivery) => delivery.platform === platform)
      .map((delivery) => ({ ...delivery, kind: notification.kind }))
  ));
  deliveries.sort((a, b) => (
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
  ));
  return deliveries[0] || null;
}

function registrationDiagnosis(platform, registrations) {
  const label = platform === 'ios' ? 'iOS' : 'Android';
  const matches = registrations.filter((row) => row.platform === platform);
  if (!matches.length) {
    return {
      platform,
      area: 'registration',
      severity: 'error',
      code: 'registration_missing',
      message: `No current ${label} push registration exists for this account.`,
    };
  }
  const eligible = matches.filter((row) => row.delivery_eligible === true);
  if (eligible.length) {
    return {
      platform,
      area: 'registration',
      severity: 'success',
      code: 'registration_active',
      message: `${label} has ${eligible.length} active, delivery-eligible registration${eligible.length === 1 ? '' : 's'}.`,
    };
  }
  if (matches.every((row) => !['authorized', 'provisional'].includes(row.permission_status))) {
    return {
      platform,
      area: 'registration',
      severity: 'error',
      code: 'permission_ineligible',
      message: `${label} is registered, but notification permission is not eligible for delivery.`,
    };
  }
  return {
    platform,
    area: 'registration',
    severity: 'error',
    code: 'session_inactive',
    message: `${label} is registered, but every registration has an expired Social session.`,
  };
}

function deliveryDiagnosis(platform, registrations, notifications) {
  const label = platform === 'ios' ? 'iOS' : 'Android';
  const latest = latestPlatformDelivery(platform, notifications);
  if (!latest) {
    if (!notifications.length) {
      return {
        platform,
        area: 'delivery',
        severity: 'info',
        code: 'no_recent_activity',
        message: `No recent push-capable inbox activity is available to evaluate for ${label}.`,
      };
    }
    const hasEligible = registrations.some((row) => (
      row.platform === platform && row.delivery_eligible === true
    ));
    return {
      platform,
      area: 'delivery',
      severity: 'warning',
      code: 'delivery_missing',
      message: hasEligible
        ? `Recent inbox activity produced no ${label} delivery row; this registration was not eligible when those notifications were inserted.`
        : `Recent inbox activity produced no ${label} delivery because no eligible registration was available.`,
    };
  }
  const suffix = latest.errorCode ? ` (${latest.errorCode})` : '';
  switch (latest.status) {
    case 'sent':
      return {
        platform,
        area: 'delivery',
        severity: 'success',
        code: 'provider_accepted',
        message: `FCM accepted the latest ${label} ${latest.kind} delivery; device presentation is not confirmed.`,
      };
    case 'pending':
      return {
        platform,
        area: 'delivery',
        severity: 'warning',
        code: latest.errorCode || 'provider_retrying',
        message: `The latest ${label} ${latest.kind} delivery is waiting for retry${suffix}.`,
      };
    case 'sending':
      return {
        platform,
        area: 'delivery',
        severity: 'info',
        code: 'provider_sending',
        message: `The latest ${label} ${latest.kind} delivery is currently being sent.`,
      };
    case 'dead':
      return {
        platform,
        area: 'delivery',
        severity: 'error',
        code: latest.errorCode || 'provider_rejected',
        message: `The latest ${label} ${latest.kind} delivery failed permanently${suffix}.`,
      };
    case 'cancelled':
      return {
        platform,
        area: 'delivery',
        severity: 'error',
        code: latest.errorCode || 'delivery_cancelled',
        message: `The latest ${label} ${latest.kind} delivery was cancelled before provider acceptance${suffix}.`,
      };
    default:
      return {
        platform,
        area: 'delivery',
        severity: 'warning',
        code: 'delivery_unknown',
        message: `The latest ${label} delivery has an unknown state.`,
      };
  }
}

function diagnose(registrations, notifications) {
  return ['ios', 'android'].flatMap((platform) => [
    registrationDiagnosis(platform, registrations),
    deliveryDiagnosis(platform, registrations, notifications),
  ]);
}

async function loadOverview(pool) {
  const [deployment, registrations, recent] = await Promise.all([
    pool.query(
      `SELECT environment, firebase_project_id, send_enabled, send_not_before, updated_at
         FROM mobile_push_deployment_state
        ORDER BY environment`
    ),
    pool.query(
      `SELECT platform,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE permission_status IN ('authorized', 'provisional')
                  AND session_expires_at > NOW()
              )::int AS eligible,
              MAX(last_seen_at) AS last_seen_at
         FROM mobile_push_registrations
        GROUP BY platform
        ORDER BY platform`
    ),
    pool.query(
      `SELECT COALESCE(platform, 'unknown') AS platform,
              status, last_error_code,
              COUNT(*)::int AS total,
              MAX(updated_at) AS last_updated_at
         FROM mobile_push_deliveries
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY COALESCE(platform, 'unknown'), status, last_error_code
        ORDER BY MAX(updated_at) DESC
        LIMIT 30`
    ),
  ]);
  return {
    deployment: deployment.rows,
    registrations: registrations.rows,
    deliveriesLast24h: recent.rows,
  };
}

async function resolveUser(pool, lookup) {
  const { rows } = await pool.query(
    `SELECT id, username
       FROM users
      WHERE ($2::integer IS NOT NULL AND id = $2)
         OR LOWER(username) = LOWER($1)
         OR LOWER(email) = LOWER($1)
      ORDER BY CASE
        WHEN $2::integer IS NOT NULL AND id = $2 THEN 0
        WHEN LOWER(username) = LOWER($1) THEN 1
        ELSE 2
      END
      LIMIT 1`,
    [lookup.query, lookup.userId]
  );
  return rows[0] || null;
}

async function loadUser(pool, user) {
  const [registrations, preferences, notificationRows] = await Promise.all([
    pool.query(
      `SELECT id, installation_id, environment, platform, permission_status,
              session_expires_at, last_seen_at, created_at, updated_at,
              (permission_status IN ('authorized', 'provisional')
                AND session_expires_at > NOW()) AS delivery_eligible
         FROM mobile_push_registrations
        WHERE user_id = $1
        ORDER BY platform, updated_at DESC`,
      [user.id]
    ),
    pool.query(
      `SELECT policy.category,
              COALESCE(preference.enabled, BOOL_AND(policy.default_enabled)) AS enabled
         FROM mobile_push_kind_categories policy
         LEFT JOIN mobile_push_preferences preference
           ON preference.user_id = $1
          AND preference.category = policy.category
        GROUP BY policy.category, preference.enabled
        ORDER BY policy.category`,
      [user.id]
    ),
    pool.query(
      `WITH recent AS (
         SELECT n.id, n.kind, n.read_at, n.created_at,
                policy.category AS push_category,
                COALESCE(preference.enabled, policy.default_enabled) AS push_enabled
           FROM notifications n
           JOIN mobile_push_kind_categories policy ON policy.kind = n.kind
           LEFT JOIN mobile_push_preferences preference
             ON preference.user_id = n.user_id
            AND preference.category = policy.category
          WHERE n.user_id = $1
          ORDER BY n.created_at DESC, n.id DESC
          LIMIT ${RECENT_NOTIFICATION_LIMIT}
       )
       SELECT recent.id AS notification_id, recent.kind, recent.read_at,
              recent.created_at AS notification_created_at,
              recent.push_category, recent.push_enabled,
              delivery.id AS delivery_id,
              COALESCE(delivery.platform, registration.platform) AS delivery_platform,
              delivery.environment AS delivery_environment,
              delivery.installation_id AS delivery_installation_id,
              delivery.status AS delivery_status,
              delivery.attempts AS delivery_attempts,
              delivery.available_at AS delivery_available_at,
              delivery.expires_at AS delivery_expires_at,
              delivery.sent_at AS delivery_sent_at,
              delivery.last_error_code AS delivery_error_code,
              delivery.created_at AS delivery_created_at,
              delivery.updated_at AS delivery_updated_at
         FROM recent
         LEFT JOIN mobile_push_deliveries delivery ON delivery.notification_id = recent.id
         LEFT JOIN mobile_push_registrations registration ON registration.id = delivery.registration_id
        ORDER BY recent.created_at DESC, recent.id DESC,
                 delivery.id ASC`,
      [user.id]
    ),
  ]);
  const notifications = groupNotificationRows(notificationRows.rows);
  return {
    user,
    registrations: registrations.rows,
    preferences: preferences.rows,
    notifications,
    diagnostics: diagnose(registrations.rows, notifications),
  };
}

async function gather(pool, rawLookup) {
  const lookup = normalizeLookup(rawLookup);
  const overview = await loadOverview(pool);
  if (!lookup) return { overview, lookup: null, user: null };
  const user = await resolveUser(pool, lookup);
  if (!user) {
    return {
      overview,
      lookup: { query: lookup.query, found: false },
      user: null,
    };
  }
  return {
    overview,
    lookup: { query: lookup.query, found: true },
    ...(await loadUser(pool, user)),
  };
}

module.exports = {
  MAX_LOOKUP_LENGTH,
  RECENT_NOTIFICATION_LIMIT,
  MobilePushDiagnosticsInputError,
  normalizeLookup,
  groupNotificationRows,
  diagnose,
  gather,
};
