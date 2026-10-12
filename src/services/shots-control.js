'use strict';

// A before/after run gets one purpose-bound JWT and this in-memory,
// run-scoped control plane. The shots agent can read its brief, save shots
// and clips, note what a change's shots leave out, skip a change with a
// reason, note a few problems it saw on the after build, and record what it
// did to both builds to reach a change (a request held or failed, a sample
// file uploaded). It cannot address another run, obtain app auth material,
// or invoke generic platform APIs. A platform restart drops the registry;
// recovery retries the durable run rather than trusting an orphan model
// process.

const planContract = require('./visible-changes');
const shots = require('./shots-files');
const homeTile = require('./shots-home-tile');

const controls = new Map();

class ShotsControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'ShotsControlError';
    this.code = code;
    this.status = status;
  }
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// The run's phone sign-in code (the brief's phoneSignIn.code, on Homeroom's
// own copies), masked wherever the agent wrote it: six digits on their own,
// or with a space or a dash between them ("482 913"). Below the length the
// log redaction masks literals at, so it gets its own pattern.
function maskPhoneTestCode(text, code) {
  if (typeof text !== 'string' || !/^[0-9]{6}$/.test(String(code || ''))) return text;
  const digits = new RegExp(`(?<![0-9])${[...String(code)].join('[ -]?')}(?![0-9])`, 'g');
  return text.replace(digits, '****');
}

class RunControl {
  constructor({ runId, sessionId, intent, context, expiresAt, homeTiles = null, afterOnly = false }) {
    this.runId = runId;
    this.sessionId = Number(sessionId);
    this.intent = planContract.parseIntent(intent);
    this.context = cloneJson(context);
    // A project's first version: the before address is still the starter
    // template's placeholder (shots-starter.js), so this run takes and
    // publishes the after side only, and a before shot is refused.
    this.afterOnly = afterOnly === true;
    // The brief hands the agent this code; what the agent writes for people
    // (a skip reason, a note) is shown on the proposal, so it never keeps it.
    this.phoneTestCode = this.context?.phoneSignIn?.code || null;
    // Each side's tile on Homeroom's home screen, served on that side's
    // address (services/shots-home-tile.js). Kept out of the brief, which
    // only describes them: an icon image is up to 256 KB.
    this.homeTiles = homeTiles ? cloneJson(homeTiles) : null;
    this.expiresAt = Number(expiresAt || Date.now() + 8 * 60_000);
    this.saved = new Map();
    this.skipped = new Map();
    // The skipped changes the agent said the after build broke on: it did
    // the steps and the app errored. Shown and handled as the change not
    // working, not as a state these copies could not reach.
    this.failed = new Set();
    // What a change's shots leave out, shown beside them once it is ready.
    this.notes = new Map();
    // Problems the agent noticed on the after build besides the declared
    // changes, in the order it noted them (at most shots.MAX_NOTICES).
    // Advisory: nothing here changes a change's status or the run's.
    this.notices = [];
    // What the agent did to both builds to reach each change's state (an API
    // GET held or failed, a sample file uploaded), recorded before it does
    // it and shown beside that change's shots.
    this.conditions = new Map();
    // Set when the agent says nothing at all can be shot (for example every
    // screen shows a sign-in page); it explains every change that is not
    // ready and has no reason of its own.
    this.skippedAll = null;
    this.skippedAllFailed = false;
    // The last refused tool call survives a normal model exit, for the
    // owner's diagnostics.
    this.lastToolFailure = null;
  }

  assertLive() {
    if (Date.now() > this.expiresAt) {
      throw new ShotsControlError('shots_control_expired', 'This preview run has expired.', 410);
    }
  }

  assertOpen() {
    this.assertLive();
    if (this.skippedAll) throw new ShotsControlError('shots_turn_finished', 'This preview run was already skipped.');
  }

  getContext() {
    this.assertLive();
    return cloneJson({ ...this.context, progress: this.progress() });
  }

  // The page the proxy serves at the home tile path on one side's address.
  homeTilePage(side) {
    this.assertLive();
    const tile = homeTile.SIDES.includes(side) ? this.homeTiles?.[side] : null;
    if (!tile) throw new ShotsControlError('home_tile_unavailable', 'This run has no home tile for that side.', 404);
    return homeTile.renderPage(tile, { side });
  }

