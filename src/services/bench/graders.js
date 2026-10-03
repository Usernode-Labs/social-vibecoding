'use strict';

// #3654: the benchmark's DETERMINISTIC graders, and the one rule that turns a
// trial's grades into its verdict.
//
// Deterministic first, wherever the answer can be checked rather than judged:
//
//   triage     the verdict against the reference's (per class), a question
//              present when one is expected, suggested answers with it
//   build      commits produced; the diff-scope rule (no pre-existing check
//              or test edited or removed unless the task allows it); the
//              hidden checks, when they could run (they cannot yet, see
//              services/bench/runner.js hiddenChecksUnavailable)
//   follow-up  the action against the reference's, when it names one
//   dm         the final verdict after the simulated conversation, within
//              its turn limit (services/bench/dm-sim.js)
//
// A deterministic FAIL is final: no judge is asked to rescue a wrong verdict.
// What a rule cannot see (is this question a real blocker, does this diff do
// what was asked) is marked `needsJudge`, and the Opus grade (or a person's,
// which overrides it) decides. The shape stored on the trial:
//
//   { pass: true | false | null, needsJudge, criteria: { name: bool|null }, notes: [] }
//
// `pass: null` is "nothing to grade against yet" (no reference): such a trial
// waits for its task to be labelled and is left out of accuracy until then.

const log = require('../logger');

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|e2e)\//i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function isTestPath(filename) {
  return TEST_PATH_RE.test(String(filename || '')) || TEST_FILE_RE.test(String(filename || ''));
}

