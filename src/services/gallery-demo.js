'use strict';

// Staging mock data for the Screenshot gallery console section (#860).
//
// The gallery reads `chat_sessions` + `session_visuals`, both tagged
// `staging:private` in src/db/schema.sql — so a prod-cloned staging DB has
// ZERO merged proposals with captures and the section renders an empty list
// in every PR review. Per the platform's "Staging mock data" convention this
// is REQUEST-TIME demo injection: gated on `IS_STAGING && ?demo=1`,
// read-path only (nothing is written to the staging DB), and a strict no-op
// in production.
//
// The rows are obviously fake: a synthetic `staging-demo` app slug, "Staging
// demo …" titles, and ids far above anything real. Three proposals cover the
// states a reviewer needs to see:
//
//   1. a complete capture (before + after stills + a recording),
//   2. a capture whose "before" side fell back to '/' (the caption branch),
//   3. a console-only proposal with no artifacts at all (the "no screenshots
//      were stored" branch, driven by capture_detail.reason).
//
// Image bytes: the tile renderer (AppView.visualsTilesHtml) always points at
// /visuals/<id>, so a data-URI can't be threaded through it. Instead the
// demo artifact ids share the reserved DEMO_ID_PREFIX and
// src/routes/visuals.js serves the tiny inline placeholder PNGs below for
// them — same IS_STAGING gate, so production /visuals is untouched.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Reserved prefix for demo artifact ids. Real ids are 32 hex chars from
// crypto.randomBytes(16) (src/services/visuals.js); the chance of a real id
// colliding with this prefix is ~1 in 16^8, and even then the collision only
// matters inside a staging container serving ?demo=1.
const DEMO_ID_PREFIX = '57a61de0';
const demoId = (suffix) => (DEMO_ID_PREFIX + String(suffix).padEnd(24, '0')).slice(0, 32);

// 24x16 solid PNGs — muted slate for the "before" side, platform violet for
// the "after" side, so a reviewer can tell the two halves apart at a glance
// without any real capture existing.
const PLACEHOLDER_PNG = {
  before: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR4nGOwt4+iCmIYNWjUoFGDRg2iDAEAJ11EEMV9lisAAAAASUVORK5CYII=',
    'base64'
  ),
  after: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAGklEQVR4nGPojvlGFcQwatCoQaMGjRpEGQIA/6HLn8k2L7UAAAAASUVORK5CYII=',
    'base64'
  ),
};

// Artifact ids, laid out so the id itself says which side it is.
const IDS = {
  p1BeforePng: demoId('1b0'),
  p1AfterPng: demoId('1a0'),
  p1AfterWebm: demoId('1a1'),
  p2BeforePng: demoId('2b0'),
  p2AfterPng: demoId('2a0'),
};
const ALL_IDS = Object.values(IDS);

// The synthetic app the demo rows hang off, for the App filter dropdown.
const DEMO_APP = { id: 0, slug: 'staging-demo', name: 'Staging demo app', proposal_count: 3 };

// True when this id is one of ours AND we're allowed to serve it.
function isDemoVisualId(id) {
  return IS_STAGING && ALL_IDS.includes(String(id));
}

// The bytes + content type for a demo artifact id, or null when the id
// isn't ours (or we're not in staging).
function demoVisualBytes(id) {
  if (!isDemoVisualId(id)) return null;
  // Only the "before" stills use the slate placeholder; everything else gets
  // the violet one. The webm id is served as a PNG on purpose — the tile
  // falls back to its poster when the video source won't decode, which is
  // exactly what we want from a placeholder without shipping a video file.
  const isBefore = id === IDS.p1BeforePng || id === IDS.p2BeforePng;
  return {
    contentType: 'image/png',
    data: isBefore ? PLACEHOLDER_PNG.before : PLACEHOLDER_PNG.after,
  };
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// The three demo proposals, in the API's response shape. `visuals` is
// deliberately given in the already-grouped { captures: [...] } form that
// services/visuals.js groupRows() produces, so the client renderer is fed
// exactly what a real row gives it.
function demoProposals() {
  return [
    {
      id: 9600001,
      mergedAt: hoursAgo(3),
      prNumber: 9101,
      prUrl: 'https://github.com/usernode-demo/staging-demo/pull/9101',
      title: 'Staging demo capture — complete before/after pair',
      appId: DEMO_APP.id,
      appSlug: DEMO_APP.slug,
      appName: DEMO_APP.name,
      captureState: 'captured',
      captureReason: null,
      captureDetail: null,
      capturedAt: hoursAgo(3),
      visuals: {
        captures: [{
          index: 0,
          path: '/board',
          viewport: 'desktop',
          before: { png: IDS.p1BeforePng },
          after: { png: IDS.p1AfterPng, webm: IDS.p1AfterWebm },
        }],
      },
    },
    {
      id: 9600002,
      mergedAt: hoursAgo(9),
      prNumber: 9102,
      prUrl: 'https://github.com/usernode-demo/staging-demo/pull/9102',
      title: 'Staging demo capture — before side fell back to the home page',
      appId: DEMO_APP.id,
      appSlug: DEMO_APP.slug,
      appName: DEMO_APP.name,
      captureState: 'partial',
      captureReason: 'The "before" path 404\'d on production and was re-shot at "/".',
      captureDetail: { reason: 'before_fell_back' },
      capturedAt: hoursAgo(9),
      visuals: {
        captures: [{
          index: 0,
          path: '/settings/notifications',
          viewport: 'desktop',
          before: { png: IDS.p2BeforePng },
          after: { png: IDS.p2AfterPng },
          beforeFellBack: true,
        }],
      },
    },
    {
      id: 9600003,
      mergedAt: hoursAgo(26),
      prNumber: 9103,
      prUrl: 'https://github.com/usernode-demo/staging-demo/pull/9103',
      title: 'Staging demo capture — no visual change expected',
      appId: DEMO_APP.id,
      appSlug: DEMO_APP.slug,
      appName: DEMO_APP.name,
      captureState: 'console_only',
      captureReason: 'Backend-only change — no screenshots were stored for this proposal.',
      captureDetail: { reason: 'console_only' },
      capturedAt: hoursAgo(26),
      visuals: null,
    },
  ];
}

// Counters matching demoProposals() so the stats strip agrees with the list.
function demoStats() {
  return {
    total: 3,
    missing_recording: 1,
    missing_before: 0,
    before_fell_back: 1,
    root_only: 0,
    failed_or_skipped: 1,
    complete: 1,
    unknown_state: 0,
  };
}

module.exports = {
  IS_STAGING,
  DEMO_ID_PREFIX,
  IDS,
  DEMO_APP,
  isDemoVisualId,
  demoVisualBytes,
  demoProposals,
  demoStats,
};
