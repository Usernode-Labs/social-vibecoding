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
//
// Apart from the declared changes, the agent may note a few clear problems
// it saw on the after build while it took the shots (note_problem): content
// cut off, controls overlapping, an error on screen. They are advisory and
// kept beside the results as the verdict's `notices`: they never change a
// change's status, never fail a run and are never read as the change not
// working.
//
// And what the agent did to both builds alike to reach a change's state,
// beyond the author's steps: an API GET it held unanswered or made fail
// (control_request), or a sample file it uploaded (upload_file). Each is a
// change's `conditions`, recorded before the agent can do it, and shown
// beside that change's shots, so a loading state nobody's network produced
// is never taken for the app's own.

const crypto = require('crypto');
const planContract = require('./visible-changes');
const { SAMPLE_NAMES, MAX_FILES: MAX_SAMPLE_FILES } = require('../../worker/shots-samples');

const SHOTS_MODE = 'shots';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
// A run taken at the screen's own density (services/shots-density.js): a 2x
// desktop screen of a photo-heavy page passes 6 MB, and the agent cannot
// choose a smaller scale, so its cap leaves room for one. It stays under the
// internal route's 21 MB body limit (routes/internal.js).
const MAX_DENSE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_CLIP_BYTES = 20 * 1024 * 1024;
const MIN_CLIP_BYTES = 1024;
const MAX_IMAGE_EDGE = 8192;
const MAX_REASON = 1000;
const MAX_NOTE = 500;
// A problem the agent noticed is one short sentence, and a run keeps a
// handful: more than that is a review, not a notice.
const MAX_NOTICE = 300;
const MAX_NOTICES = 5;
// What the agent did to reach a change's state, at most this many a change.
const CONDITION_KINDS = Object.freeze(['request_held', 'request_failed', 'sample_file']);
const MAX_CONDITIONS = 4;
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
function inspectImage(buffer, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length + 25 + PNG_IEND.length) {
    throw new ShotError('invalid_shot_image', 'A shot must be a complete PNG image.');
  }
  if (buffer.length > maxBytes) {
    throw new ShotError('shot_too_large',
      `A shot may be at most ${maxBytes} bytes; save the visible screen or one element, not the full page.`, 413);
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

function slotKey({ storyId, viewport, side, variant, theme, part }) {
  // A dark slot's key extends the light one only when it is dark, and a
  // close-up's (shots-closeups.js) by its number on the screen, so every
  // other key stays exactly as it is now.
  return `${storyId}\u0000${viewport}\u0000${side}\u0000${variant}${theme === 'dark' ? '\u0000dark' : ''}`
    + `${variant === 'closeup' ? `\u0000${Number(part) || 1}` : ''}`;
}

// Where a saved file belongs: a declared change, one of its screen sizes, a
// side, and whether it is the screen, one element, or a clip — in light, or
// (whole screens only) in dark.
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
  const theme = raw.theme == null || raw.theme === '' ? 'light' : String(raw.theme);
  if (!['light', 'dark'].includes(theme)) {
    throw new ShotError('invalid_theme', 'Theme must be light or dark.');
  }
  if (theme === 'dark' && kind.variant !== 'context') {
    throw new ShotError('dark_screen_only',
      'A dark shot is the whole screen only: element shots and clips stay in light mode.');
  }
  return { storyId: story.id, viewport, side, variant: kind.variant, media: kind.media, theme };
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

// Whether the before build shows the same problem: true, false, or
// 'unknown' when the agent did not look (the default).
function alsoBefore(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (value == null || value === '' || value === 'unknown') return 'unknown';
  throw new ShotError('invalid_also_before', 'alsoBefore must be true, false, or "unknown".');
}

// One problem the agent noticed on the after build, where it shows: a
// declared change it was shooting, one of that change's screens, and
// optionally which of that screen's after shots shows it.
function notice(intent, raw = {}) {
  const text = typeof raw.problem === 'string' ? raw.problem.trim().slice(0, MAX_NOTICE) : '';
  if (!text) throw new ShotError('problem_required', 'Say in one short sentence what is broken, in words a person reading the proposal will understand.');
  const story = changeFor(intent, raw.change);
  const screen = String(raw.screen || '');
  if (!story.viewports.some((candidate) => candidate.name === screen)) {
    throw new ShotError('unknown_screen',
      `Screen ${JSON.stringify(screen)} is not declared for ${story.id}; use ${story.viewports.map((v) => v.name).join(' or ')}.`);
  }
  let shot = null;
  if (raw.shot != null && raw.shot !== '') {
    if (!['screen', 'element'].includes(raw.shot)) throw new ShotError('invalid_kind', 'Shot must be screen or element.');
    shot = raw.shot;
  }
  return { text, change: story.id, screen, shot, alsoBefore: alsoBefore(raw.alsoBefore) };
}

// An API GET the shots tools may hold or fail, as people will read it: the
// same exact-path rule as a declared controlledFailurePath, and nothing that
// looks like a credential.
function requestPath(value) {
  if (typeof value !== 'string' || !planContract.validControlledFailurePath(value)) return null;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  return planContract.credentialLike(value) || planContract.credentialLike(decoded) ? null : value;
}

// One thing the agent did to both builds to reach a declared change's state:
// `{ change, kind, request }` for an API GET held or failed, `{ change, kind,
// files }` for sample files uploaded.
function condition(intent, raw = {}) {
  const story = changeFor(intent, raw.change);
  const kind = String(raw.kind || '');
  if (!CONDITION_KINDS.includes(kind)) {
    throw new ShotError('invalid_condition', `Kind must be one of ${CONDITION_KINDS.join(', ')}.`);
  }
  if (kind === 'sample_file') {
    const files = Array.isArray(raw.files) ? raw.files : [];
    if (!files.length || files.length > MAX_SAMPLE_FILES || new Set(files).size !== files.length
        || !files.every((name) => SAMPLE_NAMES.includes(name))) {
      throw new ShotError('invalid_condition', `Name 1 to ${MAX_SAMPLE_FILES} of the sample files: ${SAMPLE_NAMES.join(', ')}.`);
    }
    return { change: story.id, kind, files: [...files] };
  }
  const request = requestPath(raw.request);
  if (!request) {
    throw new ShotError('invalid_condition', 'The request must be one exact API GET path under /api/, with its query if it has one.');
  }
  return { change: story.id, kind, request };
}

function sameCondition(a, b) {
  return a.kind === b.kind && (a.kind === 'sample_file'
    ? a.files.join('\n') === b.files.join('\n') : a.request === b.request);
}

// What a stored or served result's conditions may hold: the three kinds,
// their own fields, nothing else.
function cleanConditions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_CONDITIONS).map((entry) => {
    if (!entry || !CONDITION_KINDS.includes(entry.kind)) return null;
    if (entry.kind === 'sample_file') {
      const files = Array.isArray(entry.files)
        ? entry.files.filter((name) => SAMPLE_NAMES.includes(name)).slice(0, MAX_SAMPLE_FILES) : [];
      return files.length ? { kind: entry.kind, files } : null;
    }
    const request = requestPath(entry.request);
    return request ? { kind: entry.kind, request } : null;
  }).filter(Boolean);
}

