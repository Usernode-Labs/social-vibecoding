/**
 * #6019, follow-up: a request's changes and its vote to close, on the
 * request's own page, under the request (./request-head.tsx). Plan v3 and
 * the 28 Oct decisions: the request leads; its changes follow under a rule,
 * each with the Votes and Testing cards its own page draws; changes that
 * compete are one short row each and ONE vote between them; an open vote to
 * close the request competes with them the same way (Close it in Neither's
 * place), or stands alone as its own Votes card.
 *
 *   ───────────────────────────────────────────────
 *   CHANGE #406 · DEWI                (a single change)
 *   Night mode by schedule             → its page
 *   [ Votes  1 of 2 yes   ▮▮▯ ] [Yes][No]
 *   [ Testing  All checks passed ] [Try it]
 *   ⌄ 2 earlier replies on this change
 *
 *   2 CHANGES FOR #403                  (competing)
 *   [A] Night mode toggle · bot · #405 · ✓ Checks passed · Try it
 *   [B] Night mode by schedule · dewi · #406 · Checks running
 *   [ Votes   A ▮▮▯ 1 · B ▮▯▯ 0 · Neither 0 ] [A][B][Neither]
 *
 * 31 Oct 2026: a change built from a plan says so under its name, with
 * the plan's Read (`plans`, ./request-head.tsx plansByChange), and the plan
 * is not listed again over the changes:
 *
 *   [A] Dark theme that follows the system setting · ana · #6067 · ✓ Checks passed
 *       📋 Built from the plan "Follow the system setting" · Read
 *
 * Each change is read the way its own page reads it (topic-head.tsx
 * readChangeDetail, then AppView._topicViewFor), so its cards are its page's
 * cards, with their buttons, and they move when its page would: on the
 * `change-detail-refresh` that names it. Nothing renders until the thread is
 * read (an effect in ./request-head.tsx), so the first paint is the page as
 * it was.
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { Avatar } from '@/components/ui/feed';
import { CheckIcon, ChevronDownIcon, XIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import { ActionButton } from '../card/dev-card';
import type { DevCardModel } from '../card/model';
import { ChangeGates } from './change-head';
import { changeDetailAsk, mergeChangePatch } from './change-detail-refresh';
import type { ChangeThreadView } from './model';
import { readChangeDetail } from './topic-head';
import { openRequestSpec, type RequestSpecCard } from './request-model';
import {
  ballotOf,
  ballotVotes,
  type Ballot,
  type FoldedReply,
  type ThreadItem,
  type ThreadPayload,
} from './thread-model';

function appView(): any {
  return typeof window !== 'undefined' ? (window as any).AppView : null;
}

function openChange(id: number): void {
  const av = appView();
  if (av && typeof av.openTopic === 'function' && id > 0) av.openTopic('proposal', id);
}

interface ChangeView {
  row: any;
  card: DevCardModel;
  v: ChangeThreadView;
}

/** Whether a change has cards to draw: it is up for a vote, or went in. */
const hasCards = (item: ThreadItem) => item.state === 'review' || item.state === 'merged';

/**
 * Each change's own page read, and the view its page builds from it, in the
 * order given. Null until it is read, and for a change still being built (it
 * has no cards before it is up for a vote). One hook for the list, so the
 * count of changes can move without moving the hooks.
 */
