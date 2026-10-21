// What app-creation reads inside its transaction, after the instance lock.

import type { Tx } from '../kernel/index.ts';

export interface Facts {
  app: { id: number; slug: string; status: string; selfHosted: boolean; repoUrl: string | null } | null;
  // A first request is owed: the project was made with a description
  // (homeroom_bot_first_versions, written with the row) and has a
  // repository to file it in. Read when a setup ends.
  firstRequestOwed: boolean;
  // The one-line reason of the failure the row records.
  failureReason: string | null;
  // Its first deploy, as app delivery holds it (read at a deadline and at a
  // Retry): a request of this machine's it still owes an answer (one it
  // answered DeliveryFailed stays open there for a later deploy, but that
  // deploy failed), and when app delivery last deployed the app.
  delivery: { asked: boolean; lastDeployAt: string | null } | null;
}

export async function readFacts(tx: Tx, appId: number, { firstRequest = false, delivery = false } = {}): Promise<Facts> {
  const { rows: [a] } = await tx.query(
    `SELECT id, slug, status, self_hosted, repo_url, last_failure->>'reason' AS reason
       FROM apps WHERE id = $1`, [appId]);
  const app = a ? { id: a.id, slug: a.slug, status: String(a.status), selfHosted: !!a.self_hosted, repoUrl: a.repo_url || null } : null;
  let firstRequestOwed = false;
  if (firstRequest && app?.repoUrl) {
    const { rows: [f] } = await tx.query(
      `SELECT 1 FROM homeroom_bot_first_versions WHERE app_id = $1 AND status IN ('waiting', 'filing')`, [appId]);
    firstRequestOwed = !!f;
  }
  let held: Facts['delivery'] = null;
  if (delivery && app) {
    const { rows: [d] } = await tx.query(
      `SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(data->'requests', '[]'::jsonb)) r
                       WHERE r->'from'->>'machine' = 'app-creation'
                         AND COALESCE((r->>'told')::boolean, false) = false) AS asked,
              data->'last'->>'at' AS last_at
         FROM wf_instances WHERE machine = 'app-delivery' AND key = 'app:' || $1::text`, [appId]);
    held = { asked: !!d?.asked, lastDeployAt: d?.last_at ?? null };
  }
  return { app, firstRequestOwed, failureReason: a?.reason ?? null, delivery: held };
}