// `dense`, for a still saved at more than one device pixel per CSS pixel in
// a run taken at device density (services/shots-density.js): its original,
// `{ density, data, width, height, bytes, sha256 }`. `buffer` and `info` are
// then its 1x copy, what everyone outside the experiment is shown.
function stored(target, buffer, info, dense = null) {
  return {
    ...target,
    contentType: target.media === 'webm' ? 'video/webm' : 'image/png',
    data: buffer,
    width: info.width,
    height: info.height,
    bytes: info.bytes,
    sha256: info.sha256,
    density: dense ? dense.density : 1,
    dense: dense ? { data: dense.data, width: dense.width, height: dense.height, bytes: dense.bytes, sha256: dense.sha256 } : null,
    focusRect: null,
    stageLabels: null,
  };
}

// A close-up (shots-closeups.js) as a run keeps it: the after side of a
// change on one screen, its number there (1 or 2), the region of the after
// still it shows (CSS px) and its density (device px per CSS px, one
// decimal). Its PNG is the only copy: only the New Needs you experiment's
// accounts are ever shown one.
function storedCloseup({ storyId, viewport, part, rect, scale }, buffer, info) {
  return {
    storyId, viewport, side: 'head', variant: 'closeup', media: 'png', theme: 'light', part,
    contentType: 'image/png', data: buffer,
    width: info.width, height: info.height, bytes: info.bytes, sha256: info.sha256,
    density: 1, dense: null, scale, focusRect: { ...rect }, stageLabels: null,
  };
}

