/**
 * 1 Nov 2026 (threads, one loop: phase B): "Work on this with Homeroom bot"
 * under a change, on its request's page (./thread-changes.tsx ChangeBlock)
 * and on its own page (./change-head.tsx): a quiet button, for asking about
 * the change or sketching a revision of it in a thread only the viewer can
 * see (../../../lib/thread-about.ts). The request's own version is its page's
 * one action (AppView.workOnIssueWithBot); this is the neutral one beside a
 * change's Votes and Testing cards, which keep the accent.
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

export function WorkWithBotButton({ slug, number, kind = 'change' }: {
  slug: string | null | undefined;
  /** The change's pull request number (or the request's). */
  number: number | null | undefined;
  kind?: 'request' | 'change';
}): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  if (!slug || !number || number <= 0 || !canWork()) return null;
  return (
    <div className="mt-2" data-work-with-bot={number}>
      <Button
        type="button"
        variant="pillNeutral"
        size="sm"
        ink="neutral"
        disabledStyle="dim"
        title={t('project:topic.workWithBot.title')}
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
        {busy ? t('project:topic.workWithBot.opening') : t('project:topic.workWithBot.button')}
      </Button>
    </div>
  );
}
