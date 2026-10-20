// release: what a release of the platform runs once, whichever of its
// processes runs it. Every process that runs the workflow says it booted
// (Booted, keyed by the build, so a release's processes append it once
// between them); its first one queues the release's work (release.adopt),
// which only a process of that release claims (an older build still running
// during the rollout would run its own, older adoptions: WorkHandler.
// ownRelease), under a lease, retried like any work and shown in Admin →
// Workflows. Booting waits for none of it, and a second replica of the
// conductor does not run it again (docs/workflows.md, "Running it"). A
// release none of whose processes took its work in ADOPT_WITHIN_MS (it was
// replaced first) is abandoned: the next release adopts what is left.

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, WorkResultPayload } from '../kernel/index.ts';

export const MACHINE = 'release';
export const WORK = Object.freeze({ adopt: 'release.adopt' });
export const releaseKey = (release: string) => `release:${release}`;
// A release's processes claim its work at once (Booted is appended just
// before their loops start); one that has not in this long is gone.
export const ADOPT_WITHIN_MS = 10 * 60 * 1000;

type Name = 'adopting' | 'done' | 'failed' | 'abandoned';
interface Data { release: string; adopted?: Json; error?: string | null }
export type RState = { name: Name; data: Data } | { name: typeof NONE; data: null };

const release = (p: any) => {
  const r = typeof p?.release === 'string' ? p.release.trim() : '';
  if (!r || r.length > 64) throw new Error('release must name the build');
  return { release: r };
};

const ended = (name: 'done' | 'failed') => (s: RState, e: Event<WorkResultPayload>): Outcome<RState> => {
  const data = (s as { data: Data }).data;
  return name === 'done'
    ? { next: { name, data: { ...data, adopted: e.payload.result ?? null } }, timer: null }
    : { next: { name, data: { ...data, error: e.payload.error?.message ?? null } }, timer: null };
};

// Whether the release's work is still its own to finish (Expired then
// waits for it rather than give it up under it): a process of the release
// is running it now, or one that may run it is alive, its work waiting out a
// retry's backoff (a release whose processes stay is never abandoned for a
// failed try of its work).
interface Facts { running: boolean }
const LIVE_SECONDS = 45;

export function releaseMachine() {
  return defineMachine<RState, Facts>({
    name: MACHINE,
    // 2: Expired waits for a release whose processes live (its facts).
    version: 2,
    events: { Booted: release, Expired: () => ({}) },
    create: ['Booted'],
    terminal: ['done', 'failed', 'abandoned'],
    decode: (row) => (row.state === NONE ? { name: NONE, data: null } : { name: row.state as Name, data: row.data as Data }),
    async facts(tx, state, event, ctx) {
      if (event.type !== 'Expired') return { running: false };
      const release = (state as { data?: Data }).data?.release ?? null;
      const { rows: [w] } = await tx.query(
        `SELECT 1 FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3
            AND ((status = 'running' AND lease_until > now())
              OR (status = 'queued' AND EXISTS (
                    SELECT 1 FROM platform_processes p
                     WHERE (p.release = $4 OR ($4 LIKE 'dev:%' AND p.release IS NULL))
                       AND p.role <> 'web' AND p.state = 'serving'
                       AND p.heartbeat_at > now() - make_interval(secs => $5))))`,
        [MACHINE, ctx.key, WORK.adopt, release, LIVE_SECONDS]);
      return { running: !!w };
    },
    authorize: {
      Booted: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
      Expired: (e) => (e.source.kind === 'timer' ? ok() : reject('timer_only')),
    },
    transitions: {
      [NONE]: {
        Booted: {
          to: (s, e, f, ctx) => ({
            next: { name: 'adopting', data: { release: e.payload.release } },
            work: [{ kind: WORK.adopt, key: 'adopt', input: { release: e.payload.release } }],
            timer: { at: new Date(ctx.now.getTime() + ADOPT_WITHIN_MS), event: { type: 'Expired' } },
          }),
        },
      },
      adopting: {
        Booted: { ignore: 'adopting' },
        WorkSucceeded: { to: ended('done') },
        WorkFailed: { to: ended('failed') },
        WorkExhausted: { to: ended('failed') },
        // None of its processes took its work: it was replaced first. The
        // work is given up (a claim under way finishes and is refused as
        // stale); the next release adopts what is left.
        Expired: {
          to: (s, e, f, ctx) => (f.running
            // Its own process is at it: wait for it.
            ? { next: s, timer: { at: new Date(ctx.now.getTime() + ADOPT_WITHIN_MS), event: { type: 'Expired' } } }
            : { next: { name: 'abandoned', data: (s as { data: Data }).data }, cancel: [{ kind: WORK.adopt, key: 'adopt' }] }),
        },
      },
      done: { '*': { ignore: 'done' } },
      failed: { '*': { ignore: 'failed' } },
      abandoned: { '*': { ignore: 'abandoned' } },
    },
  });
}