// Device pixels per CSS pixel of a screen shot: its width over the declared
// screen's. A run taken at device density (services/shots-density.js) saves
// at the browser's (3 on a phone and on a desktop: worker/write-shots-mcp-
// config.js); every other run saves at 1. Only a whole multiple counts; any other width is a
// screen shot taken at the wrong size, read as 1, the way it always was.
const DENSITIES = Object.freeze([1, 2, 3, 4]);
// The density the browser that shoots a screen saves at: a phone screen's
// phone browser 3, a desktop browser 3 as well (2 until the close-up
// capture design, 2026-10-21).
const PHONE_DENSITY = 3;
const DESKTOP_DENSITY = 3;
const browserDensity = (viewport) => (planContract.phoneScreen(viewport) ? PHONE_DENSITY : DESKTOP_DENSITY);
function densityFor(imageWidth, screenWidth) {
  const ratio = Number(imageWidth) / Number(screenWidth);
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return DENSITIES.find((factor) => Math.abs(ratio - factor) < 0.02) || 1;
}

// An element shot must fit the screen it was taken on. One wider than the
// screen means the page was laid out at another size (it was loaded before
// browser_resize, and the app chose its layout once, at load) or the element
// runs off the screen; one many screens tall is a tiled capture nobody can
// read. `screenFile` is the same side's screen shot when it is saved: its
// density (densityFor) is the element shot's too, so its element shots may
// be as much larger. Before it is saved (the agent may save the element
// first), the element may be as dense as the screen's browser saves in a
// run taken at device density (`deviceDensity`), else 1x.
// Sizes in the messages are CSS pixels, the screen's own.
function checkElementSize(story, target, info, screenFile = null, { deviceDensity = false, density = 1 } = {}) {
  if (target.variant !== 'focus' || !info?.width) return;
  const viewport = story.viewports.find((candidate) => candidate.name === target.viewport);
  if (!viewport) return;
  // `density`: what the worker said this element shot was saved at, in a
  // run taken at device density. A saved screen shot of such a run holds
  // its 1x copy, so its width says nothing about the element's.
  const scale = density > 1 ? density
    : screenFile?.width ? densityFor(screenFile.width, viewport.width)
      : deviceDensity ? browserDensity(viewport) : 1;
  const maxWidth = Math.round(viewport.width * scale) + 1;
  const maxHeight = Math.round(viewport.height * scale * MAX_ELEMENT_SCREENS_TALL) + 1;
  if (info.width > maxWidth) {
    throw new ShotError('element_shot_too_wide',
      `This element shot is ${Math.round(info.width / scale)} px wide, wider than the ${target.viewport} screen (${viewport.width} px). `
      + 'The page was probably laid out at another size: open the start path again after browser_resize, '
      + 'retake the screen shot, then shoot a smaller element that fits on the screen.');
  }
  if (info.height > maxHeight) {
    throw new ShotError('element_shot_too_tall',
      `This element shot is ${Math.round(info.height / scale)} px tall, more than ${MAX_ELEMENT_SCREENS_TALL} ${target.viewport} screens. `
      + 'Shoot the smallest element that holds the change (a card or a row, not the whole list).');
  }
}

// The changes whose before and after screen shots are the same image on
// every screen size, so their shots cannot show them.
function identicalStories(intent, saved) {
  const ids = new Set();
  for (const story of intent.stories) {
    const same = story.viewports.every((viewport) => {
      const base = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side: 'base', variant: 'context' }));
      const head = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side: 'head', variant: 'context' }));
      return !!base && !!head && base.sha256 === head.sha256;
    });
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

