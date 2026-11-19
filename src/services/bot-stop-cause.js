'use strict';

// T2.9 (19 Nov 2026, docs/plans/bot-one-model.md): why Homeroom bot stopped
// on a request, or handed it back to people, decoded once from what its
// records store.
//
// Three decoders told three stories: the chat's (homeroom-bot-dm.js
// buildFailedCause, read by its notes), the request track's
// (homeroom-bot-track.js buildStopWhy) and the bell's (work-state.js, which
// said a failed read, a failed plan and a build that ran out of time all as
// "something went wrong while I was building"). This module is the one
// reading: the note, the track line, the stored standing (`standing.cause`),
// the stage words and the push all read its codes.
//
// Every function here is pure. It reads the run's own record for what
// happened and never quotes it: the record is written for the platform.

// A build that did not finish, by its cause. `restarts` carries `times`;
// `stopped` (a person stopped it, written by the stop as `stopped: by
// @username`) carries `by`; `no_change` may carry what its last turn said
// of it (`noChange`: 'already', 'unclear', 'could_not').
const BUILD_CAUSES = Object.freeze([
  'restarts', 'time', 'restart', 'unproposed', 'push', 'push_permanent', 'push_gave_up',
  'no_change', 'no_start', 'plan', 'credit', 'stopped', 'other',
]);

// What the bot's queue calls a build that ran out of OpenRouter's credit
// (src/workflow/rules/bot-loop.ts CREDIT_WAIT_REASON), as a note's `reason`
// carries it (homeroom-bot.js announceBuilt).
const CREDIT_WAIT = 'credit_wait';

const USERNAME = /^stopped: by @([A-Za-z0-9_.-]{1,64})\b/;

/**
 * Pure: why a build of a request did not finish, from its run's
 * build_error (or a note's `reason`): `{ cause, times?, by?, noChange? }`.
 * `credit` says the request waits for building credit whatever the record
 * says (its queue row's reason). "(finished after a restart)" only says
 * which process recorded it, never why it ended, and what a failed turn was
 * last doing ("; it last said: ...") is never read: an agent that wrote "the
 * server would not start" did not fail to start.
 */
function buildCause(buildError, { credit = false, noChangeSaid = null } = {}) {
  const raw = String(buildError || '').trim();
  if (credit || raw === CREDIT_WAIT) return { cause: 'credit' };
  const by = USERNAME.exec(raw);
  if (by) return { cause: 'stopped', by: by[1] };
  if (/^stopped:/.test(raw)) return { cause: 'stopped', by: null };
  const r = raw.split(/; (?:last activity|it last said):/)[0].replace(/\s*\(finished after a restart\)/g, '');
  const restarts = /restarted in the middle of each of its last (\d+) tries/.exec(r);
  if (restarts) return { cause: 'restarts', times: Number(restarts[1]) };
  if (/ran past its time limit/.test(r)) return { cause: 'time' };
  if (/restarted|by a restart/.test(r)) return { cause: 'restart' };
  if (/built but could not be proposed/.test(r)) return { cause: 'unproposed' };
  if (/couldn't push the build's commit/.test(r)) {
    // #6267: the upload, not the build, failed. A temporary refusal is being
    // retried; the other two say how a person can help.
    if (/gave up/.test(r)) return { cause: 'push_gave_up' };
    if (/permanent/.test(r)) return { cause: 'push_permanent' };
    return { cause: 'push' };
  }
  if (/produced no change/.test(r)) {
    const why = noChangeWhy(noChangeSaid);
    return why ? { cause: 'no_change', noChange: why } : { cause: 'no_change' };
  }
  if (/could not start|would not start|could not open a session|could not create its branch/.test(r)) {
    return { cause: 'no_start' };
  }
  // #6313: the plan turn ended before it wrote a plan (homeroom-bot-live.js
  // buildAndPropose). Nothing was built.
  if (/no plan could be written|only part of a spec/.test(r)) return { cause: 'plan' };
  return { cause: 'other' };
}

/**
 * Pure (H2): what a build that changed nothing said of it, from its last
 * turn's words (never shown to anybody but admins): 'already' when it says
 * the change is already there, 'unclear' when it was not sure what to
 * change, 'could_not' when it says it could not, else null.
 */
function noChangeWhy(said) {
  const text = String(said || '');
  if (!text) return null;
  if (/\balready\b[^.]{0,60}\b(?:exists?|there|implemented|in place|done|works?|does|has|handles|shows|supports)\b|\bno (?:code )?changes? (?:is |are |were )?(?:needed|required|necessary)\b|\bnothing (?:needs|needed) to change\b/i.test(text)) {
    return 'already';
  }
  if (/\b(?:unclear|ambiguous|not sure|unsure|clarif\w*|which (?:one|of)|need(?:s)? more detail)\b/i.test(text)) return 'unclear';
  if (/\b(?:can'?t|cannot|could ?n[o']t|unable|not possible|impossible|no access|not allowed|permission)\b/i.test(text)) {
    return 'could_not';
  }
  return null;
}

// The hand-backs of a person verdict, by what its look found (T2.10). The
// requester's move only when it is `requester`; the rest name who or what
// the request waits on.
const HAND_BACKS = Object.freeze([
  'requester', 'others', 'operator_work', 'destructive_db', 'platform', 'other_project', 'wrong_project', 'close',
]);

