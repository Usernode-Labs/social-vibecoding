/**
 * FINISHING A PRIVATE THREAD (#6159, 3 Nov 2026). A private thread with
 * Homeroom bot can be done: on its own when its request goes live or is
 * closed, by Mark done in its ⋯ (here, in its head and on its row on the
 * Homeroom bot page), or by asking the bot. Reopen, or anything the person
 * writes in it, brings it back (services/private-threads.js).
 */

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { EllipsisHorizontalIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useMenuKeyboard } from '../../lib/menu-keys';
import { useDismiss } from '../message-actions/use-dismiss';
import type { PrivateThreadState } from './private-thread-bar';

/** POST a thread's Mark done or Reopen; resolves its new state, or null when it did not go through. */
async function threadDoor(rootId: number, door: 'done' | 'reopen'): Promise<PrivateThreadState['state'] | null> {
  try {
    const res = await fetch(`/api/conversations/homeroom-bot/threads/${rootId}/${door}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { state?: PrivateThreadState['state'] } | null;
    return body?.state || null;
  } catch {
    return null;
  }
}
export const markThreadDone = (rootId: number) => threadDoor(rootId, 'done');
export const reopenThread = (rootId: number) => threadDoor(rootId, 'reopen');

/**
 * The ⋯ of a private thread (its head in the bot tab's column, and its row on
 * the Homeroom bot page): one item, Mark done, or Reopen when it is done.
 * Drawn as a conversation header's ⋯ in Messages.
 */
export function ThreadDoneMenu({ rootId, done, onChanged, className = '' }: {
  rootId: number;
  done: boolean;
  onChanged: (state: PrivateThreadState['state']) => void;
  className?: string;
}): ReactNode {
  const t = useMessages('messages');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useDismiss(open, [wrapRef], close);
  const menuKeys = useMenuKeyboard(open, menuRef, btnRef, close);
  const act = async () => {
    setOpen(false);
    btnRef.current?.focus({ preventScroll: true });
    const next = done ? await reopenThread(rootId) : await markThreadDone(rootId);
    if (next) onChanged(next);
  };
  return (
    <div className={`relative ${className}`} ref={wrapRef} data-private-thread-menu="">
      <button
        ref={btnRef}
        type="button"
        className="messages-thread-action"
        aria-label={t('messages:privateThread.menu')}
        title={t('messages:privateThread.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((shown) => !shown); }}
      >
        <EllipsisHorizontalIcon aria-hidden="true" />
      </button>
      {open ? (
        <div ref={menuRef} className="messages-thread-menu" role="menu" aria-label={t('messages:privateThread.menu')} onKeyDown={menuKeys.onKeyDown}>
          <button type="button" role="menuitem" data-private-thread-act={done ? 'reopen' : 'done'} onClick={(e) => { e.stopPropagation(); void act(); }}>
            {done ? t('messages:privateThread.reopen') : t('messages:privateThread.markDone')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
