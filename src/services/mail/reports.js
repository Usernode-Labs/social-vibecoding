'use strict';
const events = require('./events');

// Counts are unique messages, grouped by send day (UTC) and kind, not
// HTTP requests. Repeated pixel fetches and scanners cannot inflate a rate.
async function readReports(pool) {
  const [cohorts, recent] = await Promise.all([
    pool.query(
      `WITH per_delivery AS (
         SELECT d.id, d.kind, d.status, d.engagement_tracked, (d.created_at AT TIME ZONE 'UTC')::date AS day,
           bool_or(e.type = 'delivered') AS delivered,
           bool_or(e.type = 'bounced') AS bounced,
           bool_or(e.type = 'complained') AS complained,
           bool_or(e.type = 'opened') AS opened,
           bool_or(e.type = 'clicked') AS clicked,
           bool_or(e.type = 'unsubscribed') AS unsubscribed
         FROM mail_deliveries d LEFT JOIN mail_events e ON e.delivery_id = d.id
         WHERE d.created_at > NOW() - INTERVAL '30 days' AND d.kind = ANY($1::text[])
         GROUP BY d.id
       )
       SELECT day::text, kind, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
         COUNT(*) FILTER (WHERE status = 'sent' AND engagement_tracked)::int AS tracked_sent,
         COUNT(*) FILTER (WHERE delivered AND status = 'sent')::int AS delivered,
         COUNT(*) FILTER (WHERE bounced AND status = 'sent')::int AS bounced,
         COUNT(*) FILTER (WHERE complained AND status = 'sent')::int AS complained,
         COUNT(*) FILTER (WHERE opened AND status = 'sent')::int AS opened,
         COUNT(*) FILTER (WHERE clicked AND status = 'sent')::int AS clicked,
         COUNT(*) FILTER (WHERE unsubscribed AND status = 'sent')::int AS unsubscribed
       FROM per_delivery GROUP BY day, kind ORDER BY day DESC, kind`,
      [events.trackedKinds()]
    ),
    pool.query(
      `SELECT e.id, e.type, e.url, e.user_agent_class, e.created_at, e.meta,
         d.message_id, d.kind, d.recipient
       FROM mail_events e JOIN mail_deliveries d ON d.id = e.delivery_id
       WHERE d.kind = ANY($1::text[]) ORDER BY e.created_at DESC, e.id DESC LIMIT 50`, [events.trackedKinds()]
    ),
  ]);
  const byKind = new Map(); const byDay = new Map();
  const metrics = ['sent', 'tracked_sent', 'delivered', 'bounced', 'complained', 'opened', 'clicked', 'unsubscribed'];
  for (const row of cohorts.rows) {
    for (const [map, key] of [[byKind, row.kind], [byDay, row.day]]) {
      if (!map.has(key)) map.set(key, { label: key, ...Object.fromEntries(metrics.map((m) => [m, 0])) });
      const group = map.get(key);
      for (const metric of metrics) group[metric] += Number(row[metric]) || 0;
    }
  }
  return { byKind: [...byKind.values()], byDay: [...byDay.values()], recentEvents: recent.rows, retentionDays: 30, trackingEnabled: !!require('./tracking').secret() };
}
module.exports = { readReports };
