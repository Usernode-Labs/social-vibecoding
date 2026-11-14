/**
 * The Homeroom bot tab's lists (30 Oct 2026, Evan, from his Task Assistant
 * prototype and a day of iterating on the page as an artifact):
 *
 *   [tile] Homeroom bot              ← a sheet of its own: the title, then
 *          Needs you: 15 · …           chips to see only some projects' work
 *   ( All ) ( Homeroom ) ( Game Corner ) ( Run Club )    ( 28 more ⌄ )
 *
 *   [bot] Main Chat          2 new   ← 1 Nov 2026: the list's first row, the
 *                                      chat with the bot itself (./index.tsx)
 *
 *   NEEDS YOU · 15                   ← a band, the sheet's width
 *   [tile] Homeroom
 *     ☑ #6038  Spell out the approval rules…      Vote
 *     ▶ #6000  Add reopen proposal…               Build it
 *              Show 5 more ⌄
 *
 *   WAITING & IN PROGRESS · 8        ← a sheet of its own, quieter rows:
 *                                      what is under way, then what waits
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
 *                    every section. The rail shows any picked from More,
 *                    then the three that need you most; its last chip, "N
 *                    more", opens every project with a search
 *                    (./project-picker.tsx, 30 Oct 2026: a chip a project
 *                    was unusable with dozens).
 *   no row lines     space and the project's name group the rows.
 *
 * Rows here are 14px over one line, not the shell's 15 over 13 (AGENTS.md,
 * "Type and colour"): this page's exception, recorded there.
 *
 * The row whose place is in the column beside the list (Main Chat, a
 * private thread, or a request, a change or a decision on its page: #6218)
 * is drawn lit, where you are (`--lit-tint`, `--lit-ink`). A row is lit by
 * the column it opens (./column.ts rowKey), the one the page says is open.
 * #6153: a design thread filed as a request is that request's row (In
 * progress, Waiting or Live, with the track's word on its right), which
 * opens the thread and is lit while it is in the column.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import type { ReactNode } from 'react';

import { Chip, FadeRail } from '@/components/ui/chip';
import { SectionHeader } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import {
  ArrowPathIcon, ArrowUpTrayIcon, BallotIcon, ChatBubbleTailIcon, ChatIcon, CheckIcon, ChevronDownIcon, ClockIcon, CodeIcon,
  CogIcon, EyeIcon, HandRaisedIcon, LockIcon, PlayIcon, ReplyArrowIcon, WarningTriangleIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { getDateLocale } from '../../lib/i18n/runtime';
import { BOT_AVATAR } from '../messages/format';
import {
  GROUP_FIRST, byDay, byProject, dayKey, freshFirst, groupRows, holdOrder,
  type AiApp, type AiThread, type WorkRow,
} from './model';
import { ThreadDoneMenu } from '../messages/private-thread-done';
import { reload as reloadTab } from '../../lib/tab-build';
import { dayHeading, useAiLines, type Glyph, type Line } from './lines';
import { usePhone } from './phone-drawer';
import { ProjectPicker } from './project-picker';
import { SmallTile } from './small-tile';
import { HISTORY_KINDS, type HistoryKind } from './filter-address';
import { monthName, type HistoryRow, type HistoryState } from './history';

// The plane a list stands on, as GroupedList draws one: the sheet's solid
// fill, 20px, one inset hairline. Complete literals for Tailwind.
const PLANE = 'mx-4 rounded-[20px] bg-[color:var(--dc-sheet-solid)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
// #6424: Main Chat's card holds one row, so when that chat is open the card
// itself is lit. A tinted box inside the round card left an uneven white ring.
const MAIN_LIT = 'mx-4 rounded-[20px] bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';
// A chip on a sheet: the sheet's own hairline round it, so a white chip does not melt into it.
const CHIP_EDGE = 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

const G = 'h-[18px] w-[18px]';
/** Each glyph's icon on this face (./lines.ts names them). */
const GLYPHS: Record<Glyph, (props: { className?: string }) => ReactNode> = {
  chat: ChatIcon, play: PlayIcon, hand: HandRaisedIcon, check: CheckIcon, again: ArrowPathIcon, warning: WarningTriangleIcon,
  lock: LockIcon, ballot: BallotIcon, upload: ArrowUpTrayIcon, eye: EyeIcon, cog: CogIcon, reply: ReplyArrowIcon, code: CodeIcon,
  clock: ClockIcon, x: XIcon, bubble: ChatBubbleTailIcon,
};
function GlyphIcon({ name }: { name: Glyph }): ReactNode {
  const Icon = GLYPHS[name];
  return <Icon className={G} />;
}

