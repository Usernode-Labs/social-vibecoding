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
// An element shot taller than this many screens is not one element a person
// can read on the card, and Chromium can tile the capture of an element far
// taller than the screen (a 2026-10-06 survey of runs found a 3679 px mosaic
// of repeated phone screens published as one product grid).
const MAX_ELEMENT_SCREENS_TALL = 2;
// What the card says, after "Not in these shots:", about a change whose
// before and after screens came out the same.
const UNCHANGED_NOTE = 'any visible difference. The before and after screens came out the same, so these shots cannot show this change.';
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

function slotKey({ storyId, viewport, side, variant, colorScheme = 'light' }) {
  return `${storyId}\u0000${viewport}\u0000${side}\u0000${variant}\u0000${colorScheme}`;
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
  if (raw.colorScheme != null && !['light', 'dark'].includes(raw.colorScheme)) {
    throw new ShotError('invalid_color_scheme', 'Photo appearance must be light or dark.');
  }
  if (kind.media !== 'png' && raw.colorScheme === 'dark') {
    throw new ShotError('invalid_color_scheme', 'Clips use the ordinary light browser.');
  }
  return { storyId: story.id, viewport, side, variant: kind.variant, media: kind.media,
    ...(raw.colorScheme == null ? {} : { colorScheme: raw.colorScheme }) };
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

// An element shot must fit the screen it was taken on. One wider than the
// screen means the page was laid out at another size (it was loaded before
// browser_resize, and the app chose its layout once, at load) or the element
// runs off the screen; one many screens tall is a tiled capture nobody can
// read. `screenFile` is the same side's screen shot when it is saved: a
// width of two or three times the screen's says the browser shot at that
// device scale, so its element shots may be as much larger. Any other width
// is a screen shot taken at the wrong size and says nothing about scale.
function checkElementSize(story, target, info, screenFile = null) {
  if (target.variant !== 'focus' || !info?.width) return;
  const viewport = story.viewports.find((candidate) => candidate.name === target.viewport);
  if (!viewport) return;
  const ratio = screenFile?.width ? screenFile.width / viewport.width : 1;
  const scale = [2, 3].find((factor) => Math.abs(ratio - factor) < 0.02) || 1;
  const maxWidth = Math.round(viewport.width * scale) + 1;
  const maxHeight = Math.round(viewport.height * scale * MAX_ELEMENT_SCREENS_TALL) + 1;
  if (info.width > maxWidth) {
    throw new ShotError('element_shot_too_wide',
      `This element shot is ${info.width} px wide, wider than the ${target.viewport} screen (${viewport.width} px). `
      + 'The page was probably laid out at another size: open the start path again after browser_resize, '
      + 'retake the screen shot, then shoot a smaller element that fits on the screen.');
  }
  if (info.height > maxHeight) {
    throw new ShotError('element_shot_too_tall',
      `This element shot is ${info.height} px tall, more than ${MAX_ELEMENT_SCREENS_TALL} ${target.viewport} screens. `
      + 'Shoot the smallest element that holds the change (a card or a row, not the whole list).');
  }
}

// The changes whose before and after screen shots are the same image on
// every screen size, so their shots cannot show them.
function identicalStories(intent, saved) {
  const ids = new Set();
  for (const story of intent.stories) {
    const modes = [...new Set([...saved.values()].filter((file) => file.storyId === story.id && file.media === 'png').map((file) => file.colorScheme || 'light'))];
    const same = modes.every((colorScheme) => story.viewports.every((viewport) => {
      const base = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side: 'base', variant: 'context', colorScheme }));
      const head = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side: 'head', variant: 'context', colorScheme }));
      return !!base && !!head && base.sha256 === head.sha256;
    }));
    if (same && story.viewports.length) ids.add(story.id);
  }
  return ids;
}

// Mark ready changes whose screens came out the same, and say so in the note
// shown beside their shots. The agent's own note is kept, with the sentence
// added after it.
function markUnchanged(stories, ids) {
  return stories.map((story) => {
    if (story.status !== 'ready' || !ids.has(story.id) || story.unchanged) return story;
    const note = story.note
      ? `${story.note} The before and after screens came out the same.`.slice(0, MAX_NOTE)
      : UNCHANGED_NOTE;
    return { ...story, unchanged: true, note };
  });
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
  fallbackReason = null, notes = new Map(), failed = new Set(), fallbackFailed = false, photoModes = ['light'],
} = {}) {
  const published = [];
  const results = intent.stories.map((story) => {
    if (skipped.has(story.id)) {
      return { id: story.id, status: failed.has(story.id) ? 'failed' : 'skipped', reason: skipped.get(story.id) };
    }
    const missing = [];
    const files = [];
    const required = planContract.needsClip(story) ? ['context', 'animation'] : ['context'];
    for (const viewport of story.viewports) {
      for (const side of ['base', 'head']) {
        for (const variant of ['context', 'focus', 'animation']) {
          for (const colorScheme of variant === 'animation' ? ['light'] : photoModes) {
            const file = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side, variant, colorScheme }));
            if (file) files.push(file);
            else if (required.includes(variant)) missing.push(missingWords(viewport.name, side, variant)
              + (photoModes.length > 1 && variant !== 'animation' ? ` in ${colorScheme} mode` : ''));
          }
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
  // A ready change is still published when its before and after are the same
  // image (people judge the shots), but the card says so rather than letting
  // two copies of one screen pass for the change.
  const stories = markUnchanged(results, identicalStories(intent, saved));
  const ready = stories.filter((story) => story.status === 'ready').length;
  const manifest = published
    .map(({ storyId, viewport, side, variant, colorScheme, sha256: digest }) => ({ storyId, viewport, side, variant, ...(colorScheme ? { colorScheme } : {}), sha256: digest }))
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
  UNCHANGED_NOTE,
  ShotError,
  inspectImage,
  inspectClip,
  shotTarget,
  slotKey,
  checkElementSize,
  identicalStories,
  markUnchanged,
  OUTCOMES,
  outcome,
  reason,
  note,
  stored,
  summarize,
  failedReason,
  isShotsVerdict,
};
