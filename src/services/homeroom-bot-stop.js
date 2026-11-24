'use strict';

// Stop, in a person's chat with Homeroom bot (task 2148). A tester sent the
// wrong prompt and could only wait: an answer is up to sixteen rounds of
// model request and tool calls, and nothing could end it.
//
// The person's Stop is an event on their DM machine (src/workflow/bot-dm/
// machine.ts StopRequested), which marks the answer under way as stopped
// and leaves its work item running: the work is what ends the turn, at its
// next safe point, and says so. Nothing is cancelled from outside, so the
// turn is never still running after the chat says "Stopped.", and the next
// message waits for it as it always did.
//
// How the turn hears of it: the answer's work (bot-dm/services.ts) watches
// for the mark while it runs (`watch`), reading it as the try begins and
// every STOP_POLL_MS after, wherever the Stop was taken: the web process
// that takes it is seldom the one that runs the answer, and the mark is the
// one thing both read. Nothing is kept between calls (no list of running
// answers in this process), so a restart loses nothing. Finding the mark
// aborts the watch's signal, which is the turn's own: never the work
// item's lease signal, which also aborts when the process is stopping for
// a release, and a release is not a person's Stop.
//
// Where the turn looks at the signal (homeroom-bot-turn-engine.js runRound):
// before each model request and before each tool call, and a model request
// in flight is cut off (homeroom-bot-mayor.js askModel). A tool call that
// has started always finishes: what it does is never left half done.
//
// What a stopped turn says is one line, written here from what its tool
// calls had already done that stays done (LASTING). It is the bot's own
// stored message, so it is server text, and it is sent as it is written:
// never through the reply checks, which would cut it.

const STOP_POLL_MS = 1000;
const STOPPED = 'stopped';

/** The error a stopped turn ends with: never a failure, never retried. */
function stopError() {
  return Object.assign(new Error('Stopped by the person'), { code: STOPPED, stopped: true });
}

function isStop(err) {
  return !!err && err.stopped === true && err.code === STOPPED;
}

/** Throws when `signal` says the person stopped the turn. A safe point. */
function check(signal) {
  if (signal?.aborted) throw stopError();
}

// ── Hearing a Stop ───────────────────────────────────────────────────────

/**
 * Watch for a Stop of one answer while it runs. `asked()` resolves whether
 * the person's DM machine holds the mark for it (read at once, then every
 * `everyMs`). Resolves { signal, did, note, add, end }: `signal` aborts
 * when it is stopped; `did` is what the answer has done that stays done
 * (`kept`: an earlier attempt's, from the work's checkpoint), added to with
 * `note` (a tool call) and `add`, which `onNote` keeps; `end()` stops
 * watching. Everything it holds is this call's own, and ends with it.
 */
async function watch({ asked, kept = [], onNote = null, everyMs = STOP_POLL_MS }) {
  const controller = new AbortController();
  const did = Array.isArray(kept) ? kept.filter((thing) => thing && typeof thing === 'object') : [];
  const abort = () => { if (!controller.signal.aborted) controller.abort(stopError()); };
  const look = async () => {
    if (controller.signal.aborted) return;
    try {
      if (await asked()) abort();
    } catch {
      // A read that failed is asked again at the next one.
    }
  };
  // What it did is kept as it is done (the work's checkpoint), best effort.
  const keep = () => (typeof onNote === 'function' ? Promise.resolve().then(() => onNote(did)).catch(() => {}) : Promise.resolve());
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    look().finally(() => { busy = false; });
  }, Math.max(20, Number(everyMs) || STOP_POLL_MS));
  timer.unref?.();
  await look();
  return {
    signal: controller.signal,
    did,
    note: (tool, args, result) => {
      const before = did.length;
      noteDone(did, tool, args, result);
      return did.length !== before ? keep() : Promise.resolve();
    },
    // Something done outside a tool call (a thread opened for a screen).
    add: (thing) => {
      if (!thing || typeof thing.did !== 'string' || did.some((d) => d.did === thing.did)) return Promise.resolve();
      did.push({ did: thing.did, stays: String(thing.stays || 'it stays done') });
      return keep();
    },
    end: () => { clearInterval(timer); },
  };
}

// ── What it had already done ─────────────────────────────────────────────

