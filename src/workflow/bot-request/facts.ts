// What the bot-request machine reads inside a transition: the lane's
// settings (whether the bot acts on this request's project at all, for a fix
// it is asked for), and, for a look an older release left, whether that
// release's turn still runs and what it recorded since. Read, not locked:
// every move here is the instance's own, and what it reads only says
// whether to go on now or look again later.

import type { Tx } from '../kernel/index.ts';
import { BOT_USERNAME } from '../rules/bot-notes.ts';
import { LANE_SETTING_KEYS, botOn, laneSettings } from '../rules/bot-loop.ts';

export interface Facts {
  // The bot acts on this project now (on, not paused, not a staging copy).
  acting: boolean;
  // A look an older release claimed: its turn (one with no owner, on the
  // project's triage session or a change for the request) still runs.
  olderBusy: boolean;
}

export const NO_FACTS: Facts = { acting: false, olderBusy: false };

export async function readFacts(tx: Tx, p: { appId: number; issueNumber: number; staging: boolean; older: { claimedAt: string } | null; wantActing: boolean }): Promise<Facts> {
  let acting = false;
  if (p.wantActing) {
    const { rows } = await tx.query(
      `SELECT s.key, s.value, a.slug FROM apps a
         LEFT JOIN platform_settings s ON s.key = ANY($2::text[])
        WHERE a.id = $1`, [p.appId, LANE_SETTING_KEYS]);
    const slug = rows[0]?.slug ?? null;
    const settings = laneSettings(rows.filter((r: any) => r.key).map((r: any) => ({ key: r.key, value: r.value })));
    acting = !!slug && botOn(settings, p.staging) && !settings.pausedApps.includes(slug);
  }
  if (!p.older) return { ...NO_FACTS, acting };
  const { rows: [r] } = await tx.query(
    `SELECT EXISTS (
              SELECT 1 FROM chat_sessions cs JOIN users u ON u.id = cs.user_id AND u.username = $3 AND u.is_synthetic
               WHERE cs.app_id = $1 AND cs.active_turn IS NOT NULL AND cs.active_turn->'owner' IS NULL
                 AND (cs.branch_name = 'main' OR $2 = ANY(cs.linked_issues))) AS busy`,
    [p.appId, p.issueNumber, BOT_USERNAME]);
  return { acting, olderBusy: !!r?.busy };
}