function useChangeViews(items: ThreadItem[]): Array<ChangeView | null> {
  const [rows, setRows] = useState<Record<number, any>>({});
  const [revision, setRevision] = useState(0);
  const key = items.filter(hasCards).map((i) => `${i.id}:${i.status}`).join(',');
  useEffect(() => {
    const read = items.filter(hasCards);
    if (!read.length) return undefined;
    const abort = new AbortController();
    for (const item of read) {
      readChangeDetail({ id: item.id, status: item.status }, false, abort.signal)
        .then((row) => { if (!abort.signal.aborted && row) setRows((was) => ({ ...was, [item.id]: row })); })
        .catch(() => {});
    }
    // Told the way its own page is (./change-detail-refresh.ts).
    const refresh = (event: Event) => {
      for (const item of read) {
        const ask = changeDetailAsk((event as CustomEvent).detail, item.id);
        if (!ask) continue;
        if ('row' in ask) setRows((was) => ({ ...was, [item.id]: ask.row }));
        else if ('patch' in ask) setRows((was) => ({ ...was, [item.id]: mergeChangePatch(was[item.id], item.id, ask.patch) }));
        else setRevision((n) => n + 1);
      }
    };
    window.addEventListener('change-detail-refresh', refresh);
    return () => { abort.abort(); window.removeEventListener('change-detail-refresh', refresh); };
  }, [key, revision]);
  return useMemo(() => items.map((item) => {
    const av = appView();
    const row = rows[item.id];
    if (!row || !av || typeof av._topicViewFor !== 'function' || !hasCards(item)) return null;
    // A vote still on its way stays on the button, as on its own page.
    if (typeof av._overlayPendingVote === 'function') av._overlayPendingVote(row);
    const built = av._topicViewFor('proposal', row);
    const v = built && built.body && built.body.thread;
    return v ? { row, card: built.card, v } : null;
  }), [items, rows]);
}

/**
 * Whether the gate counts the viewer's own change as their Yes without a
 * vote (governance-rules.ts: proposing counts as a yes on the counted
 * rules), read off its proposal row: Two yeses and Open floor count every
 * person's change; You or the group counts the creator's. Anything else
 * (Group vote, a project's own rules) is not assumed: the viewer taps. Nor
 * is a change a coding agent submitted for them (`external_agent`): its
 * author taps Yes on it like anyone else.
 */
export function authorCounts(item: ThreadItem, row: any): boolean {
  if (!item.mine || item.byBot || item.myVote || !row || row.external_agent || row.approval_mode !== 'rules') return false;
  if (row.approval_preset === 'two_yeses' || row.approval_preset === 'open_floor') return true;
  return row.approval_preset === 'you_or_the_group' && !!row.creator_yes;
}

/** What a change's own page counts toward its rule, and needs. */
function tally(row: any): { yes: number; need: number } {
  const yes = Number(row?.qualified_yes_count ?? row?.yes_count) || 0;
  const need = Math.max(1, Number(row?.votes_required) || 1);
  return { yes, need };
}

const KICKER = 'text-[12px] font-semibold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

/** A change's name where its cards begin: who built it, and its number. */
function ChangeLine({ item, letter = null }: { item: ThreadItem; letter?: string | null }): ReactNode {
  const t = useMessages('project');
  const by = item.by || t('project:topic.thread.page.someone');
  const kicker = letter
    ? t('project:topic.thread.page.changeLettered', { letter, by })
    : item.number
      ? t('project:topic.thread.page.changeNumbered', { number: item.number, by })
      : t('project:topic.thread.page.change', { by });
  return (
    <div className="min-w-0" data-thread-change-line={item.id}>
      <div className={KICKER}>{kicker}</div>
      <button
        type="button"
        className="mt-0.5 block min-w-0 text-left text-[15px] font-[650] leading-snug text-zinc-900 hover:underline dark:text-zinc-100"
        data-thread-change-open={item.id}
        onClick={() => openChange(item.id)}
      >
        {item.title || t('project:topic.thread.item.changeUnnumbered')}
      </button>
    </div>
  );
}

/** The plan a change was built from, under its name, with the plan's own Read. */
function PlanLine({ plan }: { plan: RequestSpecCard }): ReactNode {
  const t = useMessages('project');
  const [loading, setLoading] = useState(false);
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-change-plan={plan.key}>
      <span aria-hidden="true">📋</span>
      <span className="min-w-0 truncate">{t('project:topic.thread.page.fromPlan', { title: plan.title })}</span>
      <button
        type="button"
        className="shrink-0 font-semibold text-violet-700 hover:underline disabled:opacity-60 dark:text-violet-300"
        disabled={loading}
        aria-label={t('project:topic.request.spec.readNamed', { title: plan.title })}
        onClick={async () => {
          setLoading(true);
          try { await openRequestSpec(plan); } finally { setLoading(false); }
        }}
      >
        {loading ? t('project:topic.request.spec.opening') : t('project:topic.request.spec.read')}
      </button>
    </span>
  );
}

