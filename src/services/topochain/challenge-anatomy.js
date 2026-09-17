// How a rule scores, step by step — for the admin's rule detail.
//
// An operator choosing how often a rule should run needs to know what a run
// of it DOES: which tables it reads, whether a model is called, what stops it
// paying twice. That used to be knowable only by reading the scorer, and the
// difference matters — five of the seven measures are two SQL reads, and two
// of them can spend most of a minute on model calls.
//
// Everything printed here is taken from the thing that runs, not retyped
// beside it: the statement is the scorer's own constant (MEASURE_SQL), the
// rubric is the grader's own function called with the rule's ceiling, and the
// model, the input limits and the run budgets are the constants those modules
// execute with. tests/challenge-scoring.test.js holds each of them to that,
// so a panel that has drifted from the behaviour is a failing test rather
// than a wrong sentence on a screen somebody trusts.
//
// Pure: no pool, no I/O. The route hands it a measure and the two numbers.
'use strict';

const rules = require('./challenge-rules');
const grader = require('./challenge-grader');
const scorer = require('./challenge-scorer');

const { MEASURES, TRY_APPS_MIN_SECONDS } = rules;

// What each measure reads, in the words an operator would use, and how a
// credit names the thing it was paid for. `key` is the source key's fixed
// part: the test runs every measure and checks the keys it really produces
// start with it.
const READS = {
  TRY_APPS: {
    tables: ['app_activity', 'apps'],
    key: 'app:',
    keyLabel: 'app:<app id>',
    text: () => 'One row per person and app: apps they opened inside the window and spent at least '
      + `${TRY_APPS_MIN_SECONDS} seconds in, added up across days. Apps they made themselves are left out.`,
  },
  USE_APPS_MINUTES: {
    tables: ['app_activity', 'apps'],
    key: 'window',
    keyLabel: 'window',
    text: ({ target }) => 'One row per person: their time in apps inside the window, added up, once it reaches '
      + `${target == null ? 'the target' : `${fmt(target)} minutes`}. Apps they made themselves are left out.`,
  },
  PROPOSAL_SENT: {
    tables: ['chat_sessions', 'apps'],
    key: 'session:',
    keyLabel: 'session:<session id>',
    text: () => 'Proposals put to the group vote inside the window. Only the promote button writes '
      + '`promoted_at`, so the platform\'s own maintenance proposals never count.',
  },
  PROPOSAL_ACCEPTED: {
    tables: ['events', 'chat_sessions', 'apps'],
    key: 'merged:',
    keyLabel: 'merged:<event id>',
    text: () => 'Merges inside the window, credited to the proposal\'s author. A merge an admin forced is '
      + 'left out: it is not a change the group accepted.',
  },
  USEFUL_FEEDBACK: {
    tables: ['feedback_reports', 'apps'],
    key: 'feedback:',
    keyLabel: 'feedback:<report id>',
    text: () => 'Reports sent inside the window that reached GitHub as an issue. One whose issue call '
      + 'failed helped nobody, and is left out.',
  },
  CONNECT_ACCOUNTS: {
    tables: ['user_social_identities'],
    key: 'provider:',
    keyLabel: 'provider:<x or github>',
    text: () => 'Every linked account, one row per person and provider. No window: an account linked '
      + 'before the season counts.',
  },
  BLOCK_PRODUCTION_ON: {
    tables: ['users', 'epoch_stats'],
    key: 'block-production',
    keyLabel: 'block-production',
    text: () => 'Everyone who asked for block production access, was released, or has already won a '
      + 'slot. No window: state from before the season counts.',
  },
};

// The statements are template literals indented to sit inside their module,
// so printed as they are the first line hangs left of all the others. Take
// off the indentation every line shares; what is left is the statement the
// scorer runs, laid out the way somebody would type it.
function dedent(sql) {
  const lines = String(sql).replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

function fmt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n);
}

