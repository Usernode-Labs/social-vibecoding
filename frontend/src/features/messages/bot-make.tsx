import { type ReactNode, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { radioGroupKeys } from '../../lib/radio-group';
import { t as translate } from '../../lib/i18n/runtime';
import { deviceTimeZone, postCreateApp } from '../dialogs/post-create-app';
import type { CreateAudience } from '../first-session/make';

/*
 * 1 Nov 2026 (threads, one loop: C2.4): Make the project, under a design
 * Homeroom bot drew for a project that does not exist yet (the design bot's
 * offer_project card, kind `make_offer`). A small sheet, opened in place by
 * the card's `make` button (./bot-question.tsx): the name the card gave,
 * who it is for, and Make it, which POSTs /api/apps with the design. The
 * server checks the design is the person's own, writes the first version's
 * plan from it, and files its first request with the design as the plan
 * (routes/apps.js, services/homeroom-bot-dm.js designForProject); the card
 * then says it was made, on every device.
 */

export const MAKE_AUDIENCES: readonly CreateAudience[] = ['solo', 'invited', 'open'];

const AUDIENCE_LABELS = {
  solo: 'messages:bot.make.audience.solo',
  invited: 'messages:bot.make.audience.invited',
  open: 'messages:bot.make.audience.open',
} as const;

const AUDIENCE_HINTS = {
  solo: 'messages:bot.make.audienceHint.solo',
  invited: 'messages:bot.make.audienceHint.invited',
  open: 'messages:bot.make.audienceHint.open',
} as const;

export interface MakeProject {
  name: string;
  rootId: number;
  version: number | null;
  /** #6783: what the project will do, for a card the bot wrote in a private thread (no design). */
  brief?: string | null;
  /** K (20 Nov 2026): which of the thread's artifacts it is made from, after its first. */
  artifactId?: number;
}

/** Pure: what Make it posts to /api/apps for `project`. */
export function makeBody(project: MakeProject, name: string, audience: CreateAudience, timeZone: string | null = null): Record<string, unknown> {
  const named = name.trim();
  // #6783: a New project card's brief is what the project starts from, and
  // the thread its card is in settles once it is made. No design, no `from`.
  const brief = (project.brief || '').trim();
  if (brief) {
    return {
      name: named,
      audience,
      brief,
      thread: { rootId: project.rootId },
      ...(timeZone ? { timeZone } : {}),
    };
  }
  return {
    name: named,
    audience,
    brief: named,
    from: 'design',
    // K (20 Nov 2026): the artifact the card offers, when it is not the thread's first.
    design: {
      rootId: project.rootId,
      ...(project.version ? { version: project.version } : {}),
      ...(project.artifactId ? { artifactId: project.artifactId } : {}),
    },
    ...(timeZone ? { timeZone } : {}),
  };
}

export function MakeSheet({ project, onClose, onMade }: {
  project: MakeProject;
  onClose: () => void;
  onMade: (made: { slug: string; name: string }) => void;
}): ReactNode {
  const t = useMessages('messages');
  const [name, setName] = useState(project.name);
  const [audience, setAudience] = useState<CreateAudience>('invited');
  // One tab stop, and the arrow keys move the pick (#6510).
  const audienceKeys = radioGroupKeys(MAKE_AUDIENCES, audience, setAudience);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const make = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    const reply = await postCreateApp(makeBody(project, name, audience, deviceTimeZone()));
    const app = reply.ok ? (reply.data.app as { slug?: string; name?: string } | undefined) : undefined;
    setBusy(false);
    if (!reply.ok || !app?.slug) {
      setError(reply.ok ? translate('messages:bot.make.error') : reply.error);
      return;
    }
    onMade({ slug: app.slug, name: app.name || name.trim() });
  };

  const sheet = (
    <div className="fixed inset-0 z-[9001]" data-bot-make-sheet="">
      <div aria-hidden="true" onClick={busy ? undefined : onClose} className="absolute inset-0 touch-none bg-black/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto overscroll-contain rounded-t-[20px] bg-zinc-100 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] dark:bg-zinc-900 md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-[20px] md:pb-6"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <form
          className="mt-3 flex flex-col"
          onSubmit={(event) => { event.preventDefault(); void make(); }}
        >
          <div className="flex items-center gap-3">
            <h2 id={titleId} className="min-w-0 flex-1 text-[17px] font-semibold">{t('messages:bot.make.title')}</h2>
            <button type="button" onClick={onClose} disabled={busy} aria-label={t('messages:bot.make.close')} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              <XIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <label className="mt-4 flex flex-col gap-1.5">
            <span className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t('messages:bot.make.nameLabel')}</span>
            <input
              data-bot-make-name=""
              className="h-11 rounded-xl bg-white px-3 text-[15px] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset className="mt-4">
            <legend className="pb-1.5 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t('messages:bot.make.audienceLabel')}</legend>
            <div className="overflow-hidden rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800" role="radiogroup" onKeyDown={audienceKeys.onKeyDown}>
              {MAKE_AUDIENCES.map((option, i) => {
                const on = audience === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={audienceKeys.tabIndex(option)}
                    data-bot-make-audience={option}
                    onClick={() => setAudience(option)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-start ${i ? 'shadow-[inset_0_1px_0_var(--app-sheet-line)]' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{t(AUDIENCE_LABELS[option])}</span>
                      <span className="block text-[13px] text-zinc-500 dark:text-zinc-400">{t(AUDIENCE_HINTS[option])}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={`h-5 w-5 shrink-0 rounded-full ${on ? 'border-[6px] border-violet-600' : 'border-2 border-zinc-300 dark:border-zinc-600'}`}
                    />
                  </button>
                );
              })}
            </div>
          </fieldset>
          <p className="mt-3 text-[13px] text-zinc-500 dark:text-zinc-400">{t(project.brief ? 'messages:bot.make.noteBrief' : 'messages:bot.make.note')}</p>
          {error ? <p role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
          <Button
            type="submit"
            data-bot-make-submit=""
            disabled={busy || !name.trim()}
            layout="full"
            variant="pillAccent"
            size="pillLg"
            ink="solidLate"
            className="mt-4 flex items-center justify-center disabled:opacity-60"
          >
            {busy ? t('messages:bot.make.making') : t('messages:bot.make.submit')}
          </Button>
        </form>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}

/**
 * Pure (#6783): whether a New project card's brief has more to show than its
 * four lines: more than four lines, or long enough to run past them.
 */
export function briefNeedsMore(brief: string | null | undefined): boolean {
  const words = String(brief || '').trim();
  return words.split('\n').length > 4 || words.length > 280;
}

/**
 * #6783: the New project card Homeroom bot offers in a private thread: what
 * it will do, with Make it (the sheet above) and Edit first (the create
 * screen, filled in with the name and the brief). Once made, it says what it
 * made and opens it, on every device (routes/apps.js noteProjectMade).
 * The name the bot suggested is the head line the message itself carries.
 */
export function ProjectOfferCard({ project, made = null, closedLine = null }: {
  project: MakeProject;
  made?: { slug: string; name: string } | null;
  /** #6783: an offer a newer message or a week's wait closed says so in its buttons' place. */
  closedLine?: string | null;
}): ReactNode {
  const t = useMessages('messages');
  const brief = (project.brief || '').trim();
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  // What this device made, until the server's own state comes back.
  const [madeHere, setMadeHere] = useState<{ slug: string; name: string } | null>(null);
  const done = made || madeHere;

  const edit = () => {
    const app = typeof window !== 'undefined' ? (window as any).App : null;
    app?.showCreateModal?.({ idea: brief, name: project.name });
  };

  return (
    <div className="messages-bot-question" data-bot-question={done ? 'answered' : closedLine ? 'closed' : 'open'} data-bot-project-card="">
      <div className="rounded-[20px] bg-white p-3.5 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800">
        <div className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:bot.make.briefLabel')}</div>
        <p className={`mt-1 whitespace-pre-line text-[15px] leading-snug text-zinc-900 dark:text-zinc-100 ${open ? '' : 'line-clamp-4'}`} data-bot-project-brief="">{brief}</p>
        {briefNeedsMore(brief) ? (
          <button
            type="button"
            className="py-1 text-[14px] font-semibold text-violet-700 dark:text-violet-300"
            data-bot-project-more=""
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {t(open ? 'messages:bot.make.showLess' : 'messages:bot.make.showAll')}
          </button>
        ) : null}
        {done ? (
          <p className="messages-bot-answered" data-bot-made="">
            <a className="font-semibold text-violet-700 dark:text-violet-300" href={`#app/${encodeURIComponent(done.slug)}`}>{t('messages:bot.make.open', { project: done.name || done.slug })}</a>
          </p>
        ) : closedLine ? (
          <p className="messages-bot-answered">{closedLine}</p>
        ) : (
          <div className="messages-bot-answers mt-2" role="group" aria-label={project.name || t('messages:bot.make.unnamed')}>
            <button type="button" className="messages-bot-primary" data-bot-project-make="" onClick={() => setMaking(true)}><span>{t('messages:bot.make.cardSubmit')}</span></button>
            <button type="button" className="messages-bot-secondary" data-bot-project-edit="" onClick={edit}><span>{t('messages:bot.make.editFirst')}</span></button>
          </div>
        )}
      </div>
      {making ? (
        <MakeSheet
          project={project}
          onClose={() => setMaking(false)}
          onMade={(app) => { setMaking(false); setMadeHere(app); }}
        />
      ) : null}
    </div>
  );
}