  // One file the agent saved: a screen or element shot, or a clip. Saving the
  // same slot again replaces it, so the agent can retake a poor shot, and
  // saving for a change it skipped takes that skip back.
  saveShot(rawTarget, buffer) {
    try {
      this.assertOpen();
      const target = shots.shotTarget(this.intent, rawTarget);
      if (this.afterOnly && target.side === 'base') {
        throw new ShotsControlError('before_not_needed',
          'This app is new: the before address shows only the starter template\'s placeholder, so this run '
          + 'takes after shots only. Save the after side of each change and leave the before address alone.', 400);
      }
      const info = target.media === 'webm' ? shots.inspectClip(buffer) : shots.inspectImage(buffer);
      shots.checkElementSize(
        this.declaredChange(target.storyId), target, info,
        this.saved.get(shots.slotKey({ ...target, variant: 'context' })),
      );
      this.saved.set(shots.slotKey(target), shots.stored(target, buffer, info));
      this.skipped.delete(target.storyId);
      this.failed.delete(target.storyId);
      // The same image on the other side says the two sides were not shot
      // in the states the claim compares. Said while the agent can still
      // retake them, not only on the card afterwards.
      const otherSide = target.media === 'png'
        ? this.saved.get(shots.slotKey({ ...target, side: target.side === 'base' ? 'head' : 'base' }))
        : null;
      const sameAsOtherSide = !!otherSide && otherSide.sha256 === info.sha256;
      return {
        saved: true,
        change: target.storyId,
        screen: target.viewport,
        side: target.side === 'base' ? 'before' : 'after',
        kind: target.variant === 'animation' ? 'clip' : target.variant === 'focus' ? 'element' : 'screen',
        bytes: info.bytes,
        ...(info.width ? { width: info.width, height: info.height } : {}),
        ...(sameAsOtherSide ? {
          sameAsOtherSide: true,
          warning: 'This before and after are the same image, so they cannot show the change. Check that each '
            + 'side followed the steps to the state the claim describes, at the same scroll position, and shoot '
            + 'again. If these copies cannot show the change, call note_change to say what the shots leave out, '
            + 'or skip_change.',
        } : {}),
        progress: this.progress(),
      };
    } catch (error) {
      this.lastToolFailure = { operation: 'save-shot', error };
      throw error;
    }
  }

  // The agent could not reach a change, or found that the shots it saved do
  // not show it. Its reason is shown on the proposal for that change, and
  // nothing saved for it is published; the other changes still are. Without
  // a change id the reason covers every change that is not ready and has
  // none of its own. `outcome: 'failed'` says the agent did the steps and
  // the after build broke, so the change is failed rather than skipped.
  skipChange({ change = null, reason, outcome = null } = {}) {
    try {
      this.assertOpen();
      const text = maskPhoneTestCode(shots.reason(reason), this.phoneTestCode);
      const broke = shots.outcome(outcome) === 'failed';
      const said = broke ? { outcome: 'failed' } : {};
      if (change == null || change === '') {
        this.skippedAll = text;
        this.skippedAllFailed = broke;
        return { skipped: 'all', ...said, progress: this.progress() };
      }
      const story = this.declaredChange(change);
      this.skipped.set(story.id, text);
      if (broke) this.failed.add(story.id);
      else this.failed.delete(story.id);
      return { skipped: story.id, ...said, progress: this.progress() };
    } catch (error) {
      this.lastToolFailure = { operation: 'skip-change', error };
      throw error;
    }
  }

  // What a change's shots leave out (part of the claim these copies cannot
  // show). Shown beside the shots once the change is ready; a later note
  // replaces it.
  noteChange({ change = null, note } = {}) {
    try {
      this.assertOpen();
      const story = this.declaredChange(change);
      this.notes.set(story.id, maskPhoneTestCode(shots.note(note), this.phoneTestCode));
      return { noted: story.id, progress: this.progress() };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-change', error };
      throw error;
    }
  }

