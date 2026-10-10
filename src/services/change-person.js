'use strict';

// Who a change is credited to: an expression over `cs` (chat_sessions). A
// change is its author's, except one the Homeroom bot built. The bot is a
// synthetic account and the session's author, so its changes used to count
// for nobody; such a change is the person's who asked for it, recorded in
// homeroom_bot_requesters for the request it was built from, else whoever
// filed that request on Homeroom (the same join as
// topochain/challenge-scorer.js and homeroom-bot.js liveCandidates). A bot
// build with neither is NULL, and still counts for nobody.
//
// One definition, read by the Journey page (services/journey.js), the admin
// analytics dashboard (routes/dashboard.js) and its funnels
// (services/analytics-funnels.js), so every admin surface credits a change
// to the same person. It is a leaf module so those callers share it without
// loading each other, and its export is a literal property (read it as
// `changePerson.CHANGE_PERSON_SQL`, not destructured) so scripts/check-sql.js
// can still resolve the queries that splice it in as static SQL.
module.exports = {
  CHANGE_PERSON_SQL: `(CASE
      WHEN EXISTS (SELECT 1 FROM users bu WHERE bu.id = cs.user_id AND bu.is_synthetic)
      THEN COALESCE(
        (SELECT r.user_id FROM homeroom_bot_requesters r
          WHERE r.app_id = cs.app_id AND r.issue_number = cs.created_from_issue_number),
        (SELECT ri.created_by FROM issues ri
          WHERE ri.app_id = cs.app_id AND ri.github_issue_number = cs.created_from_issue_number
          ORDER BY ri.id LIMIT 1))
      ELSE cs.user_id
    END)`,
};
