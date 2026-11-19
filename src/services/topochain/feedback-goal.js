// The line above Cancel and Post in the Suggest an improvement dialog
// (#6758): how many more useful reports the weekly "Send useful feedback"
// challenge can still count for the viewer this week.
//
// The answer is read off the RULE that scores the challenge, not off the
// card: a challenge is found by an enabled USEFUL_FEEDBACK rule bound to it
// (or its template), in the WEEKLY category, and the target is the one the
// scorer caps by (rules.countedByOf, the rule's own before the card's). A
// card nothing scores, a closed window, or a schedule that is switched off
// gives no answer, so the dialog never counts toward a goal that will not
// move.
//
// `counted` is this week's credits, from Monday 00:00 UTC, the week the
// scorer caps by. A report is credited later, after a filter and a grade, so
// `left` is how many more CAN count, never a promise about the next one.

const rules = require('./challenge-rules');

const FEEDBACK_GOAL_SQL = `
  /* feedback weekly goal */
  SELECT r.id AS rule_id, r.measure, r.target AS rule_target, r.points AS rule_points,
         r.interval_minutes AS rule_interval_minutes,
         c.id AS challenge_id, c.enabled, c.completed,
         c.schedule_start, c.schedule_end, c.metric_target, c.reward,
         ct.category AS t_category,
         ct.schedule_start AS t_schedule_start, ct.schedule_end AS t_schedule_end,
         ct.metric_target AS t_metric_target, ct.reward AS t_reward,
         se.starts_at AS event_starts_at, se.ends_at AS event_ends_at,
         (SELECT COUNT(*)::int FROM user_activities ua
           WHERE ua.user_id = $1 AND ua.challenge_id = c.id
             AND ua.activity_at >= date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS credits
    FROM challenge_scoring_rules r
    JOIN challenges c
      ON (r.challenge_id IS NOT NULL AND c.id = r.challenge_id)
      OR (r.challenge_template_id IS NOT NULL AND c.challenge_template_id = r.challenge_template_id)
    JOIN challenge_templates ct ON ct.id = c.challenge_template_id
    JOIN season_events se ON se.id = c.season_event_id
    LEFT JOIN seasons s ON s.id = se.season_id
   WHERE r.enabled = TRUE AND r.measure = 'USEFUL_FEEDBACK'
     AND UPPER(TRIM(COALESCE(ct.category, ''))) = 'WEEKLY'
     AND se.internal = FALSE AND COALESCE(s.internal, FALSE) = FALSE
     AND se.is_active = TRUE AND COALESCE(s.is_active, FALSE) = TRUE
   ORDER BY c.display_order ASC, c.id ASC, r.id ASC
`;

// The first row a rule would score right now speaks. null when none does.
function pickFeedbackGoal(rows, { now = Date.now(), defaultMinutes } = {}) {
  for (const row of rows || []) {
    const rule = {
      id: row.rule_id,
      measure: row.measure,
      target: row.rule_target,
      points: row.rule_points,
      enabled: true,
      intervalMinutes: row.rule_interval_minutes,
    };
    const by = rules.countedByOf([rule], row, { now, defaultMinutes });
    if (!by || by.measure !== 'USEFUL_FEEDBACK') continue;
    const target = Number(by.target);
    if (!Number.isInteger(target) || target < 1) continue;
    const counted = Math.max(0, Math.min(Number(row.credits) || 0, target));
    return { target, counted, left: target - counted };
  }
  return null;
}

async function loadFeedbackGoal(pool, userId, opts = {}) {
  const { rows } = await pool.query(FEEDBACK_GOAL_SQL, [userId]);
  return pickFeedbackGoal(rows, opts);
}

module.exports = { FEEDBACK_GOAL_SQL, pickFeedbackGoal, loadFeedbackGoal };
