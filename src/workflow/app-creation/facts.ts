// What app-creation reads inside its transaction, after the instance lock.

import type { Tx } from '../kernel/index.ts';

export interface Facts {
  app: { id: number; slug: string; status: string; selfHosted: boolean } | null;
  // An older build's process makes it still: its owner's heartbeat is live
  // (the owner lease that made projects before this machine).
  ownedElsewhere: boolean;
  // A first request is owed: the project was made with a description
  // (homeroom_bot_first_versions, written with the row). Read when a setup
  // ends.
  firstRequestOwed: boolean;
  // The one-line reason of the failure the row records.
  failureReason: string | null;
}

// An older build's owner lapsed after this long without a heartbeat.
const OWNER_LAPSE_SECONDS = 90;

export async function readFacts(tx: Tx, appId: number, { firstRequest = false } = {}): Promise<Facts> {
  const { rows: [a] } = await tx.query(
    `SELECT id, slug, status, self_hosted, last_failure->>'reason' AS reason,
            (creating_owner IS NOT NULL AND creating_owner <> 'workflow'
             AND creating_heartbeat_at > NOW() - make_interval(secs => $2)) AS owned_elsewhere
       FROM apps WHERE id = $1`, [appId, OWNER_LAPSE_SECONDS]);
  const app = a ? { id: a.id, slug: a.slug, status: String(a.status), selfHosted: !!a.self_hosted } : null;
  let firstRequestOwed = false;
  if (firstRequest && app) {
    const { rows: [f] } = await tx.query(
      `SELECT 1 FROM homeroom_bot_first_versions WHERE app_id = $1 AND status IN ('waiting', 'filing')`, [appId]);
    firstRequestOwed = !!f;
  }
  return { app, ownedElsewhere: !!a?.owned_elsewhere, firstRequestOwed, failureReason: a?.reason ?? null };
}
