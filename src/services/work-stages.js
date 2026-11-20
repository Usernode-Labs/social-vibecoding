'use strict';

// The one table of a work state's vocabulary (work-stages.json): its ten
// stages, the whys of waiting_for_you, the reasons of stopped, and every
// line code, each with what it means wherever it is read. The lists the
// derive, the words, the lists a person sees, the bot's own work and a
// project chat's card used to keep one each (READY, PLAIN_LINES,
// WAITING_LINES, placeFor's own, botWorkOf's own, the card's READY_LINES, the
// track's two) are read off it here, so a new line code is one entry in the
// table (review B2: `credit_wait` needed seven edits and missed an eighth).
//
// Nothing here requires anything but the table: the browser reads the same
// JSON (as it reads services/countries.json) through
// frontend/src/lib/work-stages.ts, and tests build their lists from it.
// tests/work-stages-client.test.js fails when the client and this table
// disagree on any stage, why, reason or line code.
//
// A stage:
//   phrase        its word, a phrase id of frontend/locales/en/core.json
//   whoseMove     whose move it is unless the derive says otherwise
//   works         the bot may be at it this minute (busyNow)
//   bot           what the bot is doing in it: 'reading' | 'building' (botWorkOf)
//   listed        where it is listed for a person: 'needs' (theirs to act
//                 on), 'waiting', 'next' (in progress), 'vote' (the feed's
//                 own Vote row when they owe one), 'live' (for a week), null
//   bell          the moment entering it rings (bellOf), if any
//   step          the step of a request's track it lights
//   firstVersion  the step a first version's App tab draws it at
// A why and a reason: `phrase` (a why's `phraseOthers` for anyone but its
// requester), `said` (which of the bell's sentences it says), and what a why
// is to the bot (`bot`) and to a first version (`firstVersion`).
// A line code:
//   stages        the stages it is written on
//   phrase        its words when it needs no value, or null
//   valued        its words with values: `phrase`, the line's field it needs
//                 (`need`; without it the plain phrase, or nothing), the
//                 values by the field each is read from, `text` when they
//                 are words not numbers, `fallback` for a missing number
//   notStarted    on a request being read: nobody has started on it
//   ready         on a build: found ready, and waiting (its turn, a limit,
//                 building credit)
//   waits         the bot is not at it this minute
//   listed        'waiting' when it is listed under Waiting, not In progress
//   counted       its words count the project's other requests (a place in
//                 a line), so a move of one marks the others
//   approved      its change's votes are in
//   failing       its change's tests fail (its own checks, GitHub's, or a
//                 fix of them that failed): a surface tints the row bad.
//                 Read by the client only (lib/work-stages.ts FAILING_LINES,
//                 and app-view.js's copy the agreement test holds to it)
//   stageWord     the stage word it replaces, by stage
//   bot           what the bot is doing on it, by stage, where that is not
//                 the stage's own: null (nothing), { what, held?, turn? },
//                 or { when: a field of the line, then, otherwise } where
//                 'stage' means the stage's own
//   firstVersion  the step a first version's App tab draws it at (by stage
//                 when it differs), `firstVersionReady` when the line says a
//                 build waits behind it

const TABLE = require('./work-stages.json');

const freezeDeep = (v) => {
  if (v && typeof v === 'object') { Object.values(v).forEach(freezeDeep); Object.freeze(v); }
  return v;
};
freezeDeep(TABLE);

const STAGE = TABLE.stages;
const WHY = TABLE.whys;
const REASON = TABLE.reasons;
const LINE = TABLE.lines;

const STAGES = Object.freeze(Object.keys(STAGE));
const WHYS = Object.freeze(Object.keys(WHY));
const REASONS = Object.freeze(Object.keys(REASON));
const LINE_CODES = Object.freeze(Object.keys(LINE));

const codesWith = (test) => new Set(LINE_CODES.filter((code) => test(LINE[code])));