// The cap a person reaches, which is what "already paid" stops at.
function capSentence(spec, target) {
  if (!spec.counted) return 'One credit a person, so a second pass finds nothing left to pay.';
  const n = target == null ? 'the target' : fmt(target);
  return spec.windowed
    ? `A person stops at ${n} ${spec.targetUnit} per window.`
    : `A person stops at ${n} ${spec.targetUnit}.`;
}

function anatomy(measureKey, { points = null, target = null } = {}) {
  const spec = MEASURES[measureKey];
  const reads = READS[measureKey];
  if (!spec || !reads) return null;

  const pts = Number(points);
  const tgt = Number(target);
  const hasPoints = Number.isFinite(pts) && pts > 0;
  const hasTarget = Number.isFinite(tgt) && tgt > 0;
  // The ceiling the grader is given for one unit — the scorer's own
  // arithmetic, so the rubric printed is the rubric sent.
  const ceiling = spec.graded && hasPoints && hasTarget
    ? rules.unitPoints({ payout: 'graded', points: pts, target: tgt, index: 0 })
    : null;

  const steps = [{
    kind: 'read',
    title: 'Read the candidates',
    text: reads.text({ target: hasTarget ? tgt : null }),
    tables: reads.tables,
    sql: dedent(scorer.MEASURE_SQL[measureKey]),
    note: `At most ${fmt(scorer.CANDIDATE_LIMIT)} rows a run.`,
  }];

  if (measureKey === 'USEFUL_FEEDBACK') {
    steps.push({
      kind: 'filter',
      title: 'Drop the junk',
      text: `No model call: a report under ${grader.MIN_FEEDBACK_CHARS} characters, or the same text this `
        + 'person already sent, is dropped here. It runs before the cap, so junk never holds one of a '
        + 'person\'s slots.',
    });
  }

  steps.push({
    kind: 'paid',
    title: 'Drop what is already paid',
    text: `Reads this challenge's ledger rows and drops every candidate whose source key (${reads.keyLabel}) `
      + `is already there. ${capSentence(spec, hasTarget ? tgt : null)}`,
    tables: ['user_activities'],
    sql: dedent(scorer.CREDITED_SQL),
  });

  if (spec.graded) {
    steps.push({
      kind: 'grade',
      title: 'Grade each new one',
      text: `One call to ${grader.GRADE_MODEL} for each new ${spec.unit}, one at a time, at most `
        + `${scorer.MAX_GRADES_PER_RUN} in a run across every graded rule. It is sent the app name, the first `
        + `${fmt(grader.GRADE_TITLE_CHARS)} characters of the title and the first ${fmt(grader.GRADE_TEXT_CHARS)} of the text, `
        + `and returns a score from 1 to ${ceiling == null ? 'the ceiling' : fmt(ceiling)} with a reason. Both are kept on the `
        + 'ledger row. A call that fails pays nothing, and the unit waits for this rule\'s next run. '
        + `Already graded is already paid, so each ${spec.unit} is sent once in its life.`,
      model: grader.GRADE_MODEL,
      rubric: ceiling == null ? null : grader.RUBRICS[measureKey].system(ceiling),
    });
  }

  steps.push({
    kind: 'write',
    title: 'Write the credits',
    text: 'One `user_activities` row per credit, dated when the thing happened, source '
      + '`challenge_scorer`. A unique index on challenge, person and source key refuses a second row, so '
      + `running the rule again pays nothing twice. At most ${fmt(scorer.MAX_CREDITS_PER_RUN)} credits in one run `
      + 'across every rule; a rule cut short by that goes first on the next beat.',
    tables: ['user_activities'],
  });

  return {
    measure: measureKey,
    lane: spec.graded ? 'sql_model' : 'sql',
    // What the interval actually buys, said where the interval is chosen.
    cost: spec.graded
      ? `SQL, then one model call for each new ${spec.unit}. A ${spec.unit} is graded once in its life, so a `
        + 'shorter interval does not spend more. It only marks sooner.'
      : 'SQL only: two small reads a run, so a short interval costs nothing you would notice.',
    steps,
  };
}

module.exports = { anatomy, dedent, READS };
