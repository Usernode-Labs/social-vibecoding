// What the main-check machine reads inside its transaction, after the
// instance lock: the app's row (its repository and the main_check_* columns
// it owns, read when an instance starts from it), and the tests
// known to flake on the app, read only when a run reports.

import type { Tx } from '../kernel/index.ts';

export interface Row {
  slug: string;
  repoUrl: string | null;
  state: string | null;
  sha: string | null;
  at: string | null;
  detail: any;
  pausedSha: string | null;
  resumedSha: string | null;
}

export interface Facts {
  row: Row | null;
  // `<file>\0<test>` of each test seen flaking on the app lately.
  flakes: ReadonlySet<string>;
}

export const NO_FACTS: Facts = { row: null, flakes: new Set() };

// A flake is known for this long after it was last seen (main-watch.js
// FLAKE_MEMORY_DAYS).
const FLAKE_MEMORY_DAYS = 30;

export const testKey = (t: { file?: string | null; test: string }) => `${t.file || ''}\u0000${t.test}`;

export async function readFacts(tx: Tx, appId: number, { flakes = false }: { flakes?: boolean } = {}): Promise<Facts> {
  const { rows: [a] } = await tx.query(
    `SELECT slug, repo_url, main_check_state, main_check_sha, main_check_at, main_check_detail,
            main_check_paused_sha, main_check_resumed_sha
       FROM apps WHERE id = $1`, [appId]);
  const row: Row | null = a ? {
    slug: a.slug, repoUrl: a.repo_url || null, state: a.main_check_state || null, sha: a.main_check_sha || null,
    at: a.main_check_at ? new Date(a.main_check_at).toISOString() : null,
    detail: a.main_check_detail && typeof a.main_check_detail === 'object' ? a.main_check_detail : {},
    pausedSha: a.main_check_paused_sha || null, resumedSha: a.main_check_resumed_sha || null,
  } : null;
  if (!flakes || !row) return { row, flakes: new Set() };
  const { rows } = await tx.query(
    `SELECT file, test FROM main_test_flakes
      WHERE app_id = $1 AND last_seen_at > NOW() - ($2::int * interval '1 day')`, [appId, FLAKE_MEMORY_DAYS]);
  return { row, flakes: new Set(rows.map((r: { file: string; test: string }) => testKey(r))) };
}
