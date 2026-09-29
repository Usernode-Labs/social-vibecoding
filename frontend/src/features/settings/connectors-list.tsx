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

import { GroupedList, ListRow } from '@/components/ui/grouped-list';

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
      <p className="px-4 text-[0.9375rem] text-zinc-500 dark:text-zinc-400">
        No chat products connected yet.
      </p>
    );
  }
  // #2370: one grouped card, in the language the rest of the pane wears now
  // — was a bordered 12px card per connection. Disconnect stays its OWN button
  // and the row is not a control: a destructive action never gets a whole
  // row's width, where a stray thumb finds it.
  return (
    <GroupedList className="mx-0">
      {connectors.map((connector) => (
        <ListRow
          key={connector.id}
          inset="text"
          chevron={false}
          title={connector.title}
          titleClassName="font-medium"
          subtitle={connector.detail}
          subtitleClassName="whitespace-normal"
          trailing={(
            <button
              type="button"
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-full bg-red-500/10 px-4 text-[0.9375rem] font-medium text-red-700 dark:text-red-400 hover:bg-red-500/15 transition-colors"
              onClick={(e) => controller()?._disconnectConnector?.(connector.id, e.currentTarget)}
            >
              Disconnect
            </button>
          )}
        />
      ))}
    </GroupedList>
  );
}

export function ConnectorsList() {
  return <ConnectorsListView {...useStoreState<ConnectorsState>(connectorsStore)} />;
}