// A request in the reading stage nobody has started on yet.
const NOT_STARTED = codesWith((l) => l.notStarted === true);
// A build found ready that waits: its turn, one of the project's limits, credit.
const READY = codesWith((l) => l.ready === true);
// The lines whose words need no value.
const PLAIN_LINES = codesWith((l) => typeof l.phrase === 'string');
// The lines that say the bot waits rather than works.
const WAITING_LINES = codesWith((l) => l.waits === true);
// The lines listed under Waiting rather than In progress.
const LISTED_WAITING = codesWith((l) => l.listed === 'waiting');
// The lines whose words count the project's other requests.
const PLACE_LINES = Object.freeze(LINE_CODES.filter((code) => LINE[code].counted === true));
// The lines that say a change's votes are in.
const APPROVED_LINES = Object.freeze(LINE_CODES.filter((code) => LINE[code].approved === true));
// The lines that say a change's tests fail (the client tints them bad).
const FAILING_LINES = codesWith((l) => l.failing === true);

const lineOf = (code) => (code && Object.prototype.hasOwnProperty.call(LINE, code) ? LINE[code] : null);
const stageOf = (stage) => (stage && Object.prototype.hasOwnProperty.call(STAGE, stage) ? STAGE[stage] : null);

/** Pure: whose move a stage is, when the derive names nobody. */
function whoseMoveOf(stage) {
  const s = stageOf(stage);
  return s ? s.whoseMove || null : null;
}

/** Pure: the phrase of a stage's word, as its line may replace it. */
function stageWordOf(stage, code) {
  const line = lineOf(code);
  if (line && line.stageWord && line.stageWord[stage]) return line.stageWord[stage];
  if (stage === 'reading' && NOT_STARTED.has(code)) return TABLE.words.notStarted;
  if (stage === 'building' && READY.has(code)) return TABLE.words.readyToBuild;
  return (stageOf(stage) || STAGE.reading).phrase;
}

/** Pure: a line's phrase ({ id, values? }) from the line as stored, or null when it says nothing. */
function linePhraseOf(line) {
  const def = lineOf(line && line.code);
  if (!def) return null;
  const v = def.valued;
  if (v && (!v.need || line[v.need])) {
    const values = {};
    for (const [name, field] of Object.entries(v.values)) {
      values[name] = v.text ? String(line[field]) : Number(line[field]) || (v.fallback ?? Number(line[field]));
    }
    return { id: v.phrase, values };
  }
  return def.phrase ? { id: def.phrase } : null;
}

/**
 * Pure: what the bot is doing on an item at `stage` with `line`: null, or
 * { what, held?, turn?, plan? } (work-state.js botWorkOf adds since when).
 * `why` is a waiting_for_you item's.
 */
function botOf(stage, line, why = null) {
  const s = stageOf(stage);
  if (!s) return null;
  if (stage === 'waiting_for_you') return (why && WHY[why] && WHY[why].bot) || null;
  const own = s.bot ? { what: s.bot } : null;
  const def = lineOf(line && line.code);
  const spec = def && def.bot && Object.prototype.hasOwnProperty.call(def.bot, stage) ? def.bot[stage] : undefined;
  if (spec === undefined) return own;
  if (spec === null) return null;
  if (!spec.when) return spec;
  const pick = line[spec.when] ? spec.then : spec.otherwise;
  return pick === 'stage' ? own : pick;
}

/** Pure: the step a first version's App tab draws an item at, or null when it is no step. */
function firstVersionStepOf(stage, line, why = null) {
  const s = stageOf(stage);
  if (!s) return null;
  if (stage === 'waiting_for_you') return (why && WHY[why] && WHY[why].firstVersion) || null;
  const def = lineOf(line && line.code);
  if (def) {
    if (def.firstVersionReady && line.ready) return def.firstVersionReady;
    const fv = def.firstVersion;
    if (typeof fv === 'string') return fv;
    if (fv && fv[stage]) return fv[stage];
  }
  return s.firstVersion || null;
}

module.exports = {
  TABLE,
  STAGE,
  WHY,
  REASON,
  LINE,
  STAGES,
  WHYS,
  REASONS,
  LINE_CODES,
  NOT_STARTED,
  READY,
  PLAIN_LINES,
  WAITING_LINES,
  LISTED_WAITING,
  PLACE_LINES,
  APPROVED_LINES,
  FAILING_LINES,
  whoseMoveOf,
  stageWordOf,
  linePhraseOf,
  botOf,
  firstVersionStepOf,
};
