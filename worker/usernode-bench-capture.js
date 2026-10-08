#!/usr/bin/env node
'use strict';

// #3737: the benchmark's SCREENSHOT STEP, run inside a trial's sealed worker
// after its build (a `first_version` trial) or on an app checked out at a
// commit (a `capture` trial, the "before" arm). It is not baked into the
// worker image: the platform writes this file into the worker and runs it
// when a trial reaches the step (services/bench/capture.js), so the step is
// always the platform's current version, whichever image the worker has.
//
// It boots the app the way a build turn's in-loop browser does, then looks:
//
//   1. BOOT. Dependencies installed when the checkout has none (`npm ci`, as
//      the image build does), the worker's local Postgres started and its
//      `inloop` database made fresh (start-inloop-db.sh, the build turns'
//      own helper), and the app launched through usernode-run-inloop: the
//      app's `npm run build`, USERNODE_ENV=staging, the manifest's staging
//      fallbacks, and the platform's hosted /usernode-* assets served on
//      the app's origin as production's edge serves them.
//   2. SIGN-IN. Every app's HTML and API sit behind the platform's RS256
//      identity token, which a worker cannot mint. So this step makes a
//      throwaway key pair, hands the app its public half as
//      USERNODE_JWT_PUBLIC_KEY (the variable the platform sets), and signs
//      one viewer's token with the private half, which never leaves this
//      process. Nothing anywhere else trusts that key.
//   3. SCREENSHOTS, with Playwright and the worker's pinned Chromium: two
//      viewports (390x844, 1280x800) x two looks (?un-theme=light|dark) x
//      four states:
//        populated  the app's own staging seed (boot-time seeding in
//                   staging mode, plus ?demo=1 for request-time demo data);
//        error      every same-origin GET under /api/ answered 500;
//        loading    every same-origin GET under /api/ held about 2 s, the
//                   screen taken about 300 ms after the document loads;
//        empty      the same database with every row removed (the tables
//                   the app made at boot stay), no ?demo=1.
//      And a fifth, on the phone in both looks and the desktop in the light
//      one, while its time lasts:
//        result     the populated screen after its PRIMARY ACTION was
//                   tapped once, for an app whose main content appears only
//                   after the person acts (a calculator's answer below its
//                   form). Deterministic, no model: chooseAction picks the
//                   control (a marked one, else the design kit's single
//                   .btn-primary, else a form's submit button, else the
//                   button filled with the page's accent colour) or says why
//                   none; primaryAction taps it with dialogs dismissed,
//                   navigation to another origin blocked and a few seconds'
//                   bound, waits for the network to go quiet and scrolls
//                   what changed into view. Never a reason the capture fails.
//   4. AUTOMATIC CHECKS, as numbers: console errors (populated and empty
//      screens; the error and loading states provoke their own), horizontal
//      overflow at 360 px, tap targets under 44 px, text below the WCAG AA
//      contrast ratio from computed styles (a small in-page check, no
//      dependency), and cards nested in cards on the rendered page.
//   5. THE TELLS LINT over the app's client source: emoji used as icons,
//      `uppercase tracking-*` eyebrows, arbitrary `text-[Npx]` sizes, hex
//      colour literals, all as counts with a few examples.
//
// An app that will not install, build or boot is a RESULT (booted: false
// and why), never a crash: the trial records it and the run goes on.
//
// Output: one line on stdout, `__USERNODE_BENCH_CAPTURE__ <json>`, the
// screenshots inside it as base64 PNGs. Exit code 0 whenever that line was
// written, whatever the app did.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MARKER = '__USERNODE_BENCH_CAPTURE__';
const VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'phone', width: 390, height: 844, mobile: true }),
  Object.freeze({ name: 'desktop', width: 1280, height: 800, mobile: false }),
]);
const LOOKS = Object.freeze(['light', 'dark']);
// The order they are taken in: the empty state last, because it empties the
// database the others read, and the result state just before it, because
// tapping an app's primary action may write to it.
const STATES = Object.freeze(['populated', 'error', 'loading', 'result', 'empty']);
// The screens the result state is taken on, most telling first: the step
// stops taking them when RESULT_BUDGET_MS is spent.
const RESULT_SCREENS = Object.freeze(['phone-light', 'phone-dark', 'desktop-light']);
// The attribute an app may put on the one control the result state should
// tap. Optional: without it the step looks for the screen's primary button.
const ACTION_MARKER = 'data-capture-action';
// The step's handle on the candidates it found, kept on the page between
// finding them and tapping one.
const CANDIDATES_KEY = '__usernodeBenchCaptureCandidates';
const CHANGES_KEY = '__usernodeBenchCaptureChanges';
// One control is the most prominent of several only when its box is at
// least this much larger than the next one's.
const PROMINENCE_MARGIN = 1.25;
const ACTION_CLICK_MS = 2000;
// After the tap: no request in flight for this long is network idle, and
// the step waits no longer than ACTION_WAIT_MS for it.
const ACTION_QUIET_MS = 500;
const ACTION_WAIT_MS = 3000;
const ACTION_SETTLE_MS = 500;
// The whole extra step on one screen (finding, tapping, waiting, revealing).
const ACTION_BUDGET_MS = 8000;
// The result state on all its screens, their page loads included.
const RESULT_BUDGET_MS = 30000;
const OVERFLOW_WIDTH = 360;
const MIN_TAP_PX = 44;
const LOADING_DELAY_MS = 2000;
const LOADING_SHOT_MS = 300;
const SETTLE_MS = 600;
// A page that never goes quiet (polling, a game loop's fetches) waits this
// long for network idle, then is taken once it has loaded.
const NAV_TIMEOUT_MS = 15000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const BOOT_TIMEOUT_MS = 3 * 60 * 1000;
const LOG_TAIL_CHARS = 1500;
const MAX_SAMPLES = 5;
const MAX_LINT_FILES = 400;
const MAX_LINT_FILE_BYTES = 512 * 1024;
const VIEWER = Object.freeze({ id: 900001, username: 'staging-demo-viewer' });

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clip(text, max = 200) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── The plan ─────────────────────────────────────────────────────────────

