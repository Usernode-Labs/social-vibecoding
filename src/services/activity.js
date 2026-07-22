const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const log = require('./logger');

const PUBLISH_BATCH_SIZE = 25;
const PUBLISH_INTERVAL_MS = 2000;
const SESSION_EXPIRY_SKEW_MS = 30_000;
const MAX_CACHED_SESSIONS = 10_000;
const REQUEST_TIMEOUT_MS = 5000;

class ActivityHttpError extends Error {
  constructor(message, { status = 0, code = null, body = '' } = {}) {
    super(message);
    this.name = 'ActivityHttpError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function trimBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function boundedText(value, max = 512) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

async function parseResponse(response) {
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  return { text: boundedText(text), body };
}

function mapActivityItem(item) {
  const sourceEvent = item?.activityEvent?.sourceEvent || {};
  const facts = sourceEvent.facts || {};
  return {
    id: String(item.inboxSequence),
    occurrenceId: sourceEvent.sourceEventId ?? null,
    kind: facts.kind ?? null,
    readAt: item.readAt ?? null,
    createdAt: sourceEvent.occurredAt ?? null,
    appId: facts.appId ?? null,
    appSlug: facts.appSlug ?? null,
    appName: facts.appName ?? null,
    chatMessageId: facts.chatMessageId ?? null,
    messageContent: facts.messageContent ?? null,
    threadType: facts.threadType ?? null,
    threadRef: facts.threadRef ?? null,
    sessionId: facts.sessionId ?? null,
    prTitle: facts.prTitle ?? null,
    prNumber: facts.prNumber ?? null,
    headlessIssueNumber: facts.headlessIssueNumber ?? null,
    branchName: facts.branchName ?? null,
    sourceUsername: facts.sourceUsername ?? null,
    detail: facts.detail ?? null,
  };
}

function createActivityService(config, {
  pool,
  fetchImpl = global.fetch,
  now = () => Date.now(),
  random = Math.random,
} = {}) {
  const baseUrl = trimBaseUrl(config.activityBaseUrl);
  const producerToken = config.activityProducerToken || '';
  const ledgerId = config.activityLedgerId || '';
  const readPath = config.activityNotificationsReadPath || 'legacy';
  const sessionCache = new Map();
  let assertionKey = null;
  let publisherTimer = null;
  let publisherRunning = false;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Activity integration requires fetch');
  }
  if (readPath === 'activity') {
    if (!baseUrl || !ledgerId || !config.activitySocialAssertionKey) {
      throw new Error(
        'Activity read path requires ACTIVITY_BASE_URL, ACTIVITY_LEDGER_ID, and ACTIVITY_SOCIAL_ASSERTION_KEY'
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(config.activitySocialAssertionKey)) {
      throw new Error('ACTIVITY_SOCIAL_ASSERTION_KEY must be unpadded base64url');
    }
    assertionKey = Buffer.from(config.activitySocialAssertionKey, 'base64url');
    if (assertionKey.length !== 32) {
      throw new Error('ACTIVITY_SOCIAL_ASSERTION_KEY must decode to exactly 32 bytes');
    }
  }

  function publisherEnabled() {
    return !!(pool && baseUrl && producerToken);
  }

  function evictSessionCacheIfNeeded() {
    while (sessionCache.size >= MAX_CACHED_SESSIONS) {
      const oldest = sessionCache.keys().next().value;
      sessionCache.delete(oldest);
    }
  }

  async function exchangeSession(userId) {
    if (!assertionKey) {
      throw new Error('Activity consumer assertions are not configured');
    }
    const subject = String(userId);
    if (!/^[1-9][0-9]{0,18}$/.test(subject)) {
      throw new Error('Activity consumer subject must be a positive decimal id');
    }
    const issuedAt = Math.floor(now() / 1000);
    const assertion = jwt.sign(
      {
        iss: 'social/social-dev',
        aud: ledgerId,
        sub: subject,
        iat: issuedAt,
        exp: issuedAt + 60,
        jti: crypto.randomUUID(),
      },
      assertionKey,
      {
        algorithm: 'HS256',
        header: { typ: 'activity-inbox-assertion+jwt' },
      }
    );
    const response = await fetchImpl(`${baseUrl}/v1/auth/exchanges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ assertion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await parseResponse(response);
    if (!response.ok) {
      throw new ActivityHttpError('Activity assertion exchange failed', {
        status: response.status,
        code: parsed.body?.error || null,
        body: parsed.text,
      });
    }
    const accessToken = parsed.body?.accessToken;
    const expiresAt = Date.parse(parsed.body?.expiresAt || '');
    if (typeof accessToken !== 'string' || !Number.isFinite(expiresAt)) {
      throw new ActivityHttpError('Activity assertion exchange returned an invalid response');
    }
    evictSessionCacheIfNeeded();
    sessionCache.set(subject, { accessToken, expiresAt });
    return accessToken;
  }

  async function consumerToken(userId, forceRefresh = false) {
    const subject = String(userId);
    const cached = sessionCache.get(subject);
    if (!forceRefresh && cached && cached.expiresAt - SESSION_EXPIRY_SKEW_MS > now()) {
      return cached.accessToken;
    }
    sessionCache.delete(subject);
    return exchangeSession(subject);
  }

  async function consumerRequest(userId, path, options = {}, retryAuth = true) {
    const token = await consumerToken(userId);
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
        authorization: `Bearer ${token}`,
      },
      signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 && retryAuth) {
      sessionCache.delete(String(userId));
      await consumerToken(userId, true);
      return consumerRequest(userId, path, options, false);
    }
    const parsed = await parseResponse(response);
    if (!response.ok) {
      throw new ActivityHttpError('Activity consumer request failed', {
        status: response.status,
        code: parsed.body?.error || null,
        body: parsed.text,
      });
    }
    return parsed.body;
  }

  async function feed(userId, { limit = 100, before = null } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    const page = await consumerRequest(userId, `/v1/me/activity?${query}`);
    return {
      notifications: (page.items || []).map(mapActivityItem),
      hasMore: !!page.hasMore,
      nextCursor: page.nextCursor || null,
      readThroughInboxSequence: String(page.readThroughInboxSequence),
    };
  }

  async function unread(userId) {
    return consumerRequest(userId, '/v1/me/unread-count');
  }

  async function setRead(userId, selector) {
    return consumerRequest(userId, '/v1/me/activity/read', {
      method: 'POST',
      body: JSON.stringify({ selector }),
    });
  }

  async function readScope(userId, readScope, throughInboxSequence = null) {
    let watermark = throughInboxSequence;
    if (watermark == null) {
      const snapshot = await unread(userId);
      watermark = snapshot.readThroughInboxSequence;
    }
    return setRead(userId, {
      type: 'scope',
      readScope,
      throughInboxSequence: String(watermark),
    });
  }

  function retryDelayMs(attemptCount) {
    const base = Math.min(300_000, 1000 * (2 ** Math.min(attemptCount, 8)));
    return Math.round(base * (0.75 + random() * 0.5));
  }

  async function recordPublished(row) {
    const { rows } = await pool.query(
      `UPDATE notifications
          SET activity_published_at = NOW(),
              activity_attempt_count = activity_attempt_count + 1,
              activity_next_attempt_at = NULL,
              activity_last_error = NULL
        WHERE id = $1 AND activity_published_at IS NULL
        RETURNING user_id`,
      [row.id]
    );
    if (!rows.length) return;
    try {
      const { pushNotificationToUser } = require('./ws');
      pushNotificationToUser(rows[0].user_id, { type: 'notifications_changed' });
    } catch (err) {
      log.warn('activity', 'published notification invalidation failed', {
        notificationId: row.id,
        err: err.message,
      });
    }
  }

  async function recordFailure(row, message, retry) {
    const nextDelay = retry ? retryDelayMs(row.activity_attempt_count + 1) : null;
    await pool.query(
      `UPDATE notifications
          SET activity_attempt_count = activity_attempt_count + 1,
              activity_next_attempt_at = CASE
                WHEN $2::integer IS NULL THEN NULL
                ELSE NOW() + ($2::integer * INTERVAL '1 millisecond')
              END,
              activity_last_error = $3
        WHERE id = $1 AND activity_published_at IS NULL`,
      [row.id, nextDelay, boundedText(message)]
    );
  }

  async function publishOne(row) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/source-events`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${producerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(row.activity_event),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      await recordFailure(row, `network: ${err.message}`, true);
      return;
    }

    const parsed = await parseResponse(response);
    if (response.status === 200 || response.status === 201) {
      await recordPublished(row);
      return;
    }

    const code = parsed.body?.error || null;
    const retry = response.status === 429
      || response.status >= 500
      || (response.status === 422 && code === 'recipient_not_bound');
    await recordFailure(
      row,
      `HTTP ${response.status}${code ? ` ${code}` : ''}${parsed.text ? `: ${parsed.text}` : ''}`,
      retry
    );
    if (!retry) {
      log.error('activity', 'notification publication stopped after permanent response', {
        notificationId: row.id,
        status: response.status,
        code,
      });
    }
  }

  async function drainPublisher() {
    if (!publisherEnabled() || publisherRunning) return;
    publisherRunning = true;
    try {
      const { rows } = await pool.query(
        `SELECT id, user_id, activity_event, activity_attempt_count
           FROM notifications
          WHERE activity_event IS NOT NULL
            AND activity_published_at IS NULL
            AND activity_next_attempt_at IS NOT NULL
            AND activity_next_attempt_at <= NOW()
          ORDER BY activity_next_attempt_at, id
          LIMIT $1`,
        [PUBLISH_BATCH_SIZE]
      );
      for (const row of rows) await publishOne(row);
    } catch (err) {
      log.warn('activity', 'notification publisher drain failed', { err: err.message });
    } finally {
      publisherRunning = false;
    }
  }

  function startPublisher() {
    if (!publisherEnabled() || publisherTimer) return false;
    drainPublisher();
    publisherTimer = setInterval(drainPublisher, PUBLISH_INTERVAL_MS);
    publisherTimer.unref?.();
    log.info('activity', 'notification publisher started');
    return true;
  }

  function stopPublisher() {
    if (!publisherTimer) return;
    clearInterval(publisherTimer);
    publisherTimer = null;
  }

  return {
    readPath,
    publisherEnabled,
    startPublisher,
    stopPublisher,
    drainPublisher,
    feed,
    unread,
    setRead,
    readScope,
    mapActivityItem,
  };
}

module.exports = {
  ActivityHttpError,
  createActivityService,
  mapActivityItem,
};
