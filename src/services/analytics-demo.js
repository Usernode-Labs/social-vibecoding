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

// Weekly kudos-giving participation: how many users gave 0, 1, 2, 3, 4–5,
// 6–10 or 11+ kudos that week. #964 rebanded these from the old exact-1..5
// series when the weekly allowance rose to 20 — the keys here must keep
// matching GET /api/admin/analytics/kudos exactly, since this payload is
// substituted wholesale for it in staging (pr_kudos is staging:private, so
// the real query returns all-zero rows there). The two heavy-giver bands
// stay deliberately small: most weeks have a long tail, not a fat one.
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
      g4_5: pick(s + 0.6, 2, 9),
      g6_10: pick(s + 0.75, 1, 7),
      g11p: pick(s + 0.9, 0, 4),
    });
  }
  return { weeks };
}

// Progress estimator accuracy (#891). `progress_estimates` is
// `staging:private`, so a prod-cloned staging DB has it schema-only and the
// card renders as a wall of dashes in every PR preview — this is the
// substituted read-path payload (same shape as the real endpoint's).
//
// Numbers mirror what production actually measured (#892) rather than a
// flattering invention: a v1 prompt that fails every bar (181s median error,
// 31% in band, -110s bias) beside a v2 that clears the bias bar and lands
// just UNDER the 45% in-band bar. Deliberate on both counts — a staging
// preview showing a green "Ready to leave experimental" off mock data
// invites being read as the real answer, and the amber "not yet" path is
// the one a reviewer most needs to see rendered. The priors block is seeded
// STALE (one bucket over the 25% drift threshold) for the same reason: the
// stale state is the one worth recognising on sight.
function estimatorAccuracy() {
  const window30 = {
    ticks: 243,
    resolved: 240,
    unresolved: 3,
    unresolvedRate: 3 / 243,
    runs: 55,
    users: 6,
    scored: 231,
    ranPast: 9,
    coverage: 0.95,
    // Pooled v1+v2, so it sits between the two versions below.
    medianAbsErrS: 178,
    medianBiasS: -48,
    within60s: 0.24,
    withinBand: 0.36,
  };
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const s = 20000 + i;
    daily.push({
      day: isoDay(i),
      scored: pick(s, 3, 14),
      medianAbsErrS: pick(s + 0.5, 45, 130),
    });
  }
  return {
    last30d: window30,
    // All-time is the same run of data plus the pre-fix tail: a much worse
    // unresolved rate, which is exactly the story the card should tell.
    allTime: {
      ...window30,
      ticks: 618,
      resolved: 559,
      unresolved: 59,
      unresolvedRate: 59 / 618,
      runs: 141,
      users: 7,
      scored: 534,
      ranPast: 25,
      medianAbsErrS: 179,
      medianBiasS: -84,
      within60s: 0.22,
      withinBand: 0.33,
    },
    usersEnabled: 6,
    // The clearest visual before/after: v1's bias swings from +81s early to
    // -299s late (it collapses to a flat two-minute guess as runs drag on),
    // v2's stays near zero throughout.
    byElapsed: [
      { bucket: '<2m', promptVersion: 1, scored: 871, medianAbsErrS: 161, medianBiasS: 81, withinBand: 0.32 },
      { bucket: '<2m', promptVersion: 2, scored: 58, medianAbsErrS: 132, medianBiasS: 12, withinBand: 0.44 },
      { bucket: '2-5m', promptVersion: 1, scored: 1212, medianAbsErrS: 149, medianBiasS: -14, withinBand: 0.34 },
      { bucket: '2-5m', promptVersion: 2, scored: 81, medianAbsErrS: 138, medianBiasS: 9, withinBand: 0.46 },
      { bucket: '5-10m', promptVersion: 1, scored: 1102, medianAbsErrS: 243, medianBiasS: -243, withinBand: 0.29 },
      { bucket: '5-10m', promptVersion: 2, scored: 74, medianAbsErrS: 186, medianBiasS: -31, withinBand: 0.43 },
      { bucket: '10-20m', promptVersion: 1, scored: 800, medianAbsErrS: 246, medianBiasS: -246, withinBand: 0.28 },
      { bucket: '10-20m', promptVersion: 2, scored: 41, medianAbsErrS: 201, medianBiasS: -44, withinBand: 0.41 },
      { bucket: '20m+', promptVersion: 1, scored: 265, medianAbsErrS: 299, medianBiasS: -299, withinBand: 0.25 },
      { bucket: '20m+', promptVersion: 2, scored: 14, medianAbsErrS: 228, medianBiasS: -58, withinBand: 0.36 },
    ],
    // v1 = the "bias toward 2-10 minutes" prompt whose flat output failed
    // every bar. v2 = the same model given the measured run-length
    // distribution as prompt input. No output-side multiplier is involved in
    // either, which is the point of splitting them.
    byPromptVersion: [
      {
        promptVersion: 1, ticks: 4737, resolved: 4275, unresolved: 462,
        unresolvedRate: 462 / 4737, runs: 965, users: 6, scored: 4250,
        ranPast: 0, coverage: 0.99,
        medianAbsErrS: 181, medianBiasS: -110, within60s: 0.21, withinBand: 0.31,
      },
      {
        promptVersion: 2, ticks: 274, resolved: 271, unresolved: 3,
        unresolvedRate: 3 / 274, runs: 62, users: 6, scored: 268,
        ranPast: 0, coverage: 1,
        medianAbsErrS: 171, medianBiasS: 14, within60s: 0.27, withinBand: 0.43,
      },
    ],
    // What the estimator has to BEAT. The oracle is the best any
    // elapsed-only predictor could do — 39% in band, which is why the
    // retired 60% graduation bar was unreachable by anything at all.
    baselines: {
      scored: 4518,
      constant: { medianAbsErrS: 166, medianBiasS: 0, withinBand: 0.32 },
      oracle: { medianAbsErrS: 202, medianBiasS: -5, withinBand: 0.39 },
    },
    // Seeded STALE on the 5-10m bucket so the preview exercises the
    // "refresh is due" rendering rather than the quiet happy path.
    priors: {
      snapshot: {
        generatedOn: '2026-08-02', windowStart: '2026-06-14',
        scoredTicks: 4250, runs: 965, users: 6,
      },
      buckets: [
        { bucket: '<2m', committedP50: 124, liveP50: 131, driftRatio: 0.06, scored: 901 },
        { bucket: '2-5m', committedP50: 207, liveP50: 214, driftRatio: 0.03, scored: 1244 },
        { bucket: '5-10m', committedP50: 400, liveP50: 512, driftRatio: 0.28, scored: 1130 },
        { bucket: '10-20m', committedP50: 369, liveP50: 381, driftRatio: 0.03, scored: 819 },
        { bucket: '20m+', committedP50: 450, liveP50: 470, driftRatio: 0.04, scored: 279 },
      ],
      stale: true,
      staleReasons: ['bucket 5-10m drifted 28%'],
    },
    // The guard's whole job is to make "raw" and "displayed" differ: the
    // model's own projections slipped later on 65% of transitions, what the
    // user saw slipped on 21%. "expired" dominates the slip reasons because
    // a run that outlives its estimate now EXTENDS rather than bailing out
    // to an open-ended state — the countdown always shows a number.
    monotonicity: {
      transitions: 3775,
      raw: {
        laterRate: 0.647, earlierRate: 0.199, increasedRate: 0.224,
        medianShiftS: 60, p90ShiftS: 180,
      },
      displayed: {
        transitions: 3775,
        laterRate: 0.21, earlierRate: 0.42, increasedRate: 0.02,
        medianShiftS: 0, p90ShiftS: 60,
      },
      clampRate: 0.31,
      flooredRate: 0.09,
      slipReasons: { expired: 152, new_phase: 44, revision: 27 },
    },
    completionClaims: {
      ticks: 1355, suppressed: 91,
      overFiveMinLeftRate: 0.35, medianActualLeftS: 174,
    },
    byOutcome: [
      { outcome: 'committed', scored: 187, medianAbsErrS: 72.1, withinBand: 0.65 },
      { outcome: 'noop', scored: 24, medianAbsErrS: 96.4, withinBand: 0.50 },
      { outcome: 'error', scored: 13, medianAbsErrS: 148.9, withinBand: 0.31 },
      { outcome: 'stopped', scored: 7, medianAbsErrS: 201.3, withinBand: 0.29 },
    ],
    daily,
  };
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
  estimatorAccuracy,
};
