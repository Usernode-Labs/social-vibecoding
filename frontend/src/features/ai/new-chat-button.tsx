/**
 * NEW CHAT (14 Nov 2026): the Homeroom bot tab's one labelled, filled
 * button, in its heading beside search, where a "+" disc was. Every
 * conversation with the bot is a thread and there is no Main Chat to type
 * into, so this is how one starts: it opens "What do you want to do?"
 * (../messages/new-thread.tsx) with its project already set (./index.tsx
 * newChatPreset).
 *
 *   [bot] Homeroom bot                       ( 🔍 ) ( + New chat )
 *
 * Where the heading is too narrow for the words beside the bot's name (a
 * phone, or the lists squeezed beside an open column), app.css draws the
 * accent disc with its plus alone and keeps the words for a screen reader
 * (`[data-ai-new-chat]`, by the heading's own width); the phone's Ask bar
 * says them in full.
 *
 * Drawn in the first render, as the prerender has it: it needs nothing read.
 */
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { PlusIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';

export function NewChatButton({ onOpen }: { onOpen: () => void }): ReactNode {
  const t = useMessages('messages');
  return (
    <Button
      type="button"
      variant="pillAccent"
      size="icon"
      ink="solid"
      className="inline-flex h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 text-[15px] font-semibold [&>svg]:h-[18px] [&>svg]:w-[18px]"
      title={t('messages:newThread.start')}
      data-bot-new-thread=""
      data-ai-new-chat=""
      onClick={onOpen}
    >
      <PlusIcon aria-hidden="true" />
      <span>{t('messages:newThread.start')}</span>
    </Button>
  );
}
