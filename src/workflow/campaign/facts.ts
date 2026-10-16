// What the campaign machine reads inside a transition. The campaign's row is
// locked first: during a rollout an older release's driver may still write
// it (its lease, its app rows), and the machine adopts a campaign only once
// that driver has let it go.

import type { Event, Tx } from '../kernel/index.ts';

export interface CampaignRow {
  id: number;
  issueId: number | null;
  title: string;
  status: string;
  targetFilter: string[] | null;
  // An older release's driver holds its lease right now.
  drivenElsewhere: boolean;
  // The app whose thread carries the governance proposal (the platform's own).
  threadAppId: number | null;
}

// A campaign app row as it stands (adoption of a campaign an older release
// started), or a target app (a campaign starting fresh).
export interface AppRow {
  appId: number;
  slug: string;
  state: string | null;
  sessionId: number | null;
  prNumber: number | null;
  error: string | null;
}

// A proposal the campaign asked to go up for a vote: where it stands.
export interface Asked {
  appId: number;
  sessionId: number | null;
  status: string | null;
  prNumber: number | null;
  // The proposal machine's instance: its state, and whether a promote is
  // still under way there.
  state: string | null;
  promoting: boolean;
  answer: { ok?: boolean; code?: string | null; message?: string | null } | null;
  // The campaign's last promote of it, as the proposal machine settled it
  // (result null: not applied yet): a rejected one (the guard refused it)
  // sends no answer of its own.
  promote: { result: string | null; reason: string | null } | null;
  // Its app row or its proposal is gone (the app was deleted).
  gone: boolean;
}

export interface Facts {
  campaign: CampaignRow | null;
  // Start: the rows it already has, else its targets.
  apps: AppRow[];
  // MergeGreen: its proposals in review whose checks passed or were skipped.
  green: { sessionId: number; appId: number }[];
  // Check: its proposals still being put up for a vote.
  asked: Asked[];
  // A change's result: whether its app still exists (locked, so it is not
  // deleted under the proposal row the result writes).
  appAlive: boolean | null;
}

export const NO_FACTS: Facts = { campaign: null, apps: [], green: [], asked: [], appAlive: null };

async function readCampaign(tx: Tx, id: number): Promise<CampaignRow | null> {
  const { rows: [r] } = await tx.query(
    `SELECT mc.id, mc.issue_id, mc.title, mc.status, mc.target_filter,
            (mc.lease_until IS NOT NULL AND mc.lease_until > now() AND mc.runner_id IS DISTINCT FROM 'workflow') AS driven_elsewhere,
            (SELECT i.app_id FROM issues i WHERE i.id = mc.issue_id) AS thread_app_id
       FROM maintenance_campaigns mc WHERE mc.id = $1 FOR UPDATE`, [id]);
  if (!r) return null;
  const filter = Array.isArray(r.target_filter) && r.target_filter.length ? r.target_filter.map(String) : null;
  return {
    id: r.id, issueId: r.issue_id ?? null, title: String(r.title), status: String(r.status), targetFilter: filter,
    drivenElsewhere: !!r.driven_elsewhere, threadAppId: r.thread_app_id ?? null,
  };
}

// The rows an older release seeded, in their order; none: the apps the
// campaign reaches, fixed now (Q2): every live app with a repository, but the
// platform itself and an app moderation suspended, within the slug filter.
async function readApps(tx: Tx, c: CampaignRow): Promise<AppRow[]> {
  // A campaign that ended before the machine took it keeps the rows it has
  // (none, if it reached no app): it is not given today's fleet.
  const { rows: existing } = await tx.query(
    `SELECT mca.app_id, a.slug, mca.state, mca.session_id, mca.error, cs.pr_number
       FROM maintenance_campaign_apps mca
       JOIN apps a ON a.id = mca.app_id
       LEFT JOIN chat_sessions cs ON cs.id = mca.session_id
      WHERE mca.campaign_id = $1 ORDER BY mca.id`, [c.id]);
  if (existing.length || c.status !== 'running') {
    return existing.map((r: any) => ({ appId: r.app_id, slug: String(r.slug), state: r.state ?? null,
      sessionId: r.session_id ?? null, prNumber: r.pr_number ?? null, error: r.error ?? null }));
  }
  const { rows } = await tx.query(
    `SELECT a.id, a.slug FROM apps a
      WHERE a.repo_url IS NOT NULL AND a.self_hosted IS NOT TRUE AND a.status = 'running'
        AND a.moderation_suspended_at IS NULL
        AND ($1::text[] IS NULL OR a.slug = ANY($1::text[]))
      ORDER BY a.id`, [c.targetFilter]);
  return rows.map((r: any) => ({ appId: r.id, slug: String(r.slug), state: null, sessionId: null, prNumber: null, error: null }));
}

