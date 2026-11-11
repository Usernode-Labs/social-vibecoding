'use strict';

// A standing's words, as the server sends them (11 Nov 2026, one model).
//
// The server words every standing once (src/services/work-state.js
// phrasesOf) and ships the phrase ids as `words`: the stage as its requester
// reads it, as anyone else does, and its second line. The client only draws
// them (frontend/src/lib/work-state.ts stageWords, lineWords). A test that
// hands a screen a work state by its stage, why, reason and line uses
// `withWords` to give it the words the server would have sent with it, so a
// fixture is the contract's shape. tests/standing-client.test.js holds this
// table to the server's own phrasesOf.

const camel = (s) => String(s).replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

// A request nobody has started on yet, and one ready to build that waits
// its turn, are said so: the same stages, in plainer words.
const NOT_STARTED = new Set(['queued', 'waiting', 'on_hold', 'cooldown', 'first_version_wait']);
const READY = new Set(['queued', 'held_builds', 'held_waiting']);
// The second lines that need no value.
const PLAIN_LINES = new Set([
  'queued', 'first_version_wait', 'held_builds', 'held_waiting', 'on_hold', 'cooldown', 'reply', 'retry_plan',
  'starting', 'proposing', 'fixing', 'revising', 'update_queued', 'checks_failing', 'sync_wait', 'conflict_on_yes',
  'github_checks', 'github_checks_failing', 'github_wait', 'first_version', 'planning_with_you', 'waiting',
  'approved_checking',
]);

function stagePhrase(item, yours) {
  if (item.stage === 'waiting_for_you' && item.why) return { id: `core:work.${yours ? 'why' : 'whyOthers'}.${camel(item.why)}` };
  if (item.stage === 'stopped' && item.reason) return { id: `core:work.reason.${camel(item.reason)}` };
  const code = item.line && item.line.code;
  if (item.stage === 'checking' && code === 'syncing') return { id: 'core:work.stage.syncing' };
  // #6594: its votes are in: Approved while its checks (or GitHub's) finish.
  if (item.stage === 'checking' && code === 'approved_checking') return { id: 'core:work.stage.approved' };
  if (item.stage === 'going_live' && code === 'github_checks') return { id: 'core:work.stage.approved' };
  if (item.stage === 'going_live' && code === 'github_wait') return { id: 'core:work.stage.waitingToMerge' };
  if (item.stage === 'reading' && NOT_STARTED.has(code)) return { id: 'core:work.stage.notStarted' };
  if (item.stage === 'building' && READY.has(code)) return { id: 'core:work.stage.readyToBuild' };
  return { id: `core:work.stage.${camel(item.stage)}` };
}

function linePhrase(item) {
  const line = item.line;
  if (!line || !line.code) return null;
  switch (line.code) {
    case 'queued':
      return line.place ? { id: 'core:work.line.queuedAt', values: { place: line.place } } : { id: 'core:work.line.queued' };
    case 'reviewing':
      return { id: 'core:work.line.reviewing', values: { round: line.round || 1, of: line.of || 1 } };
    case 'checks_failing':
      return line.failing
        ? { id: 'core:work.line.checksFailingCount', values: { count: line.failing } }
        : { id: 'core:work.line.checksFailing' };
    case 'checks_running':
      return line.minutes ? { id: 'core:work.line.checksRunning', values: { count: line.minutes } } : null;
    case 'earlier_yes':
      return line.count ? { id: 'core:work.line.earlierYes', values: { count: line.count } } : null;
    case 'claimed':
      return line.by ? { id: 'core:work.line.claimed', values: { username: line.by } } : null;
    case 'reason':
      return line.text ? { id: 'core:work.line.said', values: { reason: line.text } } : null;
    default:
      return PLAIN_LINES.has(line.code) ? { id: `core:work.line.${camel(line.code)}` } : null;
  }
}

/** The words the server sends with a work state. */
function wordsOf(item) {
  return { stage: stagePhrase(item, true), stageOthers: stagePhrase(item, false), line: linePhrase(item) };
}

/** A work state with the words the server sends with it (a fixture in the contract's shape). */
function withWords(item) {
  return item && item.stage ? { ...item, words: wordsOf(item) } : item;
}

module.exports = { wordsOf, withWords };
