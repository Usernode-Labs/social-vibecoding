'use strict';

// Homeroom bot's automatic switch to "Verified accounts only".
//
// Admin › Homeroom bot, "Who Homeroom bot works for", can switch the bot
// from everyone who is let in to verified accounts only by hand
// (homeroom-bot-verified.js, #6632). This is the same switch made by the
// platform when it grows: while it is armed (settings.verifiedAuto) and the
// bot still works for everyone, the clock's sweep reads two figures and, the
// first time either reaches its threshold, switches the bot to verified
// accounts only through homeroom-bot.js writeSettings, exactly as the
// console's Save would. That write records verifiedSince, so with "keep the
// bot" ticked the members let in before then keep it. Then it tells the
// full admins.
//
//   active users   distinct people active on Homeroom on any of the trailing
//                  30 UTC days (settings.verifiedAutoUsers, 500 by default)
//   AI spend       what the platform paid for AI over the last 30 days: the
//                  platform key plus system tokens, a person's own key left
//                  out (settings.verifiedAutoSpendCents, $5,000 by default)
//
// Both are read by services/analytics-figures.js, the queries Admin ›
// Analytics draws its MAU and its spend chart from (admins left out, as the
// dashboard shows them by default), so the trigger and the dashboard never
// disagree.
//
// It latches. Firing disarms it (verifiedAuto off, in the same write) and
// records when and why (state.fired); it never switches the bot back to
// everyone, and it does nothing while the bot already works for verified
// accounts only. An admin who switches back to everyone afterwards is not
// overridden: it stays disarmed until someone arms it again. Armed while a
// figure is already over its threshold, it fires on the next sweep.
//
// Before that, the full admins are told once when either figure passes 80%
// of its threshold, re-armed only once the figure falls back under 70% (a
// 30-day window moves slowly, and the gap keeps it from flapping). Which
// signals count and the grandfathering are the admin's, and stay as set.
//
// The thresholds and the switch are the bot's settings (homeroom-bot.js);
// what the sweep saw and did is one platform setting of its own (KEY_STATE),
// as openrouter-credit.js keeps its own.

const log = require('./logger');

const KEY_STATE = 'homeroom_bot_verified_auto_state';
const DEFAULT_USERS = 500;
const DEFAULT_SPEND_CENTS = 500000;
// The admins are told at 80% of a threshold, and again only after the
// figure has been back under 70%.
const NEAR_RATIO = 0.8;
const REARM_RATIO = 0.7;
// The two figures, by the names the state, the console and the alert use.
const FIGURES = Object.freeze(['activeUsers', 'aiSpend']);

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

/** A stored state, or an empty one. Pure: junk is dropped. */
function stateOf(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const near = {};
  for (const f of FIGURES) if (s.near && s.near[f] === true) near[f] = true;
  const fired = s.fired && typeof s.fired === 'object' && FIGURES.includes(s.fired.figure)
    && typeof s.fired.at === 'string'
    ? {
      at: s.fired.at,
      figure: s.fired.figure,
      value: Number(s.fired.value) || 0,
      threshold: Number(s.fired.threshold) || 0,
    }
    : null;
  const figures = s.figures && typeof s.figures === 'object'
    ? {
      activeUsers: Number.isFinite(Number(s.figures.activeUsers)) && s.figures.activeUsers !== null ? Number(s.figures.activeUsers) : null,
      aiSpendCents: Number.isFinite(Number(s.figures.aiSpendCents)) && s.figures.aiSpendCents !== null ? Number(s.figures.aiSpendCents) : null,
      at: typeof s.figures.at === 'string' ? s.figures.at : null,
    }
    : null;
  return { near, fired, figures };
}

/** Each figure's value and threshold, from the figures read and the settings. Pure. */
function pairs(settings, figures) {
  return [
    { figure: 'activeUsers', value: figures?.activeUsers ?? null, threshold: Number(settings?.verifiedAutoUsers) },
    { figure: 'aiSpend', value: figures?.aiSpendCents ?? null, threshold: Number(settings?.verifiedAutoSpendCents) },
  ].filter((p) => Number.isFinite(p.threshold) && p.threshold > 0);
}

/**
 * Pure: what one sweep does, from the bot's settings, the two figures read
 * now ({ activeUsers, aiSpendCents }, either may be null for a failed read)
 * and the stored state. Answers { fire, events, state }:
 *
 *   fire    null, or { figure, value, threshold, at } when the bot is to be
 *           switched to verified accounts only now (the figure reached
 *           furthest past its threshold, when both did)
 *   events  what the full admins are told: { type: 'fired' | 'near', figure,
 *           value, threshold }
 *   state   the state to store
 */