/** Every screenshot the step takes, in the order it takes them. Pure. */
function capturePlan({ viewports = VIEWPORTS, looks = LOOKS, states = STATES } = {}) {
  const shots = [];
  for (const state of states) {
    for (const viewport of viewports) {
      for (const look of looks) {
        if (state === 'result' && !RESULT_SCREENS.includes(`${viewport.name}-${look}`)) continue;
        shots.push({
          id: `${viewport.name}-${look}-${state}`,
          viewport: viewport.name, width: viewport.width, height: viewport.height, mobile: !!viewport.mobile,
          look, state,
        });
      }
    }
  }
  return shots;
}

/** The URL a shot opens: the app's root, its look, its sign-in, and ?demo=1 on the populated screen (the result state's too). Pure. */
function shotUrl(baseUrl, { look, state }, token) {
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  params.set('un-theme', look);
  if (state === 'populated' || state === 'result') params.set('demo', '1');
  return `${String(baseUrl).replace(/\/+$/, '')}/?${params.toString()}`;
}

/** Whether a request is one the error and loading states intercept: a same-origin GET under /api/. Pure. */
function interceptsApi(baseUrl, method, url) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    return target.origin === base.origin && target.pathname.startsWith('/api/');
  } catch { return false; }
}

/** Whether `url` is on the app's own origin (what the result state lets a tap navigate to). Pure. */
function sameOrigin(baseUrl, url) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch { return false; }
}

// ── The result state: which control is the screen's primary action ──────

// Where a control sits, in the order the step looks: the main content
// (inside <main> when the page has one), elsewhere on the page, and last
// the page's header, footer and navigation, whose buttons are passed over
// whenever the main content has one of its own.
const ACTION_REGIONS = Object.freeze([
  Object.freeze({ region: 'main', where: 'in the main content' }),
  Object.freeze({ region: 'other', where: 'outside the main content' }),
  Object.freeze({ region: 'chrome', where: 'in the page\'s header or navigation (the main content has none)' }),
]);
// What counts as a primary action, in the order the step looks, after a
// control the app marks itself. The first rule with any candidate decides:
// two equally prominent kit primary buttons are a skip, not a reason to
// fall through to a form's submit button.
const ACTION_RULES = Object.freeze([
  Object.freeze({
    rule: 'kit-primary', flag: 'kitPrimary',
    one: 'the design kit\'s primary button (.btn-primary)', many: 'design kit primary buttons (.btn-primary)',
  }),
  Object.freeze({ rule: 'form-submit', flag: 'formSubmit', one: 'a form\'s submit button', many: 'form submit buttons' }),
  Object.freeze({
    rule: 'accent', flag: 'accent',
    one: 'the button filled with the page\'s accent colour', many: 'buttons filled with the page\'s accent colour',
  }),
]);
const MARKED_RULE = Object.freeze({ rule: 'marked', one: `the control marked ${ACTION_MARKER}`, many: `controls marked ${ACTION_MARKER}` });
const MAX_ACTION_LABEL = 40;

/** A control's label as captions quote it: one line, no double quotes, at most 40 characters. Pure. */
function actionLabel(text) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').replace(/"/g, '\'').trim();
  return s.length > MAX_ACTION_LABEL ? `${s.slice(0, MAX_ACTION_LABEL - 1)}…` : s;
}

function quoted(label) { return label ? `"${label}"` : 'an unlabelled control'; }

function pickProminent(list, rule, where, margin) {
  const area = (c) => Number(c.area) || 0;
  const ranked = [...list].sort((a, b) => area(b) - area(a) || (Number(a.index) || 0) - (Number(b.index) || 0));
  const [top, next] = ranked;
  const place = where ? ` ${where}` : '';
  if (next && area(top) < area(next) * margin) {
    const tied = ranked.filter((c) => area(c) * margin > area(top));
    const names = tied.slice(0, 3).map((c) => quoted(actionLabel(c.label))).join(', ');
    return { skipped: `no clear primary action: ${tied.length} equally prominent ${rule.many}${place} (${names}${tied.length > 3 ? ', …' : ''})` };
  }
  const label = actionLabel(top.label);
  if (top.disabled) return { skipped: `the primary action ${quoted(label)} is disabled` };
  if (top.offOrigin) return { skipped: `the primary action ${quoted(label)} leads to another site` };
  const why = ranked.length === 1 ? `${rule.one}, the only one${place}` : `the largest of ${ranked.length} ${rule.many}${place}`;
  return { index: Number(top.index), label, rule: rule.rule, why };
}

/**
 * Which control is the screen's primary action, from descriptors of the
 * page's candidates (actionCandidates collects them in the page): each
 * { index, label, visible, disabled, region ('main' | 'other' | 'chrome'),
 * marked, kitPrimary, formSubmit, accent, offOrigin, area }. Pure.
 *
 * A control marked data-capture-action wins wherever it is. Otherwise the
 * main content's candidates come first, then the rest of the page's, then
 * its header's and navigation's; within them, a .btn-primary, then a
 * form's submit button, then a button filled with the accent colour. Of
 * several, the one clearly the largest (PROMINENCE_MARGIN) is chosen.
 *
 * Resolves { index, label, rule, why } for the control to tap, or
 * { skipped } saying why none is tapped: there is no candidate, two or
 * more are equally prominent, or the chosen one is disabled or leads to
 * another site.
 */
function chooseAction(candidates, { margin = PROMINENCE_MARGIN } = {}) {
  const shown = (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.visible !== false);
  const marked = shown.filter((c) => c.marked);
  if (marked.length) return pickProminent(marked, MARKED_RULE, '', margin);
  for (const { region, where } of ACTION_REGIONS) {
    const pool = shown.filter((c) => (c.region || 'main') === region);
    for (const rule of ACTION_RULES) {
      const list = pool.filter((c) => c[rule.flag]);
      if (list.length) return pickProminent(list, rule, where, margin);
    }
  }
  return { skipped: 'no clear primary action: no marked control, .btn-primary, form submit button or accent-coloured button on the screen' };
}

/**
 * The candidates for the screen's primary action, described. Runs IN THE
 * PAGE, like measurePage (actionExpression sends it with colorMath), and
 * keeps the elements themselves on the page under `key` so the step can
 * tap the one chooseAction picks.
 */
