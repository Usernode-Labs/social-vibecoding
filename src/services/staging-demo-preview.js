'use strict';

// The preview of a staging demo change.
//
// Staging containers have no Docker socket (SELF-HOSTING.md Phase 2g), so a
// preview cannot be built there and both preview routes used to answer
// "not available (demo)" for every change. That made the preview's own
// states unreachable for anyone reviewing a change on the staging copy, and
// impossible to shoot: a change to the preview could not be tried.
//
// With the demo data (`?demo=1`) a demo change now opens the same preview a
// real one does, showing a small, obviously fake Sample app. It is served by
// the staging host itself, on the same origin and through the same sandboxed
// frame and token, so what people see is the preview's own behaviour.
// Everything here is fixed, fake data: nothing reads a real change.
//
// Real changes on staging keep answering "not available (demo)".

const zlib = require('zlib');
const shotsView = require('./shots-view');

// Under /api/ on purpose: the service worker bypasses /api/ navigations and
// answers every other one with the shell document (public/sw.js classify).
const SAMPLE_PATH = '/api/staging-demo/sample-app';

// The demo proposal whose before & after shots are fixed here: the
// near-majority change that is up for a vote (routes/votes.js).
const DEMO_PREVIEW_SESSION_ID = 9000013;

// The fixed revision the demo shots were taken on. `serialize` compares it
// with the session's head, and they are the same value, so the run reads as
// verified.
const HEAD = '5'.repeat(40);
const BASE = '4'.repeat(40);

// The two placeholder pictures' artifact ids (32 hex, the shape the artifact
// route and the client's image URL both require).
const ARTIFACT_IDS = Object.freeze({
  base: '9000013a'.padEnd(32, '0'),
  head: '9000013b'.padEnd(32, '0'),
});

const CLAIM_ID = 'top-bar-line';
const VIEWPORT = 'desktop';
const WIDTH = 1280;
const HEIGHT = 800;

// Staging only, and only when the page carries the demo data. Inert in
// production whatever the URL says.
function isDemoEnv(req) {
  return process.env.USERNODE_ENV === 'staging' && req?.query?.demo === '1';
}

// The ready answer Try it opens, in the same shape a real preview answers.
// `startPath` is required: without it the frame would open the host root,
// which is the shell itself.
function previewAnswer(mock) {
  if (!mock) return null;
  return {
    status: 'ready',
    url: SAMPLE_PATH,
    verified: true,
    checksRunning: false,
    appName: mock.app_name || null,
    startPath: SAMPLE_PATH,
    prNumber: mock.pr_number,
    title: mock.pr_title,
  };
}

// The two placeholder pictures' ids, for the artifact route.
function isDemoArtifact(artifactId) {
  return Object.values(ARTIFACT_IDS).includes(String(artifactId || ''));
}

function isDemoPreviewSession(id) {
  return Number(id) === DEMO_PREVIEW_SESSION_ID;
}

// The whole page: no script, no external resource, nothing real.
function sampleAppHtml() {
  return '<!doctype html>\n'
    + '<html lang="en">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>Sample app</title>\n'
    + '</head>\n'
    + '<body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#18181b">\n'
    + '<main style="min-height:100vh;padding:48px 20px;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:center">\n'
    + '<div style="width:100%;max-width:520px;background:#fff;border-radius:20px;padding:28px;box-shadow:0 0 0 1px #e4e4e7">\n'
    + '<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#71717a">Sample</div>\n'
    + '<h1 style="font-size:24px;font-weight:700;margin:6px 0 10px">Sample app</h1>\n'
    + '<p style="font-size:15px;line-height:1.5;color:#52525b;margin:0 0 18px">'
    + 'This is a sample page that stands in for a change\'s preview on Homeroom\'s staging copy. Nothing here is real.'
    + '</p>\n'
    + '<button type="button" style="background:#2563eb;color:#fff;border:0;border-radius:999px;padding:10px 18px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer">Press me</button>\n'
    + '</div>\n</main>\n</body>\n</html>\n';
}

// ── The demo's before and after pictures ─────────────────────────────────
// Drawn here so the demo needs no stored image: an obviously fake page of
// plain bars, the shape PR 6958's shots had (21 Nov 2026). A top bar; on the
// after side a 1 px line under it, a tenth darker than the bar (under the
// comparison's ordinary tolerance, a hairline it finds on its own); and two
// strips of card text far below that differ between the sides for reasons
// unrelated to the claim. The run says the change is about the top bar (its
// frame, as its shots agent's element shot would record it), so the card
// frames there, and outlines the strips only as something else.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const pngCache = new Map();

const CREAM = [246, 241, 228];
const BAR = [252, 250, 244];
const BAR_LINE = BAR.map((c) => Math.round(c * 0.9));
const INK = [60, 60, 70];
const SOFT = [205, 205, 210];
const CARD = [255, 255, 255];
// The top bar, the claim's frame on both sides: [x, y, w, h] in CSS px.
const TOP_BAR = Object.freeze([0, 0, WIDTH, 52]);

