// What the shots machine reads inside a transition: the proposal's row
// (locked first, so a turn or a merge committed while the lock was waited
// for is seen), its app, whether its preview serves a head, and whether
// anyone else works on it (a coding turn, a turn on a local agent, an old
// flow's operation).

import type { Tx } from '../kernel/index.ts';
import { botLookingSql, operationsLiveSql, syncWorkingSql } from '../session-work.ts';

export interface Session {
  id: number;
  appId: number;
  appSlug: string;
  status: string;
  source: string | null;
  // The newest exact head the row names (services/shots-orchestrator.js
  // headForSession): an imported pull request's, a promoted proposal's
  // reviewed head, its checks', a hand-off's, its preview's.
  head: string | null;
  // The revision columns a head event names (its `pin`): an imported pull
  // request's head, a promoted proposal's reviewed head, a hand-off's.
  pins: { imported: string | null; reviewed: string | null; handoff: string | null };
  // A head its preview serves, or whose checks settled (a verdict that
  // needed no preview): ready to be shot.
  readyHeads: string[];
  // Its agent is free: no coding turn, no turn on a local agent, no old
  // flow's operation.
  agentBusy: boolean;
  // The slot as [main] left it, read when the machine first takes the
  // proposal.
  slot: { state: string | null; runId: string | null; detail: any;
    run: { id: string; state: string; head: string; failureCode: string | null } | null };
  // An imported or merged proposal's agent runs in a worker made for the
  // run (services/shots-agent.js temporaryShotsWorker).
  temporaryWorker: boolean;
}

export interface Facts { session: Session | null }

export const OPEN: ReadonlySet<string> = new Set(['active', 'paused', 'promoted', 'merging']);
const SHA = /^[0-9a-f]{40}$/;
const sha = (v: unknown) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);
const SETTLED_CHECKS: ReadonlySet<string> = new Set(['passing', 'failing', 'error', 'skipped']);

export async function readFacts(tx: Tx, sessionId: number): Promise<Facts> {
  await tx.query('SELECT 1 FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
  const { rows: [r] } = await tx.query(
    `SELECT cs.id, cs.app_id, cs.status, cs.source, cs.imported_pr_head_sha, cs.reviewed_head_sha,
            cs.checks_commit_sha, cs.handoff_head_sha, cs.staging_commit_sha, cs.staging_url, cs.check_state,
            cs.shots_state, cs.shots_run_id, cs.shots_detail,
            r.id AS run_id, r.state AS run_state, r.head_sha AS run_head, r.failure_code AS run_failure_code,
            (cs.active_turn IS NOT NULL
              OR EXISTS (SELECT 1 FROM local_agent_turns t
                          WHERE t.session_id = cs.id AND t.status IN ('queued', 'offered', 'accepted', 'running'))
              OR ${operationsLiveSql('cs.id')} OR ${syncWorkingSql('cs.id')} OR ${botLookingSql('cs.id')}) AS agent_busy,
            a.slug AS app_slug
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
       LEFT JOIN shot_runs r ON r.id = cs.shots_run_id
      WHERE cs.id = $1`, [sessionId]);
  if (!r) return { session: null };
  const head = sha(r.imported_pr_head_sha) || sha(r.reviewed_head_sha) || sha(r.checks_commit_sha)
    || sha(r.handoff_head_sha) || sha(r.staging_commit_sha);
  const readyHeads = new Set<string>();
  if (sha(r.staging_commit_sha) && r.staging_url) readyHeads.add(sha(r.staging_commit_sha)!);
  if (sha(r.checks_commit_sha) && SETTLED_CHECKS.has(r.check_state)) readyHeads.add(sha(r.checks_commit_sha)!);
  return {
    session: {
      id: r.id, appId: r.app_id, appSlug: r.app_slug, status: r.status, source: r.source ?? null,
      head, readyHeads: [...readyHeads],
      pins: { imported: sha(r.imported_pr_head_sha), reviewed: sha(r.reviewed_head_sha), handoff: sha(r.handoff_head_sha) },
      agentBusy: !!r.agent_busy,
      slot: {
        state: r.shots_state ?? null, runId: r.shots_run_id ?? null,
        detail: r.shots_detail && typeof r.shots_detail === 'object' ? r.shots_detail : null,
        run: r.run_id ? { id: r.run_id, state: r.run_state, head: r.run_head, failureCode: r.run_failure_code ?? null } : null,
      },
      temporaryWorker: r.source === 'imported' || r.status === 'merged',
    },
  };
}