/** What was said on a change's own page, folded under it; new replies go on the request. */
function EarlierReplies({ item }: { item: ThreadItem }): ReactNode {
  const t = useMessages('project');
  const [open, setOpen] = useState(false);
  const replies: FoldedReply[] = item.folded || [];
  if (!item.replies || !replies.length) return null;
  return (
    <div className="mt-2" data-thread-earlier={item.id}>
      <button type="button" className="dev-ws-reveal dev-ws-reveal-start touch-target-32" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" style={open ? { transform: 'rotate(180deg)' } : undefined} />
        {open ? t('project:topic.thread.page.earlierHide') : t('project:topic.thread.page.earlier', { count: item.replies })}
      </button>
      {open ? (
        <div className="mt-1 flex flex-col gap-1 border-l-2 border-[color:var(--app-sheet-line)] pl-2">
          {replies.map((reply) => (
            <span key={reply.id} className="msgx-thread-line">
              <span className="msgx-thread-face">
                <Avatar shape="square" size="sm" color={swatchFor(reply.username)} aria-hidden="true">
                  {reply.username.charAt(0).toUpperCase()}
                </Avatar>
              </span>
              <strong className="msgx-thread-line-name">{reply.bot ? reply.username : `@${reply.username}`}</strong>
              <span className="msgx-thread-line-text">{reply.text}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** One change, on its own: its name, its two cards, and its earlier replies. */
function ChangeBlock({ item, plan = null }: { item: ThreadItem; plan?: RequestSpecCard | null }): ReactNode {
  const t = useMessages('project');
  const [view] = useChangeViews([item]);
  return (
    <div className="mt-3" data-thread-change={item.id} data-thread-change-state={item.state || ''}>
      <ChangeLine item={item} />
      {plan ? <PlanLine plan={plan} /> : null}
      {item.state === 'underway' ? (
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('project:topic.thread.page.underway')}</p>
      ) : view ? (
        <ChangeGates id={item.id} card={view.card} v={view.v} />
      ) : null}
      <EarlierReplies item={item} />
    </div>
  );
}

const letterOf = (i: number) => String.fromCharCode(65 + i);

/** One competing change's row, with its Testing in a word and its preview. */
function CompetingRow({ item, i, view, plan = null }: { item: ThreadItem; i: number; view: ChangeView | null; plan?: RequestSpecCard | null }): ReactNode {
  const t = useMessages('project');
  const preview = view ? (view.card.actions || []).find((a) => a.preview) : null;
  const testing = view ? view.v.testing : null;
  return (
    <div role="listitem" className={`flex items-start gap-3 px-3.5 py-3${i ? ' border-t border-[color:var(--app-sheet-line)]' : ''}`} data-change-row={letterOf(i)} data-thread-change={item.id}>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-200/80 text-[13px] font-bold text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200" aria-hidden="true">{letterOf(i)}</span>
      <span className="min-w-0 flex-1">
        <button type="button" className="block min-w-0 text-left text-[15px] font-[650] leading-snug text-zinc-900 hover:underline dark:text-zinc-100" onClick={() => openChange(item.id)}>
          {item.title || t('project:topic.thread.item.changeUnnumbered')}
        </button>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
          <span>{item.number ? t('project:topic.thread.page.rowBy', { by: item.by || t('project:topic.thread.page.someone'), number: item.number }) : (item.by || '')}</span>
          {testing ? (
            <span className={testing.done ? 'inline-flex items-center gap-0.5 font-semibold text-[color:var(--state-ok)]' : testing.tone === 'bad' ? 'font-semibold text-[color:var(--state-blocked)]' : ''} data-thread-change-testing={testing.tone}>
              {testing.done ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}{testing.figure}
            </span>
          ) : null}
        </span>
        {plan ? <PlanLine plan={plan} /> : null}
      </span>
      {preview ? <span className="shrink-0"><ActionButton a={preview} /></span> : null}
    </div>
  );
}

interface CloseRow {
  yes: number;
  need: number;
  myVote: 'yes' | 'no' | null;
}

/** A vote to close's own read (routes/issues.js GET governance/:id): its tally and the viewer's vote. */
function useCloseRow(slug: string | null, close: ThreadItem | null, revision: number): CloseRow | null {
  const [row, setRow] = useState<CloseRow | null>(null);
  useEffect(() => {
    if (!slug || !close) { setRow(null); return undefined; }
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/governance/${close.id}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const p = json && json.proposal;
        if (!live || !p) return;
        setRow({
          yes: Number(p.qualified_yes_count ?? p.up_count) || 0,
          need: Math.max(1, Number(p.votes_required) || 1),
          myVote: p.my_vote === 'up' ? 'yes' : p.my_vote === 'down' ? 'no' : null,
        });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [slug, close?.id, revision]);
  return row;
}

/** A Votes card's bar, one segment per yes the rule needs. */
function Bar({ yes, need, label }: { yes: number; need: number; label: string }): ReactNode {
  return (
    <div className="dev-change-bar" role="img" aria-label={label}>
      {Array.from({ length: need }, (_, i) => (
        <span key={i} className="dev-change-bar-seg" style={{ flexGrow: 1, flexBasis: 0 }}>
          <span className="dev-change-bar-fill" data-state="moving" style={{ width: i < yes ? '100%' : '0%' }} />
        </span>
      ))}
    </div>
  );
}

/**
 * Changes that compete, and an open vote to close that competes with them:
 * a short row each, then ONE Votes card with a bar per choice and a button
 * per choice. A pick is ordinary votes (./thread-model.ts ballotVotes): Yes
 * on the pick, the others' Yes taken back, and No on every change for
 * Neither or Close it. The first to pass its project's rule wins and closes
 * the rest (services/threads.js closeRivals, closeThreadChanges).
 */
export function Competing({ slug, data, anchor, options, close, onChanged, plans = null }: {
  slug: string | null;
  data: ThreadPayload;
  /** The requests the page is about (./thread-model.ts ballotOf). */
  anchor: readonly number[];
  options: ThreadItem[];
  close: ThreadItem | null;
  onChanged: () => void;
  /** The plan each change was built from, by its id. */
  plans?: ReadonlyMap<number, RequestSpecCard> | null;
}): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const views = useChangeViews(options);
  const closeRow = useCloseRow(slug, close, revision);
  const counts = new Set(options.filter((o, i) => authorCounts(o, views[i]?.row)).map((o) => o.id));
  const ballot: Ballot | null = ballotOf(data, counts, anchor);
  if (!ballot) return null;
  const project = appView()?.appData?.name || '';
  const choose = async (pick: number | 'neither' | 'close') => {
    const av = appView();
    if (busy || !av) return;
    setBusy(true);
    try {
      for (const v of ballotVotes(ballot, pick, counts)) {
        if (v.kind === 'close') await av.castIssueVote?.(v.issueId, 'up', { reason: null });
        else if (v.vote === null) await av.retractVote?.(v.sessionId, v.epoch);
        else await av.castVote?.(v.sessionId, v.vote, v.epoch, { reason: null });
      }
    } finally {
      setBusy(false);
      setRevision((n) => n + 1);
      onChanged();
    }
  };
  const choices = [
    ...options.map((o, i) => ({ key: String(o.id), label: letterOf(i), pick: o.id as number | 'neither' | 'close', ...tally(views[i]?.row) })),
    close
      ? { key: 'close', label: t('project:topic.thread.ballot.close'), pick: 'close' as const, yes: closeRow?.yes ?? 0, need: closeRow?.need ?? 1 }
      : { key: 'neither', label: t('project:topic.thread.ballot.neither'), pick: 'neither' as const, yes: 0, need: 1 },
  ];
  const heading = close
    ? (options.length === 1 ? t('project:topic.thread.ballot.headingClose') : t('project:topic.thread.ballot.headingCloseMany', { n: options.length }))
    : t('project:topic.thread.ballot.heading', { n: options.length, number: anchor[0] ?? data.thread.number ?? '' });
  return (
    <div className="mt-3" data-thread-ballot={options.length} data-thread-ballot-close={close ? close.id : undefined} aria-busy={busy}>
      <div className={KICKER}>{heading}</div>
      <div className="mt-2 overflow-hidden rounded-2xl bg-[color:var(--messages-surface)]" role="list" aria-label={t('project:topic.thread.ballot.label')}>
        {options.map((o, i) => <CompetingRow key={o.id} item={o} i={i} view={views[i]} plan={plans?.get(o.id) || null} />)}
        {close ? (
          <div role="listitem" className="flex items-start gap-3 border-t border-[color:var(--app-sheet-line)] px-3.5 py-3" data-change-row="close">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-zinc-200/80 text-zinc-700 dark:bg-zinc-700/80 dark:text-zinc-200" aria-hidden="true"><XIcon className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-[650] leading-snug text-zinc-900 dark:text-zinc-100">{t('project:topic.thread.ballot.close')}</span>
              <span className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">
                {close.reason
                  ? t('project:topic.thread.close.byWhy', { by: close.by || t('project:topic.thread.page.someone'), reason: close.reason })
                  : t('project:topic.thread.close.by', { by: close.by || t('project:topic.thread.page.someone') })}
              </span>
            </span>
          </div>
        ) : null}
      </div>
      <div className="dev-change-pair mt-2">
        <div className="dev-change-gate" data-change-gate="ballot" data-done="false" data-tone={ballot.pick === null ? 'ask' : 'muted'} role="group" aria-label={t('project:topic.thread.ballot.label')}>
          <div className="dev-change-gate-main">
            <div className="dev-change-gate-head">
              <span className="dev-change-gate-name">{t('project:topic.thread.ballot.votes')}</span>
              <span className="dev-change-gate-figure">{ballot.pick === null ? t('project:topic.thread.ballot.yourPick') : t('project:topic.thread.ballot.picked')}</span>
            </div>
            <div className="mt-2.5 flex flex-col gap-2">
              {choices.map((c) => (
                <div key={c.key} className="grid grid-cols-[66px_minmax(0,1fr)_18px] items-center gap-2.5 text-[13px]" data-ballot-tally={c.key}>
                  <span className="truncate font-semibold text-zinc-700 dark:text-zinc-200">{c.label}</span>
                  <Bar yes={c.yes} need={c.need} label={t('project:topic.thread.ballot.tally', { choice: c.label, yes: c.yes, need: c.need })} />
                  <span className="text-right tabular-nums text-zinc-500 dark:text-zinc-400">{c.yes}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="dev-change-gate-act" role="radiogroup" aria-label={t('project:topic.thread.ballot.label')}>
            {choices.map((c) => {
              const on = ballot.pick === c.pick;
              return (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className="dev-vote-btn"
                  data-ballot-option={c.key}
                  disabled={busy}
                  style={on ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)' }}
                  onClick={() => { if (!on) void choose(c.pick); }}
                >
                  {on ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : null}{c.label}
                </button>
              );
            })}
          </div>
          <p className="dev-change-gate-note">{close
            ? t('project:topic.thread.ballot.aboutClose', { project })
            : t('project:topic.thread.ballot.about', { project })}</p>
        </div>
      </div>
    </div>
  );
}

/** A vote to close the request with no change competing: who proposed it and why, then its Votes card. */
function CloseVote({ slug, close, onChanged }: { slug: string | null; close: ThreadItem; onChanged: () => void }): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const row = useCloseRow(slug, close, revision);
  const vote = async (side: 'up' | 'down') => {
    const av = appView();
    if (busy || !av || typeof av.castIssueVote !== 'function') return;
    setBusy(true);
    try { await av.castIssueVote(close.id, side); } finally {
      setBusy(false);
      setRevision((n) => n + 1);
      onChanged();
    }
  };
  const mine = row ? row.myVote : close.myVote || null;
  const yes = row ? row.yes : 0;
  const need = row ? row.need : 1;
  return (
    <div className="mt-3" data-close-proposal={close.id}>
      <div className={KICKER}>{t('project:topic.thread.close.kicker', { by: close.by || t('project:topic.thread.page.someone') })}</div>
      <button type="button" className="mt-0.5 block min-w-0 text-left text-[15px] font-[650] leading-snug text-zinc-900 hover:underline dark:text-zinc-100" onClick={() => appView()?.openTopic?.('gov', close.id)}>
        {close.reason || close.title || t('project:topic.thread.item.close')}
      </button>
      <div className="dev-change-pair mt-2">
        <div className="dev-change-gate" data-change-gate="close" data-done="false" data-tone={mine ? 'muted' : 'ask'} role="group" aria-label={t('project:topic.thread.close.votes')}>
          <div className="dev-change-gate-main">
            <div className="dev-change-gate-head">
              <span className="dev-change-gate-name">{t('project:topic.thread.ballot.votes')}</span>
              <span className="dev-change-gate-figure">{t('project:topic.thread.close.figure', { yes, need })}</span>
            </div>
            <Bar yes={yes} need={need} label={t('project:topic.thread.close.figure', { yes, need })} />
          </div>
          <div className="dev-change-gate-act">
            {(['up', 'down'] as const).map((side) => {
              const on = mine === (side === 'up' ? 'yes' : 'no');
              return (
                <button
                  key={side}
                  type="button"
                  className="dev-vote-btn"
                  aria-pressed={on}
                  disabled={busy}
                  data-close-vote={side}
                  style={on || (!mine && side === 'up') ? { minWidth: 0 } : { minWidth: 0, background: 'var(--state-neutral-bg)', color: 'var(--text-primary)' }}
                  onClick={() => { void vote(side); }}
                >
                  {side === 'up' ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <XIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                  {side === 'up' ? t('project:topic.thread.close.yes') : t('project:topic.thread.close.no')}
                </button>
              );
            })}
          </div>
          <p className="dev-change-gate-note">{mine
            ? t(mine === 'yes' ? 'project:topic.thread.close.saidYes' : 'project:topic.thread.close.saidNo')
            : t('project:topic.thread.close.note')}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The request's changes and its vote to close, under a rule. The changes
 * that would close THIS request and are up for a vote compete (with the vote
 * to close it, when that is open): one ballot. Every other change (one still
 * being built, one gone live, one that closes another request of the thread
 * or nothing at all) is drawn on its own, with its own cards. Nothing when
 * the thread holds neither.
 */
export function ThreadChanges({ slug, data, number, changes, close, onChanged, plans = null }: {
  slug: string | null;
  data: ThreadPayload;
  /** The request the page is: what its ballot is about. */
  number: number;
  changes: ThreadItem[];
  close: ThreadItem | null;
  onChanged: () => void;
  /** The plan each change was built from, by its id (./request-head.tsx plansByChange). */
  plans?: ReadonlyMap<number, RequestSpecCard> | null;
}): ReactNode {
  if (!changes.length && !close) return null;
  const anchor = [number];
  // Who counts as whose pick is settled inside the ballot, from each change's
  // own read; which changes compete is not, so ask without it.
  const ballot = ballotOf(data, new Set(), anchor);
  const competing = ballot ? new Set(ballot.options.map((o) => o.id)) : new Set<number>();
  const rest = changes.filter((c) => !competing.has(c.id));
  const closeAlone = close && !(ballot && ballot.close && ballot.close.id === close.id) ? close : null;
  return (
    <section className="mt-4 border-t border-[color:var(--app-sheet-line)]" data-thread-changes={changes.length}>
      {ballot ? (
        <Competing key={ballot.options.map((o) => o.id).join(',')} slug={slug} data={data} anchor={anchor}
          options={ballot.options} close={ballot.close} onChanged={onChanged} plans={plans} />
      ) : null}
      {rest.map((item) => <Fragment key={item.id}><ChangeBlock item={item} plan={plans?.get(item.id) || null} /></Fragment>)}
      {closeAlone ? <CloseVote slug={slug} close={closeAlone} onChanged={onChanged} /> : null}
    </section>
  );
}