// What a change's result reads as wherever results are read
// (shots-state.runSummary's shotResults, the admin listing, the runs
// export): ready, unchanged, skipped or failed. The verdict stores an
// unchanged change as `status: 'ready'` with `unchanged: true`, because its
// shots are still published and the run still counts it as ready (`passed`,
// the manifest and the outlines read it so), and runs saved before the
// flag existed have neither. A reader that knows only ready, skipped and
// failed can take unchanged for ready: its shots are there, and its note
// says they came out the same. Until 2026-10-12 results said 'ready' for
// these (at least six changes in the 200 proposals merged 10-09 to 10-12),
// so only their note told them apart.
const RESULT_STATUSES = Object.freeze(['ready', 'unchanged', 'skipped', 'failed']);
function resultStatus(story) {
  if (story?.status === 'ready') return story.unchanged === true ? 'unchanged' : 'ready';
  return story?.status === 'failed' ? 'failed' : 'skipped';
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
// `fallbackFailed` says that skip was the app breaking. `notices` (what
// the agent noticed broken on the after build) ride along as they are, and
// a notice names its shot only while that shot is published. A change's
// `conditions` (what the agent did to both builds to reach it) go on its
// result whatever its status, and only when there are some.
// `afterOnly` is a project's first version, whose before side is the
// starter template's placeholder (shots-starter.js): a change is ready with
// its after shots alone, nothing from the before side is published, and the
// verdict says so for the card.
function summarize(intent, saved, skipped = new Map(), {
  fallbackReason = null, notes = new Map(), failed = new Set(), fallbackFailed = false, notices = [],
  conditions = new Map(), afterOnly = false,
} = {}) {
  const published = [];
  const sides = afterOnly ? ['head'] : ['base', 'head'];
  const resultFor = (story) => {
    if (skipped.has(story.id)) {
      return { id: story.id, status: failed.has(story.id) ? 'failed' : 'skipped', reason: skipped.get(story.id) };
    }
    const missing = [];
    const files = [];
    // Dark shots (#4459) are extras beside the light ones: they are never
    // required, so a change with no dark shot is still ready.
    const darkFiles = [];
    const required = planContract.needsClip(story) ? ['context', 'animation'] : ['context'];
    for (const viewport of story.viewports) {
      for (const side of sides) {
        for (const variant of ['context', 'focus', 'animation']) {
          const file = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side, variant }));
          if (file) files.push(file);
          else if (required.includes(variant)) missing.push(missingWords(viewport.name, side, variant));
          if (variant === 'context') {
            const dark = saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side, variant, theme: 'dark' }));
            if (dark) darkFiles.push(dark);
          }
        }
      }
    }
    if (!missing.length) {
      // Close-ups are extras of the after side, like dark shots.
      const closeups = story.viewports.flatMap((viewport) => [1, 2]
        .map((part) => saved.get(slotKey({ storyId: story.id, viewport: viewport.name, side: 'head', variant: 'closeup', part })))
        .filter(Boolean));
      published.push(...files, ...darkFiles, ...closeups);
      const note = notes.get(story.id);
      return { id: story.id, status: 'ready', files: files.length, ...(note ? { note } : {}) };
    }
    return {
      id: story.id,
      status: fallbackReason && fallbackFailed ? 'failed' : 'skipped',
      reason: fallbackReason || `The shots agent did not save ${missing.join(', ')}.`,
    };
  };
  const results = intent.stories.map((story) => {
    const result = resultFor(story);
    const done = cleanConditions(conditions.get(story.id));
    return done.length ? { ...result, conditions: done } : result;
  });
  // A ready change is still published when its before and after are the same
  // image (people judge the shots), but the card says so rather than letting
  // two copies of one screen pass for the change. An after-only run has no
  // before to compare.
  const stories = afterOnly ? results : markUnchanged(results, identicalStories(intent, saved));
  const ready = stories.filter((story) => story.status === 'ready').length;
  const manifest = published
    .map(({ storyId, viewport, side, variant, theme, part, sha256: digest }) => ({
      storyId, viewport, side, variant, theme, ...(variant === 'closeup' ? { part } : {}), sha256: digest,
    }))
    .sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
  const publishedSlots = new Set(published.map(slotKey));
  const noticed = (Array.isArray(notices) ? notices : []).slice(0, MAX_NOTICES).map((entry) => ({
    ...entry,
    shot: entry.shot && publishedSlots.has(slotKey({
      storyId: entry.change, viewport: entry.screen, side: 'head', variant: KINDS[entry.shot].variant,
    })) ? entry.shot : null,
  }));
  return {
    stories,
    notices: noticed,
    files: published,
    readyCount: ready,
    failedCount: stories.filter((story) => story.status === 'failed').length,
    // Stored as the run's plan hash: it fences storage and names exactly
    // which files were published.
    manifestHash: sha256(Buffer.from(planContract.canonicalJson({ mode: SHOTS_MODE, intent, manifest }))),
    // A run without notices stores no `notices` key, as every run before
    // them did, and only an after-only run stores `afterOnly`.
    verdict: {
      passed: ready > 0, mode: SHOTS_MODE, runs: 1, stories,
      ...(noticed.length ? { notices: noticed } : {}),
      ...(afterOnly ? { afterOnly: true } : {}),
    },
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
  MAX_DENSE_IMAGE_BYTES,
  MAX_CLIP_BYTES,
  MAX_NOTICE,
  MAX_NOTICES,
  CONDITION_KINDS,
  MAX_CONDITIONS,
  UNCHANGED_NOTE,
  ShotError,
  inspectImage,
  inspectClip,
  shotTarget,
  slotKey,
  PHONE_DENSITY,
  DESKTOP_DENSITY,
  densityFor,
  checkElementSize,
  identicalStories,
  markUnchanged,
  RESULT_STATUSES,
  resultStatus,
  OUTCOMES,
  outcome,
  reason,
  note,
  alsoBefore,
  notice,
  condition,
  sameCondition,
  cleanConditions,
  stored,
  storedCloseup,
  summarize,
  failedReason,
  isShotsVerdict,
};
