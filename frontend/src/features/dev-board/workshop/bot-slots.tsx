/**
 * HOMEROOM BOT'S SLOTS (16 Oct 2026): a page under a project's Workshop.
 *
 * The bot may hold PROPOSALS_PER_APP_CAP slots on a project (services/
 * homeroom-bot.js slotHolders): a change of its up for a vote or being
 * merged, or a build under way that will become one. When they are all
 * taken, a request found ready waits for one, and nobody could see that
 * happen: five requests sat held on 15 October and none appeared anywhere a
 * person would look. This page shows the slots and what holds each, with
 * its track (../../messages/bot-track.tsx); the requests waiting for one,
 * in the order the bot takes them up; the ones on hold until the week's
 * building time resets; and the limits, the viewer's own building time
 * among them (GET /api/apps/:slug/homeroom-bot/slots, services/
 * homeroom-bot-track.js slotsView).
 *
 * Its doors: a line in the Workshop's overview card, above its approval
 * rule (BotSlotsDoor), the bot chat's drawer (../../messages/bot-strip.tsx), and
 * the card of any request held for a slot (bot-track.tsx trackLinks). Its
 * address is the Workshop's own with `?ws=bot` (places.ts), and the
 * Workshop stays lit in the places list while it is up, as for All items.
 *
 * Each row says what its request is about, not only its number: its title,
 * a line of what it asks in the asker's own words, who asked, and how long
 * it has waited. A row opens its request (or its change, once it has one)
 * the way the Workshop's own rows do: in the panel beside the page on a wide
 * window (`onOpen`, ./side-panel.tsx), else its page. A request the bot
 * found ready that a person has taken since is listed apart, as theirs: the
 * bot leaves it alone, so it does not wait for a slot.
 *
 * Nothing is read on the first render; the page reads in an effect.
 */

import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { ChevronRightIcon } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';

import { t as translate } from '../../../lib/i18n/runtime';
import { useMessages } from '../../../lib/i18n/react';
import { getBotSlots } from '../../messages/api';
import { spanText } from '../../messages/bot-activity';
import { RequestTag } from '../../messages/bot-strip';
import { TrackBadge, TrackBar, trackShort } from '../../messages/bot-track';
import type { BotSlotEntry, BotSlotsView } from '../../messages/types';
import { PageBack } from './page-back';
import type { TopicRef } from './work-row';