// Complete literals: Tailwind's extractor reads source text. 36px a row on a
// desktop, so a project's rows sit closer than the groups do; 44px on a
// phone, the shell's tap target.
const ROW = 'flex w-full min-h-[44px] md:min-h-[36px] items-center gap-3 py-1.5 md:py-1 text-start rounded-md hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04]';
const LIVE_ROW = 'flex w-full min-h-[40px] md:min-h-[32px] items-center gap-3 py-1 text-start rounded-md hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.04]';
const GLYPH_OWE = 'flex shrink-0 text-violet-600 dark:text-violet-300';
const GLYPH = 'flex shrink-0 text-zinc-400 dark:text-zinc-500';
// Where you are: the row whose chat is in the column, on the lit tint.
const LIT_ROW = 'flex w-full min-h-[44px] md:min-h-[36px] items-center gap-3 py-1.5 md:py-1 text-start rounded-md bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)]';
// #6424: the row inside a lit card: the lit row's layout without its own
// fill and radius, so the card's edges are the only ones on screen.
const MAIN_LIT_ROW = 'flex w-full min-h-[44px] md:min-h-[36px] items-center gap-3 py-1.5 md:py-1 text-start';

function LineRow({ line, quiet = false, freshTitles = false }: { line: Line; quiet?: boolean; freshTitles?: boolean }): ReactNode {
  // #6159: a private thread's row has its ⋯ beside it, with Mark done.
  if (line.done) {
    const { rootId, mark } = line.done;
    return (
      <div className="flex min-w-0 items-center gap-1" data-ai-line-done="">
        <div className="min-w-0 flex-1"><LineButton line={line} quiet={quiet} freshTitles={freshTitles} /></div>
        <ThreadDoneMenu rootId={rootId} done={false} onChanged={(state) => { if (state === 'done') mark(); }} className="shrink-0" />
      </div>
    );
  }
  return <LineButton line={line} quiet={quiet} freshTitles={freshTitles} />;
}

/**
 * #6262: the dot in the row's leading margin, so rows with and without one
 * stay lined up. The accent the page already uses for Vote and Needs Reply.
 */
const DOT = 'absolute -start-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-violet-600 dark:bg-violet-300';

/**
 * #6312 (4 Nov 2026, Evan): the box a fold clips, while it animates open and
 * shut. The dot stands 12px past its row's start edge (DOT), so the box keeps
 * 16px of room on that side: the negative start margin widens the clip edge,
 * and the same padding leaves every row exactly where it was, so a row with
 * something new shows its dot folded and open alike.
 */
const FOLD_CLIP = 'min-h-0 overflow-hidden -ms-4 ps-4';

function LineButton({ line, quiet = false, freshTitles = false }: { line: Line; quiet?: boolean; freshTitles?: boolean }): ReactNode {
  const t = useMessages('messages');
  // #6421: a thread that holds several requests says how many after its title.
  const many = Number(line.requests) > 1;
  const requestsWord = many ? t('messages:ai.row.requests', { count: line.requests }) : '';
  const tooltip = many ? `${line.tooltip} · ${requestsWord}` : line.tooltip;
  return (
    <button
      type="button"
      className={`${line.lit ? LIT_ROW : quiet ? LIVE_ROW : ROW} relative`}
      onClick={line.open}
      title={tooltip}
      data-ai-line={line.kind}
      data-ai-lit={line.lit ? '' : undefined}
      data-ai-fresh={line.fresh ? '' : undefined}
      aria-current={line.lit ? 'true' : undefined}
    >
      {line.fresh ? <span className={DOT} aria-hidden="true" data-ai-dot="" /> : null}
      <span className={line.owe ? GLYPH_OWE : GLYPH} aria-hidden="true"><GlyphIcon name={line.glyph} /></span>
      {/* Not on a phone, where the drawer's list is 85% of the screen: the
          title needs the room more, and the tooltip still says the number.
          1 Nov 2026: nor under 1024px, where the column beside the list
          leaves it about as narrow. */}
      <span className="hidden lg:block w-12 shrink-0 font-mono text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        {line.number ? t(line.pr ? 'messages:ai.live.numberPr' : 'messages:ai.live.number', { number: line.number }) : ''}
      </span>
      <span className="min-w-0 flex-1">
        <span className={line.lit
          ? 'block truncate text-sm leading-5 font-medium'
          : quiet
            ? 'block truncate text-[13px] leading-5 text-zinc-600 dark:text-zinc-400'
            : line.fresh
              // #6262: what is new is bold; the rest of Needs you, once
              // anything there is new, is lighter so it stands out.
              ? 'block truncate text-sm leading-5 font-bold text-zinc-900 dark:text-zinc-100'
              : freshTitles
                ? 'block truncate text-sm leading-5 font-normal text-zinc-600 dark:text-zinc-400'
                : 'block truncate text-sm leading-5 font-medium text-zinc-900 dark:text-zinc-100'}
        >
          {line.title}
          {many ? (
            <span className="ms-1 text-xs font-normal text-zinc-500 dark:text-zinc-400" data-ai-line-requests={line.requests}>
              {requestsWord}
            </span>
          ) : null}
        </span>
        {line.why ? (
          <span className="block truncate text-xs leading-4 text-zinc-500 dark:text-zinc-400 md:hidden" aria-hidden="true" data-ai-line-why="">{line.why}</span>
        ) : null}
      </span>
      {/* #6389: a pill may be two words ("Tests failing", "Conflicts with
          main"), so it never wraps: the title truncates instead. */}
      <span className={line.owe
        ? 'shrink-0 whitespace-nowrap text-[13px] font-semibold text-violet-700 dark:text-violet-300'
        : 'shrink-0 whitespace-nowrap text-[13px] text-zinc-500 dark:text-zinc-400'}
      >
        {line.right}
      </span>
      <span className="sr-only">{tooltip}</span>
    </button>
  );
}

