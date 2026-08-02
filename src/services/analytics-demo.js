'use strict';

// Staging mock data for the Analytics console section (#860).
//
// Every chart on that section is derived from `events` and `llm_usage`, both
// tagged `staging:private` in src/db/schema.sql — so in a prod-cloned
// staging DB they are EMPTY and the section renders as a wall of blank axes.
// Per the platform's "Staging mock data" convention this is REQUEST-TIME
// demo injection: gated on `IS_STAGING && ?demo=1`, read-path only (nothing
// is written to the staging DB), and a strict no-op in production.
//
// Each generator below is SUBSTITUTED for the real result only when the real
// result is genuinely empty (see `isEmpty*` helpers at the call sites in
// src/routes/dashboard.js) — a staging DB that somehow does have rows shows
// its own data rather than having demo numbers added on top of it.
//
// Values are deterministic: a tiny seeded LCG, so the same day renders the
// same series and a reviewer comparing two staging builds isn't reading
// noise. Usernames are the obviously-fake `staging-demo-user*` form the
// convention mandates.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const DAYS = 90;       // the daily charts' window
const SPEND_DAYS = 30; // the spend charts' window
const WEEKS = 14;      // growth / kudos / retention buckets

// Deterministic pseudo-random in [0,1) from an integer seed. Not
// cryptographic — it only needs to look like activity and be stable.
function rnd(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
// Integer in [lo, hi] for a given seed.
const pick = (seed, lo, hi) => lo + Math.floor(rnd(seed) * (hi - lo + 1));

// 'YYYY-MM-DD' for N days before today, UTC — the same text form the real
// SQL returns for `day` / `wk`.
function isoDay(daysAgo) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
// Monday-aligned week start, N weeks back.
function isoWeek(weeksAgo) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  d.setUTCDate(d.getUTCDate() - dow - weeksAgo * 7);
  return d.toISOString().slice(0, 10);
}

// ── Per-endpoint payloads ───────────────────────────────────────────────

function overview() {
  return {
    users: { total: 412, new_week: 17, new_month: 63 },
    appsTotal: 38,
    prs: { promoted: 4, promoted_all_time: 286, merged: 231 },
    wau: 96,
    mau: 214,
    llmSpendTodayCents: 1873.42,
    kudosTotal: 1420,
  };
}

// Daily platform / user-key / system spend, ascending by day (today last).
function spend() {
  const days = [];
  for (let i = SPEND_DAYS - 1; i >= 0; i--) {
    const s = 1000 + i;
    days.push({
      day: isoDay(i),
      platform_cents: pick(s, 400, 4200),
      user_key_cents: pick(s + 0.5, 0, 900),
      system_cents: pick(s + 0.25, 0, 260),
      // Admin-attributed slices — non-zero so the "Include admin users"
      // toggle visibly changes the chart in a preview.
      platform_cents_admin: pick(s + 0.75, 0, 600),
      user_key_cents_admin: pick(s + 0.9, 0, 120),
    });
  }
  return { days };
}

// Weekly growth counters, ascending by week.
function growth() {
  const weeks = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const s = 2000 + i;
    weeks.push({
      wk: isoWeek(i),
      new_users: pick(s, 3, 24),
      new_apps: pick(s + 0.3, 0, 5),
      promoted_prs: pick(s + 0.6, 2, 19),
      merged_prs: pick(s + 0.8, 1, 15),
      new_users_admin: pick(s + 0.1, 0, 3),
      new_apps_admin: pick(s + 0.15, 0, 2),
      promoted_prs_admin: pick(s + 0.2, 0, 4),
      merged_prs_admin: pick(s + 0.25, 0, 3),
    });
  }
  return { weeks };
}

// DAU / WAU / MAU rolling windows, ascending by day. WAU >= DAU and
// MAU >= WAU by construction so the three charts read coherently.
function generalUsers() {
  const daily = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const s = 3000 + i;
    const dau = pick(s, 18, 52);
    daily.push({
      day: isoDay(i),
      dau,
      wau: dau + pick(s + 0.4, 20, 55),
      mau: dau + pick(s + 0.7, 90, 165),
    });
  }
  return { daily };
}

// Power-user rolling WAU plus the L4 consistency stack.
function powerUsers() {
  const wau = [];
  const l4 = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const s = 4000 + i;
    wau.push({ day: isoDay(i), count: pick(s, 6, 23) });
    l4.push({
      day: isoDay(i),
      b1: pick(s + 0.2, 2, 11),
      b2: pick(s + 0.4, 1, 8),
      b3: pick(s + 0.6, 0, 6),
      b4: pick(s + 0.8, 0, 4),
    });
  }
  return { wau, l4 };
}

