/**
 * The Homeroom bot tab's lists (30 Oct 2026, Evan, from his Task Assistant
 * prototype and a day of iterating on the page as an artifact):
 *
 *   [tile] Homeroom bot              ← a sheet of its own: the title, then
 *          Needs you: 15 · …           a chip a project to see only theirs
 *   ( All ) ( Homeroom ) ( Game Corner ) …
 *
 *   NEEDS YOU · 15                   ← a band, the sheet's width
 *   [tile] Homeroom
 *     ☑ #6038  Spell out the approval rules…      Vote
 *     ▶ #6000  Add reopen proposal…               Build it
 *              Show 5 more ⌄
 *   ─────────────────────────
 *   IN PROGRESS · 3                  ← a line over each after the first
 *   ─────────────────────────
 *   WAITING · 5
 *
 *   LIVE THIS WEEK · 41              ← a sheet of its own, quieter rows
 *
 *   one line a row   its glyph says what it asks (in the accent when it is
 *                    yours to do), then its number, its title and, on the
 *                    right, the one word that matters. The whole line is its
 *                    tooltip; on a phone, where nothing hovers, a row whose
 *                    reason is news says it on a second line (whyOf).
 *   grouped          each section's rows under their project's name, once,
 *                    instead of a tile on every row. Needs you stays first
 *                    whatever the project.
 *   each group folds a project shows its first few rows; its own Show more
 *                    opens the rest downward (height and fade, the kit's
 *                    spring ease; none under Reduce Motion).
 *   project chips    pick one or several projects to see only theirs (the
 *                    shell's filter chip, a toggle each; none picked is
 *                    All). One picked: its name is not said again over
 *                    every section.
 *   no row lines     space and the project's name group the rows; the only
 *                    lines are over In progress and Waiting.
 *
 * Rows here are 14px over one line, not the shell's 15 over 13 (AGENTS.md,
 * "Type and colour"): this page's exception, recorded there.
 */
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import type { ReactNode } from 'react';

import { Chip } from '@/components/ui/chip';
import { SectionHeader } from '@/components/ui/grouped-list';
import {
  ArrowPathIcon, ArrowUpTrayIcon, BallotIcon, ChatIcon, CheckIcon, ChevronDownIcon, ClockIcon, CodeIcon,
  CogIcon, EyeIcon, HandRaisedIcon, LockIcon, PlayIcon, ReplyArrowIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  GROUP_FIRST, byProject, nextWords, projectsOf, shortWords, threadWhy, whyOf,
  type AiApp, type AiThread, type Phrase, type WorkRow,
} from './model';

// The plane a list stands on, as GroupedList draws one: the sheet's solid
// fill, 20px, one inset hairline. Complete literals for Tailwind.
const PLANE = 'mx-4 rounded-[20px] bg-[color:var(--dc-sheet-solid)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
// A chip on a sheet: the sheet's own hairline round it, so a white chip does not melt into it.
const CHIP_EDGE = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/** A project's tile at a one-line row's size, or a project heading's. */
export function SmallTile({ app, size = 'row' }: { app: AiApp | null; size?: 'row' | 'head' }): ReactNode {
  const box = size === 'head' ? 'w-4 h-4 rounded-[5px] text-[9px]' : 'w-5 h-5 rounded-md text-[11px]';
  if (!app) return <span className={`${box} shrink-0 bg-zinc-200 dark:bg-zinc-700`} aria-hidden="true" />;
  return (
    <span className={`app-icon-tile ${box} shrink-0 overflow-hidden flex items-center justify-center font-bold`} data-icon={appIconKind(app as any)} aria-hidden="true">
      <AppIconContent app={app as any} />
    </span>
  );
}

interface Line {
  key: string;
  /** What the row is, for the page's checks: need, plan, decide, … or a thread's `what`. */
  kind: string;
  app: AiApp | null;
  glyph: ReactNode;
  number: number | null;
  title: string;
  right: string;
  tooltip: string;
  /** On a phone, a second line: the reason, where it is news. */
  why: string | null;
  /** Yours to do: the glyph and the word in the accent. */
  owe: boolean;
  open: () => void;
}