/**
 * #6262: the line between what is new in a project and what the reader has
 * already seen. The small caps label style of the section headings.
 */
function EarlierRule(): ReactNode {
  const t = useMessages('messages');
  return (
    <div className="flex items-center gap-2 py-1.5" data-ai-earlier="">
      <span className="h-px flex-1 bg-[color:var(--app-sheet-line)]" aria-hidden="true" />
      <span className="text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t('messages:ai.work.earlier')}</span>
      <span className="h-px flex-1 bg-[color:var(--app-sheet-line)]" aria-hidden="true" />
    </div>
  );
}

/**
 * 6 Nov 2026 (Evan): the day inside a project's rows, in Needs you and
 * Waiting & in progress: the small caps label with a thin rule after it, as
 * the design's "With date headings" column drew it.
 */
function DayRule({ at }: { at: string | null | undefined }): ReactNode {
  const t = useMessages('messages');
  const label = dayHeading(at, t, getDateLocale());
  if (!label) return null;
  return (
    <div className="flex items-center gap-2 py-1.5" data-ai-day={dayKey(at)}>
      <span className="shrink-0 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="h-px flex-1 bg-[color:var(--app-sheet-line)]" aria-hidden="true" />
    </div>
  );
}

/**
 * #6262: a count of new threads, on a chip or beside a heading. The number
 * is decoration; the spoken words say what it counts.
 */