type OpenItem = (event: ReactMouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;

interface SlotsState { view: BotSlotsView | null; failed: boolean; loaded: boolean }

/** A project's bot slots, read in an effect, again when the slug changes. */
export function useBotSlots(slug: string | null | undefined): SlotsState {
  const [state, setState] = useState<SlotsState>({ view: null, failed: false, loaded: false });
  useEffect(() => {
    if (!slug) return undefined;
    let live = true;
    setState({ view: null, failed: false, loaded: false });
    getBotSlots(slug)
      .then((view) => { if (live) setState({ view, failed: false, loaded: true }); })
      .catch(() => { if (live) setState({ view: null, failed: true, loaded: true }); });
    return () => { live = false; };
  }, [slug]);
  return state;
}

/**
 * The Workshop's door to the page: one line in its overview card, above
 * the approval rule, "Homeroom bot: 5 of 5 slots in use, 1 request waiting". Nothing on
 * a project the bot does not build on and holds nothing on.
 */
export function BotSlotsDoor({ slug, onOpen }: { slug: string; onOpen: () => void }): ReactNode {
  const t = useMessages('project');
  const { view } = useBotSlots(slug);
  if (!view || (!view.acts && !view.slots.length)) return null;
  const used = view.slots.length;
  const waiting = view.waiting.length;
  const words = waiting
    ? t('project:botSlots.doorWaiting', { used, cap: view.cap, count: waiting })
    : t('project:botSlots.door', { used, cap: view.cap });
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-t border-[color:var(--app-sheet-line)] pt-2.5 text-left text-[13px] font-semibold text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
      data-ws-bot-slots-door={`${used}/${view.cap}`}
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1 truncate">{words}</span>
      <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}

/** Pure: where a row's link goes: its change once it has one, else its request. */
export function hrefOf(entry: BotSlotEntry, slug: string): string | null {
  return entry.track?.links?.proposal || entry.track?.links?.request
    || (entry.issueNumber ? `#app/${encodeURIComponent(slug)}/dev/issues/${entry.issueNumber}` : null);
}

/**
 * Pure: the same item, as the Workshop's panel names it (./work-row.tsx
 * topicRef), or null for a link the panel cannot name (a change with no
 * id), which then opens as a page.
 */
export function entryRef(entry: BotSlotEntry): TopicRef | null {
  if (entry.track?.links?.proposal) return entry.track.proposalId ? { kind: 'proposal', id: entry.track.proposalId } : null;
  return entry.issueNumber ? { kind: 'issue', id: entry.issueNumber } : null;
}

/**
 * Pure: what a row says under its title. Its badge names the state, so the
 * row says where it is and why ("Fixing what its checks found"); one waiting
 * for a slot, under the heading that already says so, its place in line.
 */
export function entryLine(track: BotSlotEntry['track']): string | null {
  return track ? trackShort(track) : null;
}

/** Which of the page's lists a row is in. */
type Section = 'slots' | 'waiting' | 'taken' | 'onHold';

/**
 * Pure: the facts after a row's line: who asked, and how long a request
 * has waited for a slot, or since a person took it.
 */
export function entryMeta(entry: BotSlotEntry, section: Section, now: Date): string[] {
  const out: string[] = [];
  if (entry.askedBy) out.push(translate('project:botSlots.meta.asked', { username: entry.askedBy }));
  const span = section === 'waiting' || section === 'taken' ? spanText(entry.since || null, now) : null;
  if (span) out.push(translate(section === 'taken' ? 'project:botSlots.meta.taken' : 'project:botSlots.meta.waiting', { span }));
  return out;
}

/**
 * One request on the page: its badge, number and title; a line of what it
 * asks; where it is, who asked and how long it has waited; and its bar.
 * The row is its item's link, opened beside the page where there is room.
 */
function EntryRow({ entry, section, slug, openKey, onOpen }: {
  entry: BotSlotEntry;
  section: Section;
  slug: string;
  openKey?: string | null;
  onOpen?: OpenItem;
}): ReactNode {
  const t = useMessages('project');
  const track = entry.track;
  const title = entry.title || (entry.issueNumber ? t('project:botSlots.untitled', { number: entry.issueNumber }) : '');
  const href = hrefOf(entry, slug);
  const ref = entryRef(entry);
  const on = !!openKey && !!ref && openKey === `${ref.kind}:${ref.id}`;
  const facts = [entryLine(track), ...entryMeta(entry, section, new Date())].filter(Boolean).join(' \u00b7 ');
  return (
    <ListRow
      as={href ? 'a' : 'div'}
      href={href || undefined}
      chevron={!!href}
      aria-current={on ? 'true' : undefined}
      onClick={href && ref && onOpen ? (event: ReactMouseEvent<HTMLElement>) => onOpen(event as ReactMouseEvent<HTMLAnchorElement>, ref) : undefined}
      className={on ? 'bg-[color:var(--lit-tint)]' : undefined}
      leading={track ? <TrackBadge track={track} /> : null}
      title={(
        <span className="flex min-w-0 items-center gap-1.5">
          <RequestTag number={entry.issueNumber} />
          <span className="truncate">{title}</span>
        </span>
      )}
      subtitle={entry.excerpt || facts || track ? (
        <span className="flex flex-col gap-1.5">
          {entry.excerpt ? (
            <span className="line-clamp-2 text-zinc-700 dark:text-zinc-300" data-ws-bot-slot-excerpt="">{entry.excerpt}</span>
          ) : null}
          {facts ? <span className="line-clamp-2" data-ws-bot-slot-facts="">{facts}</span> : null}
          {track && section !== 'taken' ? <TrackBar track={track} className="max-w-[220px]" /> : null}
        </span>
      ) : null}
      subtitleClassName="whitespace-normal"
      data-ws-bot-slot={entry.issueNumber || ''}
      data-ws-bot-slot-state={track?.state || ''}
      data-ws-open={ref ? `${ref.kind}:${ref.id}` : undefined}
    />
  );
}

/** The five slots, as five cells: taken ones in the lit ink. */
function SlotCells({ used, cap }: { used: number; cap: number }): ReactNode {
  return (
    <span className="grid gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, cap)}, minmax(0, 1fr))` }} aria-hidden="true">
      {Array.from({ length: Math.max(1, cap) }, (_, i) => (
        <i key={i} className={`block h-2.5 rounded-[3px] ${i < used ? 'bg-[color:var(--lit-ink)]' : 'bg-zinc-200 dark:bg-zinc-700'}`} />
      ))}
    </span>
  );
}

/** The page's body, from one read. Pure, so a test can draw every state. */
export function BotSlotsBody({ view, openKey = null, onOpen }: { view: BotSlotsView; openKey?: string | null; onOpen?: OpenItem }): ReactNode {
  const t = useMessages('project');
  const used = view.slots.length;
  const note = !view.botOn ? t('project:botSlots.off') : view.paused ? t('project:botSlots.paused') : !view.acts ? t('project:botSlots.notHere') : null;
  const week = view.week;
  const resets = week?.resetsAt ? new Date(week.resetsAt) : null;
  const resetsText = resets && !Number.isNaN(resets.getTime())
    ? resets.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : null;
  const rowProps = (section: Section) => ({ section, slug: view.app.slug, openKey, onOpen });
  return (
    <div className="flex flex-col gap-2 pb-6" data-ws-bot-slots-body="">
      {note ? <p className="px-5 text-[13px] text-zinc-500 dark:text-zinc-400" data-ws-bot-slots-note="">{note}</p> : null}
      <SectionHeader className="px-5 pb-0 pt-2">{t('project:botSlots.slots.title')}</SectionHeader>
      <GroupedList tone="plane" data-ws-bot-slots="">
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="font-semibold text-zinc-900 dark:text-zinc-100" data-ws-bot-slots-used={`${used}/${view.cap}`}>
              {t('project:botSlots.slots.used', { used, cap: view.cap })}
            </span>
          </div>
          <SlotCells used={used} cap={view.cap} />
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{used ? t('project:botSlots.slots.frees') : t('project:botSlots.slots.empty')}</p>
        </div>
        {view.slots.map((entry) => <EntryRow key={`${entry.kind || 'slot'}-${entry.issueNumber}`} entry={entry} {...rowProps('slots')} />)}
      </GroupedList>
      {view.waiting.length ? (
        <>
          <SectionHeader className="px-5 pb-0 pt-3">{t('project:botSlots.waiting.title')}</SectionHeader>
          <GroupedList tone="plane" data-ws-bot-waiting="">
            {view.waiting.map((entry) => <EntryRow key={`waiting-${entry.issueNumber}`} entry={entry} {...rowProps('waiting')} />)}
          </GroupedList>
        </>
      ) : null}
      {view.taken.length ? (
        <>
          <SectionHeader className="px-5 pb-0 pt-3">{t('project:botSlots.taken.title')}</SectionHeader>
          <GroupedList tone="plane" data-ws-bot-taken="">
            {view.taken.map((entry) => <EntryRow key={`taken-${entry.issueNumber}`} entry={entry} {...rowProps('taken')} />)}
          </GroupedList>
        </>
      ) : null}
      {view.onHold.length ? (
        <>
          <SectionHeader className="px-5 pb-0 pt-3">{t('project:botSlots.onHold.title')}</SectionHeader>
          <GroupedList tone="plane" data-ws-bot-on-hold="">
            {view.onHold.map((entry) => <EntryRow key={`hold-${entry.issueNumber}`} entry={entry} {...rowProps('onHold')} />)}
          </GroupedList>
        </>
      ) : null}
      <SectionHeader className="px-5 pb-0 pt-3">{t('project:botSlots.limits.title')}</SectionHeader>
      <GroupedList tone="plane" data-ws-bot-limits="">
        {week ? (
          <div className="flex flex-col gap-2 px-4 py-3.5" data-ws-bot-week="">
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">{t('project:botSlots.limits.week')}</span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {week.limited && week.usedShare !== null
                  ? t('project:botSlots.limits.weekUsed', { percent: Math.round(week.usedShare * 100) })
                  : t('project:botSlots.limits.weekUnlimited')}
              </span>
            </div>
            {week.limited && week.usedShare !== null ? (
              <span className="block h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" aria-hidden="true">
                <i className="block h-full bg-[color:var(--lit-ink)]" style={{ width: `${Math.round(week.usedShare * 100)}%` }} />
              </span>
            ) : null}
            {resetsText ? <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{t('project:botSlots.limits.weekResets', { date: resetsText })}</p> : null}
          </div>
        ) : null}
        <ListRow
          chevron={false}
          title={view.buildsAtOnce ? t('project:botSlots.limits.buildsAtOnce', { count: view.buildsAtOnce }) : t('project:botSlots.slots.used', { used, cap: view.cap })}
          subtitle={t('project:botSlots.limits.reading', { count: view.reading })}
          titleClassName="font-medium text-[0.875rem]"
        />
      </GroupedList>
    </div>
  );
}

/**
 * The page: its way back to the Workshop, its title, and what was read. A
 * row opens through `onOpen`, the Workshop's own (workshop.tsx openItem),
 * and `openKey` marks the row whose item is open beside it.
 */
export function BotSlotsPage({ slug, backLabel, onBack, openKey = null, onOpen }: {
  slug: string;
  backLabel: string;
  onBack: () => void;
  openKey?: string | null;
  onOpen?: OpenItem;
}): ReactNode {
  const t = useMessages('project');
  const { view, failed, loaded } = useBotSlots(slug);
  return (
    <section className="dev-ws-pane" data-ws-pane="" data-ws-bot-slots-page="">
      <PageBack label={backLabel} title={t('project:page.title.bot')} onBack={onBack} />
      {!loaded ? (
        <div className="flex flex-col gap-3 px-5 py-4" aria-hidden="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : view ? (
        <BotSlotsBody view={view} openKey={openKey} onOpen={onOpen} />
      ) : failed ? (
        <p role="alert" className="px-5 py-4 text-[13px] text-red-700 dark:text-red-400">{t('project:botSlots.loadFailed')}</p>
      ) : null}
    </section>
  );
}
