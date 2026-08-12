'use strict';

const { decrypt } = require('./secrets');
const { ALLOWED_KINDS, buildMessage } = require('./mobile-push-policy');
const { classifyError } = require('./mobile-push-provider');
const log = require('./logger');

const DEFAULTS = Object.freeze({
  batchSize: 20,
  pollMs: 5000,
  busyPollMs: 100,
  sendTimeoutMs: 5000,
  retryBaseMs: 5000,
  retryMaxMs: 60 * 60 * 1000,
  retentionDays: 30,
  retentionBatchSize: 500,
  retentionIntervalMs: 6 * 60 * 60 * 1000,
});

function deadline(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Push provider deadline exceeded');
      err.code = 'provider_timeout';
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function retryDelayMs(attempts, baseMs, maxMs) {
  const parsed = Number(attempts);
  const attempt = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  // Cap the exponent so a delivery can keep retrying until expiry without
  // overflowing the delay.
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(maxMs, baseMs * (2 ** exponent));
}

class MobilePushWorker {
  constructor({ pool, config, provider, options = {} }) {
    this.pool = pool;
    this.config = config;
    this.provider = provider;
    this.options = { ...DEFAULTS, ...options };
    this.timer = null;
    this.running = null;
    this.stopping = true;
    this.lastRetentionAt = 0;
  }

  start() {
    if (!this.config.mobilePushEnabled || !this.provider || !this.stopping) return;
    this.stopping = false;
    this._schedule(0);
  }

  _schedule(ms) {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runOnce()
        .catch((err) => {
          log.error('mobile-push', 'delivery pass failed', {
            code: typeof err?.code === 'string' ? err.code : 'unknown',
          });
          return 0;
        })
        .then((count) => {
          this.running = null;
          if (!this.stopping) {
            this._schedule(count > 0 ? this.options.busyPollMs : this.options.pollMs);
          }
        });
    }, ms);
    this.timer.unref?.();
  }

  async stop({ timeoutMs = 5000 } = {}) {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return true;
    let timeout;
    try {
      return await Promise.race([
        this.running.then(() => true),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async maintain() {
    // Passes do not overlap. Any `sending` row seen here was left behind by a
    // failed prior pass and can be retried without distributed lease state.
    await this.pool.query(
      `UPDATE mobile_push_deliveries
          SET status = CASE
                WHEN expires_at <= NOW() THEN 'cancelled'
                ELSE 'pending'
              END,
              available_at = NOW(),
              last_error_code = CASE
                WHEN expires_at <= NOW() THEN 'expired'
                ELSE 'sender_interrupted'
              END,
              updated_at = NOW()
        WHERE status = 'sending'
           OR (status = 'pending' AND expires_at <= NOW())`
    );
    const now = Date.now();
    if (now - this.lastRetentionAt >= this.options.retentionIntervalMs) {
      await this.pool.query(
        `WITH doomed AS (
           SELECT r.id
             FROM mobile_push_registrations r
            WHERE r.session_expires_at <= NOW()
            ORDER BY r.id LIMIT $1
         )
         DELETE FROM mobile_push_registrations r USING doomed
          WHERE r.id = doomed.id
            AND r.session_expires_at <= NOW()`,
        [this.options.retentionBatchSize]
      );
      await this.pool.query(
        `WITH doomed AS (
           SELECT id FROM mobile_push_deliveries
            WHERE status IN ('sent', 'dead', 'cancelled')
              AND updated_at < NOW() - make_interval(days => $1::integer)
            ORDER BY id LIMIT $2
         )
         DELETE FROM mobile_push_deliveries d USING doomed
          WHERE d.id = doomed.id`,
        [this.options.retentionDays, this.options.retentionBatchSize]
      );
      await this.pool.query(
        `WITH doomed AS (
           SELECT m.environment, m.installation_id, m.latest_mutation_revision
             FROM mobile_push_installation_mutations m
            WHERE m.updated_at < NOW() - make_interval(days => $1::integer)
              AND NOT EXISTS (
                SELECT 1
                  FROM mobile_push_registrations r
                 WHERE r.environment = m.environment
                   AND r.installation_id = m.installation_id
              )
            ORDER BY m.updated_at, m.environment, m.installation_id
            LIMIT $2
         )
         DELETE FROM mobile_push_installation_mutations m USING doomed
          WHERE m.environment = doomed.environment
            AND m.installation_id = doomed.installation_id
            AND m.latest_mutation_revision = doomed.latest_mutation_revision`,
        [this.options.retentionDays, this.options.retentionBatchSize]
      );
      this.lastRetentionAt = now;
    }
  }

  async claimBatch() {
    const { rows } = await this.pool.query(
      `WITH picked AS (
         SELECT d.id
           FROM mobile_push_deliveries d
           JOIN mobile_push_deployment_state state ON state.environment = d.environment
          WHERE d.status = 'pending' AND d.available_at <= NOW() AND d.expires_at > NOW()
            AND d.environment = $2
            AND state.firebase_project_id = $3
            AND state.send_enabled
            AND state.send_not_before IS NOT NULL
            AND d.created_at >= state.send_not_before
          ORDER BY d.available_at, d.id
          LIMIT $1
       )
       UPDATE mobile_push_deliveries d
          SET status = 'sending',
              attempts = d.attempts + 1,
              updated_at = NOW()
         FROM picked
       WHERE d.id = picked.id AND d.status = 'pending'
       RETURNING d.id, d.attempts`,
      [
        this.options.batchSize,
        this.config.mobilePushEnvironment,
        this.config.firebaseProjectId,
      ]
    );
    return rows;
  }

  async runOnce() {
    if (!this.config.mobilePushEnabled || !this.provider || this.stopping) return 0;
    await this.maintain();
    const jobs = await this.claimBatch();
    const results = await Promise.allSettled(
      jobs.map((job) => this.processDelivery(job))
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return jobs.length;
  }

  async loadDelivery(job) {
    const { rows } = await this.pool.query(
      `SELECT d.id, d.attempts, d.expires_at,
              d.created_at AS delivery_created_at,
              n.id AS notification_id, n.user_id AS notification_user_id,
              n.kind, n.read_at, n.detail,
              a.name AS app_name,
              su.username AS source_username,
              cm.content AS message_content,
              cs.session_title, cs.pr_title, cs.branch_name,
              policy.category AS push_category,
              COALESCE(preference.enabled, policy.default_enabled, FALSE) AS push_enabled,
              d.environment AS delivery_environment,
              d.installation_id AS delivery_installation_id,
              state.send_enabled AS deployment_send_enabled,
              state.send_not_before AS deployment_send_not_before,
              state.firebase_project_id AS deployment_firebase_project_id,
              r.id AS registration_id, r.installation_id, r.environment AS registration_environment,
              r.registration_hash, r.registration_enc, r.permission_status,
              r.user_id AS registration_user_id,
              r.session_expires_at AS registration_session_expires_at
         FROM mobile_push_deliveries d
         JOIN notifications n ON n.id = d.notification_id
         LEFT JOIN apps a ON a.id = n.app_id
         LEFT JOIN users su ON su.id = n.source_user_id
         LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
         LEFT JOIN chat_sessions cs ON cs.id = n.session_id
         LEFT JOIN mobile_push_kind_categories policy ON policy.kind = n.kind
         LEFT JOIN mobile_push_preferences preference
           ON preference.user_id = n.user_id
          AND preference.category = policy.category
         LEFT JOIN mobile_push_deployment_state state ON state.environment = d.environment
         LEFT JOIN mobile_push_registrations r ON r.id = d.registration_id
        WHERE d.id = $1 AND d.status = 'sending'`,
      [job.id]
    );
    return rows[0] || null;
  }

  invalidReason(row) {
    if (row.read_at) return 'notification_read';
    if (!ALLOWED_KINDS.has(row.kind) || !row.push_category) return 'kind_not_allowed';
    if (row.push_enabled !== true) return 'preference_disabled';
    if (!row.registration_id) return 'registration_missing';
    if (row.delivery_environment !== this.config.mobilePushEnvironment
        || row.registration_environment !== row.delivery_environment) {
      return 'environment_mismatch';
    }
    if (row.deployment_send_enabled !== true) return 'sender_disabled';
    if (row.deployment_firebase_project_id !== this.config.firebaseProjectId) {
      return 'firebase_project_mismatch';
    }
    const deliveryCreatedAt = new Date(row.delivery_created_at).getTime();
    const sendNotBefore = new Date(row.deployment_send_not_before).getTime();
    if (!row.deployment_send_not_before
        || !Number.isFinite(deliveryCreatedAt)
        || !Number.isFinite(sendNotBefore)
        || deliveryCreatedAt < sendNotBefore) {
      return 'activation_cutoff';
    }
    if (String(row.installation_id).toLowerCase()
        !== String(row.delivery_installation_id).toLowerCase()) {
      return 'installation_mismatch';
    }
    if (!['authorized', 'provisional'].includes(row.permission_status)) return 'permission_ineligible';
    if (new Date(row.registration_session_expires_at) <= new Date()) {
      return 'session_inactive';
    }
    if (String(row.notification_user_id) !== String(row.registration_user_id)) {
      return 'recipient_mismatch';
    }
    if (new Date(row.expires_at) <= new Date()) return 'expired';
    return null;
  }

  async finish(job, status, code = null, availableAt = null) {
    const sent = status === 'sent';
    await this.pool.query(
      `UPDATE mobile_push_deliveries
          SET status = $2,
              available_at = COALESCE($3, available_at),
              sent_at = CASE WHEN $4 THEN NOW() ELSE sent_at END,
              last_error_code = $5,
              updated_at = NOW()
        WHERE id = $1 AND status = 'sending'`,
      [job.id, status, availableAt, sent, code]
    );
  }

  async retry(job, code) {
    const delayMs = retryDelayMs(
      job.attempts,
      this.options.retryBaseMs,
      this.options.retryMaxMs
    );
    await this.finish(job, 'pending', code, new Date(Date.now() + delayMs));
  }

  async deleteLoadedRegistration(row) {
    const result = await this.pool.query(
      `DELETE FROM mobile_push_registrations
        WHERE id = $1 AND registration_hash = $2 AND registration_enc = $3`,
      [row.registration_id, row.registration_hash, row.registration_enc]
    );
    return result.rowCount === 1;
  }

  async invalidateLoadedRegistration(job, row, code) {
    if (await this.deleteLoadedRegistration(row)) {
      await this.finish(job, 'dead', code);
      return;
    }
    // A newer PUT refreshed this same row after loadDelivery. Keep
    // the FK and retry against the new encrypted registration instead of
    // deleting or condemning the replacement based on the stale provider call.
    await this.retry(job, 'registration_refreshed');
  }

  async processDelivery(job) {
    const row = await this.loadDelivery(job);
    if (!row) return;
    const invalid = this.invalidReason(row);
    if (invalid) {
      await this.finish(job, 'cancelled', invalid);
      return;
    }

    const token = decrypt(row.registration_enc, this.config.dataEncryptionKey);
    if (!token) {
      await this.invalidateLoadedRegistration(
        job, row, 'registration_decrypt_failed'
      );
      return;
    }

    let message;
    try {
      message = buildMessage({
        token,
        notificationId: row.notification_id,
        kind: row.kind,
        environment: row.delivery_environment,
        installationId: row.installation_id,
        userId: row.notification_user_id,
        expiresAt: row.expires_at,
        // Send-time display context (#3289). Every field is optional: the
        // policy degrades to the generic copy rather than failing a delivery.
        context: {
          appName: row.app_name,
          sourceUsername: row.source_username,
          messageContent: row.message_content,
          sessionTitle: row.session_title,
          prTitle: row.pr_title,
          branchName: row.branch_name,
          detail: row.detail,
        },
      });
    } catch (err) {
      await this.finish(job, 'dead', String(err.message || 'message_invalid').slice(0, 96));
      return;
    }

    try {
      await deadline(Promise.resolve().then(() => this.provider.send(message)), this.options.sendTimeoutMs);
      await this.finish(job, 'sent');
    } catch (err) {
      const outcome = classifyError(err);
      if (outcome.action === 'drop_registration') {
        await this.invalidateLoadedRegistration(job, row, outcome.code);
      } else if (outcome.action === 'dead') {
        await this.finish(job, 'dead', outcome.code);
      } else {
        await this.retry(job, outcome.code);
      }
    }
  }
}

module.exports = { MobilePushWorker, DEFAULTS, deadline, retryDelayMs };
