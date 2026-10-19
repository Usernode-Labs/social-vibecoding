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

// The predicate itself is one copy, in src/workflow/rules/first-version.ts:
// the proposal machine reads it under its lock when it claims a merge.
const { firstVersionSql } = require('../workflow/rules/first-version.ts');

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
