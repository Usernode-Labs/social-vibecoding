'use strict';

// Before/after shots. The author declares up to three changes; the shots
// agent walks each one on the exact before (base) and after (head) builds
// and saves what it sees: a screen shot per screen size and side, plus a
// short clip per side when the change is motion a still cannot show.
//
// This module is pure. It checks one saved file against the declared
// changes and folds everything saved into one result per change, so a change
// the agent could not reach never hides the ones it did.
//
// A change that is not ready is one of two things, and people act on them
// differently. SKIPPED: these copies could not reach the state (missing
// data, access, an interaction the agent could not perform); better steps or
// hints fix that. FAILED: the agent carried out the steps on the after build
// and the app itself broke (a server error answered the action, an error
// showed, or the claimed effect never appeared because the app errored).
// That is the change not working, and it is shown and handled as a problem
// (shots-state.brokenOnHead, homeroom-bot-followup.checksDue). The agent
// says which, as skip_change's `outcome`.

const crypto = require('crypto');
const planContract = require('./visible-changes');

const SHOTS_MODE = 'shots';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CLIP_BYTES = 20 * 1024 * 1024;
const MIN_CLIP_BYTES = 1024;
const MAX_IMAGE_EDGE = 8192;
const MAX_REASON = 1000;
const MAX_NOTE = 500;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
// Friendly words for the agent and people; base/head stay the stored names.
const SIDES = Object.freeze({ before: 'base', after: 'head', base: 'base', head: 'head' });
const KINDS = Object.freeze({
  screen: { variant: 'context', media: 'png' },
  element: { variant: 'focus', media: 'png' },
  clip: { variant: 'animation', media: 'webm' },
});

class ShotError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ShotError';
    this.code = code;
    this.status = status;
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Structural checks only: the platform image ships no codecs, and the header
// plus terminator is enough to refuse anything that is not one whole PNG.
function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 25 + PNG_IEND.length) {
    throw new ShotError('invalid_shot_image', 'A shot must be a complete PNG image.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ShotError('shot_too_large',
      `A shot may be at most ${MAX_IMAGE_BYTES} bytes; save the visible screen or one element, not the full page.`, 413);
  }
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)
      || buffer.readUInt32BE(8) !== 13
      || buffer.toString('latin1', 12, 16) !== 'IHDR'
      || !buffer.subarray(buffer.length - PNG_IEND.length).equals(PNG_IEND)) {
    throw new ShotError('invalid_shot_image', 'A shot must be a complete PNG image.');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw new ShotError('invalid_shot_image', 'The shot has unsupported dimensions.');
  }
  return { width, height, bytes: buffer.length, sha256: sha256(buffer) };
}

// The browser writes WebM itself. Check it is one (EBML header) and a sane
// size; dimensions are not in a fixed position, so none are recorded.
function inspectClip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_CLIP_BYTES
      || !buffer.subarray(0, 4).equals(EBML_MAGIC)) {
    throw new ShotError('invalid_clip', 'A clip must be the WebM file the browser recorded.');
  }
  if (buffer.length > MAX_CLIP_BYTES) {
    throw new ShotError('clip_too_large',
      `A clip may be at most ${MAX_CLIP_BYTES} bytes; record only the moment of the change.`, 413);
  }
  return { width: null, height: null, bytes: buffer.length, sha256: sha256(buffer) };
}

function changeFor(intent, changeId) {
  const story = intent.stories.find((candidate) => candidate.id === String(changeId || ''));
  if (!story) {
    throw new ShotError('unknown_change', `Change ${JSON.stringify(String(changeId || ''))} is not one the author declared.`);
  }
  return story;
}

function slotKey({ storyId, viewport, side, variant }) {
  return `${storyId}\u0000${viewport}\u0000${side}\u0000${variant}`;
}

// Where a saved file belongs: a declared change, one of its screen sizes, a
// side, and whether it is the screen, one element, or a clip.
function shotTarget(intent, raw = {}) {
  const story = changeFor(intent, raw.change);
  const viewport = String(raw.screen || '');
  if (!story.viewports.some((candidate) => candidate.name === viewport)) {
    throw new ShotError('unknown_screen',
      `Screen ${JSON.stringify(viewport)} is not declared for ${story.id}; use ${story.viewports.map((v) => v.name).join(' or ')}.`);
  }
  const side = SIDES[String(raw.side || '')];
  if (!side) throw new ShotError('invalid_side', 'Side must be before or after.');
  const kind = KINDS[String(raw.kind || 'screen')];
  if (!kind) throw new ShotError('invalid_kind', 'Kind must be screen, element, or clip.');
  if (kind.variant === 'animation' && !planContract.needsClip(story)) {
    throw new ShotError('clip_not_needed', `${story.id} is not declared as motion; save still shots for it.`);
  }
  return { storyId: story.id, viewport, side, variant: kind.variant, media: kind.media };
}