function decide(settings, figures, state, { now = Date.now() } = {}) {
  const prev = stateOf(state);
  const at = new Date(now).toISOString();
  const next = {
    ...prev,
    near: { ...prev.near },
    figures: { activeUsers: figures?.activeUsers ?? null, aiSpendCents: figures?.aiSpendCents ?? null, at },
  };
  const events = [];
  // Disarmed: nothing is decided, and the 80% notices start afresh when it
  // is armed again.
  if (!settings || settings.verifiedAuto !== true) {
    next.near = {};
    return { fire: null, events, state: next };
  }
  // Already for verified accounts only: there is nothing to switch, and the
  // switch never goes the other way.
  if (settings.worksFor === 'verified') return { fire: null, events, state: next };
  const known = pairs(settings, figures).filter((p) => p.value != null && Number.isFinite(Number(p.value)));
  const reached = known.filter((p) => p.value >= p.threshold)
    .sort((a, b) => (b.value / b.threshold) - (a.value / a.threshold));
  if (reached.length) {
    const { figure, value, threshold } = reached[0];
    const fire = { figure, value, threshold, at };
    next.fired = fire;
    next.near = {};
    events.push({ type: 'fired', figure, value, threshold });
    return { fire, events, state: next };
  }
  for (const { figure, value, threshold } of known) {
    if (value >= threshold * NEAR_RATIO) {
      if (!next.near[figure]) events.push({ type: 'near', figure, value, threshold });
      next.near[figure] = true;
    } else if (value < threshold * REARM_RATIO) {
      delete next.near[figure];
    }
  }
  return { fire: null, events, state: next };
}

// "verify:on:u:512:500" or "verify:near:s:4100:5000": fired or near, the
// figure (u: active users, s: AI spend), its value and its threshold (spend
// in whole dollars). Under the notifications table's 32 characters: each
// number is at most 8 digits, the settings' ceilings.
function detailToken(event) {
  const kind = event.type === 'fired' ? 'on' : 'near';
  const spend = event.figure === 'aiSpend';
  const n = (v) => String(Math.max(0, Math.round(spend ? v / 100 : v)));
  return `verify:${kind}:${spend ? 's' : 'u'}:${n(event.value)}:${n(event.threshold)}`;
}

async function tellAdmins(pool, deps, event, now) {
  const notifications = deps.notifications ? deps.notifications() : require('./notifications');
  const detail = detailToken(event);
  // A firing is told every time it happens (once per arming); an 80% notice
  // at most once a day per figure, whatever the re-arming does.
  const prefix = detail.split(':').slice(0, 3).join(':');
  const since = event.type === 'fired' ? new Date(now - 60 * 1000) : new Date(now - 24 * 60 * 60 * 1000);
  const created = await notifications.createPlatformIncidentNotifications(pool, { detail, dedupePrefix: prefix, since });
  await Promise.all((created || []).map((r) => notifications.hydrateAndPush(pool, r)));
}

async function readState(pool) {
  const { rows } = await pool.query('SELECT value FROM platform_settings WHERE key = $1', [KEY_STATE]);
  try {
    return stateOf(JSON.parse(rows[0]?.value || 'null'));
  } catch {
    return stateOf(null);
  }
}

async function writeState(pool, state) {
  await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY_STATE, JSON.stringify(state)],
  );
}

/**
 * One pass, run by the clock every 15 minutes: read the two figures (also
 * while disarmed, so the console shows them beside the thresholds), decide,
 * switch the bot to verified accounts only if it is time, and tell the full
 * admins. Returns { figures, fired, events }. Never throws.
 */
async function sweep(pool, config, deps = {}) {
  const out = { figures: null, fired: null, events: [], staging: deps.staging ?? isStaging() };
  try {
    const bot = deps.bot || require('./homeroom-bot');
    const settings = await bot.readSettings(pool, { strict: true });
    const figures = deps.figures
      ? await deps.figures()
      : await require('./analytics-figures').trailingFigures(pool);
    out.figures = figures;
    const now = deps.now ? deps.now() : Date.now();
    const decided = decide(settings, figures, await readState(pool), { now });
    if (decided.fire) {
      // The console's own write: worksFor 'verified' records verifiedSince
      // (once), and the switch disarms in the same save. Signals and the
      // grandfathering are left as the admin set them.
      const saved = await bot.writeSettings(pool, { worksFor: 'verified', verifiedAuto: false }, null, config);
      if (!saved || !saved.ok) {
        log.warn('homeroom-bot-verified-auto', 'Could not switch Homeroom bot to verified accounts only', {
          error: saved?.error || null,
        });
        return out;
      }
      out.fired = decided.fire;
      log.info('homeroom-bot-verified-auto', 'Homeroom bot switched to verified accounts only automatically', decided.fire);
    }
    await writeState(pool, decided.state);
    out.events = decided.events;
    if (!out.staging) {
      for (const event of decided.events) {
        await tellAdmins(pool, deps, event, now).catch((err) =>
          log.warn('homeroom-bot-verified-auto', 'Could not tell the admins', { err: err.message, type: event.type }));
      }
    }
  } catch (err) {
    log.warn('homeroom-bot-verified-auto', 'The sweep failed', { err: err.message });
  }
  return out;
}

/** What the console and the connector show: the last figures read and the last firing. Never throws. */
async function status(pool) {
  try {
    const s = await readState(pool);
    return { figures: s.figures, fired: s.fired, near: Object.keys(s.near) };
  } catch {
    return { figures: null, fired: null, near: [] };
  }
}

module.exports = {
  KEY_STATE,
  DEFAULT_USERS,
  DEFAULT_SPEND_CENTS,
  NEAR_RATIO,
  REARM_RATIO,
  FIGURES,
  stateOf,
  decide,
  detailToken,
  sweep,
  status,
};