const G = 'h-[18px] w-[18px]';
/** Needs you's glyph, by what the row asks. */
function needGlyph(row: WorkRow): ReactNode {
  const kind = row.key.startsWith('need:') ? row.key.split(':')[1] : row.key.split(':')[0];
  if (kind === 'question' || kind === 'bot_question') return <ChatIcon className={G} />;
  if (kind === 'plan') return <PlayIcon className={G} />;
  if (kind === 'decide') return <HandRaisedIcon className={G} />;
  if (kind === 'stopped') return <ArrowPathIcon className={G} />;
  if (kind === 'private') return <LockIcon className={G} />;
  return <BallotIcon className={G} />;
}
/** In progress's glyph, by what is being done. */
function nextGlyph(t: AiThread): ReactNode {
  if (t.what === 'going_live' || t.what === 'merging') return <ArrowUpTrayIcon className={G} />;
  if (t.what === 'reading') return <EyeIcon className={G} />;
  if (t.what === 'fixing') return <CogIcon className={G} />;
  if (t.what === 'revising') return <ReplyArrowIcon className={G} />;
  return <CodeIcon className={G} />;
}

// Complete literals: Tailwind's extractor reads source text. 36px a row on a
// desktop, so a project's rows sit closer than the groups do; 44px on a
// phone, the shell's tap target.
const ROW = 'flex w-full min-h-[44px] md:min-h-[36px] items-center gap-3 py-1.5 md:py-1 text-left rounded-md hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04]';
const LIVE_ROW = 'flex w-full min-h-[40px] md:min-h-[32px] items-center gap-3 py-1 text-left rounded-md hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04]';
const GLYPH_OWE = 'flex shrink-0 text-violet-600 dark:text-violet-300';
const GLYPH = 'flex shrink-0 text-zinc-400 dark:text-zinc-500';

function LineRow({ line, quiet = false }: { line: Line; quiet?: boolean }): ReactNode {
  const t = useMessages('messages');
  return (
    <button type="button" className={quiet ? LIVE_ROW : ROW} onClick={line.open} title={line.tooltip} data-ai-line={line.kind}>
      <span className={line.owe ? GLYPH_OWE : GLYPH} aria-hidden="true">{line.glyph}</span>
      {/* Not on a phone, where the drawer's list is 85% of the screen: the
          title needs the room more, and the tooltip still says the number. */}
      <span className="hidden md:block w-12 shrink-0 font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        {line.number ? t('messages:ai.live.number', { number: line.number }) : ''}
      </span>
      <span className="min-w-0 flex-1">
        <span className={quiet
          ? 'block truncate text-[13px] leading-5 text-zinc-600 dark:text-zinc-400'
          : 'block truncate text-sm leading-5 font-medium text-zinc-900 dark:text-zinc-100'}
        >
          {line.title}
        </span>
        {line.why ? (
          <span className="block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400 md:hidden" aria-hidden="true" data-ai-line-why="">{line.why}</span>
        ) : null}
      </span>
      <span className={line.owe
        ? 'shrink-0 text-[13px] font-semibold text-violet-700 dark:text-violet-300'
        : 'shrink-0 text-[13px] text-zinc-500 dark:text-zinc-400'}
      >
        {line.right}
      </span>
      <span className="sr-only">{line.tooltip}</span>
    </button>
  );
}

/**
 * The chips' rail inside the title's sheet: one line that scrolls, as the
 * shell's ChipRail does, fading out toward whichever edge has more chips past
 * it rather than cutting the last one off against the sheet's border (Evan,
 * 30 Oct: wrapping to a second line read worse). The fade is a mask, so it
 * fades to whatever the sheet is, in either theme.
 */