function actionCandidates({ marker, key, maxLabel, maxCandidates }, math) {
  const css = getComputedStyle(document.body || document.documentElement);
  // The page's accent: the starter kit's --accent ("15 118 110"), else the
  // native kit's --un-accent ("#7c3aed").
  const toColor = (raw) => {
    const v = String(raw || '').trim();
    if (!v) return null;
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
      const h = v.length <= 5 ? v.slice(1).split('').map((ch) => ch + ch).join('') : v.slice(1);
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
    }
    if (/^[\d.]+(\s*,\s*|\s+)[\d.]+(\s*,\s*|\s+)[\d.]+$/.test(v)) return math.parse(`rgb(${v})`);
    return math.parse(v);
  };
  const accent = toColor(css.getPropertyValue('--accent')) || toColor(css.getPropertyValue('--un-accent'));
  const near = (a, b) => Math.abs(a.r - b.r) <= 6 && Math.abs(a.g - b.g) <= 6 && Math.abs(a.b - b.b) <= 6;
  const hasMain = !!document.querySelector('main, [role=main]');
  const regionOf = (el) => {
    if (el.closest('nav, [role=navigation], [role=banner], [role=contentinfo], [role=tablist], [role=menubar]')) return 'chrome';
    // A header or footer is the page's own unless it heads a section.
    const edge = el.closest('header, footer');
    if (edge && !(edge.parentElement && edge.parentElement.closest('article, aside, main, nav, section, [role=main]'))) return 'chrome';
    if (!hasMain) return 'main';
    return el.closest('main, [role=main]') ? 'main' : 'other';
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };
  const elements = [];
  const out = [];
  const selector = `[${marker}], .btn-primary, button, input[type=submit], input[type=button], input[type=image], [role=button], a[href]`;
  for (const el of document.querySelectorAll(selector)) {
    if (out.length >= maxCandidates) break;
    const tag = el.tagName.toLowerCase();
    const marked = el.hasAttribute(marker);
    const kitPrimary = el.classList.contains('btn-primary');
    const formSubmit = (tag === 'button' || tag === 'input') && !!el.form && el.type === 'submit';
    const bg = math.parse(getComputedStyle(el).backgroundColor);
    const accentFill = !!accent && !!bg && bg.a >= 0.9 && near(bg, accent);
    if (!marked && !kitPrimary && !formSubmit && !accentFill) continue;
    // Where a tap would take the page: a link's address, a submit button's form action.
    let offOrigin = false;
    const target = tag === 'a' ? el.href : (formSubmit ? el.formAction : '');
    if (target) {
      try {
        const u = new URL(target, location.href);
        offOrigin = /^https?:$/.test(u.protocol) && u.origin !== location.origin;
      } catch { offOrigin = false; }
    }
    const r = el.getBoundingClientRect();
    elements.push(el);
    out.push({
      index: out.length,
      tag,
      label: String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('alt') || '')
        .replace(/\s+/g, ' ').trim().slice(0, maxLabel),
      visible: visible(el),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      region: regionOf(el),
      marked, kitPrimary, formSubmit, accent: accentFill, offOrigin,
      area: Math.round(r.width * r.height),
    });
  }
  window[key] = elements;
  return { candidates: out, accent: !!accent };
}

/** The expression page.evaluate runs to find the candidates. Pure. */
function actionExpression() {
  const opts = { marker: ACTION_MARKER, key: CANDIDATES_KEY, maxLabel: 80, maxCandidates: 200 };
  return `(${actionCandidates.toString()})(${JSON.stringify(opts)}, (${colorMath.toString()})())`;
}

/** Start noting what changes on the page. Runs IN THE PAGE, just before the tap. */
function watchChanges({ key }) {
  const changed = new Set();
  const note = (records) => {
    for (const rec of records) {
      if (rec.type === 'childList') rec.addedNodes.forEach((n) => changed.add(n.nodeType === 1 ? n : n.parentElement));
      else if (rec.type === 'characterData') changed.add(rec.target.parentElement);
      else changed.add(rec.target);
    }
  };
  const observer = new MutationObserver(note);
  observer.observe(document.body || document.documentElement, {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'],
  });
  window[key] = { observer, changed, note };
  return true;
}

/**
 * After the tap: count what changed (the tapped control's own label aside)
 * and, when the largest change sits out of view, as a calculator's answer
 * below its form does on a phone, scroll it into view with a little room
 * above. Takes focus off the tapped control. Runs IN THE PAGE.
 */
