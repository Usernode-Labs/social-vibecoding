'use strict';

// A before/after run gets one purpose-bound JWT and this in-memory,
// run-scoped control plane. The shots agent can read its brief, save shots
// and clips, note what a change's shots leave out, and skip a change with a
// reason. It cannot address another run, obtain app auth material, or invoke
// generic platform APIs. A platform restart drops the registry; recovery
// retries the durable run rather than trusting an orphan model process.

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

class RunControl {
  constructor({ runId, sessionId, intent, context, expiresAt, homeTiles = null }) {
    this.runId = runId;
    this.sessionId = Number(sessionId);
    this.intent = planContract.parseIntent(intent);
    this.context = cloneJson(context);
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
  prepareShot(rawTarget, buffer) {
    this.assertOpen();
    const target = shots.shotTarget(this.intent, rawTarget);
    const info = target.media === 'webm' ? shots.inspectClip(buffer) : shots.inspectImage(buffer);
    shots.checkElementSize(this.declaredChange(target.storyId), target, info,
      this.saved.get(shots.slotKey({ ...target, variant: 'context' })));
    return { target, info, file: shots.stored(target, buffer, info) };
  }

  storeShots(prepared) {
    // Validation above is complete for every member before any replacement.
    // This synchronous mutation cannot expose a partial pair to publication.
    for (const { target, file } of prepared) {
      this.saved.set(shots.slotKey(target), file);
      this.skipped.delete(target.storyId);
      this.failed.delete(target.storyId);
    }
    return prepared.map((entry) => {
      const { target, info } = entry;
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
    });
  }

  saveShot(rawTarget, buffer) {
    try { return this.storeShots([this.prepareShot(rawTarget, buffer)])[0]; }
    catch (error) { this.lastToolFailure = { operation: 'save-shot', error }; throw error; }
  }

  savePhotoPair(rawTarget, buffer) {
    try {
      if (!Buffer.isBuffer(buffer) || buffer.length < 4) throw new shots.ShotError('invalid_shot_pair', 'A photo pair must contain both complete PNG images.');
      const lightBytes = buffer.readUInt32BE(0);
      if (!lightBytes || lightBytes >= buffer.length - 4) throw new shots.ShotError('invalid_shot_pair', 'A photo pair must contain both complete PNG images.');
      const prepared = ['light', 'dark'].map((colorScheme, index) => this.prepareShot(
        { ...rawTarget, colorScheme }, index ? buffer.subarray(4 + lightBytes) : buffer.subarray(4, 4 + lightBytes)));
      if (prepared.some(({ target }) => target.media !== 'png')) throw new shots.ShotError('invalid_shot_pair', 'Only PNG photos can be paired.');
      return this.storeShots(prepared);
    } catch (error) { this.lastToolFailure = { operation: 'save-shot', error }; throw error; }
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
      const text = shots.reason(reason);
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
      this.notes.set(story.id, shots.note(note));
      return { noted: story.id, progress: this.progress() };
    } catch (error) {
      this.lastToolFailure = { operation: 'note-change', error };
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
      failed: this.failed, fallbackFailed: this.skippedAllFailed,
      photoModes: this.context?.photoModes || ['light'],
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
  registerRun,
  forRequest,
  _clearForTests: clearForTests,
};
