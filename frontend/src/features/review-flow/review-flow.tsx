/**
 * EXPERIMENTAL (Settings › Experimental, "New Needs you"; ./settings.ts):
 * the Communities tab's Needs you as a calm list of changes, each opening
 * into its own page where you look, decide, and move on.
 *
 * ── The feed ────────────────────────────────────────────────────────────
 * One card per decision waiting on you, across your communities, in the
 * feed's own order (GET /api/workshop/needs-feed). A card is its title shot
 * (the change's after picture, cropped to where it differs, on a ground that
 * says how much it changes; ./model.ts) and its title. Nothing else: no
 * counts, no buttons. A change with nothing visible shows its summary on a
 * quiet card; a group decision opens its own page, as it always has. At the
 * end, a quiet "That's everything for now" and the way back.
 *
 * ── The change page ─────────────────────────────────────────────────────
 * Tapping a card EXPANDS it: one sheet grows out of the card, its coloured
 * ground shrinks into the header, and the title travels up into the header.
 * The feed recedes behind it. The page is fixed above the tab bar, which
 * stays. Its hero is the before/after slider (./compare.tsx), with
 * thumbnails when the change has several screens; under it, what the change
 * does; at the foot the vote sheet (./vote-sheet.tsx).
 *
 * Next change PUSHES the next one in from the side: the page you leave
 * slides a little left and dims, the next one slides in, the title changes,
 * and the slider's handle and pill arrive a moment after it lands. The feed
 * behind scrolls quietly to that card, so Back lands on it.
 *
 * ── Island rules ────────────────────────────────────────────────────────
 * Rendered only while the Needs you pane shows, from data the controller
 * loads in an effect; the page is a portal on <body>.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, ChevronLeftIcon, EllipsisHorizontalIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { callAppView } from '../dev-board/card/fold';
import type { NeedsFeedItem } from '../workshop/needs-reel';
import { CompareSlider } from './compare';
import { Illustration } from './illustrations';
import {
  composeTitle, nextIndex, orderForReview, piecesOf, titleCrop, toReviewItems,
  type AreaKind, type BenefitKind, type DecisionKind, type ReviewItem, type ReviewScreen,
} from './model';
import { VoteSheet, sheetOpen, type SheetState, type Vote } from './vote-sheet';

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const OPEN_MS = 380;
const PUSH_MS = 440;
const MARKS_AFTER = 160;

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function shape(visuals: unknown, shots: unknown) {
  const out = callAppView('_workshopVisuals', visuals, shots);
  return out && typeof out === 'object' ? (out as never) : null;
}

/* ── The title shot ────────────────────────────────────────────────────── */

// Each label is a whole message id, so the language tools can find it.
const BENEFIT_LABEL: Record<BenefitKind, string> = {
  fixed: 'communities:review.benefit.fixed',
  stability: 'communities:review.benefit.stability',
  clarity: 'communities:review.benefit.clarity',
  more: 'communities:review.benefit.more',
  results: 'communities:review.benefit.results',
  speed: 'communities:review.benefit.speed',
  effort: 'communities:review.benefit.effort',
  security: 'communities:review.benefit.security',
  behind: 'communities:review.benefit.behind',
};
const AREA_LABEL: Record<Exclude<AreaKind, 'app'>, string> = {
  agents: 'communities:review.area.agents',
  proposals: 'communities:review.area.proposals',
  platform: 'communities:review.area.platform',
  projects: 'communities:review.area.projects',
  accounts: 'communities:review.area.accounts',
  admin: 'communities:review.area.admin',
  messages: 'communities:review.area.messages',
  challenges: 'communities:review.area.challenges',
};
const DECISION_LABEL: Record<DecisionKind, string> = {
  close_issue: 'communities:review.decision.closeIssue',
  rename: 'communities:review.decision.rename',
  secret_change: 'communities:review.decision.secret',
  decision: 'communities:review.decision.other',
};

/**
 * A drawn picture: a benefit object for a change with nothing (yet) to show,
 * a decision object for a group decision. Every card has a picture.
 */