function revealChange({ key, controlKey, controlIndex, headroom }) {
  const control = (window[controlKey] || [])[controlIndex] || null;
  try { delete window[controlKey]; } catch { window[controlKey] = undefined; }
  if (control && document.activeElement === control && typeof control.blur === 'function') control.blur();
  const watch = window[key];
  // None means a new document: the tap navigated.
  if (!watch) return { changes: null, revealed: false };
  try { delete window[key]; } catch { window[key] = undefined; }
  watch.note(watch.observer.takeRecords());
  watch.observer.disconnect();
  let target = null;
  let changes = 0;
  for (const el of watch.changed) {
    if (!el || el.nodeType !== 1 || !el.isConnected || el === document.body || el === document.documentElement) continue;
    if (control && (el === control || control.contains(el))) continue;
    const cs = getComputedStyle(el);
    // A toast or a fixed bar is on screen wherever the page is scrolled.
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    changes += 1;
    if (!target || r.width * r.height > target.area) target = { el, area: r.width * r.height };
  }
  if (!target) return { changes, revealed: false };
  const vh = window.innerHeight;
  const top = target.el.getBoundingClientRect().top;
  if (top >= 0 && top < vh * 0.75) return { changes, revealed: false };
  target.el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
  if (window.scrollY > 0) window.scrollBy({ top: -Math.round(vh * headroom), behavior: 'instant' });
  return { changes, revealed: Math.abs(target.el.getBoundingClientRect().top - top) >= 1 };
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Requests in flight on a page, to tell when it has gone quiet after the tap. */
function watchNetwork(page) {
  let inFlight = 0;
  let lastChange = Date.now();
  const start = () => { inFlight += 1; lastChange = Date.now(); };
  const end = () => { inFlight = Math.max(0, inFlight - 1); lastChange = Date.now(); };
  page.on('request', start);
  page.on('requestfinished', end);
  page.on('requestfailed', end);
  return {
    async quiet(idleMs, maxMs) {
      const deadline = Date.now() + maxMs;
      while (Date.now() < deadline) {
        if (inFlight === 0 && Date.now() - lastChange >= idleMs) return 'network idle';
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
      }
      return `still busy after ${Math.round(maxMs / 1000)} s`;
    },
    stop() {
      page.off('request', start);
      page.off('requestfinished', end);
      page.off('requestfailed', end);
    },
  };
}

/**
 * Tap the screen's primary action once, on a page already loaded and
 * settled. Never throws. Resolves the record the capture keeps:
 * { used: { label, rule, why }, settled, changes, revealed, dialogs,
 * blocked, ms } when it tapped, { skipped } when no control is clearly the
 * primary action, { failed } when the tap or what followed went wrong.
 * Native dialogs are dismissed, a navigation to another origin is blocked
 * and a new window closed (both counted in `blocked`), and the whole step
 * is bound by ACTION_BUDGET_MS.
 */
async function primaryAction(page, baseUrl) {
  const started = Date.now();
  const state = { dialogs: 0, blocked: 0, choice: null };
  const run = async () => {
    const found = await page.evaluate(actionExpression());
    const choice = chooseAction(found && found.candidates);
    if (choice.skipped) return { skipped: choice.skipped };
    state.choice = choice;
    const handle = await page.evaluateHandle(`(window[${JSON.stringify(CANDIDATES_KEY)}] || [])[${Number(choice.index)}] || null`);
    const control = handle.asElement();
    if (!control) return { failed: `${quoted(choice.label)} left the page before it could be tapped` };
    // What a tap may set off, guarded from here on. The page loaded as the
    // populated screen did, so a tap that changes nothing leaves the same
    // picture, which pickShots then names identical.
    page.on('dialog', (dialog) => { state.dialogs += 1; dialog.dismiss().catch(() => {}); });
    page.context().on('page', (popup) => { state.blocked += 1; popup.close().catch(() => {}); });
    await page.route((url) => !sameOrigin(baseUrl, url.toString()), (route) => {
      const req = route.request();
      let topLevel = false;
      try { topLevel = req.isNavigationRequest() && req.frame() === page.mainFrame(); } catch { topLevel = false; }
      if (topLevel) {
        state.blocked += 1;
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });
    const net = watchNetwork(page);
    try {
      await page.evaluate(`(${watchChanges.toString()})(${JSON.stringify({ key: CHANGES_KEY })})`);
      await control.click({ timeout: ACTION_CLICK_MS });
      const settled = await net.quiet(ACTION_QUIET_MS, ACTION_WAIT_MS);
      // Off the control, so a hover style is not what changed.
      await page.mouse.move(0, 0).catch(() => {});
      const shown = await page.evaluate(`(${revealChange.toString()})(${JSON.stringify({
        key: CHANGES_KEY, controlKey: CANDIDATES_KEY, controlIndex: Number(choice.index), headroom: 0.1,
      })})`).catch(() => ({ changes: null, revealed: false }));
      await sleep(ACTION_SETTLE_MS);
      return {
        used: { label: choice.label, rule: choice.rule, why: choice.why },
        settled, changes: shown.changes, revealed: !!shown.revealed,
      };
    } finally {
      net.stop();
    }
  };
  let out;
  try {
    out = await withTimeout(run(), ACTION_BUDGET_MS, `the primary action took longer than ${ACTION_BUDGET_MS / 1000} s`);
  } catch (err) {
    out = {
      failed: clip(err && err.message ? err.message.split('\n')[0] : err, 200),
      ...(state.choice ? { tried: { label: state.choice.label, rule: state.choice.rule } } : {}),
    };
  }
  return { ...out, ...(out.used ? { dialogs: state.dialogs, blocked: state.blocked } : {}), ms: Date.now() - started };
}

/**
 * The capture record's account of the result state, one entry per planned
 * result screen: the control used and why, or why none was. Pure.
 */
function primaryActionRecord(shots) {
  return (shots || []).filter((s) => s && s.state === 'result').map((s) => {
    const a = s.action || {};
    const settledWhy = a.used || a.skipped || a.failed;
    return {
      id: s.id,
      ...a,
      ...(settledWhy ? {} : (s.failed ? { failed: s.failed } : { skipped: s.skipped || 'not taken' })),
      // Tapped, but the screenshot after it could not be taken.
      ...(a.used && s.failed ? { failed: s.failed } : {}),
      ...(s.sameAs ? { sameAs: s.sameAs } : {}),
    };
  });
}

// ── Sign-in: a throwaway identity the app can verify ─────────────────────

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * A key pair made for this capture alone, and one viewer's identity token
 * signed with it: RS256, issuer `usernode`, audience `usernode:app:<id>`,
 * `pur: 'iframe'`, the shape services/platform-jwt.js signs. Pure apart from
 * the key generation.
 */
function throwawayIdentity(appId, { now = Date.now(), ttlSeconds = 30 * 60 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const iat = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    id: VIEWER.id, username: VIEWER.username, usernode_pubkey: null, locale: null, pur: 'iframe',
    iat, exp: iat + ttlSeconds, aud: `usernode:app:${Number(appId) || 1}`, iss: 'usernode',
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    token: `${signingInput}.${base64url(signature)}`,
  };
}

// ── Colour and contrast (WCAG 2.x), also run inside the page ─────────────

/**
 * The colour arithmetic, as a factory so the same source runs in Node (the
 * tests) and in the page (measurePage receives it as text and calls it).
 * Self-contained on purpose: nothing from outside its body.
 */
function colorMath() {
  function parse(value) {
    const m = String(value || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i);
    if (!m) return null;
    let a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (!Number.isFinite(a)) a = 1;
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
  }
  // `top` drawn over the opaque `bottom`.
  function over(top, bottom) {
    const a = top.a;
    return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
  }
  function channel(c) {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }
  function luminance(c) {
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  }
  function ratio(fg, bg) {
    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  // WCAG's "large text": 24px and up, or 18.66px (14pt) and up when bold.
  function required(fontSizePx, fontWeight) {
    const size = Number(fontSizePx) || 0;
    const bold = (Number(fontWeight) || 400) >= 700;
    return size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
  }
  return { parse, over, luminance, ratio, required };
}

/**
 * Measure one rendered page. Runs IN THE PAGE: measureExpression sends its
 * source and colorMath's as one expression, evaluated by the browser's
 * automation channel (which the page's Content-Security-Policy does not
 * govern), so it uses nothing from outside its own body but its two
 * arguments. Returns plain numbers and a few samples.
 */
function measurePage({ minTap, maxSamples }, math) {
  const vw = window.innerWidth;
  const doc = document.documentElement;
  const out = {
    overflowPx: Math.max(0, Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0) - vw),
    tap: { checked: 0, small: 0, samples: [] },
    contrast: { checked: 0, low: 0, unknown: 0, worst: null, samples: [] },
    nestedCards: 0,
  };
  const label = (el) => String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.tagName)
    .replace(/\s+/g, ' ').trim().slice(0, 40);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  // Tap targets. A link inside a run of text is exempt (WCAG 2.5.8 "inline").
  const inline = (el) => {
    if (el.tagName !== 'A') return false;
    const parent = el.parentElement;
    if (!parent) return false;
    const text = Array.from(parent.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
    return text.length > 0;
  };
  const tappable = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], '
    + '[role=tab], [role=checkbox], [role=switch], [role=menuitem], [onclick]';
  for (const el of document.querySelectorAll(tappable)) {
    if (el.disabled || !visible(el) || inline(el)) continue;
    // A checkbox or radio inside its label is tapped through the label.
    const host = (el.type === 'checkbox' || el.type === 'radio') && el.closest('label') ? el.closest('label') : el;
    const r = host.getBoundingClientRect();
    out.tap.checked += 1;
    if (r.width < minTap || r.height < minTap) {
      out.tap.small += 1;
      if (out.tap.samples.length < maxSamples) {
        out.tap.samples.push({ tag: el.tagName.toLowerCase(), text: label(el), width: Math.round(r.width), height: Math.round(r.height) });
      }
    }
  }
  // Text contrast, from computed styles: each element that holds text of its
  // own, its colour over the backgrounds stacked behind it. A background
  // image (a gradient, a photo) cannot be read this way: counted unknown.
  const darkCanvas = /dark/.test(getComputedStyle(doc).colorScheme || '');
  const canvas = darkCanvas ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = math.parse(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let bg = canvas;
    for (let i = layers.length - 1; i >= 0; i -= 1) bg = math.over(layers[i], bg);
    return bg;
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body || doc, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && out.contrast.checked < 2000; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent.trim()) continue;
    seen.add(el);
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName) || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const fg = math.parse(cs.color);
    const bg = backdrop(el);
    if (!fg || !bg) { out.contrast.unknown += 1; continue; }
    const ratio = math.ratio(math.over(fg, bg), bg);
    const need = math.required(parseFloat(cs.fontSize), cs.fontWeight);
    out.contrast.checked += 1;
    if (out.contrast.worst == null || ratio < out.contrast.worst) out.contrast.worst = Math.round(ratio * 100) / 100;
    if (ratio < need) {
      out.contrast.low += 1;
      if (out.contrast.samples.length < maxSamples) {
        out.contrast.samples.push({ text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, need });
      }
    }
  }
  // Cards nested in cards: a box with its own edge (a border or a shadow), a
  // rounded corner and padding, inside another such box.
  const isCard = (el) => {
    const cs = getComputedStyle(el);
    const edged = (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') || (cs.boxShadow && cs.boxShadow !== 'none');
    const rounded = parseFloat(cs.borderTopLeftRadius) >= 4;
    const padded = parseFloat(cs.paddingTop) >= 8 && parseFloat(cs.paddingLeft) >= 8;
    const r = el.getBoundingClientRect();
    return edged && rounded && padded && r.width >= 120 && r.height >= 40;
  };
  const cards = Array.from(document.querySelectorAll('body *')).filter((el) => visible(el) && isCard(el)).slice(0, 500);
  const cardSet = new Set(cards);
  for (const el of cards) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (cardSet.has(p)) { out.nestedCards += 1; break; }
    }
  }
  return out;
}

