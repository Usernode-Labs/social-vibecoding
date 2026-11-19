'use strict';

// Artifacts (docs/plans/artifacts.md): the ONE policy every page the bot
// writes is drawn under, for the server and the browser alike. The text
// lives in artifact-policy.json, which the shell bundles as well
// (frontend/src/features/artifact/policy.ts builds the same strings from the
// same file, and tests/artifact-policy.test.js holds the two to each other).
//
// A page is drawn in a frame in one of three modes:
//
//   run     the page's own scripts run. The frame is sandbox="allow-scripts"
//           and nothing more, so it has an origin of its own: no cookies, no
//           storage, no reach into Homeroom. Its policy lets it fetch
//           nothing (connect-src 'none'), post no form and hold no frame.
//   static  nothing runs. The frame is sandbox="" and the policy refuses
//           every script.
//   helper  nothing of the page's runs, and Homeroom's own small helper
//           does: a page that must say how tall it is and where its links
//           are, so the chat can size its box and open a link (a laid-out
//           answer). The frame cannot be measured from outside without
//           sharing Homeroom's origin, which no frame here ever does, so the
//           frame is sandbox="allow-scripts" (an opaque origin, as `run`)
//           and its policy lets one script run: the one carrying the nonce
//           made new for that frame (script-src 'nonce-...'), which only
//           Homeroom's helper carries. The page's markup is cleaned of its
//           scripts and handlers first. With no nonce, no script runs.
//
// `site` is this site's origin for a page that draws with Homeroom's or a
// project's stylesheets, pictures and fonts (a design, a plan's screen); a
// page that needs none of them names no origin at all and can load nothing.
//
// THE RULE no mode breaks: a frame never has both scripts and
// allow-same-origin. No sandbox here names allow-same-origin at all.

const policy = require('./artifact-policy.json');

const MODES = Object.freeze(Object.keys(policy.modes));

function modeOf(mode) {
  const found = policy.modes[mode];
  if (!found) throw new Error(`artifact-policy: no mode ${mode}`);
  return found;
}

/** Pure: the sandbox attribute of a frame in `mode`. */
function sandboxFor(mode) {
  return modeOf(mode).sandbox;
}

/**
 * Pure: the content security policy text of a page drawn in `mode`. `site`:
 * this site's origin when the page draws with its stylesheets, pictures and
 * fonts, else null and the page names no origin. `nonce`: the helper mode's
 * one script, by this frame's nonce (no other mode takes one; without it the
 * helper mode runs nothing). `header`: the policy as a response header,
 * which carries the sandbox too.
 */
function cspFor(mode, { site = null, nonce = null, header = false } = {}) {
  const found = modeOf(mode);
  const origin = site ? String(site).replace(/["';,\s]/g, '') : '';
  const kept = nonce ? String(nonce).replace(/[^A-Za-z0-9+/=_-]/g, '') : '';
  const parts = found.directives.map(([name, ...values]) => {
    const said = values
      .map((value) => (value === '{site}' ? origin : value))
      .map((value) => (value.includes('{nonce}') ? (kept ? value.replace('{nonce}', kept) : '') : value))
      .filter(Boolean);
    return `${name} ${said.length ? said.join(' ') : "'none'"}`;
  });
  if (header) {
    const sandbox = sandboxFor(mode);
    parts.unshift(sandbox ? `sandbox ${sandbox}` : 'sandbox');
  }
  return parts.join('; ');
}

// An HTML file a person attached, opened with Preview: served by its own
// route (routes/conversations.js, routes/chat.js) as a document of its own,
// under a header that gives it the run mode's sandbox and nothing else.
const ATTACHMENT_VIEW_CSP = policy.attachmentView;

module.exports = { MODES, sandboxFor, cspFor, ATTACHMENT_VIEW_CSP, policy };
