import { ChatIcon } from '@/components/ui/icons';

import { agoStamp } from '../../lib/timestamp';
import { GlobalChatNewChatButton } from './new-chat-button';
import { useGlobalChatState } from './store';
import type { GlobalChatThread } from './types';

const STATUS_BASE =
  'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 '
  + 'text-[11px] font-semibold '
  + '[&>.dc-status-spinner-arc]:border-current '
  + '[&>.dc-status-spinner-arc]:border-r-transparent';

function ThreadRow({
  thread,
  current,
  onNavigate,
}: {
  thread: GlobalChatThread;
  current: boolean;
  onNavigate: () => void;
}) {
  const activity = agoStamp(thread.updatedAt || thread.createdAt);
  return (
    <a
      href={`#chat/${encodeURIComponent(thread.id)}`}
      data-improve-row="chat"
      aria-current={current ? 'page' : undefined}
      className="flex items-center gap-3 px-3 min-h-[60px] text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
      onClick={onNavigate}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-200 bg-violet-500/10 text-violet-700 dark:border-violet-900 dark:bg-violet-500/15 dark:text-violet-300">
        <ChatIcon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {thread.title || 'New chat'}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          Chat
          {activity.text ? (
            <time dateTime={thread.updatedAt || thread.createdAt || undefined} title={activity.title}>
              {` · ${activity.text}`}
            </time>
          ) : null}
        </span>
      </span>
      {thread.busy ? (
        <span className={`${STATUS_BASE} bg-amber-400/20 text-amber-700 dark:text-amber-300`}>
          <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true" />
          Working
        </span>
      ) : current ? (
        <span className={`${STATUS_BASE} bg-violet-500/15 text-violet-700 dark:text-violet-300`}>
          Current
        </span>
      ) : null}
    </a>
  );
}

/** Direction A: chats and coding changes are distinct record groups in Improve. */
export function GlobalChatImproveSection({
  onNavigate,
  labelClass,
  groupClass,
}: {
  onNavigate: () => void;
  labelClass: string;
  groupClass: string;
}) {
  const snapshot = useGlobalChatState();
  const enabled = snapshot.bootstrap?.parityReady
    && snapshot.bootstrap.profiles.globalChat.enabled === true;
  const activeId = snapshot.open ? snapshot.bootstrap?.thread?.id : null;

  return (
    <>
      <GlobalChatNewChatButton onNavigate={onNavigate} />
      {enabled ? (
        <>
          <div className={`${labelClass} flex items-center justify-between gap-3`}>
            <span>Chats</span>
            {snapshot.threads.length ? <span>{snapshot.threads.length} recent</span> : null}
          </div>
          {snapshot.threads.length ? (
            <div className={groupClass}>
              {snapshot.threads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  current={thread.id === activeId}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          ) : (
            <div className="px-4 pb-2 text-xs text-zinc-500 dark:text-zinc-400">
              No chats yet.
            </div>
          )}
        </>
      ) : null}
    </>
  );
}
