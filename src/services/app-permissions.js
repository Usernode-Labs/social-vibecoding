'use strict';

/**
 * The app-frame permission catalogue (#2219).
 *
 * Apps run in a cross-origin iframe, so every powerful browser capability
 * reaches them by Permissions Policy DELEGATION: the shell's `allow`
 * attribute on the frame, and nothing else. An app cannot grant itself one.
 *
 * Until this change the shell delegated a FIXED list to every app frame
 * unconditionally, and `geolocation` was on it. Two things follow from that,
 * and together they are why a platform-level prompt exists at all:
 *
 *   1. Under permission delegation the browser attributes a cross-origin
 *      child's request to the TOP-LEVEL origin, so its own prompt reads
 *      "my.onhomeroom.com wants to know your location" and never names the
 *      app that actually asked.
 *   2. That grant is per origin. Once the user answers it for the platform,
 *      EVERY app inherits the answer silently, with no second prompt.
 *
 * So the browser's prompt cannot tell one app from another, and only the
 * platform can. A capability in GATED is delegated to an app's frame only
 * when the signed-in user has granted it to THAT app (app_permission_grants),
 * and only when the app declared it in `dapp.json` first.
 *
 * ── Why the grant is read at navigation time ────────────────────────────
 *
 * A frame's container policy is computed from `allow` when it NAVIGATES,
 * exactly like `sandbox`. Changing the attribute on a live frame does
 * nothing for the document already in it. The frame bridge already turns on
 * this property for `sandbox` (see app-frame-policy.js), and the `allow`
 * string rides the same seam: it is written immediately before the `src`
 * assignment. A newly granted capability therefore applies on the frame's
 * NEXT navigation, which is why the grant path re-navigates the frame.
 *
 * ── Two copies, one contract ────────────────────────────────────────────
 *
 * The shell needs this catalogue in the browser and the server needs it
 * here. `frontend/src/features/app-frame/app-frame-policy.js` holds the
 * browser copy and `public/js/app-view.js` the DOM adapter's, the same
 * arrangement the `allow` attribute itself has always had.
 * tests/app-permissions.test.js pins all three against this file, so a
 * capability added here and nowhere else fails the suite rather than
 * half-shipping.
 */

/**
 * Delegated to every app frame, gate or no gate.
 *
 * These are the capabilities whose blast radius does not justify a prompt:
 * writing the clipboard is a copy button, and pointer lock is a game. Both
 * shipped in the frame's `allow` before this change and both stay there.
 * `geolocation` was the third and is NOT here any more, which is the
 * behaviour change #2219 asked for.
 */
const UNGATED_CAPABILITIES = Object.freeze(['clipboard-write', 'pointer-lock']);

/**
 * The gated capabilities, in prompt-ordering.
 *
 * `name` is the Permissions Policy token, so it goes into `allow` verbatim.
 * `label` names the capability in the prompt's title and in Settings.
 * `blurb` completes the sentence "<App> wants to ...", so it is a verb
 * phrase with no trailing full stop and no em dash (see the platform's
 * user-facing copy convention).
 *
 * Only `geolocation` was reachable by an app before this change. The other
 * eight were delegated to nobody at all, so declaring them is a capability
 * apps GAIN here, behind a prompt, rather than one they lose.
 */
const GATED_CAPABILITIES = Object.freeze([
  {
    name: 'geolocation',
    label: 'Location',
    blurb: 'know where you are',
  },
  {
    name: 'microphone',
    label: 'Microphone',
    blurb: 'record audio from your microphone',
  },
  {
    name: 'camera',
    label: 'Camera',
    blurb: 'see and record video from your camera',
  },
  {
    name: 'display-capture',
    label: 'Screen sharing',
    blurb: 'record your screen, which can include other windows and tabs',
  },
  {
    name: 'usb',
    label: 'USB devices',
    blurb: 'connect to USB devices plugged into this computer',
  },
  {
    name: 'serial',
    label: 'Serial devices',
    blurb: 'connect to serial devices plugged into this computer',
  },
  {
    name: 'hid',
    label: 'Input devices',
    blurb: 'connect to keyboards, gamepads and other input devices',
  },
  {
    name: 'bluetooth',
    label: 'Bluetooth',
    blurb: 'connect to Bluetooth devices near you',
  },
  {
    name: 'midi',
    label: 'MIDI devices',
    blurb: 'connect to MIDI instruments plugged into this computer',
  },
]);

const GATED_BY_NAME = new Map(GATED_CAPABILITIES.map((c) => [c.name, c]));
const GATED_NAMES = Object.freeze(GATED_CAPABILITIES.map((c) => c.name));

/** Is this a capability the platform gates? Unknown names are not. */
function isGatedCapability(name) {
  return typeof name === 'string' && GATED_BY_NAME.has(name);
}

/** The catalogue entry, or null for anything not gated. */
function capabilityInfo(name) {
  return (typeof name === 'string' && GATED_BY_NAME.get(name)) || null;
}

/**
 * Keep only real gated capability names, de-duplicated, in catalogue order.
 *
 * Every list that crosses a trust boundary goes through here: a manifest
 * an app author wrote, a request from inside the frame, a column read back
 * from the database after the catalogue moved on. Ordering is the
 * catalogue's rather than the caller's so the `allow` attribute for a given
 * grant set is stable, which is what makes it comparable in a test.
 */
function normalizeCapabilities(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  for (const entry of list) {
    const name = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' ? entry.capability : null);
    if (isGatedCapability(name)) seen.add(name);
  }
  return GATED_NAMES.filter((name) => seen.has(name));
}

/**
 * The frame's `allow` attribute for a given granted set.
 *
 * The ungated base is always present and always first, so the attribute a
 * no-grant app gets is exactly the one every app got before this change
 * minus `geolocation`. An entry with no origin in `allow` means "this
 * feature, for the frame's own src origin", which is the delegation we want
 * and never wider.
 *
 * `granted` is filtered rather than trusted: this is the last line before a
 * capability name reaches a live DOM attribute.
 */
function allowAttribute(granted) {
  return UNGATED_CAPABILITIES.concat(normalizeCapabilities(granted)).join('; ');
}

module.exports = {
  UNGATED_CAPABILITIES,
  GATED_CAPABILITIES,
  GATED_NAMES,
  isGatedCapability,
  capabilityInfo,
  normalizeCapabilities,
  allowAttribute,
};
