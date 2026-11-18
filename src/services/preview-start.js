'use strict';

// The page a change's staging preview opens on.
//
// A preview used to open on the app's first screen whatever the change was
// about, so a reviewer pressing Try it on a settings change landed on the
// home screen and had to find the changed page themselves (#4917). A change
// already names its page in two places: the declared visible changes' start
// path (chat_sessions.shots_detail, services/visible-changes.js) and the
// build's testing deep link (chat_sessions.testing_path,
// services/testing-notes.js). This module reads those into the one start
// path the preview opens at, and the preview answer carries it to Try it.
//
// THE ORDER. A declared start path the shots followed wins over the testing
// link, and among the declarations the first one that names a page other
// than the app's first screen wins (a story that starts at `/` says nothing
// about where a change shows). A declared `/` does not block the testing
// link: a declaration of the first screen counts as no page. Only when
// neither names one does the preview open at the root, as it always did.
//
// EVERY PATH is re-validated here with testing-notes.validatePath — the same
// rule the testing deep link passed at extract time — and a stored path that
// fails it is skipped, never an error: a preview that cannot agree on a safe
// page opens at the root.
//
// Read here and nowhere else: the ensure-staging / preview-status answer
// carries `startPath` to Try it (AppView.swapToStaging).

const testingNotes = require('./testing-notes');

const ROOT = '/';

// The first declared story start path worth opening at, or null. Malformed
// stored detail (not the parsed shape, a bad path) is skipped, never thrown.
function declaredStartPath(shotsDetail) {
  const stories = shotsDetail
    && typeof shotsDetail === 'object'
    && shotsDetail.intent
    && typeof shotsDetail.intent === 'object'
    ? shotsDetail.intent.stories
    : null;
  if (!Array.isArray(stories)) return null;
  for (const story of stories) {
    const path = story && typeof story === 'object' && story.intent
      ? story.intent.startPath
      : null;
    const valid = testingNotes.validatePath(path);
    if (valid && valid !== ROOT) return valid;
  }
  return null;
}

/**
 * The page a proposal's preview opens at: the first declared story start
 * path other than the app's first screen, else the build's testing deep
 * link when it is not the first screen, else null (open at the root, as
 * today). Never throws.
 */
function startPathFor(session) {
  const declared = declaredStartPath(session && session.shots_detail);
  if (declared) return declared;
  const tested = testingNotes.validatePath(session ? session.testing_path : null);
  return tested && tested !== ROOT ? tested : null;
}

/**
 * What a preview answer carries for Try it: `{ startPath }` when the change
 * names a page, or nothing at all when it does not, so every other answer
 * stays exactly as it was.
 */
function previewAnswer(session) {
  const startPath = startPathFor(session);
  return startPath ? { startPath } : {};
}

// The narrowest screen a desktop layout is drawn at. A change whose declared
// before/after shots are ALL at least this wide is about large screens: a
// column beside a thread (400 to 900 px) would show the app's narrow layout,
// which is not what the change is about, so Try it opens it full width.
const DESKTOP_WIDTH = 1024;

/**
 * Whether every screen the change declared for its before/after shots is a
 * desktop one (services/visible-changes.js `viewports`). False when nothing
 * is declared, or when any declared screen is narrower. Never throws.
 */
function declaredWide(shotsDetail) {
  const stories = shotsDetail
    && typeof shotsDetail === 'object'
    && shotsDetail.intent
    && typeof shotsDetail.intent === 'object'
    ? shotsDetail.intent.stories
    : null;
  if (!Array.isArray(stories)) return false;
  const widths = [];
  for (const story of stories) {
    const viewports = story && typeof story === 'object' ? story.viewports : null;
    if (!Array.isArray(viewports)) continue;
    for (const viewport of viewports) {
      const width = viewport && typeof viewport === 'object' ? Number(viewport.width) : NaN;
      if (!Number.isFinite(width)) return false;
      widths.push(width);
    }
  }
  return widths.length > 0 && widths.every((width) => width >= DESKTOP_WIDTH);
}

/**
 * `{ wide: true }` for a change declared for large screens only, nothing
 * otherwise, so every other answer stays exactly as it was.
 */
function wideAnswer(session) {
  return declaredWide(session && session.shots_detail) ? { wide: true } : {};
}

module.exports = {
  ROOT,
  DESKTOP_WIDTH,
  declaredStartPath,
  declaredWide,
  wideAnswer,
  startPathFor,
  previewAnswer,
};