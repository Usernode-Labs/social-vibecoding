'use strict';

// 13 Oct 2026, D1: one definition of "this change is its project's first
// version", which goes live without a vote once it has passed its review
// and its checks, for every audience (the gate's rule is
// src/workflow/rules/governance-gate.ts applyFirstVersion).
//
// Newcomer test run four (Club Votes, 12 to 13 Oct): the first version was
// ready to try at 22:54, the App tab said "Waiting for your approval." with
// no way to give it, and it waited all night. So the first version skips the
// vote, and every later change, Homeroom bot's included, goes to it.
//
// A first version is the change Homeroom bot built for a project's first
// request, the one filed from the description the project was made with
// (homeroom_bot_first_versions), as long as no change for that request has
// gone live yet. The run that built it names it: build_session_id from the
// moment it is promoted (the build sets it when it starts, and the promote
// comes before the run records its proposal), proposal_session_id once its
// proposal is recorded. Both are the same session.
//
// Its own module, beside services/bot-requested-by.js, so a query anywhere
// can put the fragment in without loading services/governance.js (which
// suites stub), and every path that decides or shows the gate reads the
// same words: governance.js governedGate, the merge queue's line, the
// proposal serializers, the Workshop's owed votes and the vote digest.

const log = require('./logger');

const checkedAlias = (alias) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias || '')) {
    throw new Error(`Invalid SQL alias: ${alias}`);
  }
  return alias;
};

/**
 * The boolean SQL predicate "session alias `cs` is its project's first
 * version": built by Homeroom bot for the request its project's description
 * was filed as, and no change for that request has gone live (that one
 * itself aside, so a first version that went live still reads as one).
 */
function firstVersionSql(sessionAlias = 'cs') {
  const cs = checkedAlias(sessionAlias);
  // From the project's one first-version row (its primary key) to that
  // request's runs (idx_homeroom_bot_runs_issue): a handful of rows, and
  // none at all on a project made without a description.
  return `EXISTS (
    SELECT 1 FROM homeroom_bot_first_versions fvf
      JOIN homeroom_bot_runs fvr
        ON fvr.app_id = fvf.app_id AND fvr.issue_number = fvf.issue_number
     WHERE fvf.app_id = ${cs}.app_id
       AND (fvr.proposal_session_id = ${cs}.id OR fvr.build_session_id = ${cs}.id)
       AND NOT EXISTS (
         SELECT 1 FROM homeroom_bot_runs fvo
           JOIN chat_sessions fvs ON fvs.id = fvo.proposal_session_id
          WHERE fvo.app_id = fvf.app_id AND fvo.issue_number = fvf.issue_number
            AND fvs.status = 'merged' AND fvs.id <> ${cs}.id))`;
}

/**
 * Whether one change is its project's first version. A failed read answers
 * false: the change then goes to the vote like any other, never the other
 * way round.
 */
async function isFirstVersion(pool, sessionId) {
  const id = parseInt(sessionId, 10);
  if (!Number.isFinite(id)) return false;
  try {
    const res = await pool.query(
      `SELECT ${firstVersionSql('cs')} AS first_version FROM chat_sessions cs WHERE cs.id = $1`,
      [id]
    );
    return !!(res && res.rows && res.rows[0] && res.rows[0].first_version === true);
  } catch (err) {
    log.warn('first-version-rule', 'Could not read whether a change is a first version; it goes to the vote', {
      sessionId: id, err: err.message,
    });
    return false;
  }
}

module.exports = { firstVersionSql, isFirstVersion };
