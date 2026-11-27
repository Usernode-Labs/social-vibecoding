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
import { useMenu } from '../../lib/menu';
import { noteThreadName } from './private-thread-bar';
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

/** PATCH a thread's name (#6764); resolves where it stands now, or throws the server's sentence. */
async function renameThread(rootId: number, title: string): Promise<PrivateThreadState> {
  const res = await fetch(`/api/conversations/homeroom-bot/threads/${rootId}`, {
    method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  const body = await res.json().catch(() => null) as (PrivateThreadState & { error?: string }) | null;
  if (!res.ok || !body || typeof body.state !== 'string') throw new Error(body?.error || '');
  return body;
}

/**
 * The ⋯ of a private thread (its head in the bot tab's column, and its row on
 * the Homeroom bot page): Rename, then Mark done, or Reopen when it is done.
 * Drawn as a conversation header's ⋯ in Messages.
 */
export function ThreadDoneMenu({ rootId, done, name = null, onChanged, onRenamed, className = '' }: {
  rootId: number;
  done: boolean;
  /** #6764: the thread's name now, as the prompt starts from it. */
  name?: string | null;
  onChanged: (state: PrivateThreadState['state']) => void;
  /** #6764: the new name, once the PATCH went through. */
  onRenamed?: (title: string) => void;
  className?: string;
}): ReactNode {
  const t = useMessages('messages');
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  // The Menu (lib/menu.ts): a press outside, Escape, Back, the rows' keys,
  // and focus in and back to the ⋯.
  const { panelProps } = useMenu(open, { trigger: btnRef, panel: menuRef, onClose: close });
  const act = async () => {
    setOpen(false);
    btnRef.current?.focus({ preventScroll: true });
    const next = done ? await reopenThread(rootId) : await markThreadDone(rootId);
    if (next) onChanged(next);
  };
  // The same small prompt a group chat's rename uses (index.tsx renameGroup).
  const rename = async () => {
    setOpen(false);
    btnRef.current?.focus({ preventScroll: true });
    const ui = (window as unknown as {
      PlatformUI?: {
        prompt?: (opts: { title: string; value?: string; placeholder?: string; confirmLabel?: string; maxLength?: number }) => Promise<string | null>;
        toast?: (message: string) => void;
      };
    }).PlatformUI;
    if (!ui?.prompt) return;
    const next = await ui.prompt({
      title: t('messages:privateThread.renameTitle'),
      value: name || '',
      placeholder: t('messages:privateThread.renamePlaceholder'),
      confirmLabel: t('core:common.save'),
      maxLength: 80,
    });
    if (next == null) return;
    try {
      const where = await renameThread(rootId, next);
      noteThreadName(rootId, where.title);
      onRenamed?.(where.title || next);
    } catch (err) {
      ui.toast?.(err instanceof Error && err.message ? err.message : t('messages:privateThread.renameFailed'));
    }
  };
  return (
    <div className={`relative ${className}`} data-private-thread-menu="">
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
        <div ref={menuRef} className="messages-thread-menu" role="menu" aria-label={t('messages:privateThread.menu')} {...panelProps}>
          <button type="button" role="menuitem" data-private-thread-act="rename" onClick={(e) => { e.stopPropagation(); void rename(); }}>
            {t('messages:privateThread.rename')}
          </button>
          <button type="button" role="menuitem" data-private-thread-act={done ? 'reopen' : 'done'} onClick={(e) => { e.stopPropagation(); void act(); }}>
            {done ? t('messages:privateThread.reopen') : t('messages:privateThread.markDone')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
