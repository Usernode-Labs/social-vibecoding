// release: what a release of the platform runs once, whichever process runs
// it. Every process that runs the workflow says it booted (Booted, keyed by
// the build, so a release's processes append it once between them); its
// first one queues the release's work (release.adopt), which whichever
// process claims it runs, under a lease, retried like any work and shown in
// Admin → Workflows. Booting waits for none of it, and a second replica of
// the conductor does not run it again (docs/workflows.md, "Running it").

import { NONE, defineMachine, ok, reject } from '../kernel/index.ts';
import type { Event, Json, Outcome, WorkResultPayload } from '../kernel/index.ts';

export const MACHINE = 'release';
export const WORK = Object.freeze({ adopt: 'release.adopt' });
export const releaseKey = (release: string) => `release:${release}`;

type Name = 'adopting' | 'done' | 'failed';
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
    ? { next: { name, data: { ...data, adopted: e.payload.result ?? null } } }
    : { next: { name, data: { ...data, error: e.payload.error?.message ?? null } } };
};

export function releaseMachine() {
  return defineMachine<RState, null>({
    name: MACHINE,
    version: 1,
    events: { Booted: release },
    create: ['Booted'],
    terminal: ['done', 'failed'],
    decode: (row) => (row.state === NONE ? { name: NONE, data: null } : { name: row.state as Name, data: row.data as Data }),
    authorize: {
      Booted: (e) => (e.source.kind === 'system' ? ok() : reject('system_only')),
    },
    transitions: {
      [NONE]: {
        Booted: {
          to: (s, e) => ({
            next: { name: 'adopting', data: { release: e.payload.release } },
            work: [{ kind: WORK.adopt, key: 'adopt', input: { release: e.payload.release } }],
          }),
        },
      },
      adopting: {
        Booted: { ignore: 'adopting' },
        WorkSucceeded: { to: ended('done') },
        WorkFailed: { to: ended('failed') },
        WorkExhausted: { to: ended('failed') },
      },
      done: { '*': { ignore: 'done' } },
      failed: { '*': { ignore: 'failed' } },
    },
  });
}
