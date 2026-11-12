/**
 * A tool's status word and its connections, on its card in Settings > Connectors.
 *
 * Two leaves, each the only writer below its host in sections/connectors.tsx
 * (`[data-connector-status]` in the card's top row, `[data-connector-connections]`
 * under it). The rest of the card is static markup settings.js writes into, so
 * no state lives above these. settings.js keeps the fetch, the DELETE, the
 * status line and the blocks whose visibility follows what is connected.
 *
 * `Settings._disconnectConnector` is called BY NAME on `window.Settings`, for
 * the reason ./grants-list.tsx gives — and it already owns its own
 * disable-on-click, its refetch and its status reporting, so the component
 * hands it the id and the button and forgets. `Settings._reconnectConnector`
 * likewise, for the reason it gives: Reconnect opens this card's guide on the
 * step that signs in again, and that guide is static markup settings.js owns.
 */

import { ListRow } from '@/components/ui/grouped-list';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { connectorsStore } from './connectors-store.js';

type ToolKey = 'claude' | 'chatgpt' | 'codex' | 'generic';
type StatusKey = 'working' | 'unused' | 'attention' | 'none';
type ConnectionView = {
  id: string;
  title: string;
  detail: string;
  capabilities: string | null;
  /** Its sign-in ran out and its guide has a step that signs in again (#6137). */
  reconnect?: boolean;
};
type ToolView = { key: ToolKey; status: StatusKey; connections: ConnectionView[] };
type ConnectorsState = { phase: 'idle' | 'loading' | 'ready'; tools: ToolView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

const STATUS_WORD: Record<StatusKey, string> = {
  working: 'settings:connectors.tool.status.working',
  unused: 'settings:connectors.tool.status.unused',
  attention: 'settings:connectors.tool.status.attention',
  none: 'settings:connectors.tool.status.none',
};

/**
 * Plain grey words, not a pill: a settled state gets no fill. The amber dot is
 * the one mark on the card, and only for the state that is asking for something.
 */
export function ToolStatusView({ status }: { status: StatusKey }) {
  const t = useMessages('settings');
  return (
    <span className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
      {status === 'attention' ? (
        <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
      ) : null}
      {t(STATUS_WORD[status])}
    </span>
  );
}

/**
 * Disconnect stays its OWN button and the row is not a control: a destructive
 * action never gets a whole row's width, where a stray thumb finds it.
 *
 * An expired row whose guide has a sign-in step also offers Reconnect (#6137), under its lines rather than
 * beside Disconnect: two buttons in the trailing edge leave a phone's title a
 * few letters wide. It is the list's tinted control (the guide's "Ask Claude"
 * surface), the one action the row asks for.
 */
export function ToolConnectionsView({ tool, connections }: { tool: ToolKey; connections: ConnectionView[] }) {
  const t = useMessages('settings');
  return (
    <>
      {connections.map((connection) => (
        <ListRow
          key={connection.id}
          inset="text"
          chevron={false}
          title={connection.title}
          titleClassName="font-medium"
          subtitle={(
            <>
              <span className="block">{connection.detail}</span>
              {connection.capabilities ? <span className="mt-0.5 block">{connection.capabilities}</span> : null}
              {connection.reconnect ? (
                <button
                  type="button"
                  data-connector-reconnect={tool}
                  className="mt-2 inline-flex min-h-[44px] items-center rounded-full bg-zinc-100 px-4 text-[0.9375rem] font-semibold text-violet-700 transition-colors hover:bg-zinc-200 dark:bg-zinc-800 dark:text-violet-400 dark:hover:bg-zinc-700"
                  onClick={() => controller()?._reconnectConnector?.(tool)}
                >
                  {t('settings:connectors.list.reconnect')}
                </button>
              ) : null}
            </>
          )}
          subtitleClassName="whitespace-normal"
          trailing={(
            <button
              type="button"
              className="ui-btn-sm inline-flex min-h-[44px] shrink-0 items-center rounded-full bg-red-500/10 px-4 text-[0.9375rem] font-medium text-red-700 dark:text-red-400 hover:bg-red-500/15 transition-colors"
              onClick={(e) => controller()?._disconnectConnector?.(connection.id, e.currentTarget)}
            >
              {t('settings:connectors.list.disconnect')}
            </button>
          )}
        />
      ))}
    </>
  );
}

function useTool(tool: ToolKey): ToolView | null {
  const { phase, tools } = useStoreState<ConnectorsState>(connectorsStore);
  if (phase !== 'ready') return null;
  return tools.find((entry) => entry.key === tool) || null;
}

export function ToolStatus({ tool }: { tool: ToolKey }) {
  const view = useTool(tool);
  return view ? <ToolStatusView status={view.status} /> : null;
}

export function ToolConnections({ tool }: { tool: ToolKey }) {
  const view = useTool(tool);
  return view && view.connections.length ? <ToolConnectionsView tool={tool} connections={view.connections} /> : null;
}
