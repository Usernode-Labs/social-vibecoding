import { useState } from 'react';

import { ChatIcon, DraftTrashIcon } from '@/components/ui/icons';

import { agoStamp } from '../../lib/timestamp';
import { GlobalChatNewChatButton } from './new-chat-button';
import { removeGlobalChatThread, useGlobalChatState } from './store';
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
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    if (removing) return;
    setRemoving(true);
    setError('');
    try {
      await removeGlobalChatThread(thread.id);
    } catch {
      setRemoving(false);
      setError('Could not delete this chat.');
    }
  }

  return (
    <div>
      <div className="flex items-stretch">
        <a
          href={`#chat/${encodeURIComponent(thread.id)}`}
          data-improve-row="chat"
          aria-current={current ? 'page' : undefined}
          className="flex min-w-0 flex-1 items-center gap-3 px-3 min-h-[60px] text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
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
        <button
          type="button"
          className="flex w-11 shrink-0 items-center justify-center text-zinc-400 hover:bg-zinc-50 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-zinc-800/60 dark:hover:text-red-400"
          aria-label={`Delete chat ${thread.title || 'New chat'}`}
          title="Delete chat"
          disabled={removing}
          onClick={() => setConfirming(true)}
        >
          <DraftTrashIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {confirming ? (
        <div className="flex min-h-11 items-center gap-2 border-t border-zinc-200 px-3 text-xs dark:border-zinc-800">
          <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-300">Delete this chat?</span>
          <button
            type="button"
            className="min-h-9 px-2 font-medium text-zinc-600 dark:text-zinc-300"
            disabled={removing}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className="min-h-9 px-2 font-semibold text-red-600 dark:text-red-400"
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      ) : null}
      {error ? <div className="px-3 pb-2 text-xs text-red-600 dark:text-red-400" role="alert">{error}</div> : null}
    </div>
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
            <div className={`${groupClass} [&>div+div]:border-t [&>div+div]:border-zinc-200 dark:[&>div+div]:border-zinc-800`}>
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