const requestNumber = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const name = (value, max = 60) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// The tools whose effect is there once they return, each with what it did
// in plain words (after "I had already") and how it stays (after ";"), from
// its own arguments and result. Null: this call did nothing that lasts (it
// was refused, or it only repeated what stood).
const LASTING = Object.freeze({
  start_request: (args, result) => {
    if (!result?.ok || result.already) return null;
    const n = requestNumber(args?.number);
    return { did: n ? `started work on request #${n}` : 'started work on a request', stays: 'it carries on' };
  },
  revise_proposal: (_args, result) => (result?.ok && result.posted
    ? { did: 'posted your change on the proposal\'s discussion', stays: 'it stays posted' } : null),
  withdraw_proposal: (_args, result) => {
    if (!result?.ok || !result.withdrawn) return null;
    const project = name(result.withdrawn.projectName);
    return { did: project ? `withdrawn the ${project} proposal` : 'withdrawn a proposal', stays: 'it stays withdrawn' };
  },
  report_problem: (_args, result) => {
    if (!result?.ok || result.repeat) return null;
    const n = requestNumber(result.number);
    return n
      ? { did: `filed your report as request #${n}`, stays: 'it stays filed' }
      : { did: 'sent your report to the Homeroom team', stays: 'it stays sent' };
  },
  close_thread: (_args, result) => (result?.ok ? { did: 'marked this thread done', stays: 'it stays done' } : null),
  add_to_build: (args, result) => {
    if (!result?.ok) return null;
    const n = requestNumber(args?.number);
    return { did: n ? `passed your note on to the build of request #${n}` : 'passed your note on to a build', stays: 'it stays with the build' };
  },
  tell_me_when: (_args, result) => (result?.ok
    ? { did: 'noted to tell you when that is ready', stays: 'I still will' } : null),
  work_through: (_args, result) => (result?.ok && result.readingNow
    ? { did: 'queued those requests to be read again', stays: 'they stay queued' } : null),
  // A helper still reading the code when the turn stopped: it is another
  // turn, of its own, and ends by itself.
  look_into: (_args, result) => {
    if (!result?.ok || !result.running) return null;
    const project = name(result.project);
    return { did: project ? `sent a helper to look into ${project}` : 'sent a helper to look into the code', stays: 'it finishes on its own' };
  },
  // A live draft of the project (services/live-drafts.js): it stays open
  // in the thread until they Propose or Close it.
  open_app_preview: (_args, result) => (result?.ok
    ? { did: 'opened a live preview of the project', stays: 'it stays open in this thread' } : null),
  // Made and counted, and its gallery goes under a reply that is not sent.
  make_pictures: (_args, result) => (result?.ok
    ? { did: 'made the pictures you asked for', stays: 'they are not shown here' } : null),
  // Step 6 (#6864): a live draft's change, saved to the draft (and its
  // preview) by the chat's own turn. Its changes not yet saved are not.
  apply_changes: (_args, result) => (result?.saved
    ? { did: 'saved a change to the live draft', stays: 'it stays in the draft' } : null),
  // A request's plan put back in the queue to be planned again (change_plan).
  change_plan: (_args, result) => (result?.ok && !result.drafted
    ? { did: 'asked for a new plan', stays: 'it is planned again' } : null),
  // T1.11: a reply with a live draft open saves the draft's changes not yet
  // saved before it is taken (live-draft-bot.js beforeReply: `applied`), so
  // a Stop right after it has saved a change.
  reply: (_args, result) => (result?.applied?.saved
    ? { did: 'saved a change to the live draft', stays: 'it stays in the draft' } : null),
  // #6994: their attached website archive put in place of the project's
  // pages, as a change up for the project's vote (services/archive-change.js).
  use_archive: (_args, result) => {
    if (!result?.ok) return null;
    const n = requestNumber(result.number);
    return {
      did: n ? `put the archive's files in place of the project's pages as change #${n}` : 'put the archive\'s files in place of the project\'s pages',
      stays: 'it is up for the vote',
    };
  },
});

