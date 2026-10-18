// What the bot-lane machine reads inside a transition: the bot's settings
// (on or off, its paused projects, its caps), the slots in use (from the
// requests: what each took, and grants on their way), the reads and builds
// waiting for one in the queue's order, and when the next waiting request
// becomes eligible. Read under the lane's own lock, which every grant
// takes: two grants are never decided at once.

import type { Tx } from '../kernel/index.ts';
import { BOT_USERNAME } from '../rules/bot-notes.ts';
import {
  BUILD_CANDIDATES_SQL, LANE_SETTING_KEYS, NEXT_ELIGIBLE_SQL, READ_CANDIDATES_SQL, SLOTS_IN_USE_SQL,
  botOn, laneSettings,
} from '../rules/bot-loop.ts';
import type { LaneSettings, Slot } from '../rules/bot-loop.ts';

export interface ReadCandidate {
  app_id: number; issue_number: number; priority: number; reason: string;
  person_id: number | null; follow_up_session_id: number | null; triage_session_id: number | null;
}
export interface BuildCandidate { app_id: number; issue_number: number; run_id: number; person_id: number | null }

export interface Facts {
  settings: LaneSettings;
  acting: boolean;
  inUse: Slot[];
  reads: ReadCandidate[];
  builds: BuildCandidate[];
  nextEligible: string | null;
}

export const NO_FACTS: Facts = {
  settings: { mode: 'off', pausedApps: [], liveAtOnce: 12, perPerson: 3 }, acting: false, inUse: [], reads: [], builds: [], nextEligible: null,
};

export async function readFacts(tx: Tx, deps: { staging: boolean }): Promise<Facts> {
  const { rows: settingRows } = await tx.query('SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])', [LANE_SETTING_KEYS]);
  const settings = laneSettings(settingRows);
  const acting = botOn(settings, deps.staging);
  if (!acting) return { ...NO_FACTS, settings };
  const { rows: [bot] } = await tx.query('SELECT id FROM users WHERE username = $1 AND is_synthetic = TRUE', [BOT_USERNAME]);
  if (!bot) return { ...NO_FACTS, settings };
  const { rows: slotRows } = await tx.query(SLOTS_IN_USE_SQL);
  const inUse: Slot[] = slotRows
    .map((r: any) => ({ kind: String(r.slot?.kind || ''), appId: Number(r.slot?.appId ?? r.app_id), person: String(r.slot?.person || `a${r.app_id}`) }))
    .filter((sl: Slot) => sl.kind);
  const { rows: reads } = await tx.query(READ_CANDIDATES_SQL, [bot.id, settings.pausedApps]);
  const { rows: builds } = await tx.query(BUILD_CANDIDATES_SQL, [settings.pausedApps]);
  const { rows: [next] } = await tx.query(NEXT_ELIGIBLE_SQL);
  return {
    settings, acting, inUse, reads: reads as ReadCandidate[], builds: builds as BuildCandidate[],
    nextEligible: next?.at ? new Date(next.at).toISOString() : null,
  };
}
