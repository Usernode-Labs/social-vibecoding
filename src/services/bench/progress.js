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
//
// So are the in-loop browser's looks, for the same reason: a build told to
// check its screens that never looked, one that read the page's text
// snapshot, and one that took screenshots all look alike in the result. A
// screenshot is the model looking at the page as an image, a snapshot reading
// its accessibility text, a navigation loading it (one per look, roughly).
// Both harnesses report a tool call as "Using <tool>": Claude Code with the
// MCP prefix (mcp__playwright__browser_take_screenshot), Codex without it.
//
// A first version goes on after a restart from its checkpoint, so its
// tracker also keeps the skills and looks there while its turns run (`keep`):
// at each step, and when they change at most every KEEP_EVERY_MS, so a
// restart loses only the last few seconds of them. A step's write also says
// what the counts were when the step began (`stepLooks`): a turn restart
// recovery follows is replayed from its start, so its looks are added to
// those, never to counts that already hold some of them (lane.js
// recoveredLooks).

const STEPS = Object.freeze(['scaffold', 'triage', 'plan', 'spec', 'build', 'capture']);
const LINES_KEPT = 4;
const LINE_CHARS = 200;
const WRITE_EVERY_MS = 5000;
const KEEP_EVERY_MS = 15000;
const MAX_SKILLS = 20;
const SKILL_CALL_RE = /^Using skill ([A-Za-z0-9._:/-]{1,80})/;
const SKILL_FILE_RE = /\.(?:claude|agents)\/skills\/([A-Za-z0-9._-]{1,80})\/SKILL\.md/;
const LOOK_RE = /^Using (?:mcp__playwright__)?browser_(take_screenshot|snapshot|navigate)\b/;
const LOOK_KINDS = Object.freeze({ take_screenshot: 'screenshots', snapshot: 'snapshots', navigate: 'navigations' });

/** Which skill a progress line shows the model invoking or reading, if any. Pure. */
function skillIn(line) {
  const text = String(line || '');
  const call = SKILL_CALL_RE.exec(text);
  if (call) return { kind: 'invoked', name: call[1] };
  const file = SKILL_FILE_RE.exec(text);
  if (file) return { kind: 'read', name: file[1] };
  return null;
}

/** Which look a progress line shows the model taking in the in-loop browser, if any. Pure. */
function lookIn(line) {
  const m = LOOK_RE.exec(String(line || ''));
  return m ? LOOK_KINDS[m[1]] : null;
}

function clip(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text;
}

/** Look counts, every kind present and none negative: from a record, or all zero. Pure. */
function lookCounts(looks = null) {
  return Object.fromEntries(Object.values(LOOK_KINDS).map((k) => [k, Math.max(Number(looks?.[k]) || 0, 0)]));
}

/** The looks a turn's progress lines show, counted as a tracker counts them (repeats included). Pure. */
function looksIn(lines) {
  const out = lookCounts();
  for (const line of Array.isArray(lines) ? lines : []) {
    const look = lookIn(clip(line));
    if (look) out[look] += 1;
  }
  return out;
}

/** Skills already seen, as a list of names a tracker may start from. Pure. */
function skillNames(list) {
  return Array.isArray(list) ? [...new Set(list.map(String))].slice(0, MAX_SKILLS) : [];
}

/**
 * A trial's progress, kept in memory and written to its row. `step(name)`
 * writes at once; `note(line)` within WRITE_EVERY_MS; `close()` writes what
 * is left and stops. A write that fails is logged and never stops the trial.
 * `skills` and `looks` are those an earlier claim of the same trial already
 * saw (a first version going on after a restart), so its record keeps them.
 * `keep(part)`, when given, keeps them on the trial's checkpoint (the caller
 * adds them to `part`): at each new step, with `stepLooks`, and after a new
 * look or skill at most every `keepEveryMs`. A keep that fails is logged.
 */
function tracker(pool, trialId, {
  now = () => Date.now(), writeEveryMs = WRITE_EVERY_MS, log = null, skills = null, looks = null,
  keep = null, keepEveryMs = KEEP_EVERY_MS,
} = {}) {
  const iso = () => new Date(now()).toISOString();
  const seen = { invoked: skillNames(skills?.invoked), read: skillNames(skills?.read) };
  const state = { step: null, stepAt: null, lines: [], skills: seen, updatedAt: iso() };
  state.looks = lookCounts(looks);
  let timer = null;
  let closed = false;
  let chain = Promise.resolve();
  // Keeping them on the checkpoint: when a change last did, and the keep
  // waiting for the rest of its interval.
  let keptAt = -Infinity;
  let keepTimer = null;
  const keepNow = (part = {}) => {
    if (keepTimer) { clearTimeout(keepTimer); keepTimer = null; }
    return Promise.resolve().then(() => keep(part)).catch((err) => {
      if (log) log.warn('bench', 'Could not keep a trial\'s looks on its checkpoint', { trialId, err: err.message });
    });
  };
  const keepSoon = () => {
    if (!keep || closed || keepTimer) return;
    const wait = keptAt + keepEveryMs - now();
    if (wait <= 0) {
      keptAt = now();
      keepNow();
      return;
    }
    keepTimer = setTimeout(() => { keepTimer = null; keptAt = now(); keepNow(); }, wait);
    if (typeof keepTimer.unref === 'function') keepTimer.unref();
  };
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
      const wrote = write();
      if (!keep) return wrote;
      // Before the step's turn runs: what recovery adds that turn's looks to.
      return Promise.all([wrote, keepNow({ stepLooks: { step: name, ...state.looks } })]).then(() => undefined);
    },
    note(line) {
      if (closed) return;
      const text = clip(line);
      if (!text) return;
      const skill = skillIn(text);
      if (skill) {
        const list = state.skills[skill.kind];
        if (!list.includes(skill.name) && list.length < MAX_SKILLS) {
          list.push(skill.name);
          keepSoon();
        }
      }
      // Counted before a repeat is dropped: two screenshots in a row are two looks.
      const look = lookIn(text);
      if (look) {
        state.looks[look] += 1;
        keepSoon();
      }
      if (state.lines[state.lines.length - 1] === text) return;
      state.lines.push(text);
      if (state.lines.length > LINES_KEPT) state.lines.shift();
      later();
    },
    skills() {
      return { invoked: [...state.skills.invoked], read: [...state.skills.read] };
    },
    looks() {
      return { ...state.looks };
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
    async close() {
      if (closed) return chain;
      if (timer) { clearTimeout(timer); timer = null; }
      // The trial's record takes them from here (lane.recordTrial).
      if (keepTimer) { clearTimeout(keepTimer); keepTimer = null; }
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
  KEEP_EVERY_MS,
  skillIn,
  lookIn,
  looksIn,
  lookCounts,
  tracker,
};
