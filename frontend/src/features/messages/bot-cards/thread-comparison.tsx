// 20 Nov 2026: a comparison Homeroom bot laid out in a project thread
// (homeroom-bot-voice.js attach_files, metadata.homeroomBot.comparison),
// drawn under its reply instead of posted as an HTML file to open.
//
// It is a picture to read: the one frame every page the bot writes draws it
// (../../artifact/frame.tsx), in `static` mode with no origin named, so
// nothing in it runs and it loads nothing. A long one scrolls inside its own
// box, and the note under it says what it is.

import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { ArtifactFrame } from '../../artifact/frame';

export function ThreadComparison({ comparison }: { comparison: { title: string; html: string } }): ReactNode {
  const t = useMessages('messages');
  return (
    <div className="mt-2 flex max-w-[560px] flex-col gap-1.5" data-bot-comparison="">
      {comparison.title ? <span className="text-[13px] font-semibold">{comparison.title}</span> : null}
      <ArtifactFrame
        mode="static"
        viewer="other"
        html={comparison.html}
        site={false}
        title={t('messages:botCards.comparison.frameTitle', { title: comparison.title })}
        className="block h-[420px] w-full rounded-xl bg-white shadow-[0_0_0_1px_var(--app-sheet-line)]"
        style={{ border: 0 }}
      />
      <span className="text-[12px] text-zinc-500 dark:text-zinc-400">{t('messages:botCards.comparison.note')}</span>
    </div>
  );
}
