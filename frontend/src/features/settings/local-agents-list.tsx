/**
 * `#settings-local-agents-list` — the attached machines (#907), as the only
 * React writer below that host.
 *
 * settings.js keeps the fetch, the DELETE, the confirm dialog and the
 * section's own `hidden`; this file keeps the markup. `_detachLocalAgent`
 * takes the whole view row rather than an id because its confirm text names
 * the machine — the same argument the DOM builder passed it.
 */

import { useStoreState } from '../../lib/use-store-state';
import { localAgentsStore } from './local-agents-store.js';

type LocalAgentView = {
  leaseId: string | null;
  title: string;
  where: string;
  detail: string;
  detachable: boolean;
};

type LocalAgentsState = { phase: 'idle' | 'ready'; agents: LocalAgentView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

export function LocalAgentsListView({ phase, agents }: LocalAgentsState) {
  if (phase === 'idle') return null;
  return (
    <>
      {agents.map((agent, i) => (
        <div
          key={agent.leaseId || `demo:${i}`}
          className="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
                {agent.title}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-300 mt-1 truncate">
                {agent.where}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-300 mt-0.5">{agent.detail}</div>
            </div>
            {/*
                Demo rows (staging ?demo=1) are fabricated per request and own
                no lease, so there is nothing for a button to release.
            */}
            {agent.detachable ? (
              <button
                type="button"
                className="shrink-0 rounded border border-zinc-400 dark:border-zinc-600 px-2 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                onClick={(e) => controller()?._detachLocalAgent?.(agent, e.currentTarget)}
              >
                Detach
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}

export function LocalAgentsList() {
  return <LocalAgentsListView {...useStoreState<LocalAgentsState>(localAgentsStore)} />;
}
