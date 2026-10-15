'use strict';

// One definition of "this change was built by Homeroom bot from a request
// made for this viewer" (#4538).
//
// A change the bot built from a request does not belong to the person who
// asked for it in the ordinary sense — `chat_sessions.user_id` is the bot's,
// so every "yours" test in the platform fails it — yet the person waiting on
// that change is the person who asked, and Your work is where the platform
// says what is theirs to watch. So the surfaces that list a viewer's work in
// flight need one more way in: the request the change was built FROM was
// made for them.
//
// The rule is the bot queue's own ("who each one is for", services/
// homeroom-bot.js liveCandidates): whoever `homeroom_bot_requesters` records
// for the request, else whoever filed the issue on Homeroom. A request the
// bot took from a DM is recorded only in `homeroom_bot_requesters` — the
// platform-filed twin row does not name them — so `issues.created_by` alone
// would miss exactly the asks the bot was written for. The three parts:
//
//   · the session was built from a request at all
//     (`created_from_issue_number` is NULL on a shadow build);
//   · its author is really the bot (the synthetic `homeroom_bot` account),
//     never a person's session that merely links the same issue;
//   · and the request is for the viewer, by the COALESCE above.
//
// Written once and read by every route that lists work in flight, so the
// strip and the counts it mirrors cannot disagree about whose work a bot
// change is. The comparison to the viewer is a plain `=`, on purpose: bound
// NULL (a guest) makes the whole expression NULL, which a WHERE reads as
// false and a selected column wraps in COALESCE at the call site.

const checkedAlias = (alias) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias || '')) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  return alias;
};

/**
 * The boolean SQL predicate "session alias `cs` is a Homeroom bot change
 * built from a request made for the viewer bound to `viewer`" (a parameter
 * reference such as `'$1'`). The requesters table wins over the filed issue,
 * as the bot queue reads them; `homeroom_bot_requesters` is keyed by
 * (app_id, issue_number) and `issues` by (app_id, github_issue_number).
 */
function botRequestedBySql(sessionAlias = 'cs', viewer = '$1') {
  const cs = checkedAlias(sessionAlias);
  return `(cs.created_from_issue_number IS NOT NULL
         AND EXISTS (SELECT 1 FROM users bu
                      WHERE bu.id = ${cs}.user_id
                        AND bu.username = 'homeroom_bot' AND bu.is_synthetic = TRUE)
         AND COALESCE(
               (SELECT r.user_id FROM homeroom_bot_requesters r
                 WHERE r.app_id = ${cs}.app_id
                   AND r.issue_number = ${cs}.created_from_issue_number),
               (SELECT i.created_by FROM issues i
                 WHERE i.app_id = ${cs}.app_id
                   AND i.github_issue_number = ${cs}.created_from_issue_number
                 ORDER BY i.id LIMIT 1)) = ${viewer})`;
}

module.exports = { botRequestedBySql };