function Drawn({ item, width, height, play }: { item: ReviewItem; width: number; height: number; play?: boolean }): ReactNode {
  const t = useMessages('communities');
  const p = item.picture;
  if (p.kind !== 'benefit' && p.kind !== 'decision') return null;
  const area = p.kind === 'benefit' && p.area !== 'app' ? t(AREA_LABEL[p.area]) : item.app?.name || null;
  return (
    <Illustration
      kind={p.kind === 'benefit' ? { benefit: p.benefit } : { decision: p.decision }}
      label={{ main: p.kind === 'benefit' ? t(BENEFIT_LABEL[p.benefit]) : t(DECISION_LABEL[p.decision]), area }}
      token={p.kind === 'benefit' ? p.token : null}
      ground={item.ground}
      width={width}
      height={height}
      play={play}
    />
  );
}

/* ── The title shot ────────────────────────────────────────────────────── */


function TitleShot({ item, width }: { item: ReviewItem; width: number }): ReactNode {
  const height = Math.round(width * 0.75);
  if (item.picture.kind === 'benefit' || item.picture.kind === 'decision') {
    return (
      <span className="rf-cover rf-cover-drawn" style={{ width, height, background: item.ground }} data-rf-cover="">
        <Drawn item={item} width={width} height={height} />
      </span>
    );
  }
  // The changed areas the run found, composed by the prototype's rules
  // (model.ts composeTitle); without them, the run's own crop of the change
  // (or an older capture) as the one piece.
  let pieces = piecesOf(item.screens);
  if (!pieces.length) {
    const img = item.titleImage;
    if (img) {
      pieces = [{ screen: { viewport: 'crop', width: img.width, before: { url: img.url, height: img.height }, after: { url: img.url, height: img.height }, regions: [] }, box: { x: 0, y: 0, w: img.width, h: img.height } }];
    }
  }
  const comp = composeTitle(pieces, { w: width, h: height }, item.ground);
  return (
    <span className="rf-cover" style={{ width, height, background: item.ground }} data-rf-cover="" data-rf-rule={comp ? comp.rule : 'pair'}>
      {comp ? comp.plates.slice().sort((p, q) => p.z - q.z).map((p, i) => (
        <span
          key={i}
          className="rf-tplate"
          style={{ left: p.x, top: p.y, width: p.w, height: p.h, borderRadius: p.r, background: p.fill || undefined }}
        >
          {p.img ? (
            <img
              src={p.img.url}
              alt=""
              draggable={false}
              loading="lazy"
              style={{ left: p.img.left, top: p.img.top, width: p.img.width, height: p.img.height }}
            />
          ) : null}
        </span>
      )) : item.pair && (item.pair.after || item.pair.before) ? (
        <span className="rf-tplate rf-tplate-pair" style={{ left: width * 0.07, top: height * 0.14, width: width * 0.86, height: height * 0.68, borderRadius: 16 }}>
          <img src={(item.pair.after || item.pair.before)!} alt="" draggable={false} loading="lazy" className="rf-plate-fill" />
        </span>
      ) : null}
    </span>
  );
}

/* ── One change's page body (hero, thumbnails, words) ─────────────────── */