const FADE = 40;
function FadeRail({ className = '', children, ...props }: React.ComponentProps<'div'>): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const sync = () => {
      const start = el.scrollLeft > 1;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', sync); ro?.disconnect(); };
  }, []);
  const mask = edges.start || edges.end
    ? `linear-gradient(to right, ${edges.start ? 'transparent' : '#000'}, #000 ${FADE}px, #000 calc(100% - ${FADE}px), ${edges.end ? 'transparent' : '#000'})`
    : undefined;
  return (
    <div
      ref={ref}
      // ChipRail's own classes, with a ref, and its clip kept 6px inside the
      // sheet's border (mx-1.5): a chip fades out short of the border, never
      // under it. The first chip still starts 16px in, as the title does.
      className={`mx-1.5 flex gap-2 overflow-x-auto px-2.5 pt-3 pb-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      data-fade-start={edges.start ? '' : undefined}
      data-fade-end={edges.end ? '' : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

/** A project's own Show more, under its rows: centred, its arrow pointing down (up once open). */
function GroupMore({ hidden, open, onClick }: { hidden: number; open: boolean; onClick: () => void }): ReactNode {
  const t = useMessages('messages');
  return (
    <button
      type="button"
      className="flex w-full min-h-[44px] md:min-h-0 items-center justify-center gap-1 py-2 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
      onClick={onClick}
      aria-expanded={open}
      data-ai-group-more=""
    >
      {open ? t('messages:ai.work.showLess') : t('messages:ai.work.showMore', { count: hidden })}
      <ChevronDownIcon className={`h-4 w-4 transition-transform motion-reduce:transition-none${open ? ' rotate-180' : ''}`} aria-hidden="true" />
    </button>
  );
}

function Section({ list, head, owe = false, lines, quiet = false, empty = null, keep = false, first, heads, top }: {
  /** Which list, for the page's checks: work, next, up, live. */
  list: string;
  /** Drawn with no rows too: Needs you's band is in the prerender. */
  keep?: boolean;
  head: ReactNode;
  owe?: boolean;
  lines: Line[];
  quiet?: boolean;
  empty?: ReactNode;
  /** Rows a project shows before its own Show more. */
  first: number;
  /** The project's name over its rows; not when one project's chip says it already. */
  heads: boolean;
  /** How the section opens: on a band (a sheet's first), on a line, or plain. */
  top: 'band' | 'line';
}): ReactNode {
  const t = useMessages('messages');
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (!lines.length && !empty && !keep) return null;
  const label = owe ? 'text-violet-700 dark:text-violet-300' : '';
  const body = (
    <>
      {!lines.length ? empty : null}
      {byProject(lines).map((g) => {
        const key = g.app?.slug || 'none';
        const open = !!opened[key];
        const hidden = Math.max(0, g.items.length - first);
        return (
          <div key={key} data-ai-group={key}>
            {heads ? (
              <div className="flex items-center gap-2 pt-3 pb-1 text-[13px] font-semibold text-zinc-600 dark:text-zinc-300" data-ai-project-head="">
                {/* A private idea in no project yet goes under Only you, with a lock. */}
                {g.app ? <SmallTile app={g.app} size="head" /> : <LockIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="truncate">{g.app ? g.app.name || g.app.slug : t('messages:ai.short.private')}</span>
              </div>
            ) : null}
            {/* The rows sit in a little under their project's name. */}
            <div className={heads ? 'ml-3' : undefined}>
              {(hidden ? g.items.slice(0, first) : g.items).map((line) => <LineRow key={line.key} line={line} quiet={quiet} />)}
              {/* The rest, folded: a grid row that grows from 0fr to 1fr, so
                  it opens to its own height without measuring it. */}
              {hidden ? (
                <div
                  className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
                  aria-hidden={open ? undefined : true}
                  inert={!open}
                  data-ai-group-rest=""
                >
                  <div className="min-h-0 overflow-hidden">
                    {g.items.slice(first).map((line) => <LineRow key={line.key} line={line} quiet={quiet} />)}
                  </div>
                </div>
              ) : null}
              {hidden ? <GroupMore hidden={hidden} open={open} onClick={() => setOpened((o) => ({ ...o, [key]: !open }))} /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
  if (top === 'band') {
    return (
      <section className="pb-1" data-ai-list={list}>
        <div className="mb-1 rounded-t-[20px] bg-zinc-900/[0.035] px-4 pt-3 pb-2 dark:bg-white/[0.045]" data-ai-band="">
          <SectionHeader className={`px-0 pt-0 pb-0 ${label}`}>{head}</SectionHeader>
        </div>
        <div className="px-4">{body}</div>
      </section>
    );
  }
  return (
    <section className="px-4 pt-3" data-ai-list={list}>
      <div className="mb-4 h-px bg-[color:var(--app-sheet-line)]" aria-hidden="true" />
      <SectionHeader className={`px-0 pt-0 pb-1 ${label}`}>{head}</SectionHeader>
      {body}
    </section>
  );
}

/** A live row's day: today, yesterday, or the weekday. */
function dayOf(at: string | null, t: (id: string, values?: Record<string, string | number>) => string): string {
  if (!at) return '';
  const d = new Date(at);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days <= 0) return t('messages:ai.short.today');
  if (days === 1) return t('messages:ai.short.yesterday');
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

export function AiLists({ hero, ready, rows, owed, progress, waiting, live, openRow, openThread }: {
  /** The page's title, drawn in the sheet the chips are in. */
  hero: ReactNode;
  /** The lists have been read: until then Needs you says nothing, not "nothing needs you". */
  ready: boolean;
  rows: WorkRow[];
  owed: number;
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
}): ReactNode {
  const t = useMessages('messages');
  const say = (p: Phrase | null) => (p ? t(p.id, p.values) : null);
  // The projects in any list, in the order they first come; the ones picked.
  const [only, setOnly] = useState<string[]>([]);
  const projects = projectsOf(rows, progress, waiting, live);
  const picked = only.filter((slug) => projects.some((p) => p.slug === slug));
  const shows = (app: AiApp | null) => !picked.length || (!!app && picked.includes(app.slug));
  const toggle = (slug: string) => setOnly(picked.includes(slug) ? picked.filter((x) => x !== slug) : [...picked, slug]);

  const needLines: Line[] = rows.filter((row) => shows(row.app)).map((row) => ({
    key: row.key,
    kind: row.key.startsWith('need:') ? 'need' : row.key.split(':')[0],
    app: row.app,
    glyph: needGlyph(row),
    number: Number(row.sub.values?.number) || null,
    title: row.title,
    right: row.pill ? say(row.pill)! : t('messages:ai.short.private'),
    tooltip: say(row.sub)!,
    why: say(whyOf(row)),
    owe: !!row.pill,
    open: () => openRow(row),
  }));
  const threadLine = (glyph: (th: AiThread) => ReactNode) => (th: AiThread): Line => ({
    key: String(th.threadId),
    kind: th.what,
    app: th.app,
    glyph: glyph(th),
    number: th.number,
    title: th.title || '',
    right: say(shortWords(th))!,
    tooltip: say(nextWords(th))!,
    why: say(threadWhy(th)),
    owe: false,
    open: () => openThread(th),
  });
  const progressShown = progress.filter((x) => shows(x.app));
  const waitingShown = waiting.filter((x) => shows(x.app));
  const liveLines: Line[] = live.filter((x) => shows(x.app)).map((th) => ({
    ...threadLine(() => <CheckIcon className={G} />)(th),
    right: dayOf(th.at, t),
    tooltip: t('messages:ai.live.row', { project: th.app?.name || '', number: th.number || '' }),
  }));
  const owedShown = picked.length ? needLines.filter((line) => line.owe).length : owed;
  // One project picked: its chip names it, so its name is not said again over every section.
  const heads = picked.length !== 1;

  return (
    <div className="flex flex-col gap-3 pt-4" data-ai-lists="">
      <div className={`${PLANE} pt-1`} data-ai-sheet="head">
        {hero}
        {projects.length > 1 ? (
          <FadeRail role="group" aria-label={t('messages:ai.filter.label')} data-ai-project-chips="">
            <Chip size="bar" className={`px-4 ${CHIP_EDGE}`} selected={!picked.length} onClick={() => setOnly([])}>
              {t('messages:ai.filter.all')}
            </Chip>
            {projects.map((app) => (
              <Chip key={app.slug} size="bar" className={`gap-2 pl-2.5 pr-4 ${CHIP_EDGE}`} selected={picked.includes(app.slug)} onClick={() => toggle(app.slug)} data-ai-chip={app.slug}>
                <SmallTile app={app} />
                {app.name || app.slug}
              </Chip>
            ))}
          </FadeRail>
        ) : <div className="pb-3" />}
      </div>
      <div className={`${PLANE} pb-4`} data-ai-sheet="open">
        <Section
          list="work"
          keep
          top="band"
          head={owedShown ? t('messages:ai.work.titleCount', { count: owedShown }) : t('messages:ai.work.title')}
          owe={owedShown > 0}
          lines={needLines}
          empty={ready ? <p className="py-3 text-sm text-zinc-500 dark:text-zinc-400" data-ai-empty="">{t('messages:ai.work.empty')}</p> : null}
          first={GROUP_FIRST.needs}
          heads={heads}
        />
        <Section list="next" top="line" head={t('messages:ai.next.titleCount', { count: progressShown.length })} lines={progressShown.map(threadLine(nextGlyph))} first={GROUP_FIRST.next} heads={heads} />
        <Section list="up" top="line" head={t('messages:ai.up.titleCount', { count: waitingShown.length })} lines={waitingShown.map(threadLine(() => <ClockIcon className={G} />))} first={GROUP_FIRST.waiting} heads={heads} />
      </div>
      {liveLines.length ? (
        <div className={`${PLANE} pb-2`} data-ai-sheet="live">
          <Section list="live" top="band" quiet head={t('messages:ai.live.title', { count: liveLines.length })} lines={liveLines} first={GROUP_FIRST.live} heads={heads} />
        </div>
      ) : null}
    </div>
  );
}