// Users per daily spend bucket, ascending by day. b0 (the $0 bucket) is
// deliberately large — it is in production too, which is why the section
// hides it by default behind the "Show $0" toggle.
function spendDistribution() {
  const days = [];
  for (let i = SPEND_DAYS - 1; i >= 0; i--) {
    const s = 5000 + i;
    days.push({
      day: isoDay(i),
      b0: pick(s, 280, 360),
      b1: pick(s + 0.15, 8, 26),
      b2: pick(s + 0.3, 3, 14),
      b3: pick(s + 0.45, 1, 8),
      b4: pick(s + 0.6, 0, 5),
      b5: pick(s + 0.75, 0, 3),
      b6: pick(s + 0.9, 0, 2),
    });
  }
  return { days };
}

// The two dapp/PR funnels plus the distinct-users funnel. Each stage is
// monotonically <= the previous one so the conversion captions make sense.
function funnels() {
  const step = (base, seed, floor) => Math.max(floor, Math.round(base * (0.55 + rnd(seed) * 0.3)));
  const signedUp = 412;
  const openedDapp = step(signedUp, 6001, 40);
  const returned = step(openedDapp, 6002, 30);
  const engaged = step(returned, 6003, 20);
  const creators = step(engaged, 6004, 8);

  const started = 286;
  const producedPr = step(started, 6011, 30);
  const promoted = step(producedPr, 6012, 20);
  const receivedVote = step(promoted, 6013, 12);
  const mergedS = step(receivedVote, 6014, 6);

  const uStarted = 118;
  const uProduced = step(uStarted, 6021, 20);
  const uPromoted = step(uProduced, 6022, 12);
  const uMerged = step(uPromoted, 6023, 6);

  return {
    dappUsage: {
      signed_up: signedUp, signed_up_admin: 6,
      opened_dapp: openedDapp, opened_dapp_admin: 5,
      returned, returned_admin: 4,
      engaged, engaged_admin: 3,
      creators, creators_admin: 2,
    },
    prSessions: {
      started, started_admin: 12,
      produced_pr: producedPr, produced_pr_admin: 9,
      promoted, promoted_admin: 7,
      received_vote: receivedVote, received_vote_admin: 5,
      merged: mergedS, merged_admin: 4,
    },
    prUsers: {
      started: uStarted, started_admin: 5,
      produced_pr: uProduced, produced_pr_admin: 4,
      promoted: uPromoted, promoted_admin: 3,
      merged: uMerged, merged_admin: 2,
    },
  };
}

// Signup-week cohorts with per-offset active counts, decaying with age.
function retention() {
  const cohorts = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const cohortSize = pick(7000 + i, 8, 34);
    const offsets = {};
    // A cohort can only have data for weeks that have already happened.
    for (let k = 0; k <= i; k++) {
      const decay = Math.max(0.06, 1 / (1 + k * 0.75));
      offsets[k] = Math.max(0, Math.round(cohortSize * decay * (0.7 + rnd(7000 + i * 31 + k) * 0.5)));
    }
    cohorts.push({ cohortWeek: isoWeek(i), cohortSize, offsets });
  }
  return { cohorts };
}

// Top 30 builders by lifetime dev sessions, descending.
function topUsers() {
  const users = [];
  for (let i = 0; i < 30; i++) {
    const sessions = Math.max(1, 74 - i * 2 - pick(8000 + i, 0, 3));
    const producedPr = Math.round(sessions * 0.72);
    const promoted = Math.round(producedPr * 0.68);
    const receivedVote = Math.round(promoted * 0.8);
    users.push({
      name: `staging-demo-user${String(i + 1).padStart(2, '0')}`,
      sessions,
      produced_pr: producedPr,
      promoted,
      received_vote: receivedVote,
      merged: Math.round(receivedVote * 0.7),
      // Two obviously-marked admin builders so the amber marker is visible.
      is_admin: i === 2 || i === 7,
    });
  }
  return { users };
}

// Top 30 builders by lifetime LLM spend, descending.
function spendByBuilder() {
  const builders = [];
  for (let i = 0; i < 30; i++) {
    const platform = Math.max(120, 46000 - i * 1400 - pick(9000 + i, 0, 900));
    builders.push({
      name: `staging-demo-user${String(i + 1).padStart(2, '0')}`,
      platform_cents: platform,
      user_key_cents: pick(9000 + i + 0.5, 0, 9000),
      is_admin: i === 2 || i === 7,
    });
  }
  return { builders };
}

// Weekly kudos-giving participation: how many users gave exactly 0..5.
function kudos() {
  const weeks = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const s = 10000 + i;
    weeks.push({
      wk: isoWeek(i),
      g0: pick(s, 240, 330),
      g1: pick(s + 0.15, 10, 28),
      g2: pick(s + 0.3, 6, 20),
      g3: pick(s + 0.45, 3, 14),
      g4: pick(s + 0.6, 2, 9),
      g5: pick(s + 0.75, 1, 7),
    });
  }
  return { weeks };
}

module.exports = {
  IS_STAGING,
  overview,
  spend,
  growth,
  generalUsers,
  powerUsers,
  spendDistribution,
  funnels,
  retention,
  topUsers,
  spendByBuilder,
  kudos,
};
