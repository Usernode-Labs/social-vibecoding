// What the campaign machine reads inside a transition. The campaign's row is
// locked first.

import type { Event, Tx } from '../kernel/index.ts';

export interface CampaignRow {
  id: number;
  issueId: number | null;
  title: string;
  status: string;
  targetFilter: string[] | null;
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

// Whether there is room for the campaign to change its next app: the
// sessions spending the platform-wide budget (session-caps.js
// GLOBAL_SESSIONS_SQL) against the session limit, and how many of its own
// proposals are still being put up or up for a vote.
export interface Room {
  used: number;
  // The session limit: the admin's setting (services/session-limit.js,
  // platform_settings max_global_sessions), else the deploy's.
  limit: number;
  open: number;
}

export interface Facts {
  campaign: CampaignRow | null;
  // Start: the rows it already has, else its targets.
  apps: AppRow[];
  // MergeGreen, AutoMerge, and Check while auto-merge is on: its proposals
  // in review whose checks passed or were skipped.
  green: { sessionId: number; appId: number }[];
  // Check: its proposals still being put up for a vote.
  asked: Asked[];
  // A change's result: whether its app still exists (locked, so it is not
  // deleted under the proposal row the result writes).
  appAlive: boolean | null;
  // The room it has to change its next app (see Room), and how many of its
  // proposals are open (auto-merge's check runs while any are); null for a
  // drain.
  room: Room | null;
}

export const NO_FACTS: Facts = { campaign: null, apps: [], green: [], asked: [], appAlive: null, room: null };

async function readCampaign(tx: Tx, id: number): Promise<CampaignRow | null> {
  const { rows: [r] } = await tx.query(
    `SELECT mc.id, mc.issue_id, mc.title, mc.status, mc.target_filter,
            (SELECT i.app_id FROM issues i WHERE i.id = mc.issue_id) AS thread_app_id
       FROM maintenance_campaigns mc WHERE mc.id = $1 FOR UPDATE`, [id]);
  if (!r) return null;
  const filter = Array.isArray(r.target_filter) && r.target_filter.length ? r.target_filter.map(String) : null;
  return {
    id: r.id, issueId: r.issue_id ?? null, title: String(r.title), status: String(r.status), targetFilter: filter,
    threadAppId: r.thread_app_id ?? null,
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

// The session limit as services/session-limit.js resolves it (its setting,
// read here without that module's cache, else the deploy's value), and the
// counts it is held against.
const SETTING_MAX = 2000;
async function readRoom(tx: Tx, campaignId: number, deployLimit: number): Promise<Room> {
  const { rows: [r] } = await tx.query(
    `SELECT (SELECT value FROM platform_settings WHERE key = 'max_global_sessions') AS setting,
            (SELECT COUNT(*)::int FROM chat_sessions
              WHERE status IN ('active', 'promoted') AND source IS DISTINCT FROM 'imported') AS used,
            (SELECT COUNT(*)::int FROM maintenance_campaign_apps mca JOIN chat_sessions cs ON cs.id = mca.session_id
              WHERE mca.campaign_id = $1 AND cs.status IN ('active', 'promoted', 'merging')) AS open`, [campaignId]);
  const n = parseInt(r?.setting == null ? '' : String(r.setting), 10);
  const limit = Number.isInteger(n) && n >= 1 && n <= SETTING_MAX ? n : deployLimit;
  return { used: Number(r?.used) || 0, limit, open: Number(r?.open) || 0 };
}

export async function readFacts(tx: Tx, campaignId: number, event: Event<any>, proposing: number[],
  o: { deployLimit: number; autoMerge?: boolean } = { deployLimit: 100 }): Promise<Facts> {
  const campaign = await readCampaign(tx, campaignId);
  if (!campaign) return NO_FACTS;
  const out: Facts = { ...NO_FACTS, campaign };
  // Every event that may change the next app (a retry of a finished
  // campaign's app included), or that sets the check (a stop keeps it for
  // auto-merge), reads it; an admin's drain does not.
  if (event.type !== 'MergeGreen') out.room = await readRoom(tx, campaignId, o.deployLimit);
  if (event.type === 'Start') out.apps = await readApps(tx, campaign);
  // The green ones: for a drain, for auto-merge being turned on, and for
  // each check while it is on.
  if (event.type === 'MergeGreen' || event.type === 'AutoMerge' || (event.type === 'Check' && o.autoMerge)) {
    out.green = await readGreen(tx, campaignId);
  }
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