function parseTests(text) {
  try {
    const manifest = JSON.parse(text || '{}');
    return Array.isArray(manifest.tests) ? manifest.tests.filter((t) => t && typeof t === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * The declared checks a change removed or altered: every check that existed
 * at the base and is not, byte for byte, still there. Added checks are fine.
 */
function checksChanged(baseText, headText) {
  const head = new Set(parseTests(headText).map((t) => JSON.stringify(t)));
  return parseTests(baseText).filter((t) => !head.has(JSON.stringify(t)))
    .map((t) => String(t.name || t.path || 'unnamed check'));
}

/**
 * The diff-scope rule: no pre-existing test file edited, renamed or removed,
 * and no pre-existing declared check altered, unless the task allows it
 * (reference.allowed_test_edits: paths or check names). Pure.
 */
function diffScope({ files = [], checksAltered = [], allowed = [] }) {
  const allow = new Set((allowed || []).map(String));
  const violations = [];
  for (const f of files || []) {
    if (!['modified', 'removed', 'renamed', 'changed'].includes(f.status)) continue;
    const name = f.filename;
    if (isTestPath(name) && !allow.has(name)) violations.push(`${f.status} ${name}`);
    if (f.previous && isTestPath(f.previous) && !allow.has(f.previous)) violations.push(`renamed ${f.previous}`);
  }
  for (const name of checksAltered || []) {
    if (!allow.has(name)) violations.push(`altered the check "${name}"`);
  }
  return { ok: violations.length === 0, violations };
}

function triageGrade({ parsed, reference }) {
  const ref = reference || {};
  if (!parsed?.verdict) return { pass: false, needsJudge: false, criteria: { verdict_match: false }, notes: ['no verdict'] };
  if (!ref.verdict) {
    return { pass: null, needsJudge: false, criteria: { verdict_match: null }, notes: ['the task has no reference verdict yet'] };
  }
  const match = parsed.verdict === ref.verdict;
  const criteria = { verdict_match: match };
  if (ref.verdict === 'question') {
    criteria.question_present = !!(parsed.question && String(parsed.question).trim());
    criteria.suggested_answers = Array.isArray(parsed.questionAnswers) && parsed.questionAnswers.length >= 2;
  }
  if (!match) return { pass: false, needsJudge: false, criteria, notes: [`said ${parsed.verdict}, the reference says ${ref.verdict}`] };
  if (criteria.question_present === false) return { pass: false, needsJudge: false, criteria, notes: ['a question verdict with no question'] };
  // The right class; whether its question is a real blocker, or its plan is
  // right and bounded, is for the judge.
  const needsJudge = ref.verdict === 'question' || ref.verdict === 'ready';
  return { pass: needsJudge ? null : true, needsJudge, criteria, notes: [] };
}

function buildGrade({ trial, reference, scope }) {
  const ref = reference || {};
  const criteria = {
    produced_commits: Number(trial.build_commits) > 0,
    diff_scope: scope ? scope.ok : null,
    hidden_checks: trial.checks && trial.checks.ran ? trial.checks.failed === 0 : null,
  };
  const notes = [];
  if (scope && !scope.ok) notes.push(...scope.violations.slice(0, 10));
  if (trial.checks && !trial.checks.ran && trial.checks.reason) notes.push(trial.checks.reason);
  if (trial.parsed?.blocked) {
    // The spec found the request impossible. Right only when the task says so.
    const right = ref.verdict === 'impossible' || ref.blocked === true;
    return { pass: right ? true : false, needsJudge: false, criteria: { ...criteria, blocked: true }, notes: [`blocked: ${trial.parsed.blocked}`] };
  }
  if (!criteria.produced_commits) return { pass: false, needsJudge: false, criteria, notes: [...notes, 'no commits'] };
  if (criteria.diff_scope === false) return { pass: false, needsJudge: false, criteria, notes };
  if (criteria.hidden_checks === false) return { pass: false, needsJudge: false, criteria, notes };
  return { pass: null, needsJudge: true, criteria, notes };
}

function specGrade({ trial }) {
  const spec = trial.parsed?.spec;
  if (trial.parsed?.blocked) return { pass: null, needsJudge: true, criteria: { produced_spec: false, blocked: true }, notes: [] };
  if (!spec || !String(spec).trim()) return { pass: false, needsJudge: false, criteria: { produced_spec: false }, notes: ['no spec'] };
  return { pass: null, needsJudge: true, criteria: { produced_spec: true }, notes: [] };
}

function followupGrade({ trial, reference }) {
  const action = trial.parsed?.action;
  const ref = reference || {};
  const criteria = { action_match: ref.action ? action === ref.action : null };
  if (ref.action && action !== ref.action) {
    return { pass: false, needsJudge: false, criteria, notes: [`chose ${action}, the reference says ${ref.action}`] };
  }
  return { pass: null, needsJudge: true, criteria, notes: [] };
}

/**
 * #3737: a taste trial (services/bench/taste.js). A first version the
 * triage did not build, or the bot's build did not land, fails; so does an
 * app that would not boot, or one with no screenshot to look at. Anything
 * else is the judge's, from the screenshots and the rubric.
 */
function tasteGrade({ stage, trial }) {
  const p = trial.parsed || {};
  const capture = trial.capture || null;
  if (stage === 'first_version' && !p.built) {
    if (p.blocked) return { pass: false, needsJudge: false, criteria: { built: false }, notes: [`blocked: ${p.blocked}`] };
    const verdict = p.triage?.verdict;
    return {
      pass: false, needsJudge: false, criteria: { built: false },
      notes: [verdict && verdict !== 'ready' ? `the triage answered ${verdict} and built nothing` : 'nothing was built'],
    };
  }
  const shots = Array.isArray(capture?.shots) ? capture.shots.filter((s) => s.artifactId).length : 0;
  const criteria = { ...(stage === 'first_version' ? { built: true } : {}), booted: !!capture?.booted, screenshots: shots > 0 };
  if (!capture) return { pass: false, needsJudge: false, criteria, notes: ['no screenshots were taken'] };
  if (!capture.booted) return { pass: false, needsJudge: false, criteria, notes: [`the app did not boot: ${capture.error || 'no reason given'}`] };
  if (!shots) return { pass: false, needsJudge: false, criteria, notes: [capture.error || 'no screenshot came back'] };
  return { pass: null, needsJudge: true, criteria, notes: [] };
}

/** The deterministic grade of a finished trial, or null when there is none to give (not ok). Pure. */
function deterministicGrade({ stage, trial, reference, scope = null }) {
  if (trial.status !== 'ok') return null;
  switch (stage) {
    case 'first_version':
    case 'capture': return tasteGrade({ stage, trial });
    case 'triage': return triageGrade({ parsed: trial.parsed, reference });
    case 'build': return buildGrade({ trial, reference, scope });
    case 'spec': return specGrade({ trial });
    case 'followup':
    case 'checks_fix': return followupGrade({ trial, reference });
    case 'dm': return require('./dm-sim').dmGrade({ trial, reference });
    default: return null;
  }
}

/**
 * A trial's verdict from its grades. A person's grade overrides everything;
 * a deterministic fail is final; a trial a rule could settle is settled; a
 * trial that needs a judge takes the latest Opus grade, and is `pending`
 * until it has one. A trial that did not produce an answer (model failure,
 * timeout) fails; one the platform failed, or that was not applicable or
 * skipped, is `excluded` from quality. Pure.
 *
 * Returns 'pass' | 'fail' | 'pending' | 'unlabelled' | 'excluded'.
 */
function finalVerdict({ status, deterministic, grades = [] }) {
  if (['infra_fail', 'not_applicable', 'skipped_cap', 'cancelled', 'pending', 'running'].includes(status)) return 'excluded';
  const latest = (kind) => grades.filter((g) => g.grader === kind)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || b.id - a.id)[0];
  const human = latest('human');
  if (human) return human.verdict;
  if (status === 'model_fail' || status === 'timeout') return 'fail';
  if (!deterministic) return 'pending';
  if (deterministic.pass === false) return 'fail';
  if (deterministic.pass === true) return 'pass';
  if (!deterministic.needsJudge) return 'unlabelled';
  const opus = latest('opus');
  return opus ? opus.verdict : 'pending';
}

/**
 * Grade one finished trial and store it on the trial. A build's diff-scope
 * rule reads the declared checks at the base and at the branch head; GitHub
 * is the trial's guarded client. Never throws.
 */
async function gradeTrial(pool, trialId, { github = null } = {}) {
  try {
    const { rows: [t] } = await pool.query(
      `SELECT tr.*, tk.stage, tk.reference, a.repo_url
         FROM bench_trials tr JOIN bench_tasks tk ON tk.id = tr.task_id LEFT JOIN apps a ON a.id = tk.app_id
        WHERE tr.id = $1`,
      [Number(trialId)],
    );
    if (!t) return null;
    // Graded again without GitHub (a reference changed), the scope it found
    // the first time stands.
    let scope = !github && t.deterministic?.scope ? t.deterministic.scope : null;
    if (!scope && (t.stage === 'build' || t.stage === 'followup' || t.stage === 'checks_fix') && t.changed_files) {
      let altered = [];
      if (github && t.base_sha && t.build_branch && Number(t.build_commits) > 0
          && (t.changed_files.files || []).some((f) => f.filename === 'dapp.json')) {
        const repo = require('../homeroom-bot').parseRepo(t.repo_url);
        if (repo) {
          try {
            const [base, head] = await Promise.all([
              github.getFileContent(repo.owner, repo.repo, 'dapp.json', t.base_sha),
              github.getFileContent(repo.owner, repo.repo, 'dapp.json', t.build_sha || t.build_branch),
            ]);
            altered = checksChanged(base, head);
          } catch (err) {
            log.warn('bench', 'Could not read the declared checks for the diff-scope rule', { trialId, err: err.message });
          }
        }
      }
      scope = diffScope({ files: t.changed_files.files || [], checksAltered: altered, allowed: t.reference?.allowed_test_edits });
    }
    const graded = deterministicGrade({ stage: t.stage, trial: t, reference: t.reference, scope });
    const grade = graded ? { ...graded, ...(scope ? { scope } : {}) } : null;
    await pool.query('UPDATE bench_trials SET deterministic = $2::jsonb WHERE id = $1', [t.id, grade ? JSON.stringify(grade) : null]);
    return grade;
  } catch (err) {
    log.warn('bench', 'Deterministic grading failed', { trialId, err: err.message });
    return null;
  }
}

/** Grade again every finished trial of a task, after its reference changed. */
async function regradeTask(pool, taskId, opts = {}) {
  const { rows } = await pool.query(
    "SELECT id FROM bench_trials WHERE task_id = $1 AND status = 'ok'", [Number(taskId)],
  );
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    await gradeTrial(pool, r.id, opts);
  }
  return rows.length;
}

module.exports = {
  isTestPath,
  checksChanged,
  diffScope,
  triageGrade,
  buildGrade,
  specGrade,
  followupGrade,
  tasteGrade,
  deterministicGrade,
  finalVerdict,
  gradeTrial,
  regradeTask,
};
