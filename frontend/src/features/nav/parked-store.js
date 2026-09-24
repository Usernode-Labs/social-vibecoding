/**
 * The app you left, so there is one tap back to it (#2718).
 *
 * ── The problem, stated as somebody hit it ────────────────────────────
 *
 * "Go to Workshop, go to Messages, go back to my DMs — and then I want to go
 * back to my app; what do I do?" The tab bar makes the platform's five places
 * one tap each, and in doing so it makes the app you were IN the one thing
 * that is not: the bar has no tab for it, the header's app strip is gone the
 * moment you leave, and Home's grid is a list of every app rather than the
 * one you were using a second ago.
 *
 * Every host that runs other people's programs answers this, and they all
 * answer it the same way: a persistent handle to the thing you stepped out
 * of. iOS and Android draw it as the app switcher; a desktop OS as the
 * taskbar; Telegram as the minimised bot window; WeChat as the floating
 * capsule that stays on screen after you swipe a mini program away. This is
 * that handle at phone scale — a strip above the tab bar with the app's tile,
 * its name and Resume.
 *
 * ── Why it is not the recency list ───────────────────────────────────
 *
 * ../app-context/app-recency.ts already records which apps this device opens,
 * and reusing it was the obvious first answer. It is the wrong shape twice
 * over: it is an ORDERING over apps rather than a fact about one, so it would
 * name an app you opened yesterday as confidently as the one you are halfway
 * through; and it has no display data, so a strip drawn from it would have to
 * fetch a name and an icon to draw a shortcut whose whole point is to be
 * instant.
 *
 * So this store keeps the one app, with what it takes to draw it, written at
 * the moment you leave. The two stores are about different questions and both
 * are worth having: "which apps do I reach for" orders the switcher's strip,
 * "which app am I in the middle of" is this.
 *
 * ── Why it is persisted, and where ───────────────────────────────────
 *
 * localStorage, beside the recency list, because a reload is one of the ways
 * people leave an app — a crash, a pull-to-refresh, following a link out and
 * coming back — and those are exactly the times the handle is worth most. The
 * entry is four small strings.
 *
 * NOTHING HERE MAY BE CALLED DURING AN INITIAL RENDER. The store's INITIAL is
 * empty, which is what the prerendered document shows; the island reads
 * storage in an effect. A localStorage read during a first render is a
 * hydration mismatch, and a console error on any route fails proposal checks.
 */

import { createStore } from '../../lib/plain-store.js';

const KEY = 'usernode_parked_app_v1';

/**
 * @typedef {object} ParkedApp
 * @property {string} slug
 * @property {string} name
 * @property {string|null} iconUrl
 * @property {string|null} iconEmoji
 */

/**
 * @typedef {object} ParkedState
 * @property {ParkedApp|null} app  The app to offer, or null for no strip.
 */

/** @type {ParkedState} */
const INITIAL = { app: null };

export const parkedStore = createStore(INITIAL);

/** The stored app, or null. Never throws. */
export function readParked() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.slug !== 'string' || !parsed.slug) return null;
    return {
      slug: parsed.slug,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.slug,
      iconUrl: typeof parsed.iconUrl === 'string' ? parsed.iconUrl : null,
      iconEmoji: typeof parsed.iconEmoji === 'string' ? parsed.iconEmoji : null,
    };
  } catch {
    // Private mode, disabled site data, a corrupt entry. No strip is the
    // pre-existing behaviour, so there is nothing to report.
    return null;
  }
}

/**
 * Park `app`, or clear it with null.
 *
 * Writes the store AND storage, in that order: the store is what the strip
 * renders from, and a storage failure must not cost the viewer the handle for
 * the rest of this session.
 *
 * @param {ParkedApp|null} app
 */
export function setParked(app) {
  const next = app && app.slug
    ? {
      slug: String(app.slug),
      name: String(app.name || app.slug),
      iconUrl: app.iconUrl || null,
      iconEmoji: app.iconEmoji || null,
    }
    : null;
  parkedStore.set({ app: next });
  try {
    if (next) window.localStorage.setItem(KEY, JSON.stringify(next));
    else window.localStorage.removeItem(KEY);
  } catch {
    // A handle that does not survive a reload is strictly better than a throw.
  }
}

/** Exported for the test that pins the key, so it cannot drift silently. */
export const PARKED_KEY = KEY;
