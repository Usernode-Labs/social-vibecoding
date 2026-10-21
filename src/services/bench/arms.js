'use strict';

// An ARM of a core benchmark run: an OpenRouter model id, or a model at a
// reasoning effort of its own, written `vendor/model@effort`
// (`deepseek/deepseek-v4.1-flash-1017@max`). A run's `models` and a
// trial's `model` hold the arm as written, so everything that already
// groups by them (the report's arms, the cost and time history, the
// results the console and the connector read) keeps an effort apart from
// its model's default without a column of its own; and the lane hands the
// trial its model and its effort apart (lane.executeTrial), so every turn
// of it runs at that effort (runner.turnEffort). An arm with no effort runs
// at the effort the bot's own turns get, as every trial did before.
//
// The efforts are a configuration's (bot-configs.js EFFORTS): `max`
// reaches Claude Code turns only, and a Codex turn runs it at xhigh
// (agent-turn.js). An OpenRouter id never holds an `@`
// (default-model.js MODEL_ID_RE), so the suffix cannot be part of one.

const { EFFORTS } = require('../bot-configs');
const { MODEL_ID_RE } = require('../default-model');

/** `{ arm, model, effort }` for an arm as written; `effort` null when it names none. Pure. */
function parseArm(arm) {
  const s = String(arm ?? '').trim();
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const effort = s.slice(at + 1).trim().toLowerCase();
    const model = s.slice(0, at).trim();
    if (EFFORTS.includes(effort) && model) return { arm: `${model}@${effort}`, model, effort };
  }
  return { arm: s, model: s, effort: null };
}

/** The arm of `model` at `effort`, or the model alone for no effort. Pure. */
function armOf(model, effort = null) {
  const m = String(model ?? '').trim();
  return effort && EFFORTS.includes(effort) ? `${m}@${effort}` : m;
}

/** The OpenRouter model id an arm runs. Pure. */
function modelOf(arm) {
  return parseArm(arm).model;
}

/** Whether an arm is an OpenRouter model id, at an effort or not. Pure. */
function validArm(arm) {
  return MODEL_ID_RE.test(parseArm(arm).model);
}

module.exports = {
  EFFORTS,
  parseArm,
  armOf,
  modelOf,
  validArm,
};
