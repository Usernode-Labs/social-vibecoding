/**
 * `#dev-workshop` — the Dev screen's lander, as the only React writer below
 * that host. The host ELEMENT stays app-view.js's (`_repaintDevBody`
 * creates it inside #dev-body); everything under it renders from
 * `devWorkshopStore`, which `AppView._workshopView()` publishes on every
 * board repaint.
 *
 * ── What it replaced ─────────────────────────────────────────────────
 *
 * The Activity feed: the board's cards newest-first, each with a comment
 * preview and a reply box. A stream is the right shape for "what just
 * happened" and the wrong one for "what is this project about", and the
 * second question is the one a newcomer and a returning member both ask
 * first. So the lander groups the SAME cards by theme — what the work is
 * about, drafted by a model and corrected by the group — and keeps the
 * feed's two answers as strips above the themes: proposals waiting on this
 * viewer's vote, and what changed since they were last here.
 *
 * ── The row is the card, folded ──────────────────────────────────────
 *
 * A theme lists its items as one-line rows. Tapping a row unfolds it into
 * the Activity entry it always was — the dense card, the GitHub comment
 * preview and the app's own thread with its reply box (./card/feed-thread.tsx)
 * — so a reply from here lands in the same thread the Board and the topic
 * page show. One row per theme is open at a time, because a theme with
 * every row unfolded is the stream this replaced.
 *
 * Two slots inside an unfolded row stay legacy-FILLED, rendered here once,
 * empty, with constant classNames — the same seam the feed had:
 *
 * - `.dev-feed-comments[data-comments-for]` — `AppView._wireFeedComments`
 *   fills each when its entry scrolls into view. Rows unfold AFTER the
 *   publish, so the component re-wires the host from an effect (a call by
 *   name, like the footer buttons make).
 * - `[data-kudos-host]` inside merged cards — `_fillKudosHosts` + Kudos.
 *
 * Opening a card full-screen is the delegated `#dev-body` handler's, exactly
 * as on the Board: the unfolded card carries its `data-issue-row` /
 * `data-proposal-row` hooks and the compact row deliberately does not.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';

import { useStoreState } from '../../../lib/use-store-state';
import { devWorkshopStore } from '../card/cards-store';
import { CardIcon, DevCard } from '../card/dev-card';
import { FeedThread } from '../card/feed-thread';
import type { DevCardModel, ListRow, WorkshopTheme } from '../card/model';
import { CardSkeleton } from '../card/skeleton';

type CardRow = Extract<ListRow, { t: 'card' }>;
type SortKey = 'people' | 'activity' | 'open';

/** The swatch a name gets everywhere (feed-thread's rule, kept in step). */
function swatchFor(name: string): string {
  const palette = ['#0a6ee0', '#8e44ad', '#1f8a4c', '#b4620a', '#c0392b', '#0e7c86', '#6d4c41'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function relTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function callAppView(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * Where "Open" leads: the card's own full-screen route, read off the hooks
 * the delegated handler reads, so the two can never disagree.
 */
function openHref(slug: string, card: DevCardModel): string | null {
  const a = card.attrs || {};
  if (!slug) return null;
  if (a['data-issue-row']) return `#app/${slug}/dev/issues/${a['data-issue-row']}`;
  if (a['data-proposal-row']) return `#app/${slug}/dev/proposals/${a['data-proposal-row']}`;
  if (a['data-gov-row']) return `#app/${slug}/dev/governance/${a['data-gov-row']}`;
  if (a['data-shared-session-row']) return `#app/${slug}/dev/shared/${a['data-shared-session-row']}`;
  if (a['data-session-chip']) return `#app/${slug}/dev/sessions/${a['data-session-chip']}`;
  return null;
}

/** The `#N` from the meta line, when the card has one. */
function numberOf(card: DevCardModel): string | null {
  for (const m of card.meta) {
    if (m.t === 'link' && /^#\d+$/.test(m.s)) return m.s;
  }
  return null;
}

/** The author from the meta line: the first plain text part. */
function authorOf(card: DevCardModel): string | null {
  for (const m of card.meta) if (m.t === 'text') return m.s;
  return null;
}

/**
 * One folded row. A `<button>` on purpose: it is a disclosure, and the
 * delegated card-open handler must not see a `data-issue-row` on it.
 */
function FoldedRow({
  row, open, onToggle,
}: { row: CardRow; open: boolean; onToggle: () => void }): ReactNode {
  const c = row.card;
  const n = numberOf(c);
  const by = authorOf(c);
  const pill = c.pill?.state.label || null;
  return (
    <button
      type="button"
      className={open ? 'dev-ws-row dev-ws-row-open' : 'dev-ws-row'}
      aria-expanded={open}
      data-ws-row={row.key}
      onClick={onToggle}
    >
      {c.icon ? <CardIcon spec={{ ...c.icon, small: true }} /> : null}
      <span className="dev-ws-row-main">
        <span className="dev-ws-row-title">
          {c.title.text}
          {row.fresh ? <span className="dev-ws-new">new</span> : null}
        </span>
        <span className="dev-ws-row-meta">
          {n ? <span className="font-mono">{n}</span> : null}
          {by ? <span>{by}</span> : null}
          {pill ? <span className="dev-ws-row-pill">{pill}</span> : null}
        </span>
      </span>
      {c.chatCount ? <span className="dev-ws-row-chat" title={`${c.chatCount} replies`}>{`💬 ${c.chatCount}`}</span> : null}
      <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
    </button>
  );
}

/**
 * The unfolded row: the Activity entry, byte-compatible with the feed's —
 * `.dev-feed-entry` wraps the dense card, the GitHub preview slot and the
 * app thread, so app.css's sheet treatment and the module's two fillers
 * find exactly the markup they expect.
 */
function UnfoldedRow({
  row, slug, canPost, onCollapse,
}: { row: CardRow; slug: string; canPost: boolean; onCollapse: () => void }): ReactNode {
  const href = openHref(slug, row.card);
  return (
    <div className="dev-feed-entry dev-ws-sheet" data-ws-sheet={row.key}>
      <DevCard model={row.card} />
      {row.commentsFor != null ? (
        <div className="dev-feed-comments" data-comments-for={String(row.commentsFor)}></div>
      ) : null}
      {row.thread && slug ? (
        <FeedThread slug={slug} type={row.thread.type} refId={row.thread.ref} canPost={canPost} />
      ) : null}
      <div className="dev-ws-sheet-actions">
        {href ? (
          <a href={href} className="dev-ws-link">Open card ›</a>
        ) : null}
        <span className="flex-1"></span>
        <button type="button" className="gc-vote-btn" onClick={onCollapse}>Collapse</button>
      </div>
    </div>
  );
}

function Lane({
  lane, slug, canPost, openKey, onToggle, themeId,
}: {
  lane: WorkshopTheme['lanes'][number];
  slug: string;
  canPost: boolean;
  openKey: string | null;
  onToggle: (key: string) => void;
  themeId: string;
}): ReactNode {
  if (!lane.rows.length && !lane.more) return null;
  return (
    <div className={`dev-ws-lane dev-ws-lane-${lane.key}`} data-ws-lane={lane.key}>
      <h4 className="dev-ws-lane-title"><span className="dev-ws-dot" aria-hidden="true"></span>{lane.title}</h4>
      {lane.rows.map((row) => {
        if (row.t !== 'card') return null;
        const open = openKey === row.key;
        return (
          <div key={row.key} className={open ? 'dev-ws-rowwrap dev-ws-rowwrap-open' : 'dev-ws-rowwrap'}>
            <FoldedRow row={row} open={open} onToggle={() => onToggle(row.key)} />
            {open ? (
              <UnfoldedRow row={row} slug={slug} canPost={canPost} onCollapse={() => onToggle(row.key)} />
            ) : null}
          </div>
        );
      })}
      {lane.more ? (
        <div className="dev-ws-more">
          {`+${lane.more} more · `}
          <button type="button" className="dev-ws-link" onClick={() => callAppView('openBoardForTheme', themeId)}>
            Open on Board ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Faces({ people }: { people: string[] }): ReactNode {
  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;
  const [open, setOpen] = useState(false);
  if (!people.length) return null;
  return (
    <span className="dev-ws-faces-wrap">
      <button
        type="button"
        className="dev-ws-faces"
        aria-label={`Who is involved: ${people.join(', ')}`}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        {shown.map((p) => (
          <span key={p} className="dev-ws-face" style={{ backgroundColor: swatchFor(p) }} title={p}>
            {p.slice(0, 1).toUpperCase()}
          </span>
        ))}
        {extra > 0 ? <span className="dev-ws-face dev-ws-face-more">{`+${extra}`}</span> : null}
      </button>
      {open ? (
        <span className="dev-ws-roster" role="tooltip">
          {people.map((p) => <span key={p} className="dev-ws-roster-row">{p}</span>)}
        </span>
      ) : null}
    </span>
  );
}

function ThemeCard({
  theme, slug, canPost, open, onToggle, openKey, onToggleRow,
}: {
  theme: WorkshopTheme;
  slug: string;
  canPost: boolean;
  open: boolean;
  onToggle: () => void;
  openKey: string | null;
  onToggleRow: (key: string) => void;
}): ReactNode {
  const c = theme.counts;
  const chips: ReactNode[] = [];
  if (c.fresh) chips.push(<span key="fresh" className="dev-ws-cnt dev-ws-cnt-fresh"><b>{`+${c.fresh}`}</b> new</span>);
  if (c.review) chips.push(<span key="review" className="dev-ws-cnt dev-ws-cnt-review"><span className="dev-ws-dot"></span><b>{c.review}</b> in review</span>);
  if (c.underway) chips.push(<span key="underway" className="dev-ws-cnt dev-ws-cnt-underway"><span className="dev-ws-dot"></span><b>{c.underway}</b> underway</span>);
  chips.push(<span key="open" className="dev-ws-cnt"><span className="dev-ws-dot"></span><b>{c.open}</b> open</span>);
  if (c.shipped) chips.push(<span key="shipped" className="dev-ws-cnt dev-ws-cnt-shipped"><span className="dev-ws-dot"></span><b>{c.shipped}</b> shipped this week</span>);

  const building = theme.lanes.find((l) => l.key === 'underway')?.rows.length || 0;
  const reviewing = theme.lanes.find((l) => l.key === 'review')?.rows.length || 0;
  const bits: string[] = [];
  if (building) bits.push(`${building} underway`);
  if (reviewing) bits.push(`${reviewing} in review`);
  const quietDays = theme.lastActive ? Math.floor((Date.now() - theme.lastActive) / 86400000) : null;
  const foot = bits.length
    ? `${theme.people.length} involved · ${bits.join(' · ')}`
    : (quietDays != null && quietDays > 14
      ? `${theme.people.length} involved · quiet for ${quietDays} days`
      : `${theme.people.length} involved · nobody building yet`);

  return (
    <article
      className={open ? 'dev-ws-theme dev-ws-theme-open' : 'dev-ws-theme'}
      data-ws-theme={theme.id}
      data-ws-ungrouped={theme.ungrouped ? '1' : undefined}
    >
      <div
        className="dev-ws-theme-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div className="dev-ws-theme-name">{theme.name}</div>
        <div className="dev-ws-theme-people"><b>{theme.people.length}</b>{theme.people.length === 1 ? 'person' : 'people'}</div>
        {theme.saying ? (
          <p className="dev-ws-theme-say">{theme.saying}</p>
        ) : (theme.description ? <p className="dev-ws-theme-say">{theme.description}</p> : null)}
        <div className="dev-ws-theme-counts">{chips}</div>
        <div className="dev-ws-theme-foot">
          <Faces people={theme.people} />
          <span className="flex-1 min-w-0 truncate">{foot}</span>
          <ChevronRightIcon className="dev-ws-chev" aria-hidden="true" />
        </div>
      </div>
      {open ? (
        <div className="dev-ws-theme-body">
          {theme.lanes.map((lane) => (
            <Lane
              key={lane.key}
              lane={lane}
              slug={slug}
              canPost={canPost}
              openKey={openKey}
              onToggle={onToggleRow}
              themeId={theme.id}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function sortThemes(themes: WorkshopTheme[], key: SortKey): WorkshopTheme[] {
  const list = themes.slice();
  const real = list.filter((t) => !t.ungrouped);
  const tail = list.filter((t) => t.ungrouped);
  if (key === 'people') real.sort((a, b) => (b.people.length - a.people.length) || (b.lastActive - a.lastActive));
  if (key === 'activity') real.sort((a, b) => (b.lastActive - a.lastActive) || (b.people.length - a.people.length));
  if (key === 'open') real.sort((a, b) => (b.counts.open - a.counts.open) || (b.lastActive - a.lastActive));
  return real.concat(tail);
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'people', label: 'By people' },
  { key: 'activity', label: 'By activity' },
  { key: 'open', label: 'By open items' },
];

export function DevWorkshop(): ReactNode {
  const v = useStoreState(devWorkshopStore);
  const hostRef = useRef<HTMLDivElement>(null);
  const [sortKey, setSortKey] = useState<SortKey>('people');
  // Which themes are unfolded, keyed by id. The FIRST theme opens by
  // default: a lander whose every theme is shut is a list of headings.
  // Seeded once the first real publish lands, then the viewer's.
  const [openThemes, setOpenThemes] = useState<Record<string, boolean> | null>(null);
  // At most one unfolded row per theme (and one for the since strip).
  const [openRows, setOpenRows] = useState<Record<string, string>>({});
  const [sinceOpen, setSinceOpen] = useState(false);

  const themes = useMemo(() => sortThemes(v.themes, sortKey), [v.themes, sortKey]);
  const firstId = themes.length ? themes[0].id : null;
  const isOpen = (id: string) => (openThemes ? !!openThemes[id] : id === firstId);
  const toggleTheme = (id: string) => {
    setOpenThemes((cur) => {
      const base = cur || (firstId ? { [firstId]: true } : {});
      return { ...base, [id]: !base[id] };
    });
  };
  const toggleRow = (scope: string, key: string) => {
    setOpenRows((cur) => (cur[scope] === key ? { ...cur, [scope]: '' } : { ...cur, [scope]: key }));
  };

  // A deep link that names a row (the ?shot= captures): open its theme and
  // unfold it once, on the publish that carries it.
  const autoKey = v.autoExpand ? `${v.autoExpand.theme}:${v.autoExpand.key}` : null;
  useEffect(() => {
    if (!v.autoExpand) return;
    const { theme, key } = v.autoExpand;
    setOpenThemes((cur) => ({ ...(cur || (firstId ? { [firstId]: true } : {})), [theme]: true }));
    setOpenRows((cur) => ({ ...cur, [theme]: key }));
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The two legacy fillers, re-run whenever the set of unfolded entries
  // changes — see the header. `_wireFeedComments` replaces its observer, so
  // calling it again is idempotent; `_fillKudosHosts` skips filled hosts.
  const openSig = Object.values(openRows).join('|') + (sinceOpen ? '|since' : '');
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_wireFeedComments', host);
    callAppView('_fillKudosHosts', host);
  }, [openSig, v]);

  if (v.loading) return <div ref={hostRef}><CardSkeleton n={4} label="Loading the workshop" /></div>;
  const slug = v.slug || '';
  const canPost = !!v.canPost;

  return (
    <div ref={hostRef} className="dev-ws">
      {v.emptyNote ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          {v.emptyNote.filtered ? (
            'Nothing here matches the current search and filters.'
          ) : (
            <>
              {v.emptyNote.loadFailed ? "Couldn't load open issues right now. " : ''}
              {'Nothing on the board yet. Press '}
              <span className="font-medium text-violet-700 dark:text-violet-400">+</span>
              {' to propose a change or file an issue.'}
            </>
          )}
        </div>
      ) : null}

      {v.votes.rows.length ? (
        <section className="dev-ws-strip" data-ws-votes="">
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">Needs your vote</span>
            <span className="dev-ws-pill dev-ws-pill-warn">{`${v.votes.count} ${v.votes.count === 1 ? 'proposal' : 'proposals'}`}</span>
          </div>
          <div className="dev-ws-strip-cards">
            {v.votes.rows.map((row) => (row.t === 'card' ? <DevCard key={row.key} model={row.card} /> : null))}
          </div>
          {v.votes.count > v.votes.rows.length ? (
            <button type="button" className="dev-ws-link self-start" onClick={() => callAppView('openBoardNeedingVote')}>
              {`${v.votes.count - v.votes.rows.length} more waiting on you ›`}
            </button>
          ) : null}
        </section>
      ) : null}

      {v.since ? (
        <section className="dev-ws-strip" data-ws-since="">
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">{`Since your last visit · ${relTime(v.since.baseline)}`}</span>
            {v.since.shipped ? <span className="dev-ws-pill dev-ws-pill-good">{`${v.since.shipped} shipped`}</span> : null}
          </div>
          <p className="dev-ws-strip-text">
            {v.since.rows.length
              ? [
                v.since.shipped ? `${v.since.shipped} ${v.since.shipped === 1 ? 'change' : 'changes'} landed` : null,
                v.since.opened ? `${v.since.opened} new ${v.since.opened === 1 ? 'issue' : 'issues'}` : null,
                v.since.proposed ? `${v.since.proposed} new ${v.since.proposed === 1 ? 'proposal' : 'proposals'}` : null,
              ].filter(Boolean).join(', ') || `${v.since.rows.length} things moved`
              : 'Nothing has changed since then.'}
            {v.since.rows.length ? (
              <button type="button" className="dev-ws-link ml-1" aria-expanded={sinceOpen} onClick={() => setSinceOpen(!sinceOpen)}>
                {sinceOpen ? 'Hide' : `Show ${v.since.rows.length}`}
              </button>
            ) : null}
          </p>
          {sinceOpen ? (
            <div className="dev-ws-lane" data-ws-lane="since">
              {v.since.rows.map((row) => {
                if (row.t !== 'card') return null;
                const open = openRows.since === row.key;
                return (
                  <div key={row.key} className={open ? 'dev-ws-rowwrap dev-ws-rowwrap-open' : 'dev-ws-rowwrap'}>
                    <FoldedRow row={row} open={open} onToggle={() => toggleRow('since', row.key)} />
                    {open ? (
                      <UnfoldedRow row={row} slug={slug} canPost={canPost} onCollapse={() => toggleRow('since', row.key)} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {v.welcome ? (
        <section className="dev-ws-strip" data-ws-welcome="">
          <div className="dev-ws-strip-head">
            <span className="dev-ws-eyebrow">What this project is working on</span>
          </div>
          <p className="dev-ws-strip-text">
            {`${v.welcome.open} open ${v.welcome.open === 1 ? 'item' : 'items'} in ${v.welcome.themes} ${v.welcome.themes === 1 ? 'theme' : 'themes'}`}
            {v.welcome.votesWaiting ? `, ${v.welcome.votesWaiting} ${v.welcome.votesWaiting === 1 ? 'proposal' : 'proposals'} waiting for votes` : ''}
            {v.welcome.shippedWeek ? `, ${v.welcome.shippedWeek} ${v.welcome.shippedWeek === 1 ? 'change' : 'changes'} shipped this week` : ''}
            {'. Open a theme to see what is being said and built, and reply on anything to join in.'}
          </p>
        </section>
      ) : null}

      {v.discussion && v.discussion.t === 'card' ? (
        <div className="dev-ws-discussion"><DevCard model={v.discussion.card} /></div>
      ) : null}

      {themes.length ? (
        <>
          <div className="dev-ws-sort">
            <span className="dev-ws-eyebrow">
              {`${themes.filter((t) => !t.ungrouped).length} themes`}
              {v.meta.source === 'category' ? ' · grouped by category until themes are drafted' : ''}
              {v.meta.pending ? ' · regrouping…' : ''}
            </span>
            <div className="dev-ws-sort-opts" role="group" aria-label="Order themes">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  className="dev-ws-chip"
                  aria-pressed={sortKey === s.key}
                  onClick={() => setSortKey(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="dev-ws-themes">
            {themes.map((t) => (
              <ThemeCard
                key={t.id}
                theme={t}
                slug={slug}
                canPost={canPost}
                open={isOpen(t.id)}
                onToggle={() => toggleTheme(t.id)}
                openKey={openRows[t.id] || null}
                onToggleRow={(key) => toggleRow(t.id, key)}
              />
            ))}
          </div>
          <div className="dev-ws-foot-note">
            {v.meta.source === 'ai'
              ? 'Themes are drafted from the board and refreshed as it changes.'
              : 'Themes are drafted once an AI model is available; until then items are grouped by their voted category.'}
          </div>
        </>
      ) : null}
    </div>
  );
}
