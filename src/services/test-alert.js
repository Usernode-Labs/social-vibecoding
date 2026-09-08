'use strict';

const { readPreferences } = require('./mobile-push-preferences');

// Keep in sync with the test_alert delay in enqueue_mobile_push_deliveries.
const TEST_DELAY_MS = 10000;

async function queueTestAlert(pool, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const preferences = await readPreferences(client, userId);
    if (!preferences.find((row) => row.key === 'developer_sessions').enabled) {
      await client.query('ROLLBACK');
      return { queued: false, reason: 'preference_disabled', delayMs: TEST_DELAY_MS };
    }
    // The normal INSERT trigger captures eligible destinations atomically.
    // Never use a page/process timer: the phone may close immediately after
    // this request returns, and a server restart must not lose the test.
    const { rows: [notification] } = await client.query(
      `INSERT INTO notifications (user_id, kind) VALUES ($1, 'test_alert') RETURNING id`,
      [userId]
    );
    const { rows } = await client.query(
      'SELECT id FROM mobile_push_deliveries WHERE notification_id = $1',
      [notification.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return { queued: false, reason: 'no_eligible_device', delayMs: TEST_DELAY_MS };
    }
    await client.query('COMMIT');
    return { queued: true, notificationId: notification.id, delayMs: TEST_DELAY_MS };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { queueTestAlert, TEST_DELAY_MS };