// Whether a skip says the after build broke ('failed') or the state could
// not be reached ('skipped', the default and what every older caller meant).
const OUTCOMES = Object.freeze(['skipped', 'failed']);
function outcome(value) {
  if (value == null || value === '') return 'skipped';
  if (!OUTCOMES.includes(value)) {
    throw new ShotError('invalid_outcome', 'Outcome must be "skipped" (these copies cannot reach it) or "failed" (the app broke when you tried it).');
  }
  return value;
}

function reason(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, MAX_REASON) : '';
  if (!text) throw new ShotError('reason_required', 'Say briefly why, in words a person reading the proposal will understand.');
  return text;
}

// What a ready change's shots leave out, in the agent's words.
function note(value) {
  const text = typeof value === 'string' ? value.trim().slice(0, MAX_NOTE) : '';
  if (!text) throw new ShotError('note_required', 'Say briefly what the shots leave out, in words a person reading the proposal will understand.');
  return text;
}

function stored(target, buffer, info) {
  return {
    ...target,
    contentType: target.media === 'webm' ? 'video/webm' : 'image/png',
    data: buffer,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    sha256: info.sha256,
    focusRect: null,
    stageLabels: null,
  };
}

function missingWords(viewport, side, variant) {
  const which = side === 'base' ? 'before' : 'after';
  return `the ${which} ${variant === 'animation' ? 'clip' : 'shot'} on ${viewport}`;
}

// One result per declared change. A change is ready when every screen size
// has a before and an after screen shot, plus a before and an after clip if
// it is motion (element shots are optional extras), and it may carry the
// agent's note on what its shots leave out. A change the agent skipped by
// name is skipped even when its shots were saved: that is how the agent
// withdraws shots it found do not show the change. It is failed instead
// when the agent said the after build broke (`failed`). `fallbackReason` (a
// skip of everything) only explains the changes that are not ready, and
// `fallbackFailed` says that skip was the app breaking.
function summarize(intent, saved, skipped = new Map(), {
  fallbackReason = null, notes = new Map(), failed = new Set(), fallbackFailed = false,
} = {}) {
  const published = [];
  const stories = intent.stories.map((story) => {
    if (skipped.has(story.id)) {
      return { id: story.id, status: failed.has(story.id) ? 'failed' : 'skipped', reason: skipped.get(story.id) };
    }
    const missing = [];
    const files = [];
    const required = planContract.needsClip(story) ? ['context', 'animation'] : ['context'];
    for (const viewport of story.viewports) {
      for (const side of ['base', 'head']) {
        for (const variant of ['context', 'focus', 'animation']) {
          const file = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side, variant }));
          if (file) files.push(file);
          else if (required.includes(variant)) missing.push(missingWords(viewport.name, side, variant));
        }
      }
    }
    if (!missing.length) {
      published.push(...files);
      const note = notes.get(story.id);
      return { id: story.id, status: 'ready', files: files.length, ...(note ? { note } : {}) };
    }
    return {
      id: story.id,
      status: fallbackReason && fallbackFailed ? 'failed' : 'skipped',
      reason: fallbackReason || `The shots agent did not save ${missing.join(', ')}.`,
    };
  });
  const ready = stories.filter((story) => story.status === 'ready').length;
  const manifest = published
    .map(({ storyId, viewport, side, variant, sha256: digest }) => ({ storyId, viewport, side, variant, sha256: digest }))
    .sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
  return {
    stories,
    files: published,
    readyCount: ready,
    failedCount: stories.filter((story) => story.status === 'failed').length,
    // Stored as the run's plan hash: it fences storage and names exactly
    // which files were published.
    manifestHash: sha256(Buffer.from(planContract.canonicalJson({ mode: SHOTS_MODE, intent, manifest }))),
    verdict: { passed: ready > 0, mode: SHOTS_MODE, runs: 1, stories },
  };
}

// The words a run with no ready change, and at least one that failed, is
// failed with: each failed change's claim, then what the agent saw.
function failedReason(intent, stories) {
  return stories.filter((story) => story.status === 'failed').map((story) => {
    const claim = intent.stories.find((candidate) => candidate.id === story.id)?.claim || story.id;
    return `Tried "${claim}" on the after build, and it did not work. ${story.reason || ''}`.trim();
  }).join(' ').slice(0, 1800);
}

function isShotsVerdict(verdict) {
  return !!verdict && typeof verdict === 'object' && verdict.mode === SHOTS_MODE;
}

module.exports = {
  SHOTS_MODE,
  MAX_IMAGE_BYTES,
  MAX_CLIP_BYTES,
  ShotError,
  inspectImage,
  inspectClip,
  shotTarget,
  slotKey,
  OUTCOMES,
  outcome,
  reason,
  note,
  stored,
  summarize,
  failedReason,
  isShotsVerdict,
};