  // A clear problem the agent saw on the after build while it took the
  // shots, such as content cut off or controls overlapping. Shown on the
  // proposal under "Also noticed". Noting the same problem at the same place
  // again updates it rather than adding another; past the cap it is refused,
  // so the agent keeps only what matters most.
  noteProblem(raw = {}) {
    try {
      this.assertOpen();
      const entry = shots.notice(this.intent, raw);
      const same = this.notices.findIndex((existing) => existing.change === entry.change
        && existing.screen === entry.screen && existing.text.toLowerCase() === entry.text.toLowerCase());
      if (same >= 0) this.notices[same] = entry;
      else if (this.notices.length >= shots.MAX_NOTICES) {
        throw new ShotsControlError('too_many_notices',
          `This run already has ${shots.MAX_NOTICES} problems noted, the most it keeps. Note only what a person would agree is broken.`);
      } else this.notices.push(entry);
      return {
        noticed: entry.change,
        screen: entry.screen,
        alsoBefore: entry.alsoBefore,
        notices: this.notices.length,
        remaining: shots.MAX_NOTICES - this.notices.length,
        // "unknown" says nothing to a person reading it, and the agent
        // shoots the before side of every screen it shoots the after side
        // of, so it is asked to look and say.
        ...(entry.alsoBefore === 'unknown' ? { hint: this.alsoBeforeHint(entry) } : {}),
      };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-problem', error };
      throw error;
    }
  }

  // What a notice without alsoBefore asks of the agent: to look at the
  // before shot of that screen, now or once it has taken it.
  alsoBeforeHint({ change, screen }) {
    const lead = this.saved.has(shots.slotKey({ storyId: change, viewport: screen, side: 'base', variant: 'context' }))
      ? 'You saved the before shot of this screen: look at it'
      : 'Once you have shot the before side of this screen, look at it';
    return `${lead} and note this problem again with alsoBefore true or false, so people can tell whether this `
      + 'change brought it. Noting the same problem at the same place updates it.';
  }

  // The shots bridge records what it is about to do to both builds for a
  // change (control_request, upload_file) before it does it; the same thing
  // again is recorded once.
  noteCondition(raw = {}) {
    try {
      this.assertOpen();
      const { change, ...entry } = shots.condition(this.intent, raw);
      const list = this.conditions.get(change) || [];
      if (!list.some((existing) => shots.sameCondition(existing, entry))) {
        if (list.length >= shots.MAX_CONDITIONS) {
          throw new ShotsControlError('too_many_conditions',
            `${change} already has ${shots.MAX_CONDITIONS} controlled tests and sample files, the most a change shows.`);
        }
        list.push(entry);
        this.conditions.set(change, list);
      }
      return { recorded: change, conditions: list.length };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-condition', error };
      throw error;
    }
  }

  declaredChange(change) {
    const story = this.intent.stories.find((candidate) => candidate.id === String(change ?? ''));
    if (!story) {
      throw new ShotsControlError('unknown_change', `Change ${JSON.stringify(String(change ?? ''))} is not one the author declared.`, 400);
    }
    return story;
  }

  summary() {
    return shots.summarize(this.intent, this.saved, this.skipped, {
      fallbackReason: this.skippedAll, notes: this.notes,
      failed: this.failed, fallbackFailed: this.skippedAllFailed, notices: this.notices,
      conditions: this.conditions, afterOnly: this.afterOnly,
    });
  }

  progress() {
    return this.summary().stories.map((story) => ({
      change: story.id,
      status: story.status === 'ready' || story.status === 'failed' ? story.status
        : this.skipped.has(story.id) || this.skippedAll ? 'skipped' : 'missing',
      ...(story.status === 'ready' ? (story.note ? { note: story.note } : {}) : { detail: story.reason }),
    }));
  }
}

function registerRun(options) {
  if (!/^[0-9a-f]{32}$/.test(String(options?.runId || ''))) {
    throw new ShotsControlError('invalid_shots_run', 'A valid preview run id is required.', 400);
  }
  if (controls.has(options.runId)) throw new ShotsControlError('shots_control_exists', 'This preview run is already registered.');
  const control = new RunControl(options);
  controls.set(options.runId, control);
  return {
    control,
    unregister() {
      if (controls.get(options.runId) === control) controls.delete(options.runId);
    },
  };
}

function forRequest({ runId, sessionId }) {
  const control = controls.get(String(runId || ''));
  if (!control) throw new ShotsControlError('shots_control_not_found', 'This preview run is no longer active.', 410);
  if (control.sessionId !== Number(sessionId)) {
    throw new ShotsControlError('shots_scope_mismatch', 'This token does not own this preview run.', 403);
  }
  control.assertLive();
  return control;
}

function clearForTests() {
  controls.clear();
}

module.exports = {
  ShotsControlError,
  RunControl,
  maskPhoneTestCode,
  registerRun,
  forRequest,
  _clearForTests: clearForTests,
};
