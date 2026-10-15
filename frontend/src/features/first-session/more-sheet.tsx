/**
 * "Something else…": the sheet behind the make screen's fourth tile (Evan,
 * 15 Oct 2026). The grid stays two by two, the front three starting points
 * (./examples.ts FRONT) and this tile, so a new member is not asked to read
 * six; everything else is one tap away here. Your own idea comes first, as
 * the way out of the templates altogether, then "More ideas": every starting
 * point not in the front three (./examples.ts MORE), each with the line that
 * says what it is for.
 *
 * Picking a row closes the sheet, and the pick takes over the fourth tile
 * (./make.tsx), which opens this again. It is drawn like the screen's other
 * sheet, "Who can change it" (../who-decides/make-rule.tsx): on <body> after
 * the screen, so the page lock leaves it live (lib/page-lock.ts), with its
 * scrim, its handle and its close button, and Escape closes it.
 */

import { useEffect, useState } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { CheckIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { MORE, type Template } from './examples';
import { TierChart } from './tier-chart';

/** Its own idea row's key: the make screen's Your own idea (./make.tsx OWN_IDEA). */
const IDEA = 'idea';

function Glyph({ template }: { template: Template | null }) {
  return (
    <span className="app-icon-tile flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[22px]" aria-hidden="true">
      {template ? (template.chart ? <TierChart /> : template.emoji) : '💡'}
    </span>
  );
}

export function MoreSheet({ picked, onPick, onPickIdea, onClose }: {
  /** What the fourth tile holds now: a template from MORE, Your own idea, or nothing. */
  picked: Template | typeof IDEA | null;
  onPick: (template: Template) => void;
  onPickIdea: () => void;
  onClose: () => void;
}) {
  const t = useMessages('onboarding');
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const mark = (on: boolean) => (on ? <CheckIcon className="h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : null);
  return (
    <div className="fixed inset-0 z-[9002]" data-make-more-sheet="">
      <div aria-hidden="true" onClick={onClose}
        className={`absolute inset-0 bg-[color:var(--pane-scrim)] transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="make-more-sheet-title"
        className={`absolute inset-x-0 bottom-0 mx-auto max-h-[92%] max-w-lg overflow-y-auto rounded-t-[20px] bg-[color:var(--dc-sheet-solid)] px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-2 text-left transition-transform duration-200 ease-out ${shown ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="make-more-sheet-title" className="min-w-0 flex-1 text-[17px] font-semibold">{t('onboarding:firstSession.make.sheet.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('onboarding:firstSession.make.sheet.close')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <GroupedList className="mt-4">
          <ListRow
            as="button"
            data-make-more={IDEA}
            aria-pressed={picked === IDEA}
            onClick={onPickIdea}
            leading={<Glyph template={null} />}
            title={t('onboarding:firstSession.make.ownIdea')}
            subtitle={t('onboarding:firstSession.make.ownIdeaLine')}
            chevron={false}
            trailing={mark(picked === IDEA)}
          />
        </GroupedList>
        <SectionHeader className="px-1 pb-1.5 pt-5">{t('onboarding:firstSession.make.sheet.more')}</SectionHeader>
        <GroupedList>
          {MORE.map((template) => (
            <ListRow
              key={template.key}
              as="button"
              data-make-more={template.key}
              aria-pressed={picked === template}
              onClick={() => onPick(template)}
              leading={<Glyph template={template} />}
              title={t(template.short)}
              subtitle={t(template.line)}
              chevron={false}
              trailing={mark(picked === template)}
            />
          ))}
        </GroupedList>
      </div>
    </div>
  );
}