/**
 * Pure (T2.10): what a request a look left for a person waits on, from its
 * newest live run's record and what its standing holds:
 *
 *   wrong_project   it was filed on the wrong project (wrong_project)
 *   platform        it is about Homeroom itself (about_platform)
 *   other_project   it is about another project: a move is offered
 *   close           there is nothing to build (withdrawn, or only an
 *                   explanation asked for): the close vote is offered
 *   operator_work   work outside the app comes first (go_ahead_blocker)
 *   destructive_db  it changes data the app already stores: a person
 *                   builds it (go_ahead_blocker)
 *   others          the project's creator or admins decide (`deciders`,
 *                   homeroom-bot.js whoDecides), not its requester
 *   requester       its requester decides
 *
 * `run` is a STANDING_RUNS_SQL row, `offers` the request's open cards
 * (kinds), `deciders` the usernames who decide when its requester does not.
 */
function handBackOf({ run = null, offers = [], deciders = [], closeVote = false } = {}) {
  const kinds = new Set((Array.isArray(offers) ? offers : []).map((o) => String(o?.kind || o || '')));
  if (run?.wrong_project === true) return { cause: 'wrong_project' };
  if (run?.about_platform === true) return { cause: 'platform' };
  if (kinds.has('move_request')) return { cause: 'other_project' };
  if (kinds.has('close_request') || run?.go_ahead_blocker === 'explanation') return { cause: 'close' };
  if (run?.go_ahead_blocker === 'operator_work') return { cause: 'operator_work' };
  if (run?.go_ahead_blocker === 'destructive_db') return { cause: 'destructive_db' };
  const names = (Array.isArray(deciders) ? deciders : []).map(String).filter((n) => /^[A-Za-z0-9_.-]{1,64}$/.test(n)).slice(0, 4);
  if (names.length) return { cause: 'others', names };
  void closeVote;
  return { cause: 'requester' };
}

/**
 * Pure: a request's cause, as its stored standing carries it, from its
 * derived state (`next`), its newest live run (`run`, a STANDING_RUNS_SQL
 * row) and what its hand-back found (`handBack`, handBackOf): the stop's
 * cause (a build's, a look's, a fix's, a closed change's, a stall) or the
 * hand-back's. `{ cause, names? }` or null when it has none.
 */
function causeOf({ next, run = null, handBack = null, credit = false } = {}) {
  if (!next) return null;
  if (next.stage === 'stopped') {
    switch (next.reason) {
      case 'build_failed': {
        if (!run) return null;
        const c = buildCause(run.build_error, { credit, noChangeSaid: run.no_change_said });
        const code = c.cause === 'no_change' && c.noChange ? `no_change_${c.noChange}` : c.cause;
        return { cause: code, ...(c.by ? { names: [c.by] } : {}), ...(c.times ? { times: c.times } : {}) };
      }
      case 'look_failed':
        // A look that ran out of time says so; any other says it could not read it.
        return { cause: /\b(?:timed? ?out|time limit|took too long)\b/i.test(String(run?.error || '')) ? 'time' : 'look_failed' };
      case 'fix_stopped': return { cause: 'fix_stopped' };
      case 'change_closed': return { cause: 'change_closed' };
      case 'stalled': return { cause: 'stalled' };
      default: return null;
    }
  }
  if (next.stage === 'waiting_for_you' && next.why === 'needs_detail') {
    // T2.11: a build that found it impossible as written is not a look that
    // found nothing to build.
    return { cause: /^blocked:/.test(String(run?.build_error || '')) ? 'blocked' : 'empty' };
  }
  if (next.stage === 'waiting_for_you' && next.why === 'decide' && handBack) {
    return { cause: handBack.cause, ...(handBack.names?.length ? { names: handBack.names } : {}) };
  }
  return null;
}

// The words the bell and the push say for a stop, by cause
// (homeroom-bot-notify-copy.js `said`). A plan that could not be written is
// said at a stop only when no retry is owed (a retry shows as retry_plan).
const STOP_SAID = Object.freeze({
  time: 'build_time', restart: 'build_restart', restarts: 'build_restart',
  no_change: 'build_no_change', no_change_already: 'build_no_change', no_change_unclear: 'build_no_change',
  no_change_could_not: 'build_no_change',
  unproposed: 'build_not_proposed', no_start: 'build_no_start', stalled: 'build_no_start',
  push: 'build_push', push_permanent: 'build_push_permanent', push_gave_up: 'build_push_gave_up',
  plan: 'build_no_plan_stopped', credit: 'build_credit', stopped: 'stopped_by',
  look_failed: 'look_failed', fix_stopped: 'checks', change_closed: 'change_closed', other: 'build_other',
});

// The words a hand-back's bell says, by cause.
const HAND_BACK_SAID = Object.freeze({
  requester: 'decide', others: 'decide_others', operator_work: 'decide_setup', destructive_db: 'decide_person',
  platform: 'platform', other_project: 'elsewhere', wrong_project: 'wrong_project', close: 'close',
  blocked: 'blocked', empty: 'empty',
});

/** Pure: the push's words for a stored cause (`said`), or null when the cause says nothing of its own. */
function saidOfCause(cause) {
  const code = typeof cause === 'string' ? cause : cause?.cause;
  return STOP_SAID[code] || HAND_BACK_SAID[code] || null;
}

/**
 * Pure: a stored cause as a request's track names it (its line under a
 * stopped build: messages.json bot.track.line.stopped.*). The upload's three
 * causes are one line there.
 */
function trackCauseOf(cause) {
  if (!cause) return null;
  if (cause === 'push' || cause === 'push_permanent' || cause === 'push_gave_up') return 'not_pushed';
  if (cause === 'other') return 'build_failed';
  return cause;
}

module.exports = {
  BUILD_CAUSES,
  HAND_BACKS,
  CREDIT_WAIT,
  buildCause,
  noChangeWhy,
  handBackOf,
  causeOf,
  saidOfCause,
  trackCauseOf,
  STOP_SAID,
  HAND_BACK_SAID,
};
