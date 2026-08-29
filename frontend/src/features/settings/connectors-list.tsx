/**
 * `#connectors-list` — the connected chat clients, as the only React writer
 * below that host.
 *
 * The host is STATIC in the React tree (sections/connectors.tsx), so this is a
 * plain child component rather than a portal. settings.js keeps the fetch, the
 * DELETE, the status line and the three sibling blocks whose visibility
 * follows which client families are connected; this file keeps the markup.
 *
 * `Settings._disconnectConnector` is called BY NAME on `window.Settings`, for
 * the reason ./grants-list.tsx gives — and it already owns its own
 * disable-on-click, its refetch and its status reporting, so the component
 * hands it the id and the button and forgets.
 */

import { useStoreState } from '../../lib/use-store-state';
import { connectorsStore } from './connectors-store.js';

type ConnectorView = { id: string; title: string; detail: string };

type ConnectorsState = {
  phase: 'idle' | 'loading' | 'ready';
  connectors: ConnectorView[];
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

export function ConnectorsListView({ phase, connectors }: ConnectorsState) {
  if (phase === 'idle') return null;
  // Bare text nodes, as the two `list.textContent = …` writes produced.
  if (phase === 'loading') return <>Loading connections…</>;
  if (!connectors.length) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-300">
        No chat products connected yet.
      </p>
    );
  }
  return (
    <>
      {connectors.map((connector) => (
        <div
          key={connector.id}
          className="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {connector.title}
              </div>
              <div className="text-xs text-zinc-500 dark:text-zinc-300 mt-1">
                {connector.detail}
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-md border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-200 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              onClick={(e) => controller()?._disconnectConnector?.(connector.id, e.currentTarget)}
            >
              Disconnect
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export function ConnectorsList() {
  return <ConnectorsListView {...useStoreState<ConnectorsState>(connectorsStore)} />;
}
