import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
/**
 * `#settings-local-agents-list` — the attached machines (#907), as the only
 * React writer below that host.
 *
 * settings.js keeps the fetch, the DELETE, the confirm dialog and the
 * section's own `hidden`; this file keeps the markup. `_detachLocalAgent`
 * takes the whole view row rather than an id because its confirm text names
 * the machine — the same argument the DOM builder passed it.
 */

import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { localAgentsStore } from './local-agents-store.js';

type LocalAgentView = {
  leaseId: string | null;
  title: string;
  where: string;
  runtime: string;
  /** The raw instant, stamped here rather than by settings.js (#1808). */
  lastSeenAt: string | null;
  detachable: boolean;
};

type LocalAgentsState = { phase: 'idle' | 'ready'; agents: LocalAgentView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/** Matches ROW_CLASS in ./grants-list.tsx — one row language on this screen. */
const ROW_CLASS = 'rounded-lg bg-white dark:bg-zinc-900 px-3 py-2 text-xs';

function AgentRow({ agent }: { agent: LocalAgentView }) {
  const seen = agoStamp(agent.lastSeenAt);
  return (
    <div className={ROW_CLASS}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">
            {agent.title}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 truncate">
            {agent.where}
          </div>
          {/*
              #1808: "last seen" is this row's whole point, so the stamp stops
              being relative at a week — a machine last seen in March gets a
              date, not "168d ago" — and `title` carries the exact instant for
              anyone chasing down a lease.
          */}
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            <LocalizedValue render={() => (tr("settings:value1_last_seen_f563e42d", { value1: agent.runtime }))} />
            <LocalizedValue render={() => (seen.text ? (
              <time dateTime={agent.lastSeenAt || undefined} title={seen.title}>{seen.text}</time>
            ) : tr("settings:unknown_b23a6a84"))} />
          </div>
        </div>
        {/*
            Demo rows (staging ?demo=1) are fabricated per request and own
            no lease, so there is nothing for a button to release.
        */}
        {agent.detachable ? (
          <button
            type="button"
            className="shrink-0 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-2 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-200 transition-colors"
            onClick={(e) => controller()?._detachLocalAgent?.(agent, e.currentTarget)}
          ><Message id="settings:detach_74bc1174" /></button>
        ) : null}
      </div>
    </div>
  );
}

export function LocalAgentsListView({ phase, agents }: LocalAgentsState) {
  if (phase === 'idle') return null;
  return (
    <>
      {agents.map((agent, i) => (
        <AgentRow key={agent.leaseId || `demo:${i}`} agent={agent} />
      ))}
    </>
  );
}

export function LocalAgentsList() {
  useUiLanguage();
  return <LocalAgentsListView {...useStoreState<LocalAgentsState>(localAgentsStore)} />;
}
