import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { Improve } from '../improve/improve-controller.js';
import { useMessagesSnapshot } from './store';

/**
 * "Which app?" — the Agent chat choice under Messages' "+" (#2778).
 *
 * An agent chat, for now, is a new dev session on one app: the viewer talks
 * to the agent that builds it. So this asks which app and then opens that
 * app's new-session screen (`Improve.startSessionFor`), where nothing is
 * created until the first message is sent. A platform-wide agent session
 * will replace this later; the "+" will not need to change when it does.
 *
 * THE APPS ARE THE VIEWER'S CHANNELS: every app they are a member of, which
 * the inbox has already loaded for its Channels section
 * (GET /api/messages/app-discussions) — the same population that may start a
 * change there. No second fetch, and no list that could disagree with the
 * one beside it.
 */
export function AgentAppDialog() {
  const snap = useMessagesSnapshot();
  const [query, setQuery] = useState('');
  const dialog = useDialog('messagesAgent', {
    onOpen: () => { setQuery(''); },
  });

  const apps = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...snap.discussions].sort((a, b) => a.name.localeCompare(b.name));
    return q
      ? all.filter((item) => item.name.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q))
      : all;
  }, [query, snap.discussions]);

  function choose(slug: string) {
    dialog.close();
    void Improve.startSessionFor(slug);
  }

  return (
    <DialogRoot id="messages-agent-dialog" layout="scroll" ref={dialog.rootRef} {...dialog.backdropProps}>
      <DialogCard size="md">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold">New agent chat</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Which app should the agent work on?</p>
          </div>
          <button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label="Close"><XIcon className="w-5 h-5" /></button>
        </div>
        {snap.discussions.length > 6 ? (
          <label className="block mb-2">
            <span className="sr-only">Find an app</span>
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find an app" autoComplete="off" />
          </label>
        ) : null}
        <div id="messages-agent-apps" className="max-h-72 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800" role="list">
          {!snap.discussionsLoaded ? <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">Loading your apps…</p> : null}
          {snap.discussionsLoaded && !snap.discussions.length
            ? <p className="text-sm text-zinc-500 dark:text-zinc-400 px-2 py-3">You aren’t a member of any app yet. Join one from Discover to start a change on it.</p>
            : null}
          {snap.discussionsLoaded && snap.discussions.length && !apps.length
            ? <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">No app matches “{query.trim()}”.</p>
            : null}
          {apps.map((item) => {
            const record = { icon_url: item.iconUrl, icon_emoji: item.iconEmoji, name: item.name };
            return (
              <div key={item.slug} role="listitem">
                <button
                  type="button"
                  data-agent-app={item.slug}
                  onClick={() => choose(item.slug)}
                  className="w-full flex items-center gap-3 px-2 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-lg"
                >
                  <span data-icon={appIconKind(record as never)} className="app-icon-tile messages-inbox-tile" aria-hidden="true">
                    <AppIconContent app={record as never} />
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium truncate">{item.name}</span>
                  <span className="ml-auto text-xs text-violet-700 dark:text-violet-400">Start</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}>Cancel</Button>
        </div>
      </DialogCard>
    </DialogRoot>
  );
}
