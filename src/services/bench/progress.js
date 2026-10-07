'use strict';

// What a benchmark trial is doing right now (bench_trials.progress), for the
// App bench studio's watch (services/bench/studio.js watchRun): the step it
// is at, when it got there, its last few activity lines (the same lines the
// worker reports for every turn: services/worker.js applyStreamEvent), and
// the skills it reached for. Written a few seconds apart while the trial
// runs, never on every line, and once more when it ends.
//
// Skills are what a context pack's theme is tested by: a skill file in the
// first commit (services/bench/packs.js) that the model never loads changes
// nothing, and "the theme did nothing" and "the theme was never read" look
// the same in screenshots. A Skill tool call names its skill in the turn's
// progress ("Using skill <name>"); a model that reads the file instead shows
// its path. Both are counted, apart.

const STEPS = Object.freeze(['scaffold', 'triage', 'plan', 'spec', 'build', 'capture']);
const LINES_KEPT = 4;
const LINE_CHARS = 200;
const WRITE_EVERY_MS = 5000;
const MAX_SKILLS = 20;
const SKILL_CALL_RE = /^Using skill ([A-Za-z0-9._:/-]{1,80})/;
const SKILL_FILE_RE = /\.(?:claude|agents)\/skills\/([A-Za-z0-9._-]{1,80})\/SKILL\.md/;

/** Which skill a progress line shows the model invoking or reading, if any. Pure. */
function skillIn(line) {
  const text = String(line || '');
  const call = SKILL_CALL_RE.exec(text);
  if (call) return { kind: 'invoked', name: call[1] };
  const file = SKILL_FILE_RE.exec(text);
  if (file) return { kind: 'read', name: file[1] };
  return null;
}

function clip(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text;
}

/**
 * A trial's progress, kept in memory and written to its row. `step(name)`
 * writes at once; `note(line)` within WRITE_EVERY_MS; `close()` writes what
 * is left and stops. A write that fails is logged and never stops the trial.
 */
function tracker(pool, trialId, { now = () => Date.now(), writeEveryMs = WRITE_EVERY_MS, log = null } = {}) {
  const iso = () => new Date(now()).toISOString();
  const state = { step: null, stepAt: null, lines: [], skills: { invoked: [], read: [] }, updatedAt: iso() };
  let timer = null;
  let closed = false;
  let chain = Promise.resolve();
  const write = () => {
    state.updatedAt = iso();
    const body = JSON.stringify(state);
    chain = chain.then(() => pool.query('UPDATE bench_trials SET progress = $2::jsonb WHERE id = $1', [Number(trialId), body]))
      .catch((err) => { if (log) log.warn('bench', 'Could not record a trial\'s progress', { trialId, err: err.message }); });
    return chain;
  };
  const later = () => {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; write(); }, writeEveryMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  return {
    step(name) {
      if (closed || !STEPS.includes(name) || state.step === name) return chain;
      state.step = name;
      state.stepAt = iso();
      if (timer) { clearTimeout(timer); timer = null; }
      return write();
    },
    note(line) {
      if (closed) return;
      const text = clip(line);
      if (!text) return;
      const skill = skillIn(text);
      if (skill) {
        const list = state.skills[skill.kind];
        if (!list.includes(skill.name) && list.length < MAX_SKILLS) list.push(skill.name);
      }
      if (state.lines[state.lines.length - 1] === text) return;
      state.lines.push(text);
      if (state.lines.length > LINES_KEPT) state.lines.shift();
      later();
    },
    skills() {
      return { invoked: [...state.skills.invoked], read: [...state.skills.read] };
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
    async close() {
      if (closed) return chain;
      if (timer) { clearTimeout(timer); timer = null; }
      const done = write();
      closed = true;
      return done;
    },
  };
}

module.exports = {
  STEPS,
  LINES_KEPT,
  WRITE_EVERY_MS,
  skillIn,
  tracker,
};