async function readGreen(tx: Tx, campaignId: number) {
  const { rows } = await tx.query(
    `SELECT cs.id, cs.app_id FROM maintenance_campaign_apps mca
       JOIN chat_sessions cs ON cs.id = mca.session_id
      WHERE mca.campaign_id = $1 AND cs.status = 'promoted' AND cs.check_state IN ('passing', 'skipped')
      ORDER BY mca.id`, [campaignId]);
  return rows.map((r: any) => ({ sessionId: Number(r.id), appId: Number(r.app_id) }));
}

async function readAsked(tx: Tx, campaignId: number, appIds: number[]): Promise<Asked[]> {
  if (!appIds.length) return [];
  // From the apps asked about, so one deleted since (its row gone with it)
  // is still answered for.
  const { rows } = await tx.query(
    `SELECT x.app_id, mca.id IS NULL AS no_row, mca.session_id, cs.id IS NULL AS no_session, cs.status, cs.pr_number, w.state,
            (w.data->'promoting') IS NOT NULL AND w.data->'promoting' <> 'null'::jsonb AS promoting,
            w.data->'answer' AS answer, p.id AS promote_id, p.result AS promote_result, p.reason AS promote_reason
       FROM unnest($2::int[]) AS x(app_id)
       LEFT JOIN maintenance_campaign_apps mca ON mca.campaign_id = $1 AND mca.app_id = x.app_id
       LEFT JOIN chat_sessions cs ON cs.id = mca.session_id
       LEFT JOIN wf_instances w ON w.machine = 'proposal' AND w.key = 'session:' || mca.session_id
       LEFT JOIN LATERAL (
         SELECT e.id, e.result, e.reason FROM wf_events e
          WHERE e.machine = 'proposal' AND e.key = 'session:' || mca.session_id AND e.type = 'Promote'
            AND e.source->>'kind' = 'message' AND e.source->'from'->>'machine' = 'campaign'
          ORDER BY e.id DESC LIMIT 1) p ON TRUE`, [campaignId, appIds]);
  return rows.map((r: any) => ({
    appId: r.app_id, sessionId: r.session_id ?? null, status: r.status ?? null, prNumber: r.pr_number ?? null,
    state: r.state ?? null, promoting: !!r.promoting, answer: r.answer && typeof r.answer === 'object' ? r.answer : null,
    promote: r.promote_id == null ? null : { result: r.promote_result ?? null, reason: r.promote_reason ?? null },
    gone: !!r.no_row || (r.session_id != null && !!r.no_session),
  }));
}

export async function readFacts(tx: Tx, campaignId: number, event: Event<any>, proposing: number[]): Promise<Facts> {
  const campaign = await readCampaign(tx, campaignId);
  if (!campaign) return NO_FACTS;
  const out: Facts = { ...NO_FACTS, campaign };
  if (event.type === 'Start') out.apps = await readApps(tx, campaign);
  if (event.type === 'MergeGreen') out.green = await readGreen(tx, campaignId);
  if (event.type === 'Check') out.asked = await readAsked(tx, campaignId, proposing);
  const p = event.payload as any;
  if ((event.type === 'WorkSucceeded' || event.type === 'WorkFailed' || event.type === 'WorkExhausted') && typeof p?.workKey === 'string') {
    const appId = Number(/^app:(\d+):/.exec(p.workKey)?.[1]);
    if (Number.isInteger(appId) && appId > 0) {
      out.appAlive = (await tx.query('SELECT 1 FROM apps WHERE id = $1 FOR KEY SHARE', [appId])).rows.length > 0;
    }
  }
  return out;
}