function FreshBadge({ count, className = '' }: { count: number; className?: string }): ReactNode {
  const t = useMessages('messages');
  if (count <= 0) return null;
  return (
    <span className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-bold ${className}`} data-ai-fresh="">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{t('messages:ai.filter.fresh', { count })}</span>
    </span>
  );
}

/**
 * 1 Nov 2026: Main Chat, the chat with the bot itself, as the list's first
 * row: the bot's mark, its name and, on the right, what is new in it, in
 * words ("2 new"), or nothing. Pressed, it is the column's (./index.tsx).
 */
function MainChatRow({ lit, unread, open }: { lit: boolean; unread: number; open: () => void }): ReactNode {
  const t = useMessages('messages');
  return (
    <div className={`${lit ? MAIN_LIT : PLANE} px-2 py-1.5`} data-ai-sheet="main">
      <button
        type="button"
        className={`${lit ? MAIN_LIT_ROW : ROW} px-2`}
        onClick={open}
        data-ai-main-row=""
        data-ai-lit={lit ? '' : undefined}
        aria-current={lit ? 'true' : undefined}
      >
        <img src={BOT_AVATAR} alt="" className="h-6 w-6 shrink-0 rounded-[8px] object-cover" />
        <span className={lit
          ? 'min-w-0 flex-1 truncate text-sm leading-5 font-semibold'
          : 'min-w-0 flex-1 truncate text-sm leading-5 font-semibold text-zinc-900 dark:text-zinc-100'}
        >
          {t('messages:store.header.main')}
        </span>
        {unread > 0 ? (
          <span className="shrink-0 text-[13px] text-zinc-500 dark:text-zinc-400" data-ai-main-unread="">
            {t('messages:ai.main.new', { count: unread })}
          </span>
        ) : null}
      </button>
    </div>
  );
}

/**
 * The chips' rail inside the title's sheet: one line that scrolls, as the
 * shell's ChipRail does, fading out toward whichever edge has more chips past
 * it rather than cutting the last one off against the sheet's border (Evan,
 * 30 Oct: wrapping to a second line read worse). The fade itself is the chip
 * primitive's, shared with Home's kind chips; this call site keeps the
 * spacing of the sheet's border.
 */

/**
 * A project's own Show more, under its rows: centred, its arrow pointing down
 * (up once open). #6408: where the fold holds rows with something new, it
 * says so ("Show 73 more · 44 new").
 */
function GroupMore({ hidden, fresh = 0, open, onClick }: { hidden: number; fresh?: number; open: boolean; onClick: () => void }): ReactNode {
  const t = useMessages('messages');
  const label = open
    ? t('messages:ai.work.showLess')
    : fresh > 0
      ? t('messages:ai.work.showMoreFresh', { count: hidden, fresh })
      : t('messages:ai.work.showMore', { count: hidden });
  return (
    <button
      type="button"
      className="flex w-full min-h-[44px] md:min-h-0 items-center justify-center gap-1 py-2 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
      onClick={onClick}
      aria-expanded={open}
      data-ai-group-more=""
    >
      {label}
      <ChevronDownIcon className={`h-4 w-4 transition-transform motion-reduce:transition-none${open ? ' rotate-180' : ''}`} aria-hidden="true" />
    </button>
  );
}

/**
 * One section's rows under their project, once, each project's first few
 * before its own Show more. A row whose chat is in the column is never
 * folded away: past the first rows it joins them, so where you are is
 * always shown.
 */
function GroupList({ lines, quiet = false, heads, first, freshStyle = false, freshProjects, dayHeads = false, foldFresh = false }: {
  lines: Line[];
  quiet?: boolean;
  heads: boolean;
  first: number;
  /** #6262: Needs you draws new rows first, under an Earlier line. */
  freshStyle?: boolean;
  /** How many rows each project has that are new, for its name's pill. */
  freshProjects?: Record<string, number>;
  /** 6 Nov 2026: split each project's rows by day, under a small caps divider. */
  dayHeads?: boolean;
  /**
   * #6408: Live this week folds after its first few whatever is new, so a
   * busy week reads as a list and not fifty rows. Its rows still put what is
   * new first, and the fold counts them.
   */
  foldFresh?: boolean;
}): ReactNode {
  const t = useMessages('messages');
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  return (
    <>
      {byProject(lines).map((g) => {
        const key = g.app?.slug || 'none';
        const open = !!opened[key];
        // #6245: only a folded group lifts the row you are on. Once its Show
        // more has opened every row, they keep their own order, so pressing
        // one does not slide it up under the pointer. #6262: a fresh row is
        // never folded either.
        // 6 Nov 2026: a day-headed list keeps each day's rows together, so a
        // project reads Today's rows, then Yesterday's, then the date.
        const { items, shown, hidden } = groupRows(dayHeads ? byDay(g.items) : g.items, first, open, !foldFresh);
        // #6408: how many of the folded rows have something new, for Show more's ending.
        const freshHidden = foldFresh ? items.slice(shown).filter((line) => line.fresh).length : 0;
        const anyFresh = freshStyle && g.items.some((line) => line.fresh);
        const firstOld = anyFresh ? items.findIndex((line) => !line.fresh) : -1;
        // The line only where an older row is actually drawn: with every
        // older row folded, Show more already says there is more.
        const earlierAt = firstOld >= 0 && firstOld < shown ? firstOld : -1;
        const freshHere = freshStyle && g.app ? freshProjects?.[g.app.slug] || 0 : 0;
        const draw = (line: Line) => <LineRow key={line.key} line={line} quiet={quiet} freshTitles={freshStyle} />;
        // 6 Nov 2026: the day each drawn row opens, in the order the rows are
        // drawn. A divider past the fold stays inside the fold, and a day that
        // spans the fold is not said twice: the first folded row shares the
        // day the last drawn one did.
        let lastDay = '';
        const drawn = items.map((line) => {
          const day = dayHeads ? dayKey(line.at) : '';
          const divider = !!day && day !== lastDay;
          if (day) lastDay = day;
          return { line, divider };
        });
        const visible = hidden ? drawn.slice(0, shown) : drawn;
        const folded = hidden ? drawn.slice(shown) : [];
        return (
          <div key={key} data-ai-group={key}>
            {heads ? (
              <div className="flex items-center gap-2 pt-3 pb-1 text-[13px] font-semibold text-zinc-600 dark:text-zinc-300" data-ai-project-head="">
                {/* A private idea in no project yet goes under Only you, with a lock. */}
                {g.app ? <SmallTile app={g.app} size="head" /> : <LockIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                <span className="truncate">{g.app ? g.app.name || g.app.slug : t('messages:ai.short.private')}</span>
                {g.items.some((line) => line.left) ? (
                  <span className="shrink-0 font-normal text-zinc-500 dark:text-zinc-400" data-ai-left="">· {t('messages:ai.history.left')}</span>
                ) : null}
                {freshHere > 0 ? (
                  <span className="ms-auto shrink-0 rounded-full bg-violet-600/10 px-2 py-0.5 text-xs font-semibold tracking-normal text-violet-700 dark:bg-violet-500/20 dark:text-violet-300" data-ai-fresh="">
                    {t('messages:ai.work.fresh', { count: freshHere })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* The rows sit in a little under their project's name. */}
            <div className={heads ? 'ms-3' : undefined}>
              {visible.map(({ line, divider }, i) => (
                <Fragment key={line.key}>
                  {i === earlierAt ? <EarlierRule /> : null}
                  {divider ? <DayRule at={line.at} /> : null}
                  {draw(line)}
                </Fragment>
              ))}
              {/* The rest, folded: a grid row that grows from 0fr to 1fr, so
                  it opens to its own height without measuring it. */}
              {hidden ? (
                <div
                  className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
                  aria-hidden={open ? undefined : true}
                  inert={!open}
                  data-ai-group-rest=""
                >
                  <div className={FOLD_CLIP}>
                    {folded.map(({ line, divider }) => (
                      <Fragment key={line.key}>
                        {divider ? <DayRule at={line.at} /> : null}
                        {draw(line)}
                      </Fragment>
                    ))}
                  </div>
                </div>
              ) : null}
              {hidden ? <GroupMore hidden={hidden} fresh={freshHidden} open={open} onClick={() => setOpened((o) => ({ ...o, [key]: !open }))} /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

function Section({ list, head, owe = false, lines, still = null, quiet = false, empty = null, note = null, keep = false, first, heads, fresh = 0, freshBySlug, freshStyle = false, dayHeads = false, foldFresh = false }: {
  /** Which list, for the page's checks: work, busy, live. */
  list: string;
  /** Said over the rows, whatever they are: why the lists show less than they should. */
  note?: ReactNode;
  /** Drawn with no rows too: Needs you's band is in the prerender. */
  keep?: boolean;
  head: ReactNode;
  owe?: boolean;
  lines: Line[];
  /**
   * #6158: the rows nobody is moving, in one part of their own at the
   * bottom of the section, folded until it is opened (or one of them is
   * where you are).
   */
  still?: { head: string; lines: Line[] } | null;
  quiet?: boolean;
  empty?: ReactNode;
  /** Rows a project shows before its own Show more. */
  first: number;
  /** The project's name over its rows; not when one project's chip says it already. */
  heads: boolean;
  /** #6262: how many of its rows have something new, for the band's pill. */
  fresh?: number;
  /** #6262: each project's count of new rows, for its name's pill. */
  freshBySlug?: Record<string, number>;
  /** #6262: Needs you draws new first, with an Earlier line (GroupList). */
  freshStyle?: boolean;
  /** 6 Nov 2026: split each project's rows by day (Needs you, Waiting & in progress). */
  dayHeads?: boolean;
  /** #6408: Live this week puts new rows first and folds after its first few whatever is new. */
  foldFresh?: boolean;
}): ReactNode {
  const t = useMessages('messages');
  const [stillOpen, setStillOpen] = useState(false);
  // #6245: while the pointer is over Needs you or a row in it has keyboard
  // focus, keep the order it was drawn in, so a live refresh cannot slide a
  // row out from under the one being pressed. Rows that arrived meanwhile
  // follow the drawn ones; anything that left drops out at once. On release
  // the list settles into the incoming order.
  const holdRef = useRef<HTMLElement | null>(null);
  const drawn = useRef<string[] | null>(null);
  const [holding, setHolding] = useState(false);
  const hold = list === 'work';
  // #6262: Needs you draws what is new first, before the order is held, so
  // a held list keeps the order it was drawn in (#6245). #6408: Live this
  // week does the same without the styles, so its first few include any new.
  const ordered = freshStyle || foldFresh ? freshFirst(lines) : lines;
  const held = hold && holding && drawn.current ? holdOrder(ordered, drawn.current) : ordered;
  const startHold = () => {
    if (!hold) return;
    if (!drawn.current) drawn.current = ordered.map((line) => line.key);
    setHolding(true);
  };
  const endHold = () => {
    if (!hold) return;
    drawn.current = null;
    setHolding(false);
  };
  const within = (node: EventTarget | null) => !!holdRef.current && node instanceof Node && holdRef.current.contains(node);
  if (!lines.length && !still?.lines.length && !empty && !note && !keep) return null;
  const label = owe ? 'text-violet-700 dark:text-violet-300' : '';
  // A row in the folded part that is where you are opens it.
  const stillShown = stillOpen || !!still?.lines.some((l) => l.lit);
  const body = (
    <>
      {note}
      {!lines.length ? empty : null}
      <GroupList lines={held} quiet={quiet} heads={heads} first={first} freshStyle={freshStyle} freshProjects={freshBySlug} dayHeads={dayHeads} foldFresh={foldFresh} />
      {still && still.lines.length ? (
        <div data-ai-still-part="">
          <button
            type="button"
            className="flex w-full min-h-[44px] md:min-h-0 items-center justify-start gap-1 py-2 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
            onClick={() => setStillOpen((o) => !o)}
            aria-expanded={stillShown}
            data-ai-still=""
          >
            {still.head}
            <ChevronDownIcon className={`h-4 w-4 transition-transform motion-reduce:transition-none${stillShown ? ' rotate-180' : ''}`} aria-hidden="true" />
          </button>
          <div
            className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${stillShown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
            aria-hidden={stillShown ? undefined : true}
            inert={!stillShown}
            data-ai-still-rest=""
          >
            <div className={FOLD_CLIP}>
              <GroupList lines={still.lines} quiet={quiet} heads={heads} first={still.lines.length} dayHeads={dayHeads} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
  return (
    <section
      ref={holdRef}
      className="pb-1"
      data-ai-list={list}
      onPointerEnter={startHold}
      onPointerLeave={endHold}
      onFocus={(e) => { if (!within(e.relatedTarget)) startHold(); }}
      onBlur={(e) => { if (!within(e.relatedTarget)) endHold(); }}
    >
      <div className="mb-1 rounded-t-[20px] bg-zinc-900/[0.035] px-4 pt-3 pb-2 dark:bg-white/[0.045]" data-ai-band="">
        <SectionHeader className={`px-0 pt-0 pb-0 ${label}`}>
          {head}
          {fresh > 0 ? (
            <span className="ms-1.5 rounded-full bg-violet-600/10 px-2 py-0.5 align-middle text-xs font-semibold tracking-normal text-violet-700 dark:bg-violet-500/20 dark:text-violet-300" data-ai-fresh="">
              {t('messages:ai.work.fresh', { count: fresh })}
            </span>
          ) : null}
        </SectionHeader>
      </div>
      <div className="px-4">{body}</div>
    </section>
  );
}

/**
 * Offline test, 2 Nov 2026: the lists could not be read and this device kept
 * no copy of them, so Needs you says why it shows nothing, in words, with a
 * way to read them again. Plain, not red: being offline is a state.
 */
function ListsFailed({ failed, onRetry }: { failed: 'unreachable' | 'failed'; onRetry: () => void }): ReactNode {
  const t = useMessages('messages');
  return (
    <div className="py-3" data-ai-failed={failed} role="status">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {failed === 'unreachable' ? t('messages:ai.work.unreachable') : t('messages:ai.work.failed')}
      </p>
      <button
        type="button"
        className="mt-1 inline-flex min-h-[44px] md:min-h-0 items-center py-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
        onClick={onRetry}
        data-ai-retry=""
      >
        {t('core:common.tryAgain')}
      </button>
    </div>
  );
}

export function AiLists({
  hero, main, query = '', lit = null, ready, failed = null, onRetry, rows, owed, progress, waiting, live, openRow, openThread, onDone,
  picked: pickedIn = [], onPick, appFor, history = null, historyKind = null, onHistoryKind, openHistory, historyRef,
}: {
  /** The page's title, drawn in the sheet the chips are in. */
  hero: ReactNode;
  /**
   * #6398: what the page's search box says. The lists keep only the threads
   * whose title, number or project name contains it, upper and lower case
   * alike; a section with no match folds away, and Main Chat steps aside
   * while you search. '' (the box closed or empty) filters nothing.
   */
  query?: string;
  /** Main Chat's row: whether it is the one in the column, what is new in it, and its press. */
  main: { lit: boolean; unread: number; open: () => void };
  /**
   * What the column shows (./column.ts columnKey): `main`, `private:<root>`
   * or `page:<route>`. The row that opens it is lit: a private thread's row,
   * the row of the request it was filed as (#6153), or a request's, a
   * change's or a decision's row while its page is in the column (#6218).
   */
  lit?: string | null;
  /** The lists have been read: until then Needs you says nothing, not "nothing needs you". */
  ready: boolean;
  /** A list could not be read and none was kept: Needs you says so (index.tsx ListsFailure). */
  failed?: 'unreachable' | 'failed' | null;
  /** Read the lists again: the note's Try again. */
  onRetry?: () => void;
  rows: WorkRow[];
  owed: number;
  progress: AiThread[];
  waiting: AiThread[];
  live: AiThread[];
  openRow: (row: WorkRow) => void;
  openThread: (t: AiThread) => void;
  /** #6159: a private thread's row was marked done from its ⋯: it leaves the lists at once. */
  onDone?: (rootId: number) => void;
  /**
   * The projects the chips narrow every list to (none: All). The page keeps
   * them, in its address (./filter-address.ts), so a link can open the tab
   * narrowed to a project: a project's Workshop and Hub do.
   */
  picked?: readonly string[];
  onPick?: (slugs: string[]) => void;
  /** A project the lists do not name (one picked by a link), for its chip. */
  appFor?: (slug: string) => AiApp | null;
  /** The History card's rows (./history.ts useHistory); none, no card. */
  history?: HistoryState | null;
  historyKind?: HistoryKind | null;
  onHistoryKind?: (kind: HistoryKind | null) => void;
  openHistory?: (row: HistoryRow) => void;
  /** The card itself, which #homeroom-bot/history scrolls to. */
  historyRef?: React.Ref<HTMLDivElement>;
}): ReactNode {
  const t = useMessages('messages');
  // The rows, the chips' projects, the counts and the notes are built once
  // for this list and the one the looks draw (./lines.ts).
  const {
    searching, ranked, picked, rail, past, setOnly, toggle, freshAll, freshByApp, freshShown, freshProjects,
    needLines, busyLines, stillLines, liveLines, liveBehind, onlyApp, nothingHere, locale, historyLines, historyMonths,
    owedShown, heads, noMatches,
  } = useAiLines({ query, lit, ready, rows, owed, progress, waiting, live, openRow, openThread, onDone, picked: pickedIn, onPick, appFor, history, openHistory });
  // More, open under its chip.
  const [more, setMore] = useState<DOMRect | null>(null);
  const phone = usePhone();
  return (
    <div className="flex flex-col gap-3 pt-4" data-ai-lists="">
      <div className={`${PLANE} pt-1`} data-ai-sheet="head">
        {hero}
        {ranked.length > 1 || picked.length ? (
          // More stands outside the rail, at its end, so a phone's narrow
          // rail never scrolls it out of reach. Drawn too whenever a link
          // picked a project, however few there are, so All is a tap away.
          <div className="flex items-start" data-ai-project-filter="">
            <FadeRail role="group" aria-label={t('messages:ai.filter.label')} data-ai-project-chips="" className="mx-1.5 min-w-0 flex-1 gap-2 px-2.5 pt-3 pb-4">
              <Chip size="bar" className={`px-4 ${CHIP_EDGE}`} selected={!picked.length} onClick={() => setOnly([])}>
                {t('messages:ai.filter.all')}
                <FreshBadge count={freshAll} className={!picked.length ? 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-white' : 'bg-violet-600 text-white'} />
              </Chip>
              {rail.map((app) => (
                <Chip key={app.slug} size="bar" className={`gap-2 ps-2.5 pe-4 ${CHIP_EDGE}`} selected={picked.includes(app.slug)} onClick={() => toggle(app.slug)} data-ai-chip={app.slug}>
                  <SmallTile app={app} />
                  {app.name || app.slug}
                  <FreshBadge count={freshByApp[app.slug] || 0} className={picked.includes(app.slug) ? 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-white' : 'bg-violet-600 text-white'} />
                </Chip>
              ))}
            </FadeRail>
            {past > 0 ? (
              <Chip
                size="bar"
                className={`mb-4 me-4 mt-3 gap-1 ps-4 pe-3 ${CHIP_EDGE}`}
                selected={false}
                aria-pressed={undefined}
                aria-haspopup="dialog"
                aria-expanded={!!more}
                onClick={(e) => setMore(more ? null : e.currentTarget.getBoundingClientRect())}
                data-ai-project-more=""
              >
                {t('messages:ai.filter.more', { count: past })}
                <ChevronDownIcon aria-hidden="true" />
              </Chip>
            ) : null}
          </div>
        ) : <div className="pb-3" />}
      </div>
      {/* #6398: Main Chat is not a thread you are searching for, so it steps
          aside while a search is on, and one short note says when nothing on
          the page matched. */}
      {searching ? null : <MainChatRow lit={main.lit} unread={main.unread} open={main.open} />}
      {noMatches ? (
        <div className={`${PLANE} px-4 py-3`} data-ai-search-empty="">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('messages:ai.search.none', { query: query.trim() })}</p>
        </div>
      ) : null}
      {more ? (
        <ProjectPicker
          sheet={phone}
          anchor={more}
          ranked={ranked}
          picked={picked}
          onToggle={toggle}
          onClear={() => setOnly([])}
          onClose={() => setMore(null)}
        />
      ) : null}
      {!searching || !ready || needLines.length || failed ? (
      <div className={`${PLANE} pb-4`} data-ai-sheet="open">
        <Section
          list="work"
          keep
          head={owedShown ? t('messages:ai.work.titleCount', { count: owedShown }) : t('messages:ai.work.title')}
          owe={owedShown > 0}
          lines={needLines}
          note={failed ? <ListsFailed failed={failed} onRetry={() => onRetry?.()} /> : null}
          /* While searching, this card is drawn only when it has a match, so
             its empty line is never the search's answer: the page says "No
             threads match" in one note of its own (#6398). */
          empty={ready ? (
            <p className="py-3 text-sm text-zinc-500 dark:text-zinc-400" data-ai-empty={nothingHere ? 'project' : ''}>
              {nothingHere && onlyApp ? t('messages:ai.filter.emptyProject', { project: onlyApp.name || onlyApp.slug }) : t('messages:ai.work.empty')}
            </p>
          ) : (
            // L06 (overnight audit, 2 Nov 2026): until the lists are read the
            // card said nothing at all, an empty card that read as final.
            // Two rows' lines at the one-line row's spacing instead: two
            // bars and no more, as the screen is in the prerendered document
            // (tests/mount-on-reveal.test.js counts its elements). A read
            // that failed says so in its note (ListsFailed) instead, with no
            // skeleton under it: no rows are coming (offline test, 2 Nov 2026).
            failed ? null : (
              <SkeletonGroup label={t('messages:ai.work.loading')} className="flex flex-col gap-8 py-4" data-ai-loading="">
                <Skeleton className="w-1/2" />
                <Skeleton className="w-2/5" />
              </SkeletonGroup>
            )
          )}
          first={searching ? Infinity : GROUP_FIRST.needs}
          heads={heads}
          fresh={freshShown}
          freshBySlug={freshProjects}
          freshStyle
          dayHeads
        />
      </div>
      ) : null}
      {busyLines.length || stillLines.length ? (
        <div className={`${PLANE} pb-2`} data-ai-sheet="busy">
          <Section
            list="busy"
            quiet
            head={t('messages:ai.busy.title', { count: busyLines.length + stillLines.length })}
            lines={busyLines}
            still={stillLines.length ? { head: t('messages:ai.up.stillCount', { count: stillLines.length }), lines: stillLines } : null}
            first={searching ? Infinity : GROUP_FIRST.busy}
            heads={heads}
            dayHeads
          />
        </div>
      ) : null}
      {liveLines.length ? (
        <div className={`${PLANE} pb-2`} data-ai-sheet="live">
          <Section list="live" quiet head={t('messages:ai.live.title', { count: liveLines.length })} lines={liveLines} first={searching ? Infinity : GROUP_FIRST.live} heads={heads} foldFresh />
          {liveBehind ? (
            // #6233: one Reload under the list, for every row this tab is
            // older than.
            <div className="flex items-center gap-2 border-t border-zinc-900/[0.07] px-4 pt-2 pb-1 dark:border-white/[0.08]" data-ai-older-tab="">
              <span className="min-w-0 flex-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('messages:ai.live.olderTab')}</span>
              <button
                type="button"
                className="shrink-0 text-[13px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
                onClick={() => reloadTab()}
                data-ai-older-tab-reload=""
              >
                {t('messages:ai.short.reload')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* #6398: History is searched as far as it has loaded; with no match in
          it, its card folds away like any other section. */}
      {history && (!searching || historyLines.length) ? (
        <div ref={historyRef} className={`${PLANE} pb-2 scroll-mt-4`} data-ai-sheet="history">
          <section className="pb-1" data-ai-list="history">
            <div className="mb-1 rounded-t-[20px] bg-zinc-900/[0.035] px-4 pt-3 pb-2 dark:bg-white/[0.045]" data-ai-band="">
              <SectionHeader className="px-0 pt-0 pb-0">{t('messages:ai.history.title')}</SectionHeader>
            </div>
            <div role="group" aria-label={t('messages:ai.history.kind.label')} className="flex gap-1.5 overflow-x-auto px-4 pt-1.5 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-ai-history-kinds="">
              <Chip size="bar" className={`h-8 px-3 text-[13px] ${CHIP_EDGE}`} selected={!historyKind} onClick={() => onHistoryKind?.(null)} data-ai-history-kind="all">
                {t('messages:ai.history.kind.all')}
              </Chip>
              {HISTORY_KINDS.map((kind) => (
                <Chip key={kind} size="bar" className={`h-8 px-3 text-[13px] ${CHIP_EDGE}`} selected={historyKind === kind} onClick={() => onHistoryKind?.(kind)} data-ai-history-kind={kind}>
                  {kind === 'change' ? t('messages:ai.history.kind.change')
                    : kind === 'request' ? t('messages:ai.history.kind.request')
                      : kind === 'vote' ? t('messages:ai.history.kind.vote')
                        : t('messages:ai.history.kind.solo')}
                </Chip>
              ))}
            </div>
            <div className="px-4">
              {!history.ready ? (
                <SkeletonGroup label={t('messages:ai.history.loading')} className="flex flex-col gap-8 py-4" data-ai-history-loading="">
                  <Skeleton className="w-1/2" />
                  <Skeleton className="w-2/5" />
                </SkeletonGroup>
              ) : null}
              {history.ready && history.failed && !historyLines.length ? (
                <div className="py-3" role="status" data-ai-history-failed="">
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('messages:ai.history.failed')}</p>
                  <button
                    type="button"
                    className="mt-1 inline-flex min-h-[44px] md:min-h-0 items-center py-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 dark:text-violet-300 dark:hover:text-violet-200"
                    onClick={history.retry}
                  >
                    {t('core:common.tryAgain')}
                  </button>
                </div>
              ) : null}
              {history.ready && !history.failed && !historyLines.length && !history.next ? (
                <p className="py-3 text-sm text-zinc-500 dark:text-zinc-400" data-ai-history-empty="">{t('messages:ai.history.empty')}</p>
              ) : null}
              {historyMonths.map((month) => (
                <div key={month.key} data-ai-history-month={month.key}>
                  <h3 className="m-0 pt-4 text-[13px] font-bold text-zinc-900 dark:text-zinc-100">{monthName(month.at, locale)}</h3>
                  <GroupList lines={month.rows} quiet heads={heads} first={searching ? Infinity : GROUP_FIRST.live} />
                </div>
              ))}
              {history.ready && history.next ? (
                <button
                  type="button"
                  className="flex w-full min-h-[44px] md:min-h-0 items-center justify-start gap-1 py-2 text-[13px] font-semibold text-violet-700 hover:text-violet-800 disabled:opacity-60 dark:text-violet-300 dark:hover:text-violet-200"
                  onClick={history.more}
                  disabled={history.loading}
                  data-ai-history-more=""
                >
                  {t('messages:ai.history.earlier')}
                  <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