function PageBody({ item, width, marks, near }: { item: ReviewItem; width: number; marks: boolean; near: boolean }): ReactNode {
  const [shot, setShot] = useState(0);
  useEffect(() => setShot(0), [item.key]);
  const height = Math.round(width * 0.75);
  const screen = item.screens[shot] || null;
  const visual = !!screen || !!(item.pair && (item.pair.after || item.pair.before));
  const t = useMessages('communities');
  return (
    <div className="rf-page-body" data-rf-body={item.key}>
      {visual ? (
        <CompareSlider screen={screen} pair={screen ? null : item.pair} ground={item.ground} width={width} height={height} marks={marks} near={near} />
      ) : (
        <div className="rf-hero-drawn" style={{ width, height, background: item.ground }}>
          <Drawn item={item} width={width} height={height} play={near} />
        </div>
      )}
      {item.screens.length > 1 ? (
        <div className="rf-thumbs" role="group" aria-label={t('communities:review.thumbs.label')}>
          {item.screens.map((s, i) => {
            const crop = titleCrop(s, { w: 52, h: 52 });
            return (
              <button
                key={`${s.viewport}-${i}`}
                type="button"
                className="rf-thumb"
                aria-pressed={i === shot}
                aria-label={t('communities:review.thumbs.one', { n: i + 1, total: item.screens.length })}
                style={{ background: item.ground }}
                onClick={() => setShot(i)}
              >
                <span className="rf-thumb-in" style={{ width: crop.w, height: crop.h }}>
                  {near ? (
                    <img
                      src={s.after.url}
                      alt=""
                      draggable={false}
                      style={{ width: s.width, height: s.after.height, transform: `translate(${crop.place.tx}px, ${crop.place.ty}px) scale(${crop.place.scale})` }}
                    />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {item.line ? <p className="rf-claim">{item.line}</p> : null}
    </div>
  );
}

/* ── The flow ─────────────────────────────────────────────────────────── */

/** `opening` expands from the card, `pushing` slides in beside the last one, `open` rests. */
type Open = { index: number; from: number | null; phase: 'opening' | 'pushing' | 'open' };

export function ReviewFlow({ items, error, capped, onDone, doneLabel, onAnswered, onRetracted }: {
  items: NeedsFeedItem[] | null;
  error: boolean;
  capped: boolean;
  onDone: () => void;
  /** The end's way on; "Back to your communities" when not given. */
  doneLabel?: string;
  onAnswered?: (id: number, epoch: number | null) => void;
  onRetracted?: (id: number) => void;
}) {
  const t = useMessages('communities');
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pageWidth, setPageWidth] = useState(0);
  // The list stays as it was while a page is open: a vote takes its item out
  // of the controller's feed, and the list under an open page must not move.
  const [list, setList] = useState<ReviewItem[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [marks, setMarks] = useState(false);
  const [votes, setVotes] = useState<Record<string, Vote>>({});
  const [fresh, setFresh] = useState(false);
  const [sheet, setSheet] = useState<SheetState>('ask');
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  const ghosts = useRef<HTMLElement[]>([]);
  useEffect(() => () => { ghosts.current.forEach((g) => g.remove()); }, []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  // A transition ends on its animation's last frame, not on a timer that a
  // busy phone can fire a frame early; the timer only rescues a stalled one.
  const whenDone = (anim: Animation | undefined, fn: () => void, ms: number) => {
    let ran = false;
    const once = () => { if (!ran) { ran = true; fn(); } };
    anim?.finished.then(once, once);
    later(once, ms + 1500);
  };
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const shaped = useMemo(() => (items ? orderForReview(toReviewItems(items, shape)) : null), [items]);
  useEffect(() => { if (shaped && !open) setList(shaped); }, [shaped, open]);

  // The cards' width: the pane's, less its margins.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const measure = () => setWidth(Math.max(0, el.clientWidth - 32));
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // The list is drawn only once the feed has items: measure from then on.
  }, [list.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = open ? list[open.index] : null;
  const leaving = open && open.from != null ? list[open.from] : null;
  const next = open ? nextIndex(list, open.index) : -1;

  const cardOf = (index: number) => rootRef.current?.querySelector<HTMLElement>(`[data-rf-card="${index}"]`) || null;

  /* ── Expand: card → page ── */
  const openAt = (index: number) => {
    if (busy.current || open) return;
    const target = list[index];
    if (!target) return;
    if (target.kind === 'governance') {
      location.hash = `#app/${encodeURIComponent(target.app.slug)}/dev/governance/${target.id}`;
      return;
    }
    busy.current = true;
    setMarks(false);
    setFresh(false);
    setSheet(votes[target.key] ? 'voted' : 'ask');
    setOpen({ index, from: null, phase: 'opening' });
  };

  useLayoutEffect(() => {
    if (!open || open.phase !== 'opening' || !pageRef.current) return;
    const page = pageRef.current;
    const pr = page.getBoundingClientRect();
    setPageWidth(Math.min(520, pr.width));
    const card = cardOf(open.index);
    const cover = card?.querySelector<HTMLElement>('[data-rf-cover]');
    const done = () => {
      setOpen((cur) => (cur ? { ...cur, phase: 'open' } : cur));
      busy.current = false;
      later(() => setMarks(true), MARKS_AFTER);
    };
    if (!cover || reducedMotion()) { done(); return; }
    const cr = cover.getBoundingClientRect();
    const headH = headRef.current ? headRef.current.getBoundingClientRect().height : 56;
    // Both ends of the title's flight are measured at rest, before anything moves.
    const titleFrom = card?.querySelector<HTMLElement>('[data-rf-title]');
    const flight = titleFrom && titleRef.current ? planTitleFlight(titleFrom, titleRef.current) : null;
    const dx = cr.left - pr.left;
    const dy = cr.top - pr.top;
    const clipFrom = `inset(0px ${Math.max(0, pr.width - cr.width)}px ${Math.max(0, pr.height - cr.height)}px 0px round 20px)`;
    const opts = { duration: OPEN_MS, easing: EASE };
    const moving = page.animate(
      [{ transform: `translate(${dx}px, ${dy}px)`, clipPath: clipFrom }, { transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)' }],
      opts,
    );
    const ground = list[open.index].ground;
    bandRef.current?.animate(
      [{ height: `${cr.height}px`, background: ground, opacity: 1 }, { height: `${headH}px`, background: 'var(--rf-page)', opacity: 1 }],
      { ...opts, fill: 'none' },
    );
    headRef.current?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], opts);
    stageRef.current?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.15 }, { opacity: 1, offset: 0.55 }, { opacity: 1 }], opts);
    // The card's picture grows into the hero's place as the hero shows through it.
    const pic = coverGhost(cover, cr);
    pic.animate([
      { transform: 'none', borderRadius: '20px', opacity: 1 },
      { opacity: 1, offset: 0.2 },
      { opacity: 0, offset: 0.6 },
      { transform: heroTransform(cr, pr, headH), borderRadius: '0px', opacity: 0 },
    ], { ...opts, fill: 'forwards' }).finished.catch(() => {}).finally(() => pic.remove());
    rootRef.current?.animate(
      [{ transform: 'none', filter: 'none' }, { transform: 'scale(0.96)', filter: 'brightness(0.94)' }],
      { ...opts, fill: 'forwards' },
    );
    // The card's title travels into the header.
    flight?.(OPEN_MS);
    whenDone(moving, done, OPEN_MS);
  }, [open && open.index, open && open.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Collapse: page → card ── */
  const close = useCallback(() => {
    if (!open || busy.current) return;
    busy.current = true;
    setMarks(false);
    const page = pageRef.current;
    const card = cardOf(open.index);
    const cover = card?.querySelector<HTMLElement>('[data-rf-cover]');
    const finish = () => {
      rootRef.current?.getAnimations().forEach((a) => a.cancel());
      // Gone once the card under them is drawn again, not a frame before.
      const left = ghosts.current.splice(0);
      requestAnimationFrame(() => requestAnimationFrame(() => left.forEach((g) => g.remove())));
      setOpen(null);
      setSheet('ask');
      busy.current = false;
    };
    if (!page || !cover || reducedMotion()) { finish(); return; }
    cover.scrollIntoView({ block: 'nearest' });
    // Measure against the feed at rest, not as it is drawn receded.
    rootRef.current?.getAnimations().forEach((a) => a.cancel());
    const cr = cover.getBoundingClientRect();
    const titleTo = card?.querySelector<HTMLElement>('[data-rf-title]');
    const flight = titleRef.current && titleTo ? planTitleFlight(titleRef.current, titleTo) : null;
    rootRef.current?.animate(
      [{ transform: 'scale(0.96)', filter: 'brightness(0.94)' }, { transform: 'none', filter: 'none' }],
      { duration: OPEN_MS * 0.85, easing: EASE },
    );
    const pr = page.getBoundingClientRect();
    const headH = headRef.current ? headRef.current.getBoundingClientRect().height : 56;
    const opts = { duration: OPEN_MS * 0.85, easing: EASE, fill: 'forwards' as FillMode };
    const moving = page.animate(
      [{ transform: 'none', clipPath: 'inset(0px 0px 0px 0px round 0px)' }, {
        transform: `translate(${cr.left - pr.left}px, ${cr.top - pr.top}px)`,
        clipPath: `inset(0px ${Math.max(0, pr.width - cr.width)}px ${Math.max(0, pr.height - cr.height)}px 0px round 20px)`,
      }],
      opts,
    );
    bandRef.current?.animate(
      [{ height: `${headH}px`, background: 'var(--rf-page)' }, { height: `${cr.height}px`, background: list[open.index].ground }],
      opts,
    );
    headRef.current?.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], opts);
    stageRef.current?.animate([{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], opts);
    // The hero hands over to the card's own picture, which lands exactly on the card.
    const pic = coverGhost(cover, cr);
    pic.animate([
      { transform: heroTransform(cr, pr, headH), borderRadius: '0px', opacity: 0 },
      { opacity: 0, offset: 0.2 },
      { opacity: 1, offset: 0.6 },
      { transform: 'none', borderRadius: '20px', opacity: 1 },
    ], opts);
    ghosts.current.push(pic);
    flight?.(OPEN_MS * 0.85);
    whenDone(moving, finish, OPEN_MS * 0.85);
  }, [open, list]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Push: this change → the next ── */
  const goNext = () => {
    if (!open || busy.current) return;
    const n = nextIndex(list, open.index);
    if (n < 0) { close(); return; }
    busy.current = true;
    setMarks(false);
    setFresh(false);
    setSheet(votes[list[n].key] ? 'voted' : 'ask');
    // The feed behind follows, so Back lands on the right card.
    cardOf(n)?.scrollIntoView({ block: 'center' });
    setOpen({ index: n, from: open.index, phase: 'pushing' });
  };

  useLayoutEffect(() => {
    if (!open || open.phase !== 'pushing') return;
    const stage = stageRef.current;
    const w = pageRef.current ? pageRef.current.getBoundingClientRect().width : 390;
    const settle = () => {
      setOpen((cur) => (cur ? { index: cur.index, from: null, phase: 'open' } : cur));
      busy.current = false;
      later(() => setMarks(true), MARKS_AFTER + 20);
    };
    if (!stage || reducedMotion()) { settle(); return; }
    const arriving = stage.querySelector<HTMLElement>('[data-rf-arriving]');
    const gone = stage.querySelector<HTMLElement>('[data-rf-leaving]');
    const opts = { duration: PUSH_MS, easing: EASE };
    const sliding = arriving?.animate([{ transform: `translateX(${w}px)`, boxShadow: '-12px 0 32px rgba(0,0,0,.4)' }, { transform: 'none', boxShadow: '-12px 0 32px rgba(0,0,0,0)' }], opts);
    gone?.animate([{ transform: 'none', filter: 'none' }, { transform: `translateX(${-0.3 * w}px)`, filter: 'brightness(0.55)' }], { ...opts, fill: 'forwards' });
    titleRef.current?.animate([{ opacity: 0, transform: 'translateX(32px)' }, { opacity: 1, transform: 'none' }], { duration: PUSH_MS * 0.8, easing: EASE });
    whenDone(sliding, settle, PUSH_MS);
  }, [open && open.index, open && open.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Votes ── */
  const vote = async (v: Vote, reason?: string): Promise<boolean> => {
    if (!item) return false;
    const key = item.key;
    setVotes((cur) => ({ ...cur, [key]: v }));
    setFresh(true);
    setSheet('voted');
    const opts = v === 'no' ? { reason: reason || '' } : { reason: null };
    let ok = false;
    try {
      ok = (await callAppView('castVote', item.id, v, item.epoch, opts)) === true;
    } catch { ok = false; }
    if (!ok) {
      setVotes((cur) => { const copy = { ...cur }; delete copy[key]; return copy; });
      setSheet('ask');
      return false;
    }
    onAnswered?.(item.id, item.epoch);
    return true;
  };
  const undo = async (): Promise<boolean> => {
    if (!item) return false;
    const key = item.key;
    let ok = false;
    try {
      ok = (await callAppView('retractVote', item.id, item.epoch)) === true;
    } catch { ok = false; }
    if (!ok) return false;
    setVotes((cur) => { const copy = { ...cur }; delete copy[key]; return copy; });
    setFresh(false);
    setSheet('ask');
    onRetracted?.(item.id);
    return true;
  };

  // Going anywhere else (a link on the page, a tab, Back) takes the page
  // down at once: it is fixed over the shell, and the screen under it may
  // only hide, not unmount.
  useEffect(() => {
    if (!open) return undefined;
    const away = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      rootRef.current?.getAnimations().forEach((a) => a.cancel());
      document.querySelectorAll('.rf-fly').forEach((el) => el.remove());
      busy.current = false;
      setMarks(false);
      setOpen(null);
      setSheet('ask');
    };
    window.addEventListener('hashchange', away);
    window.addEventListener('popstate', away);
    return () => {
      window.removeEventListener('hashchange', away);
      window.removeEventListener('popstate', away);
    };
  }, [open !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape closes the help first, then the page.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sheetOpen(sheet)) setSheet(item && votes[item.key] ? 'voted' : 'ask');
      else close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, sheet, close, item, votes]);

  /* ── Drawing ── */
  if (error) {
    return <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-error="">{t('communities:reel.error')}</p>;
  }
  if (!items && !list.length) {
    return <div className="rf-feed rf-loading" data-review-flow="" aria-busy="true" aria-label={t('communities:reel.loading')} />;
  }
  if (!list.length) {
    return <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-empty="" data-review-flow="">{t('communities:reel.empty')}</p>;
  }

  const pw = pageWidth || Math.min(520, width + 32);
  const page = open && item ? createPortal(
    <div className="rf-page-wrap" data-rf-page="">
      <div ref={pageRef} className="rf-page" role="dialog" aria-modal="false" aria-label={item.title}>
        <div ref={bandRef} className="rf-band" aria-hidden="true" />
        <div ref={headRef} className="rf-head">
          <button type="button" className="rf-head-btn" aria-label={t('communities:review.page.back')} onClick={close} data-rf-back="">
<ChevronLeftIcon aria-hidden="true" width={22} height={22} strokeWidth="2.2" />
          </button>
          <h1 className="rf-head-title"><span ref={titleRef} key={item.key}>{item.title}</span></h1>
          <button type="button" className="rf-head-btn" aria-label={t('communities:review.page.more')} onClick={() => setSheet('more')} data-rf-more="">
<EllipsisHorizontalIcon aria-hidden="true" width={22} height={22} />
          </button>
        </div>
        <div ref={stageRef} className="rf-stage">
          {leaving ? (
            <div className="rf-stage-layer rf-stage-leaving" data-rf-leaving="" aria-hidden="true">
              <PageBody item={leaving} width={pw} marks={false} near />
            </div>
          ) : null}
          <div className={leaving ? 'rf-stage-layer rf-stage-arriving' : 'rf-stage-layer'} data-rf-arriving="">
            <PageBody item={item} width={pw} marks={marks} near />
          </div>
        </div>
        <div className={sheetOpen(sheet) ? 'rf-scrim rf-scrim-on' : 'rf-scrim'} onClick={() => setSheet(votes[item.key] ? 'voted' : 'ask')} aria-hidden="true" />
        <VoteSheet
          item={item}
          vote={votes[item.key] || null}
          state={sheet}
          setState={setSheet}
          onVote={vote}
          onUndo={undo}
          onNext={goNext}
          hasNext={next >= 0}
          maxHeight={Math.max(240, (typeof window !== 'undefined' ? window.innerHeight : 800) * 0.82)}
          fresh={fresh}
        />
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={rootRef} className="rf-feed" data-review-flow="">
        {list.map((it, i) => (
          <button
            key={it.key}
            type="button"
            className="rf-card"
            data-rf-card={i}
            data-rf-kind={it.kind}
            aria-label={it.title}
            onClick={() => openAt(i)}
            style={open && open.index === i ? { visibility: 'hidden' } : undefined}
          >
            {width > 0 ? <TitleShot item={it} width={width} /> : null}
            <span className="rf-card-title" data-rf-title="">{it.title || (it.kind === 'governance' ? t('communities:reel.fallbackTitle.decision') : t('communities:reel.fallbackTitle.change'))}</span>
          </button>
        ))}
        <div className="rf-end" data-rf-end="">
          <span className="rf-end-mark" aria-hidden="true">
<CheckIcon width={24} height={24} strokeWidth="2.2" />
          </span>
          <p className="rf-end-line">{t('communities:review.end.line')}</p>
          <button type="button" className="rf-end-btn" onClick={onDone}>{doneLabel || t('communities:reel.done')}</button>
        </div>
        {capped ? <p className="rf-capped" data-needs-capped="">{t('communities:reel.capped', { count: list.length })}</p> : null}
      </div>
      {page}
    </>
  );
}

/** A fixed copy of a card's picture, laid exactly over the card. */
function coverGhost(cover: HTMLElement, at: DOMRect): HTMLElement {
  const g = cover.cloneNode(true) as HTMLElement;
  g.removeAttribute('data-rf-cover');
  g.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  g.classList.add('rf-ghost-cover');
  g.setAttribute('aria-hidden', 'true');
  Object.assign(g.style, { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
  document.body.appendChild(g);
  return g;
}

/** Where the card's picture lands: the page's full width, under the header. */
function heroTransform(card: DOMRect, page: DOMRect, headH: number): string {
  const k = page.width / card.width;
  return `translate(${page.left - card.left}px, ${page.top + headH - card.top}px) scale(${k})`;
}

/**
 * Where an element's title text actually sits: its first line's box, as
 * wrapped (the card's two lines) or as centred and cut short (the header).
 */
function textBox(el: HTMLElement): { left: number; top: number; width: number; height: number } {
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const inner = box.width - padL - padR;
  const range = document.createRange();
  range.selectNodeContents(el);
  const first = range.getClientRects()[0];
  const width = Math.min(inner, range.getBoundingClientRect().width || inner);
  const centred = cs.textAlign === 'center' || getComputedStyle(el.parentElement || el).textAlign === 'center';
  const left = centred ? box.left + padL + (inner - width) / 2 : box.left + padL;
  return { left, top: first ? first.top : box.top, width: cs.whiteSpace === 'nowrap' ? width : inner, height: box.height };
}

/** A fixed copy of an element's title, drawn in its own type and wrapping. */
function titleGhost(el: HTMLElement, at: { left: number; top: number; width: number }): HTMLElement {
  const cs = getComputedStyle(el);
  const g = document.createElement('span');
  g.className = 'rf-fly';
  g.textContent = el.textContent || '';
  Object.assign(g.style, {
    left: `${at.left}px`, top: `${at.top}px`, width: `${Math.ceil(at.width) + 1}px`,
    font: cs.font, letterSpacing: cs.letterSpacing, color: cs.color,
    whiteSpace: cs.whiteSpace === 'nowrap' ? 'nowrap' : 'normal',
    textOverflow: cs.whiteSpace === 'nowrap' ? 'ellipsis' : 'clip',
    WebkitLineClamp: cs.webkitLineClamp || 'none',
    display: cs.whiteSpace === 'nowrap' ? 'block' : '-webkit-box',
  });
  return g;
}

/**
 * The title travelling from the card to the header (and back). Both ends are
 * measured before anything moves; the returned function flies it. Two copies
 * take one path: the departing one in its own wrapping fades out as the
 * arriving one fades in, so the words never reflow or jump at either end.
 */
function planTitleFlight(from: HTMLElement, to: HTMLElement): ((ms: number) => void) | null {
  const a = textBox(from);
  const b = textBox(to);
  if (!a.width || !b.width) return null;
  const k = parseFloat(getComputedStyle(to).fontSize) / parseFloat(getComputedStyle(from).fontSize || '16');
  return (ms) => {
    const leaving = titleGhost(from, a);
    const arriving = titleGhost(to, b);
    document.body.append(leaving, arriving);
    from.style.visibility = 'hidden';
    to.style.visibility = 'hidden';
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    const opts = { duration: ms, easing: EASE, fill: 'forwards' as FillMode };
    leaving.animate([
      { transform: 'none', opacity: 1 },
      { opacity: 0, offset: 0.3 },
      { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0 },
    ], opts);
    arriving.animate([
      { transform: `translate(${-dx}px, ${-dy}px) scale(${1 / k})`, opacity: 0 },
      { opacity: 0, offset: 0.12 },
      { opacity: 1, offset: 0.4 },
      { transform: 'none', opacity: 1 },
    ], opts).finished.catch(() => {}).finally(() => {
      leaving.remove();
      arriving.remove();
      from.style.visibility = '';
      to.style.visibility = '';
    });
  };
}

/**
 * A project's own Needs you, drawn by the same flow: the cross-project feed
 * (GET /api/workshop/needs-feed) narrowed to this project, so the two never
 * draw a change differently. Read in an effect, as every island does.
 */
export function ProjectReviewFlow({ slug, onDone }: { slug: string; onDone: () => void }) {
  const t = useMessages('communities');
  const [items, setItems] = useState<NeedsFeedItem[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    let demo = '';
    try { demo = new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : ''; } catch { /* no query */ }
    fetch(`/api/workshop/needs-feed${demo}`, { cache: 'no-cache', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!live) return;
        const all: NeedsFeedItem[] = Array.isArray(data?.items) ? data.items : [];
        setItems(all.filter((it) => it.app && it.app.slug === slug));
      })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [slug]);
  return (
    <div className="rf-project" data-rf-project={slug}>
      <ReviewFlow
        items={items}
        error={error}
        capped={false}
        onDone={onDone}
        doneLabel={t('communities:review.end.backToProject')}
      />
    </div>
  );
}