// The page's rectangles on one side, painted in order: [x, y, w, h, rgb].
function demoRects(side) {
  const after = side !== 'base';
  return [
    [0, 0, WIDTH, 52, BAR], [24, 20, 160, 12, INK], [1120, 18, 136, 16, SOFT],
    ...(after ? [[0, 51, WIDTH, 1, BAR_LINE]] : []),
    [40, 120, 560, 620, CARD],
    ...[0, 1, 2, 3, 4, 5].map((i) => [64, 152 + i * 36, 480 - (i % 3) * 60, 12, SOFT]),
    // Two strips of card text the comparison finds different, which the
    // claim is not about.
    [64, 615, after ? 340 : 300, 12, INK],
    [64, 671, after ? 220 : 260, 12, INK],
    [640, 120, 600, 300, CARD], [664, 152, 400, 12, SOFT], [664, 188, 320, 12, SOFT],
  ];
}

// A WIDTH×HEIGHT PNG of one side's page (`base` the before, else the after).
function shotPng(side) {
  const key = side === 'base' ? 'base' : 'head';
  if (pngCache.has(key)) return pngCache.get(key);
  const rowLength = WIDTH * 3 + 1;
  const raw = Buffer.alloc(rowLength * HEIGHT);
  const fill = (x0, y0, w, h, [r, g, b]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const at = y * rowLength + 1 + x * 3;
        raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
      }
    }
  };
  fill(0, 0, WIDTH, HEIGHT, CREAM);
  for (const [x, y, w, h, rgb] of demoRects(key)) fill(x, y, w, h, rgb);
  // Each row's filter byte (0, none) is already zero.
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  pngCache.set(key, png);
  return png;
}

// What the comparison (services/shots-diff.js screensFor) makes of the two
// pictures, with the top bar recorded as the element the claim is about:
// the line, outlined as the bar it runs under and tied to the claim; the two
// strips, outlined as something else; and the claim's frame, the top bar.
// tests/staging-demo-preview.test.js runs the comparison on the pictures and
// holds this to what it finds.
const DEMO_SCREEN = Object.freeze({
  regions: [
    { story: CLAIM_ID, b: [...TOP_BAR], a: [...TOP_BAR], bMark: null, aMark: null },
    { story: null, b: [360, 615, 48, 12], a: [360, 615, 48, 12], bMark: null, aMark: null },
    { story: null, b: [280, 671, 48, 12], a: [280, 671, 48, 12], bMark: null, aMark: null },
  ],
  frames: [{ story: CLAIM_ID, b: [...TOP_BAR], a: [...TOP_BAR] }],
});

// The demo change's before & after, as a published run's view. Built by
// `shotsView.serialize` so the shape is exactly what a real verified run
// yields, and the addresses match the client's image rule.
function demoShots(mock, slug = require('../config').SELF_APP_SLUG) {
  if (!mock) return null;
  const artifact = (id, side) => ({
    id, storyId: CLAIM_ID, viewport: VIEWPORT, side, variant: 'context',
    media: 'png', contentType: 'image/png', width: WIDTH, height: HEIGHT,
    bytes: shotPng(side).length,
  });
  const run = {
    state: 'verified',
    required: false,
    claims: [{
      id: CLAIM_ID,
      claim: 'Staging demo: a thin line runs under the top bar',
      persona: 'member',
      viewports: [VIEWPORT],
      steps: ['Open the demo page'],
      baseState: 'present',
      animation: 'none',
    }],
    baseSha: BASE,
    headSha: HEAD,
    shotResults: [{ id: CLAIM_ID, status: 'ready', reason: null }],
    artifactSummary: [artifact(ARTIFACT_IDS.base, 'base'), artifact(ARTIFACT_IDS.head, 'head')],
    screens: [{
      viewport: VIEWPORT,
      shot: CLAIM_ID,
      stories: [CLAIM_ID],
      width: WIDTH,
      heightBefore: HEIGHT,
      heightAfter: HEIGHT,
      ...DEMO_SCREEN,
    }],
    updatedAt: new Date(0).toISOString(),
  };
  const session = { id: mock.id, reviewed_head_sha: HEAD, status: 'promoted' };
  return shotsView.serialize(run, session, slug, HEAD);
}

module.exports = {
  SAMPLE_PATH,
  DEMO_PREVIEW_SESSION_ID,
  ARTIFACT_IDS,
  HEAD,
  isDemoEnv,
  isDemoArtifact,
  isDemoPreviewSession,
  previewAnswer,
  sampleAppHtml,
  shotPng,
  demoShots,
  TOP_BAR,
  DEMO_SCREEN,
  CLAIM_ID,
};