// The tools that change nothing that lasts when they run: a read, or
// something drawn only with the reply (an offer, a card, a screen), which a
// stopped turn never sends. Step 6 (#6864): a design's version is saved only
// with the turn's reply, so a stopped turn saves none; a live draft's edits
// are saved only by apply_changes. A thread start_design opens for the screen
// is said by the design (design-bot.js roomFor, `add`). Artifacts: a page's
// version is saved with the reply too (artifact-session.js), so its tools
// leave nothing either. 20 Nov 2026 (live-draft review, A): a look at a
// draft's preview (look_at_preview) only reads it.
const NOTHING = new Set([
  'progress', 'my_work', 'request_detail', 'my_projects', 'answer_question', 'comment_on_request', 'offer_request',
  'offer_move_request', 'offer_copy_request', 'offer_close_request', 'start_design', 'offer_new_project',
  'offer_options', 'ask_questions', 'show_table', 'show_change', 'start_investigation', 'stop_and_redo',
  'write_screen', 'edit_design', 'compare_versions', 'offer_plan', 'offer_project', 'capture_page',
  'search_code', 'edit_file', 'write_file', 'look_at_preview',
  'write_artifact', 'edit_artifact', 'show_artifact', 'compare_artifacts',
  // 20 Nov 2026 (live-draft review, C): a card under the reply; its tap acts.
  'offer_propose_draft',
  // 24 Nov 2026: where a draft's preview stands, and what the draft changed,
  // only read.
  'preview_status', 'draft_changes',
]);
// A read, by its name (the platform's and the admin's among them).
const READ = /^(?:list|get|read)_[a-z_]+$/;

/** Whether tool `tool` is one whose effect this module knows: it lasts (LASTING), or it leaves nothing (NOTHING, a read). */
function knows(tool) {
  return Object.prototype.hasOwnProperty.call(LASTING, tool) || NOTHING.has(tool) || READ.test(String(tool));
}

/**
 * One tool call that has returned, noted on `did` (a turn's list) when it
 * left something that stays: { did, stays }, said once however often it was
 * called, or { unsure: true } for a tool this module does not know, whose
 * effect cannot be named and cannot be ruled out. Never throws.
 */
function noteDone(did, tool, args, result) {
  if (!Array.isArray(did)) return did;
  try {
    const key = String(tool);
    if (Object.prototype.hasOwnProperty.call(LASTING, key)) {
      const thing = LASTING[key](args || {}, result);
      if (thing && !did.some((d) => d.did === thing.did)) did.push(thing);
    } else if (!NOTHING.has(key) && !READ.test(key) && !did.some((d) => d.unsure)) {
      did.push({ unsure: true });
    }
  } catch {
    if (!did.some((d) => d.unsure)) did.push({ unsure: true });
  }
  return did;
}

/**
 * T1.11: what a turn had done that stays, as sentences ("I've started work
 * on request #12."), from the Stop watch's list (`did`), for an answer that
 * could not be written (homeroom-bot-mayor.js fallbackAnswer). `skip` leaves
 * out what the caller says in its own words. Pure.
 */
function doneSentences(did, { skip = null } = {}) {
  if (!Array.isArray(did)) return [];
  return did
    .filter((d) => d && typeof d.did === 'string' && d.did && !(skip && skip.test(d.did)))
    .map((d) => `I've ${d.did}.`);
}

const NOTHING_TEXT = 'Stopped. Nothing was filed or changed.';
// No record of what the turn did (an earlier try's, a tool not known here).
const UNSURE_TEXT = 'Stopped. Anything I had already done stays done.';

/**
 * The one line a stopped turn says, from what it had already done (`did`,
 * noteDone's list; null when there is no record): at most two things named,
 * "and more" beyond that.
 */
function stoppedText(did) {
  if (!Array.isArray(did)) return UNSURE_TEXT;
  const named = did.filter((d) => d && typeof d.did === 'string' && d.did);
  const more = did.some((d) => d && d.unsure) || named.length > 2;
  if (!named.length) return more ? UNSURE_TEXT : NOTHING_TEXT;
  if (named.length === 1 && !more) return `Stopped. I had already ${named[0].did}; ${named[0].stays || 'it stays done'}.`;
  if (named.length === 2 && !more) return `Stopped. I had already ${named[0].did} and ${named[1].did}; both stay as they are.`;
  const shown = named.slice(0, 2).map((d) => d.did);
  return `Stopped. I had already ${shown.join(', ')} and more; all of it stays as it is.`;
}

module.exports = {
  STOP_POLL_MS,
  STOPPED,
  NOTHING_TEXT,
  UNSURE_TEXT,
  LASTING,
  NOTHING,
  stopError,
  isStop,
  check,
  watch,
  knows,
  noteDone,
  stoppedText,
  doneSentences,
};
