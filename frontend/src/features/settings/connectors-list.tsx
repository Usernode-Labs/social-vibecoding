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
 *
 * Rename (#6137) is the one piece of state here: which row's editor is open,
 * and what is typed in it. The editor is this component's own subtree, drawn
 * under its row, and `Settings._renameConnector` does the saving: it resolves
 * true when the name was saved (the editor closes) and false when it was not
 * (the editor stays, with what was typed).
 */

import { Fragment, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { connectorsStore } from './connectors-store.js';
import { EDITOR_ACTIONS, EDITOR_NOTE } from './sections/sign-in-row';

type ToolKey = 'claude' | 'chatgpt' | 'codex' | 'generic';
type StatusKey = 'working' | 'unused' | 'attention' | 'none';
type ConnectionView = {
  id: string;
  title: string;
  detail: string;
  capabilities: string | null;
  /** The person's own name for it (#6137); `title` is then this, not the tool's. */
  label?: string | null;
  /** The tool's own name, kept on the row under a label. */
  toolName?: string;
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

/** The longest name a connection can be given: the server's cap. */
const LABEL_MAX = 60;

/** The quiet text action under a row's lines: 44px tall, no fill. */
const ROW_TEXT_ACTION = 'inline-flex min-h-[44px] items-center rounded-lg text-[0.9375rem] font-medium text-violet-700 hover:text-violet-500 dark:text-violet-400 dark:hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500';

/**
 * The editor's box. The row above it draws the hairline between them (a row
 * that is not last has one), so this draws only the one under itself, and only
 * when another row follows.
 */
const RENAME_EDITOR = 'px-4 pt-3 pb-4 space-y-3 border-zinc-200 dark:border-zinc-800 [&:not(:last-child)]:border-b';

/**
 * A connection's name, edited in place under its row (#6137). Enter saves,
 * Escape cancels, and an empty field saved puts the tool's own name back,
 * which is why that name is the placeholder.
 */
export function ConnectionRenameForm({ connection, value, busy, onChange, onSave, onCancel }: {
  connection: ConnectionView;
  value: string;
  busy: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useMessages('settings');
  const toolName = connection.toolName || connection.title;
  return (
    <form
      data-connector-rename-form={connection.id}
      className={RENAME_EDITOR}
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
    >
      <Input
        aria-label={t('settings:connectors.rename.fieldLabel', { tool: toolName })}
        type="text"
        autoComplete="off"
        autoFocus
        maxLength={LABEL_MAX}
        placeholder={toolName}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      <div className={EDITOR_ACTIONS}>
        <Button type="submit" variant="pillAccent" size="pill" disabled={busy}>
          {t('core:common.save')}
        </Button>
        <Button type="button" variant="pillNeutral" size="pill" ink="neutral" disabled={busy} onClick={onCancel}>
          {t('core:common.cancel')}
        </Button>
      </div>
      <p className={EDITOR_NOTE}>{t('settings:connectors.rename.note', { tool: toolName })}</p>
    </form>
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
 *
 * Rename sits under the lines too, as plain accent words: it is always there,
 * so it gets no fill. A named row leads with the person's name and keeps the
 * tool's on the line under it.
 */
export function ToolConnectionsView({ tool, connections }: { tool: ToolKey; connections: ConnectionView[] }) {
  const t = useMessages('settings');
  const [editing, setEditing] = useState<{ id: string; value: string; busy: boolean } | null>(null);
  const save = async () => {
    if (!editing || editing.busy) return;
    const { id, value } = editing;
    setEditing({ id, value, busy: true });
    let saved = false;
    try {
      saved = (await controller()?._renameConnector?.(id, value)) === true;
    } catch {
      saved = false;
    }
    // Only this save's own editor: Cancel, or another row opened meanwhile, wins.
    setEditing((now) => (now && now.id === id && now.busy ? (saved ? null : { id, value, busy: false }) : now));
  };
  return (
    <>
      {connections.map((connection) => {
        const open = editing && editing.id === connection.id ? editing : null;
        return (
          <Fragment key={connection.id}>
            <ListRow
              inset="text"
              chevron={false}
              title={connection.title}
              titleClassName="font-medium"
              subtitle={(
                <>
                  {connection.label && connection.toolName ? (
                    <span data-connector-tool-name="" className="block">{connection.toolName}</span>
                  ) : null}
                  <span className="block">{connection.detail}</span>
                  {connection.capabilities ? <span className="mt-0.5 block">{connection.capabilities}</span> : null}
                  <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {connection.reconnect ? (
                      <button
                        type="button"
                        data-connector-reconnect={tool}
                        className="mt-1 inline-flex min-h-[44px] items-center rounded-full bg-zinc-100 px-4 text-[0.9375rem] font-semibold text-violet-700 transition-colors hover:bg-zinc-200 dark:bg-zinc-800 dark:text-violet-400 dark:hover:bg-zinc-700"
                        onClick={() => controller()?._reconnectConnector?.(tool)}
                      >
                        {t('settings:connectors.list.reconnect')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-connector-rename={connection.id}
                      aria-expanded={open ? 'true' : 'false'}
                      aria-label={t('settings:connectors.list.renameNamed', { name: connection.title })}
                      className={ROW_TEXT_ACTION}
                      onClick={() => setEditing(open ? null : { id: connection.id, value: connection.label || '', busy: false })}
                    >
                      {t('settings:connectors.list.rename')}
                    </button>
                  </span>
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
            {open ? (
              <ConnectionRenameForm
                connection={connection}
                value={open.value}
                busy={open.busy}
                onChange={(value) => setEditing({ id: connection.id, value, busy: false })}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            ) : null}
          </Fragment>
        );
      })}
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
