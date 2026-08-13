"use strict";

// Normalized, backend-neutral event schema for coding-agent progress
// (plan.md §4-PR1, §10). worker.js currently pushes a Claude-specific
// vocabulary into the progress log (Reading/Writing/Editing/$/Using/…).
// Later backends (codex_openrouter) will emit different raw events; this
// module maps them onto a single schema the UI already understands, so
// progress rendering and /status stay backend-neutral.
//
// The progress "events" below are the same strings the existing
// dev-chat progress card and cc-progress-summary.js already understand.
// We define the vocabulary centrally here so PR5's Codex JSONL adapter
// and this module share the same constants instead of each inventing its
// own labels.

// Action-line prefixes (the "steps" cc-progress-summary counts).
const ACTION_PREFIXES = ["Reading ", "Writing ", "Editing ", "$ ", "Using "];

function isActionLabel(text) {
  return ACTION_PREFIXES.some((p) => String(text || "").startsWith(p));
}

// A normalized progress event emitted to onProgress. `kind` mirrors the
// current stream-json event categories; `text` is the rendered line.
const EVENT_KINDS = {
  PHASE: "phase", // "[<phase>]"
  THREAD_STARTED: "thread_started",
  TURN_STARTED: "turn_started",
  AGENT_TEXT: "agent_text", // "... <first line>"
  TOOL_USE: "tool_use", // Reading/Writing/Editing/$/Using
  TOOL_RESULT: "tool_result", // "  ⎿ <summary>"
  FILE_CHANGED: "file_changed",
  COMMAND_STARTED: "command_started",
  COMMAND_COMPLETED: "command_completed",
  ANALYSIS: "analysis",
  MESSAGE: "message",
  USAGE: "usage",
  ERROR: "error",
  WARN: "warn",
};

function normalizeLineText(kind, payload) {
  switch (kind) {
    case EVENT_KINDS.PHASE:
      return `[${payload}]`;
    case EVENT_KINDS.AGENT_TEXT:
      return `… ${payload}`;
    case EVENT_KINDS.TOOL_RESULT:
      return `  ⎿ ${payload}`;
    default:
      return String(payload == null ? "" : payload);
  }
}

module.exports = {
  ACTION_PREFIXES,
  isActionLabel,
  EVENT_KINDS,
  normalizeLineText,
};
