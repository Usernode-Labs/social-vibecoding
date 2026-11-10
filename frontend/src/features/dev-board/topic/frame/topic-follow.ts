/**
 * Follow this request, as a switch on About under one of the frame's looks:
 * the same write the page's ⋯ row makes (../thread-items.tsx), with the
 * thread's follow state read from its payload and the page reread after.
 */
import { useEffect, useState } from 'react';
import type { ThreadPayload } from '../thread-model';

export function useFollowRow(
  data: ThreadPayload | null,
  onChanged: () => void,
): { on: boolean; busy: boolean; onToggle: () => void } | null {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState<ThreadPayload['follow'] | undefined>(undefined);
  useEffect(() => { setLocal(undefined); }, [data]);
  const follow = local === undefined ? (data ? data.follow : null) : local;
  if (!data || !follow) return null;
  const state = follow.state;
  return {
    on: state === 'following',
    busy,
    onToggle: () => {
      if (busy) return;
      setBusy(true);
      void (async () => {
        try {
          const res = await fetch(`/api/threads/${data.thread.id}/follow`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notify: state === 'following' ? false : state === 'muted' ? null : true }),
          });
          if (!res.ok) throw new Error(String(res.status));
          const now = await res.json();
          setLocal({ state: now.state, chosen: !!now.chosen });
          onChanged();
        } catch {
          // The switch says what is stored; a write that failed changed nothing.
        } finally {
          setBusy(false);
        }
      })();
    },
  };
}
