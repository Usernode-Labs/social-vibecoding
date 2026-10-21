// What the bot-request machine reads inside a transition: the lane's
// settings (whether the bot acts on this request's project at all, for a fix
// it is asked for). Read, not locked: every move here is the instance's own,
// and what it reads only says whether to go on now or later.

import type { Tx } from '../kernel/index.ts';
import { LANE_SETTING_KEYS, botOn, laneSettings } from '../rules/bot-loop.ts';

export interface Facts {
  // The bot acts on this project now (on, not paused, not a staging copy).
  acting: boolean;
}

export const NO_FACTS: Facts = { acting: false };

export async function readFacts(tx: Tx, p: { appId: number; issueNumber: number; staging: boolean }): Promise<Facts> {
  const { rows } = await tx.query(
    `SELECT s.key, s.value, a.slug FROM apps a
       LEFT JOIN platform_settings s ON s.key = ANY($2::text[])
      WHERE a.id = $1`, [p.appId, LANE_SETTING_KEYS]);
  const slug = rows[0]?.slug ?? null;
  const settings = laneSettings(rows.filter((r: any) => r.key).map((r: any) => ({ key: r.key, value: r.value })));
  return { acting: !!slug && botOn(settings, p.staging) && !settings.pausedApps.includes(slug) };
}
