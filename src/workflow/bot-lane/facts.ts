// What the bot-lane machine reads inside a transition: the bot's settings
// (on or off, its paused projects, its caps), the slots in use (from the
// requests: what each took, and grants on their way), the reads and builds
// waiting for one in the queue's order, and when the next waiting request
// becomes eligible. Read under the lane's own lock, which every grant
// takes: two grants are never decided at once.

import type { Tx } from '../kernel/index.ts';
import { BOT_USERNAME } from '../rules/bot-notes.ts';
import { DM } from '../rules/bot-replies.ts';
import {
  BUILD_CANDIDATES_SQL, LANE_DEFAULTS, LANE_SETTING_KEYS, NEXT_ELIGIBLE_SQL, READ_CANDIDATES_SQL, SLOTS_IN_USE_SQL,
  botOn, laneSettings, raisedOf, slotOfRow,
} from '../rules/bot-loop.ts';
import type { LaneSettings, Raised, Slot } from '../rules/bot-loop.ts';

// Homeroom bot parity (P4): a running batch's raise, per request its Build
// started (services/homeroom-bot-batches.js raiseFor): the picks read it
// as rules/bot-loop.ts raisedOf shapes it. Only batches still running.
export const BATCH_RAISES_SQL = `
  SELECT b.app_id, n.issue_number, MAX(b.per_person)::int AS per_person
    FROM homeroom_bot_batches b CROSS JOIN LATERAL unnest(b.started_numbers) AS n(issue_number)
   WHERE b.state = 'running' AND b.ends_at > NOW() AND b.per_person IS NOT NULL
   GROUP BY b.app_id, n.issue_number`;

export interface ReadCandidate {
  app_id: number; issue_number: number; priority: number; reason: string;
  person_id: number | null; follow_up_session_id: number | null; triage_session_id: number | null;
  // The version that last wrote its request (rules/bot-loop.ts READ_SLOTS_SINCE).
  machine_version: number | null;
}
export interface BuildCandidate { app_id: number; issue_number: number; run_id: number; person_id: number | null }

// 19 Nov 2026: the people's DMs with the bot that kept a message whose
// answer ended on OpenRouter's credit (bot-dm machine `data.credit`), told
// when it is back (CreditBack). Read only for that event.
export const CREDIT_OWED_DMS_SQL = `
  SELECT key, data->>'userId' AS user_id FROM wf_instances
   WHERE machine = $1 AND jsonb_typeof(data->'credit') = 'array' AND data->'credit' <> '[]'::jsonb
   ORDER BY key`;

export interface CreditDm { key: string; userId: number }

export interface Facts {
  settings: LaneSettings;
  acting: boolean;
  inUse: Slot[];
  reads: ReadCandidate[];
  builds: BuildCandidate[];
  nextEligible: string | null;
  // Homeroom bot parity (P4): a running batch's raised per-person number,
  // for each request its Build started (BATCH_RAISES_SQL above).
  raised?: Raised;
  // CreditBack only: the DMs owed an answer once credit is back.
  creditDms?: CreditDm[];
}

export const NO_FACTS: Facts = {
  settings: { ...LANE_DEFAULTS, pausedApps: [] }, acting: false, inUse: [], reads: [], builds: [], nextEligible: null,
};

/** The DMs owed an answer once credit is back (CREDIT_OWED_DMS_SQL), whether the bot is on or not. */
export async function readCreditDms(tx: Tx): Promise<CreditDm[]> {
  const { rows } = await tx.query(CREDIT_OWED_DMS_SQL, [DM]);
  return rows.map((r: any) => ({ key: String(r.key), userId: Number(r.user_id) }))
    .filter((r: CreditDm) => Number.isInteger(r.userId) && r.userId > 0);
}

export async function readFacts(tx: Tx, deps: { staging: boolean }): Promise<Facts> {
  const { rows: settingRows } = await tx.query('SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])', [LANE_SETTING_KEYS]);
  const settings = laneSettings(settingRows);
  const acting = botOn(settings, deps.staging);
  if (!acting) return { ...NO_FACTS, settings };
  const { rows: [bot] } = await tx.query('SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME]);
  // No bot account yet: nothing to grant, but the refresh runs (it makes the
  // account, homeroom-bot.js ensureBotUser), or the bot would never start.
  if (!bot) return { ...NO_FACTS, settings, acting };
  const { rows: slotRows } = await tx.query(SLOTS_IN_USE_SQL);
  // Each with its read slot, and whether an older release may be running it.
  const inUse: Slot[] = slotRows.map((r: any) => slotOfRow(r)).filter((sl: Slot) => sl.kind);
  const { rows: reads } = await tx.query(READ_CANDIDATES_SQL, [bot.id, settings.pausedApps]);
  const { rows: builds } = await tx.query(BUILD_CANDIDATES_SQL, [settings.pausedApps]);
  const { rows: [next] } = await tx.query(NEXT_ELIGIBLE_SQL);
  const { rows: raisedRows } = await tx.query(BATCH_RAISES_SQL);
  return {
    settings, acting, inUse, reads: reads as ReadCandidate[], builds: builds as BuildCandidate[],
    nextEligible: next?.at ? new Date(next.at).toISOString() : null,
    raised: raisedOf(raisedRows),
  };
}
