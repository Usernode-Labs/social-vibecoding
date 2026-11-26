/**
 * 1 Nov 2026 (threads, one loop: phase B): the quiet button under a change,
 * on its request's page (./thread-changes.tsx ChangeBlock) and on its own
 * page (./change-head.tsx): it opens a thread only the viewer can see, with
 * Homeroom bot, about this change (../../../lib/thread-about.ts).
 *
 * #6392 (6 Nov 2026): it says what it does rather than "Work on this with
 * Homeroom bot", which read as starting work the bot had already started.
 * Not yet up for a vote: "Ask Homeroom bot privately". Up for a vote
 * (`voting`): "Suggest a change privately". While the bot is building the
 * change, or fixing or about to fix its failing checks (`botAtWork`), it is
 * left out entirely: the Testing card and the thread already say so. The
 * request's own version is its page's one action (AppView.workOnIssueWithBot);
 * this is the neutral one beside a change's Votes and Testing cards, which
 * keep the accent.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { openThreadAbout } from '../../../lib/thread-about';
import { Button } from '@/components/ui/button';

/** Whether this viewer may open a thread with the bot here: signed in, on a board they can act on. */
function canWork(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as any;
  return !!w.App?.user && !w.App.user.isSynthetic && !w.AppView?.readOnly;
}

export function WorkWithBotButton({ slug, number, kind = 'change', voting = false, botAtWork = false }: {
  slug: string | null | undefined;
  /** The change's pull request number (or the request's). */
  number: number | null | undefined;
  kind?: 'request' | 'change';
  /** The change is up for a vote, so what it offers is a revision of it. */
  voting?: boolean;
  /** Homeroom bot is building or fixing this change: no button, it is on it. */
  botAtWork?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  if (!slug || !number || number <= 0 || !canWork() || botAtWork) return null;
  return (
    <div className="mt-2" data-work-with-bot={number}>
      <Button
        type="button"
        variant="pillNeutral"
        size="sm"
        ink="neutral"
        disabledStyle="dim"
        title={voting ? t('project:topic.workWithBot.suggestTitle') : t('project:topic.workWithBot.askTitle')}
        disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          try {
            await openThreadAbout(slug, number, kind, { failed: t('project:topic.workWithBot.failed') });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? t('project:topic.workWithBot.opening')
          : voting ? t('project:topic.workWithBot.suggest') : t('project:topic.workWithBot.ask')}
      </Button>
    </div>
  );
}