/** The expression page.evaluate runs to measure a page. Pure. */
function measureExpression(opts) {
  return `(${measurePage.toString()})(${JSON.stringify(opts)}, (${colorMath.toString()})())`;
}

// ── The tells lint, over the app's client source ─────────────────────────

const LINT_EXT = /\.(html?|[cm]?jsx?|tsx?|css|vue|svelte)$/i;
const LINT_SKIP = /(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.claude|tests?|__tests__)\//i;
const LINT_SKIP_FILE = /(\.min\.(js|css)$)|(^|\/)(tailwind\.css|package-lock\.json)$/i;
// Emoji drawn as pictures: the supplementary planes' pictographs, and the
// Miscellaneous Symbols and Dingbats blocks (☀ ⭐ ✨ ❤ ✅). Arrows, ©, ® and
// ™ are text, not icons.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2B55}]/gu;
const CLASS_STRING_RE = /(["'`])((?:(?!\1)[^\n\\]|\\.){0,600})\1/g;
const ARBITRARY_TEXT_RE = /\btext-\[(\d+(?:\.\d+)?(?:px|rem|em))\]/g;
const HEX_RE = /(?<![\w&#/])#((?:[0-9a-f]{8})|(?:[0-9a-f]{6})|(?:[0-9a-f]{3,4}))(?![\w-])/gi;
// Comments are not the screen: "#1581" in a comment is an issue, not a colour.
const COMMENT_RES = Object.freeze([/<!--[\s\S]*?-->/g, /\/\*[\s\S]*?\*\//g, /(^|[^:'"`\\])\/\/[^\n]*/g]);

/** `text` with HTML, block and line comments blanked out. Pure. */
function stripComments(text) {
  let s = String(text || '');
  for (const re of COMMENT_RES) s = s.replace(re, (m, lead) => (typeof lead === 'string' ? lead : ''));
  return s;
}

/** Which files the lint reads: client source only, no dependencies, build output or tests. Pure. */
function lintable(file) {
  const f = String(file || '');
  if (!LINT_EXT.test(f) || LINT_SKIP.test(f) || LINT_SKIP_FILE.test(f)) return false;
  // Server entry points are the API, not the screen: their only markup is
  // the platform's sign-in landing page, which every app carries alike.
  if (/^(server|index|app)\.[cm]?js$/i.test(f) || /^(api|routes?|db|migrations?|lib\/server)\//i.test(f)) return false;
  return true;
}

/**
 * Count the known tells in `files` ([{ path, text }]). Pure. Hex colours are
 * literals in the source (a Tailwind arbitrary `bg-[#…]` counts too), distinct
 * values counted once; an eyebrow is one class string holding both
 * `uppercase` and a `tracking-` utility.
 */
function lintTells(files) {
  const out = {
    files: 0,
    emojiIcons: { count: 0, samples: [] },
    uppercaseEyebrows: { count: 0, samples: [] },
    arbitraryTextSizes: { count: 0, values: [] },
    hexColours: { count: 0, values: [] },
  };
  const sizes = new Set();
  const hexes = new Set();
  for (const file of files || []) {
    if (!file || !lintable(file.path)) continue;
    const text = stripComments(file.text);
    out.files += 1;
    for (const m of text.matchAll(EMOJI_RE)) {
      out.emojiIcons.count += 1;
      if (out.emojiIcons.samples.length < MAX_SAMPLES) out.emojiIcons.samples.push(`${m[0]} in ${file.path}`);
    }
    for (const m of text.matchAll(CLASS_STRING_RE)) {
      const value = m[2];
      if (/\buppercase\b/.test(value) && /\btracking-[\w[\].-]+/.test(value)) {
        out.uppercaseEyebrows.count += 1;
        if (out.uppercaseEyebrows.samples.length < MAX_SAMPLES) out.uppercaseEyebrows.samples.push(`${clip(value, 80)} in ${file.path}`);
      }
    }
    for (const m of text.matchAll(ARBITRARY_TEXT_RE)) {
      out.arbitraryTextSizes.count += 1;
      sizes.add(m[1]);
    }
    for (const m of text.matchAll(HEX_RE)) hexes.add(`#${m[1].toLowerCase()}`);
  }
  out.arbitraryTextSizes.values = [...sizes].sort().slice(0, 20);
  out.hexColours.count = hexes.size;
  out.hexColours.values = [...hexes].sort().slice(0, 20);
  return out;
}

function readLintFiles(dir) {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8' });
  const names = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  const files = [];
  for (const name of names) {
    if (files.length >= MAX_LINT_FILES) break;
    if (!lintable(name)) continue;
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (!stat.isFile() || stat.size > MAX_LINT_FILE_BYTES) continue;
      files.push({ path: name, text: fs.readFileSync(path.join(dir, name), 'utf8') });
    } catch { /* unreadable: skipped */ }
  }
  return files;
}

// ── The checks, summed over the screenshots ──────────────────────────────

/**
 * The automatic checks as numbers, from each screenshot's measurements and
 * the 360-px overflow pass. Pure. Console errors count the populated and
 * empty screens only: the error and loading states provoke their own.
 */
function summarizeChecks(shots, overflow = []) {
  const quiet = shots.filter((s) => s.state === 'populated' || s.state === 'empty');
  const messages = [];
  let consoleErrors = 0;
  for (const s of quiet) {
    consoleErrors += Number(s.consoleErrors) || 0;
    for (const m of s.errorSamples || []) if (messages.length < MAX_SAMPLES && !messages.includes(m)) messages.push(m);
  }
  const ofLook = (look) => quiet.filter((s) => s.look === look && s.metrics);
  const contrast = {};
  for (const look of LOOKS) {
    const list = ofLook(look);
    const worst = list.map((s) => s.metrics.contrast.worst).filter((v) => v != null);
    contrast[look] = {
      low: list.reduce((n, s) => n + s.metrics.contrast.low, 0),
      checked: list.reduce((n, s) => n + s.metrics.contrast.checked, 0),
      worst: worst.length ? Math.min(...worst) : null,
      samples: list.flatMap((s) => s.metrics.contrast.samples).slice(0, MAX_SAMPLES),
    };
  }
  const phone = quiet.filter((s) => s.viewport === 'phone' && s.metrics);
  const tapShot = phone.find((s) => s.look === 'light' && s.state === 'populated') || phone[0] || null;
  const overflowBy = Object.fromEntries(LOOKS.map((look) => [look, overflow.find((o) => o.look === look)?.overflowPx ?? null]));
  const nested = quiet.filter((s) => s.metrics).map((s) => s.metrics.nestedCards);
  return {
    consoleErrors: { count: consoleErrors, screens: quiet.length, samples: messages },
    overflow360: { ...overflowBy, worst: Math.max(0, ...Object.values(overflowBy).filter((v) => v != null)) },
    smallTapTargets: tapShot
      ? { small: tapShot.metrics.tap.small, checked: tapShot.metrics.tap.checked, samples: tapShot.metrics.tap.samples }
      : { small: null, checked: 0, samples: [] },
    lowContrast: contrast,
    nestedCards: { worst: nested.length ? Math.max(...nested) : null },
  };
}

// ── Booting the app ──────────────────────────────────────────────────────

/** The command production starts the app with: `npm start` when it has one, else `node server.js`. Pure. */
function startCommand(pkg, exists = () => true) {
  if (pkg && pkg.scripts && typeof pkg.scripts.start === 'string' && pkg.scripts.start.trim()) return ['npm', 'start'];
  const main = pkg && typeof pkg.main === 'string' && pkg.main.trim() ? pkg.main.trim() : null;
  if (main && exists(main)) return ['node', main];
  return ['node', 'server.js'];
}

/** The statement that empties every table the app made, keeping the tables. Pure. */
function emptyDatabaseSql() {
  return `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename !~* 'migrat' LOOP
    EXECUTE format('TRUNCATE TABLE %I.%I RESTART IDENTITY CASCADE', r.schemaname, r.tablename);
  END LOOP;
END $$;`;
}

function tail(text) {
  const s = String(text || '');
  return s.length > LOG_TAIL_CHARS ? s.slice(-LOG_TAIL_CHARS) : s;
}

// Values a log tail must not carry back: the viewer's token and the key.
function redact(text, secrets) {
  let s = String(text || '');
  for (const secret of secrets) if (secret) s = s.split(secret).join('[redacted]');
  return s;
}

function installDependencies(dir) {
  const started = Date.now();
  if (!fs.existsSync(path.join(dir, 'package.json'))) return { ran: false, ok: true, ms: 0 };
  if (fs.existsSync(path.join(dir, 'node_modules'))) return { ran: false, ok: true, ms: 0 };
  const args = fs.existsSync(path.join(dir, 'package-lock.json'))
    ? ['ci', '--include=dev', '--no-audit', '--no-fund']
    : ['install', '--include=dev', '--no-audit', '--no-fund'];
  const result = spawnSync('npm', args, { cwd: dir, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  const ok = result.status === 0;
  return {
    ran: true, ok, ms: Date.now() - started, command: `npm ${args[0]}`,
    ...(ok ? {} : { error: clip(result.error ? result.error.message : tail(`${result.stdout || ''}\n${result.stderr || ''}`), 600) }),
  };
}

function databaseName(url) {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, '')) || null; } catch { return null; }
}

/** The worker's own helper when it is there; else recreate the database with psql (a local run). */
function freshDatabase(env) {
  const helper = env.BENCH_INLOOP_DB_SCRIPT || '/usr/local/bin/start-inloop-db.sh';
  if (fs.existsSync(helper)) {
    const r = spawnSync('sh', [helper], { encoding: 'utf8', timeout: 120000, env });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (/__USERNODE_WARN__/.test(out)) return { ok: false, error: clip(out, 300) };
    return { ok: r.status === 0, ...(r.status === 0 ? {} : { error: clip(out, 300) }) };
  }
  const url = env.INLOOP_DATABASE_URL;
  const name = databaseName(url);
  if (!name || !/^[A-Za-z0-9_]+$/.test(name)) return { ok: false, error: 'no usable INLOOP_DATABASE_URL' };
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const run = (sql) => spawnSync('psql', [admin.toString(), '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], { encoding: 'utf8', timeout: 60000 });
  run(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
  const dropped = run(`DROP DATABASE IF EXISTS "${name}"`);
  const made = run(`CREATE DATABASE "${name}"`);
  return dropped.status === 0 && made.status === 0 ? { ok: true } : { ok: false, error: clip(`${dropped.stderr}${made.stderr}`, 300) };
}

function emptyDatabase(env) {
  const r = spawnSync('psql', [env.INLOOP_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-c', emptyDatabaseSql()], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? { ok: true } : { ok: false, error: clip(r.stderr || r.stdout, 300) };
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

/** Launch the app through usernode-run-inloop and wait until it answers. */
async function bootApp({ dir, env, command, port }) {
  const launcher = env.BENCH_RUN_INLOOP || '/usr/local/bin/usernode-run-inloop';
  let log = '';
  const child = spawn(process.execPath, [launcher, ...command], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk) => { log = tail(log + chunk.toString('utf8')); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { exited = { code: null, signal: null, error: err.message }; });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    // eslint-disable-next-line no-await-in-loop
    const status = await probe(port);
    // 502 is the front proxy saying the app is not listening yet.
    if (status && status !== 502) return { ok: true, child, log: () => log };
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  stopApp(child);
  const why = exited ? `the app exited (${exited.error || (exited.code != null ? `code ${exited.code}` : exited.signal)})` : 'the app did not answer within 3 minutes';
  return { ok: false, error: why, log: () => log };
}

function stopApp(child) {
  if (!child || child.exitCode != null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 3000).unref();
}

// ── Taking the screenshots ───────────────────────────────────────────────

function loadPlaywright(env) {
  const candidates = [env.BENCH_PLAYWRIGHT, 'playwright', '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright'].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  return null;
}

function pngSize(buf) {
  return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : { width: null, height: null };
}

async function takeShot(browser, baseUrl, token, shot) {
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1,
    isMobile: shot.mobile, hasTouch: shot.mobile, colorScheme: shot.look,
  });
  const errors = [];
  const started = Date.now();
  let action = null;
  try {
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(clip(msg.text())); });
    page.on('pageerror', (err) => errors.push(clip(err && err.message ? err.message : err)));
    if (shot.state === 'error' || shot.state === 'loading') {
      await page.route((url) => interceptsApi(baseUrl, 'GET', url.toString()), async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        if (shot.state === 'error') {
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal Server Error' }) });
        }
        await sleep(LOADING_DELAY_MS);
        return route.continue().catch(() => {});
      });
    }
    let status = null;
    if (shot.state === 'loading') {
      const resp = await page.goto(shotUrl(baseUrl, shot, token), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      status = resp ? resp.status() : null;
      await sleep(LOADING_SHOT_MS);
    } else {
      const resp = await page.goto(shotUrl(baseUrl, shot, token), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
        .catch(async () => page.waitForLoadState('load').then(() => null).catch(() => null));
      status = resp ? resp.status() : status;
      await sleep(SETTLE_MS);
    }
    if (shot.state === 'result') {
      // The populated screen, then its primary action tapped once. No tap,
      // no screenshot: it would be the populated one again.
      action = await primaryAction(page, baseUrl);
      if (!action.used) {
        return {
          ...shot, status, action, ...(action.failed ? { failed: `the primary action failed: ${action.failed}` } : { skipped: action.skipped }),
          consoleErrors: errors.length, errorSamples: errors.slice(0, MAX_SAMPLES), ms: Date.now() - started,
        };
      }
    }
    const png = await page.screenshot({ type: 'png', fullPage: false });
    let metrics = null;
    if (shot.state === 'populated' || shot.state === 'empty') {
      metrics = await page.evaluate(measureExpression({ minTap: MIN_TAP_PX, maxSamples: MAX_SAMPLES })).catch(() => null);
    }
    return {
      ...shot, status, png, ...pngSize(png), consoleErrors: errors.length, errorSamples: errors.slice(0, MAX_SAMPLES),
      metrics, ...(action ? { action } : {}), ms: Date.now() - started,
    };
  } catch (err) {
    return {
      ...shot, failed: clip(err.message, 300), ...(action ? { action } : {}),
      consoleErrors: errors.length, errorSamples: errors.slice(0, MAX_SAMPLES), ms: Date.now() - started,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function overflowAt360(browser, baseUrl, token, look) {
  const context = await browser.newContext({ viewport: { width: OVERFLOW_WIDTH, height: 780 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, colorScheme: look });
  try {
    const page = await context.newPage();
    await page.goto(shotUrl(baseUrl, { look, state: 'populated' }, token), { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS })
      .catch(() => page.waitForLoadState('load').catch(() => {}));
    await sleep(SETTLE_MS);
    const overflowPx = await page.evaluate(() => {
      const d = document.documentElement;
      return Math.max(0, Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0) - window.innerWidth);
    });
    return { look, overflowPx };
  } catch (err) {
    return { look, overflowPx: null, failed: clip(err.message) };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const dir = process.cwd();
  const env = { ...process.env };
  const port = Number(env.INLOOP_PORT) || 3100;
  // `localhost`, not 127.0.0.1: the bridge reads a dotted host as an app's
  // public domain and pins its "Open this app on Homeroom" mark to the
  // corner, which no screen inside the platform's frame ever shows.
  const baseUrl = `http://localhost:${port}`;
  const started = Date.now();
  const result = { ok: true, booted: false, error: null, steps: {}, shots: [], primaryAction: null, checks: null, tells: null };
  const emit = () => {
    result.ms = Date.now() - started;
    const shots = result.shots.map((s) => ({ ...s, png: s.png ? s.png.toString('base64') : null }));
    process.stdout.write(`${MARKER} ${JSON.stringify({ ...result, shots })}\n`);
  };

  // The tells first: they read the source, whatever the app does next.
  result.tells = lintTells(readLintFiles(dir));
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { pkg = {}; }

  result.steps.install = installDependencies(dir);
  if (!result.steps.install.ok) {
    result.error = `dependencies would not install: ${result.steps.install.error}`;
    return emit();
  }
  result.steps.database = freshDatabase(env);
  if (!result.steps.database.ok) {
    result.error = `the local database would not start: ${result.steps.database.error}`;
    return emit();
  }
  const identity = throwawayIdentity(env.BENCH_APP_ID);
  const appEnv = {
    ...env,
    INLOOP_BROWSER: '1', INLOOP_ENV: 'staging', INLOOP_PORT: String(port),
    USERNODE_JWT_PUBLIC_KEY: identity.publicKeyPem, USERNODE_APP_ID: String(Number(env.BENCH_APP_ID) || 1),
  };
  const command = startCommand(pkg, (f) => fs.existsSync(path.join(dir, f)));
  result.steps.boot = { command: command.join(' ') };
  const booted = await bootApp({ dir, env: appEnv, command, port });
  if (!booted.ok) {
    result.error = booted.error;
    result.steps.boot.log = redact(booted.log(), [identity.token, identity.publicKeyPem]);
    return emit();
  }
  result.booted = true;
  const playwright = loadPlaywright(env);
  let browser = null;
  try {
    if (!playwright) throw new Error('playwright is not available in this worker');
    browser = await playwright.chromium.launch({
      channel: 'chromium', headless: true,
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const plan = capturePlan();
    const overflow = [];
    let resultMs = 0;
    // A screen whose primary action was skipped, by viewport: its other look
    // is the same page, so it is skipped for the same reason, unopened.
    const skippedAt = new Map();
    for (const shot of plan) {
      if ((shot.state === 'result' || shot.state === 'empty') && !overflow.length) {
        // Before the first screen that may change the data (a tap on the
        // primary action may write; the empty state empties it): the 360-px
        // pass on the seeded data.
        for (const look of LOOKS) {
          // eslint-disable-next-line no-await-in-loop
          overflow.push(await overflowAt360(browser, baseUrl, identity.token, look));
        }
      }
      if (shot.state === 'empty' && !result.steps.emptied) result.steps.emptied = emptyDatabase(env);
      if (shot.state === 'result') {
        const earlier = skippedAt.get(shot.viewport);
        if (earlier) {
          result.shots.push({ ...shot, skipped: earlier.skipped, sameAs: earlier.id });
          continue;
        }
        if (resultMs >= RESULT_BUDGET_MS) {
          result.shots.push({ ...shot, skipped: `not taken: the result screens had used their ${RESULT_BUDGET_MS / 1000} s` });
          continue;
        }
        const t0 = Date.now();
        // eslint-disable-next-line no-await-in-loop
        const taken = await takeShot(browser, baseUrl, identity.token, shot);
        resultMs += Date.now() - t0;
        if (taken.action && taken.action.skipped) skippedAt.set(shot.viewport, { id: shot.id, skipped: taken.action.skipped });
        result.shots.push(taken);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      result.shots.push(await takeShot(browser, baseUrl, identity.token, shot));
    }
    result.primaryAction = primaryActionRecord(result.shots);
    result.checks = summarizeChecks(result.shots, overflow);
    result.checks.overflow360.samples = overflow.filter((o) => o.failed).map((o) => `${o.look}: ${o.failed}`);
  } catch (err) {
    result.error = `the screenshots could not be taken: ${clip(err.message, 300)}`;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopApp(booted.child);
  }
  // Each screenshot's own numbers stay; the browser's raw samples are
  // summed into the checks above.
  result.shots = result.shots.map((s) => {
    const { metrics, ...rest } = s;
    return {
      ...rest,
      ...(metrics ? {
        overflowPx: metrics.overflowPx, smallTapTargets: metrics.tap.small, lowContrast: metrics.contrast.low, nestedCards: metrics.nestedCards,
      } : {}),
    };
  });
  return emit();
}

if (require.main === module) {
  main().then(
    () => setTimeout(() => process.exit(0), 100),
    (err) => {
      process.stdout.write(`${MARKER} ${JSON.stringify({ ok: false, booted: false, error: `the capture step failed: ${clip(err.message, 300)}`, shots: [] })}\n`);
      setTimeout(() => process.exit(0), 100);
    },
  );
}

module.exports = {
  MARKER,
  VIEWPORTS,
  LOOKS,
  STATES,
  OVERFLOW_WIDTH,
  MIN_TAP_PX,
  LOADING_DELAY_MS,
  LOADING_SHOT_MS,
  RESULT_SCREENS,
  ACTION_MARKER,
  ACTION_BUDGET_MS,
  RESULT_BUDGET_MS,
  PROMINENCE_MARGIN,
  capturePlan,
  shotUrl,
  interceptsApi,
  sameOrigin,
  chooseAction,
  actionLabel,
  actionExpression,
  primaryAction,
  primaryActionRecord,
  takeShot,
  throwawayIdentity,
  colorMath,
  measurePage,
  measureExpression,
  lintable,
  stripComments,
  lintTells,
  summarizeChecks,
  startCommand,
  emptyDatabaseSql,
  redact,
};
