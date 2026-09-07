/**
 * The Dev board card — every band of it — rendered from a `DevCardModel`.
 *
 * ── Where the vocabulary lives ────────────────────────────────────────
 *
 * Everything here renders RESOLVED data (see ./model.ts): the icon arrives
 * as tint classes and an SVG path, a chip as its label and tint, an action
 * as its class string. The tables and derivations stay in app-view.js —
 * which Tailwind's extractor also scans, so the class literals compile from
 * where they already were. The few literals this file does own (the shell
 * geometry, the pencil, the grip, the eye) are the ones `_cardContentHtml`
 * and its siblings owned before the conversion, moved with the markup.
 *
 * ── The seams that stay legacy-owned ──────────────────────────────────
 *
 * - **The kudos slot.** `<span data-kudos-host>` is rendered ONCE, empty,
 *   with a constant className; `AppView._fillKudosHosts` writes
 *   `Kudos.renderButton`'s markup into it after every publish and
 *   `Kudos.attach`/`_refreshButton`/`_renderPopover` keep writing inside.
 *   React never looks in — the controller-host seam AGENTS.md documents.
 * - **The feed's inline-comments slot.** `.dev-feed-comments` ships empty
 *   and `AppView._fillFeedComments` innerHTMLs it when the row scrolls
 *   into view.
 * - **The ⋯ trigger's `aria-expanded`.** `_openCardMenu` sets and removes
 *   it at open/close. React renders the attribute never, so a reconcile
 *   cannot stomp it.
 * - **The title editor's error line and disabled state.** `saveIssueTitle`
 *   writes `#dev-issue-title-error` and disables the input by id, exactly
 *   as it did against the innerHTML editor.
 *
 * ── The countdown pill ticks from a store ─────────────────────────────
 *
 * `statusPillHtml` baked "Goes live in ~2h" into the string and a 30s module
 * interval rewrote the label in place. The model still carries the baked
 * label (so the first paint needs no store), plus the window's epoch; the
 * module interval now publishes `Date.now()` through `cardNowStore` and
 * every pill with a `countdown` re-derives its label here. `fmtCountdown`
 * is transcribed from `AppView._fmtCountdown` — this bundle cannot import
 * a classic script — and tests/dev-status-pill.test.js reads both ends.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisHorizontalIcon,
  EyeIcon,
  EyeOffIcon,
  Glyph,
  PencilSquareIcon,
  XIcon,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useStoreState } from '../../../lib/use-store-state';
import { aiEnabledStore, cardNowStore } from './cards-store';
import type {
  ActionRef,
  ActionSpec,
  BadgeSpec,
  CardIconSpec,
  DevCardModel,
  ExtraSpec,
  MetaPart,
  PreviewSpec,
  RailSpec,
  StatusPillState,
  TitleSpec,
} from './model';

/** Layout-timed on the client; a no-op under the server renderer, warning-free. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Dispatch a named call back into app-view.js. Unknown names are a no-op. */
function call(ref: ActionRef | undefined, node?: HTMLElement): void {
  if (!ref) return;
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  const fn = av && av[ref.fn];
  if (typeof fn !== 'function') return;
  const args: unknown[] = [...(ref.args || [])];
  if (node) args.push(node);
  fn.apply(av, args);
}

/**
 * `AppView._fmtCountdown`, transcribed (see the header): two-unit,
 * floor-rounded — ~Xd Yh above a day, ~Xh Ym above an hour, ~Xm below.
 */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400);
  if (d >= 1) {
    const h = Math.floor((s % 86400) / 3600);
    return h >= 1 ? `~${d}d ${h}h` : `~${d}d`;
  }
  const h = Math.floor(s / 3600);
  if (h >= 1) {
    const m = Math.floor((s % 3600) / 60);
    return m >= 1 ? `~${h}h ${m}m` : `~${h}h`;
  }
  const m = Math.max(1, Math.floor(s / 60));
  return `~${m}m`;
}

/** A vote still being taken: the tally tiers, before either side has won. */
function isOpenVote(s: StatusPillState): boolean {
  return (s.key === 'needs_vote' || s.key === 'tally') && s.tone === 'progress';
}

/** The in-flight arc — `.dc-status-spinner-arc` everywhere on the platform. */
function Spinner(): ReactNode {
  return <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>;
}

/**
 * The per-type icon (`_devCardIcon`'s markup).
 *
 * On a board card it draws as an 18px GLYPH in the type's colour, not the
 * 36px tinted tile it used to be: app.css's `.dev-card-dense .dev-card-icon`
 * strips the tile's box and fill, so the only thing on the card's left edge
 * is the glyph and every line of the card starts at one x. The tile's
 * classes stay in the markup — the tint utilities still carry the glyph's
 * colour, and `rounded-lg` is what a declared check finds the head by.
 *
 * `<Glyph>` rather than a named icon: the path comes out of app-view.js's
 * `DEV_CARD_ICONS` table at render time, which is exactly the case the
 * escape hatch exists for (see @/components/ui/icons.tsx).
 */
export function CardIcon({ spec }: { spec: CardIconSpec }): ReactNode {
  const box = spec.small ? 'w-7 h-7' : 'w-9 h-9';
  const glyph = spec.small ? 'w-4 h-4' : 'w-5 h-5';
  return (
    <span
      className={`${box} rounded-lg dev-card-icon ${spec.tint} flex items-center justify-center shrink-0${spec.pulse ? ' animate-pulse' : ''}`}
      title={spec.title}
    >
      <Glyph className={glyph} d={spec.path} aria-hidden="true" />
    </span>
  );
}

/** The tap-through chevron (`DEV_CARD_CHEVRON`). */
export function Chevron(): ReactNode {
  return <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" />;
}

/**
 * The composite status pill (`statusPillHtml`'s markup). The derived STATE
 * stays `AppView.statusPillState`'s; this only draws it.
 */
export function StatusPill({ s, inline }: { s: StatusPillState; inline?: boolean }): ReactNode {
  const { now } = useStoreState(cardNowStore);
  if (!s || !s.label) return null;
  let fills: ReactNode = null;
  const fullFill = (side: 'yes' | 'no') => (
    <span className={`gc-vote-fill gc-vote-fill-full gc-vote-fill-full-${side}`}></span>
  );
  if (s.fill === 'full-yes') {
    fills = fullFill('yes');
  } else if (s.fill === 'full-no') {
    fills = fullFill('no');
  } else if (s.fill) {
    const maj = s.majority || 1;
    if (s.yes >= maj) {
      fills = fullFill('yes');
    } else if (s.no >= maj) {
      fills = fullFill('no');
    } else {
      fills = (
        <>
          <span className="gc-vote-fill gc-vote-fill-yes" style={{ width: `${Math.min(100, (s.yes / maj) * 100)}%` }}></span>
          <span className="gc-vote-fill gc-vote-fill-no" style={{ width: `${Math.min(100, (s.no / maj) * 100)}%` }}></span>
        </>
      );
    }
  }
  // The 30s tick: re-derive the countdown label from the store's `now`;
  // before the first tick the baked label carries the paint.
  const label = s.countdown && now > 0
    ? `${s.reject ? 'Set aside' : 'Goes live'} in ${fmtCountdown(s.countdown - now)}${s.suffix || ''}`
    : s.label;
  const extra = Array.isArray(s.reasons) ? Math.max(0, s.reasons.length - 1) : 0;
  const titleParts: string[] = [];
  if (s.title) titleParts.push(s.title);
  else if (s.reasons && s.reasons[0]) titleParts.push(s.reasons[0].detail);
  if (s.tier === 2 && extra > 0) {
    titleParts.push(`and ${extra} more reason${extra === 1 ? '' : 's'}, open for details`);
  }
  const cd = s.countdown ? (s.reject ? ' gc-reject-countdown' : ' gc-merge-countdown') : '';
  // An OPEN vote is the bar's own tone on a board card — accent blue, with an
  // accent fill — where the tier's `progress` violet is kept for the merge
  // pipeline. app.css keys `.dev-status-pill-vote`; edgeFor mirrors the rule.
  const vote = !inline && isOpenVote(s) ? ' dev-status-pill-vote' : '';
  const block = inline ? '' : ' dev-status-pill-block';
  return (
    <span
      className={`gc-vote-count gc-vote-count-${s.tone} dev-status-pill${block}${vote}${cd}`}
      data-window-ends={s.countdown ? String(s.countdown) : undefined}
      data-label-suffix={s.countdown && s.suffix ? s.suffix : undefined}
      title={titleParts.length ? titleParts.join(' · ') : undefined}
    >
      {fills}
      <span className="gc-vote-count-label">
        {s.dot ? (
          <span className="gc-vote-count-dot"><span className="gc-vote-count-dot-ping"></span><span className="gc-vote-count-dot-core"></span></span>
        ) : null}
        {s.spinner ? <Spinner /> : null}
        {label}
        {s.advisory > 0 ? (
          <span
            className="gc-vote-count-suffix"
            title={`${s.advisory} advisory vote${s.advisory === 1 ? '' : 's'} from non-approvers, so they don't count toward merging`}
          >{`+${s.advisory}`}</span>
        ) : null}
        {s.lock ? (
          <span
            className="gc-vote-count-lock"
            aria-hidden="true"
            title="This changes who can administer the app, so it won’t merge on a timer: it needs real Yes votes to reach the app’s normal threshold."
          >{'\u{1F512}'}</span>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The Preview affordance in its three states (`cardPreviewHtml`'s markup).
 *
 * The labelled form (`iconOnly: false`) is a pill with the eye AND the word:
 * it is what the board card shows now, at the right end of its action band,
 * because a 24px eye in the corner was the hardest thing on the card to hit.
 * The icon-only form is kept for the group-chat rows that still ask for it.
 */
export function Preview({ spec }: { spec: PreviewSpec }): ReactNode {
  if (spec.state === 'live') {
    return (
      <button
        type="button"
        className={`gc-vote-btn gc-vote-btn-preview${spec.iconOnly ? ' gc-vote-btn-icon' : ''}`}
        aria-label="Open preview"
        title={spec.title}
        onClick={() => call({ fn: 'swapToStagingForSession', args: [spec.sessionId, spec.url] })}
      >
        {spec.iconOnly ? <EyeIcon aria-hidden="true" /> : <><EyeIcon aria-hidden="true" />{'Preview'}</>}
      </button>
    );
  }
  if (spec.state === 'building') {
    if (!spec.iconOnly) {
      return (
        <span className="gc-checks-running-badge" title={spec.title}>
          <Spinner />
          {'Preview building…'}
        </span>
      );
    }
    return (
      <span className="gc-vote-btn gc-vote-btn-icon gc-checks-running-badge" role="img" aria-label="Preview building" title={spec.title}>
        <Spinner />
      </span>
    );
  }
  if (!spec.iconOnly) {
    return <span className="gc-conflict-badge" title={spec.title}>Preview unavailable</span>;
  }
  return (
    <span className="gc-vote-btn gc-vote-btn-icon gc-conflict-badge" role="img" aria-label="Preview unavailable" title={spec.title}>
      <EyeOffIcon aria-hidden="true" />
    </span>
  );
}

/** One entry of the status band, dispatched over the tagged union. */
export function Badge({ b }: { b: BadgeSpec }): ReactNode {
  switch (b.t) {
    case 'chip':
      return (
        <span className={b.cls} title={b.title} {...(b.data || {})}>
          {b.spinner ? <Spinner /> : null}
          {b.label}
        </span>
      );
    case 'chipBtn':
      return (
        <button
          type="button"
          className={`${b.cls} ${b.hover}`}
          title={b.title}
          {...(b.data || {})}
          onClick={() => call(b.act)}
        >
          {b.spinner ? <Spinner /> : null}
          {b.label}
        </button>
      );
    case 'chat':
      // Rendered at 0 too, wearing `hidden`, so a live bump has a target.
      return (
        <span
          className={`dev-chat-badge dev-badge ${b.count ? 'bg-violet-500/10 text-violet-700 dark:text-violet-400' : 'hidden bg-zinc-500/10 text-zinc-500 dark:text-zinc-400'}`}
          data-count={b.count}
          title="Messages in this thread"
        >{`\u{1F4AC} ${b.count}`}</span>
      );
    case 'attr': {
      const count = b.count > 1 ? <span className="opacity-60">{`·${b.count}`}</span> : null;
      let label: ReactNode;
      if (b.label.kind === 'glyph') {
        label = b.label.glyph + ' ' + b.label.text;
      } else if (b.label.kind === 'dot') {
        label = (
          <>
            <span className={`attr-dot ${b.label.cls}`}></span>
            {b.label.text}
          </>
        );
      } else if (b.label.kind === 'avatar') {
        label = (
          <>
            <span className={`attr-avatar ${b.label.tint}`}>{b.label.initial}</span>
            <span className="dev-badge-name">{b.label.text}</span>
          </>
        );
      } else {
        label = (
          <>
            <span className="attr-avatar attr-avatar-empty"></span>
            <span className="dev-badge-name">{b.label.text}</span>
          </>
        );
      }
      if (b.readonly) {
        return <span className={`attr-chip dev-badge ${b.cls}`}>{label}{count}</span>;
      }
      return (
        <button
          type="button"
          className={`attr-chip dev-badge ${b.cls} ${b.hover}`}
          data-attr-chip=""
          data-attr-field={b.field}
          data-attr-target-type={b.targetType}
          data-attr-target-ref={b.targetRef}
          title={b.title}
        >
          {label}
          {count}
        </button>
      );
    }
    case 'issueChip':
      return (
        <button
          type="button"
          className={b.cls}
          title={b.title}
          data-issue-chip={b.n}
          onClick={() => call({ fn: 'openTopic', args: ['issue', b.n] })}
        >{`${b.prefix}#${b.n}`}</button>
      );
    case 'issueLink':
      return (
        <a href={b.href} target="_blank" rel="noopener" className={b.cls} title={b.title}>
          {`${b.verb} #${b.n}`}
        </a>
      );
    case 'ms':
      // MergeStatus.badgeHtml's shell; the descriptor comes from
      // MergeStatus.lifecycle, resolved by the builder.
      return (
        <span className={`ms-badge ms-badge-${b.tone || 'neutral'}`} title={b.title}>
          {b.spinner ? <Spinner /> : null}
          {b.glyph ? `${b.glyph} ${b.label}` : b.label}
        </span>
      );
    case 'venue':
      return <span className="dc-venue-chip" title={b.title}>{b.label}</span>;
    default:
      return null;
  }
}

/**
 * The board caps the metadata chips at four; the pill, the linkage and the
 * 💬 count ride outside the cap (`_cardBadgesHtml`'s contract, transcribed
 * with the markup it governed).
 */
export const BADGE_MAX = 4;
/** And the action band at three text pills (`ACTION_PRIMARY_MAX`). */
export const ACTION_PRIMARY_MAX = 3;

/**
 * The card's vote control: one button beside the state bar.
 *
 * The Yes/No pair used to be two pills in the action band — two of the three
 * pills a card could show, on every open proposal, whether or not the reader
 * meant to vote. They are one button now: "Vote ▾" until the viewer has cast
 * one, then "✓ Yes ▾" (filled accent) or "✕ No ▾" (blocked tint), and the
 * caret says it can always be changed. Pressing it opens a two-row picker;
 * the rows are the SAME two ActionSpecs the pills were (`castVote` /
 * `castIssueVote`, with the reviewed revision in their args), so the server's
 * head-revision guard and the tally in each label are untouched.
 *
 * The picker is portalled to `document.body` and positioned fixed from the
 * button's rect, exactly as `_toggleCardMenu` places the ⋯ menu: the kanban
 * columns scroll sideways, so anything left inside a card would be clipped
 * by its own column. On touch it hands the two rows to the native action
 * sheet instead, which is what the ⋯ menu does too.
 */
export function VoteButton({ yes, no }: { yes: ActionSpec; no: ActionSpec }): ReactNode {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const mine: 'yes' | 'no' | null = /\bgc-vote-active\b/.test(yes.cls || '')
    ? 'yes'
    : (/\bgc-vote-active\b/.test(no.cls || '') ? 'no' : null);
  // "Yes (2/3)" → "2/3": the tally rides in the spec's label already.
  const tally = (a: ActionSpec) => {
    const m = /\(([^)]*)\)\s*$/.exec(a.label || '');
    return m ? m[1] : '';
  };
  const pick = (a: ActionSpec) => {
    setOpen(false);
    call(a.act);
  };
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    const pu = (window as any).PlatformUI;
    if (pu && typeof pu.isTouch === 'function' && pu.isTouch() && typeof pu.actionSheet === 'function') {
      pu.actionSheet({
        actions: [
          { label: `✓  Yes${tally(yes) ? ` (${tally(yes)})` : ''}`, handler: () => pick(yes) },
          { label: `✕  No${tally(no) ? ` (${tally(no)})` : ''}`, handler: () => pick(no) },
        ],
      });
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const w = 168;
    const h = 84;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ top: Math.round(top), left: Math.round(left) });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onDoc = (ev: Event) => {
      const t = ev.target as Node | null;
      if (t && (btnRef.current?.contains(t) || popRef.current?.contains(t))) return;
      close();
    };
    const onKey = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  const face = mine === 'yes' ? 'Yes' : (mine === 'no' ? 'No' : 'Vote');
  // A governance apply in flight disables the pair; the one button goes
  // inert with them, wearing the spec's own explanation.
  const disabled = !!(yes.disabled || no.disabled);
  const title = disabled && yes.title ? yes.title : mine
    ? `You voted ${face}. Press to change your vote.`
    : `Cast your vote · Yes ${tally(yes)} · No ${tally(no)}`;
  const popover = open && pos ? createPortal(
    <div
      ref={popRef}
      className="dev-vote-pop"
      role="menu"
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
      onClick={(ev) => ev.stopPropagation()}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={mine === 'yes'}
        className="dev-vote-opt dev-vote-opt-yes"
        title={yes.title}
        data-act={yes.act?.fn}
        onClick={() => pick(yes)}
      >
        <CheckIcon aria-hidden="true" />
        {'Yes'}
        <span className="dev-vote-n">{tally(yes)}</span>
      </button>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={mine === 'no'}
        className="dev-vote-opt dev-vote-opt-no"
        title={no.title}
        data-act={no.act?.fn}
        onClick={() => pick(no)}
      >
        <XIcon aria-hidden="true" />
        {'No'}
        <span className="dev-vote-n">{tally(no)}</span>
      </button>
    </div>,
    document.body,
  ) : null;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`dev-vote-btn${mine ? ` dev-vote-btn-${mine}` : ''}`}
        data-vote-btn={mine || 'open'}
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : undefined}
        title={title}
        disabled={disabled}
        onClick={toggle}
      >
        {mine === 'yes' ? <CheckIcon aria-hidden="true" /> : null}
        {mine === 'no' ? <XIcon aria-hidden="true" /> : null}
        {face}
        <ChevronDownIcon className="dev-vote-caret" aria-hidden="true" />
      </button>
      {popover}
    </>
  );
}

/** A Yes or No spec — the vote pair the band demotes into `VoteButton`. */
function isVoteSpec(a: ActionSpec, side: 'yes' | 'no'): boolean {
  return new RegExp(`\\bgc-vote-btn-${side}\\b`).test(a.cls || '');
}

/** One action pill; the kudos slot and the Explore pill are its two specials. */
export function ActionButton({ a, fold, hidden }: { a: ActionSpec; fold?: number; hidden?: boolean }): ReactNode {
  const { enabled } = useStoreState(aiEnabledStore);
  // `data-fold` marks a pill the one-line band may hide; the first pill and
  // the kudos host never carry it.
  const foldAttrs = fold ? { 'data-fold': String(fold), 'data-folded': hidden ? '1' : undefined } : {};
  if (a.kudos != null) {
    // The controller host — `AppView._fillKudosHosts` owns everything below.
    return <span className="contents" data-kudos-host={a.kudos}></span>;
  }
  // The topic head's LABELLED preview — the same component as the card's
  // eye, which is also what covers its two badge states.
  if (a.preview) return <Preview spec={a.preview} />;
  if (a.explore != null) {
    // #313/#827/#621. Availability is `/api/budget`'s answer, published
    // through aiEnabledStore — the store replaces the
    // `_applyExploreChatAvailability` DOM pass for card pills.
    return (
      <button
        type="button"
        className={`gc-vote-btn gc-explore-chat-btn${enabled ? '' : ' opacity-50 cursor-not-allowed'}`}
        disabled={!enabled}
        {...foldAttrs}
        data-proposal-id={a.explore}
        title={enabled ? a.title : "AI chat isn't configured on this deployment."}
        onClick={(e) => call({ fn: 'exploreProposalInDevChat', args: [a.explore!] }, e.currentTarget)}
      >
        <span aria-hidden="true">{'✨'}</span>
        {' Explore in dev chat'}
      </button>
    );
  }
  // `data-act` is the name of the AppView method this pill calls.
  //
  // These handlers were inline `onclick="AppView.markIssueInProgress(12)"`
  // strings, and two of dapp.json's declared checks assert that a particular
  // action is offered IN THE BAND rather than buried in the ⋯ menu by
  // matching `[onclick*="markIssueInProgress"]` / `[onclick*="_setSessionShared"]`.
  // The migration replaced those strings with closures, which is what made
  // the attribute — and with it the checks' only hook — disappear.
  //
  // The model already carries the answer (`act.fn`), so publishing it keeps
  // the assertion expressible without reintroducing a global-name handler.
  // Both checks select on `[data-act="…"]` now: the same claim about the same
  // button, matched exactly instead of by substring over a fragment of
  // JavaScript source.
  return (
    <button
      className={a.cls || 'gc-vote-btn'}
      disabled={a.disabled}
      title={a.title}
      {...foldAttrs}
      data-act={a.act?.fn}
      onClick={a.act ? (e) => call(a.act, a.passNode ? e.currentTarget : undefined) : undefined}
    >
      {a.label}
    </button>
  );
}

/**
 * The card's right-edge rail (`_cardRailHtml`): ⋯ up top, the chevron below.
 *
 * The eye used to be pinned at the bottom of this column. A board card now
 * draws its preview as a LABELLED pill at the end of the action band (see
 * DevCard), so `rail.preview` is only drawn here by a caller that still
 * wants the corner form — none of the board's builders do.
 */
function Rail({ rail }: { rail: RailSpec }): ReactNode {
  const trigger = rail.menuKey ? (
    <button
      type="button"
      className="gc-vote-btn gc-vote-btn-icon dev-card-menu-btn"
      data-card-menu={rail.menuKey}
      aria-haspopup="true"
      aria-label="More actions"
      title="More actions"
    >
      <EllipsisHorizontalIcon aria-hidden="true" />
    </button>
  ) : null;
  const chevron = rail.chevron ? <Chevron /> : null;
  const preview = rail.preview ? <Preview spec={rail.preview} /> : null;
  if (!trigger && !chevron && !preview) return null;
  // A lone chevron is already the card's only right-edge child — no column.
  if (!trigger && !preview) return chevron;
  return <div className="dev-card-rail">{trigger}{chevron}{preview}</div>;
}

function MetaPartView({ p }: { p: MetaPart }): ReactNode {
  if (p.t === 'link') {
    return <a href={p.href} target="_blank" rel="noopener" className={p.cls} title={p.title}>{p.s}</a>;
  }
  if (p.t === 'span') {
    return <span className={p.cls} title={p.title}>{p.s}</span>;
  }
  return p.s;
}

/** The title band's content: lead/trail runs, the edit pencil, the editor. */
function TitleContent({ t }: { t: TitleSpec }): ReactNode {
  if (t.editing) {
    const n = t.editing.issue;
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); call({ fn: 'saveIssueTitle', args: [n] }); }
      if (e.key === 'Escape') { e.preventDefault(); call({ fn: 'cancelIssueTitleEdit' }); }
    };
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="dev-issue-title-input"
          type="text"
          maxLength={200}
          defaultValue={t.editing.initial}
          autoFocus
          width="flex"
          box="tight"
          onKeyDown={onKeyDown}
        />
        <button type="button" className="gc-vote-btn" onClick={() => call({ fn: 'saveIssueTitle', args: [n] })}>Save</button>
        <button type="button" className="gc-vote-btn" onClick={() => call({ fn: 'cancelIssueTitleEdit' })}>Cancel</button>
        <span id="dev-issue-title-error" className="w-full text-xs text-red-400 hidden"></span>
      </div>
    );
  }
  // The space before the pencil rides INSIDE the title string: a bare
  // {' '} between two text runs is two adjacent children, which cannot
  // survive hydration (React #418) and the shell build refuses it.
  const text = t.lead ? ` ${t.text}` : t.text;
  return (
    <>
      {t.lead ? <span className={t.lead.cls}>{t.lead.s}</span> : null}
      {t.edit ? `${text} ` : text}
      {t.trail ? <span className={t.trail.cls}>{` · ${t.trail.s}`}</span> : null}
      {t.edit ? (
        <>
          <button
            type="button"
            className="align-middle text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors dark:text-zinc-400"
            title="Edit this issue's title (you created it)"
            aria-label="Edit title"
            onClick={() => call({ fn: 'beginIssueTitleEdit', args: [t.edit!.issue] })}
          >
            <PencilSquareIcon className="w-3.5 h-3.5 inline -mt-0.5" />
          </button>
        </>
      ) : null}
    </>
  );
}

function ExtraRow({ x }: { x: ExtraSpec }): ReactNode {
  if (x.t === 'note') {
    return (
      <div className="mt-1 px-0.5 text-[0.7rem] leading-snug text-zinc-500 dark:text-zinc-400" data-work-note={x.workState}>
        {x.text}
      </div>
    );
  }
  // The topic-view-only admin claim list, with its per-claim clear control.
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 px-0.5 text-[0.65rem] text-zinc-500 dark:text-zinc-400">
      {'Claims:'}
      {x.claims.map((c) => (
        <span key={c.userId} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-400">
          {c.username}
          <button
            type="button"
            className="hover:text-sky-700 dark:hover:text-sky-300 dark:text-sky-400"
            title={`Release ${c.username}'s claim (admin)`}
            onClick={() => call({ fn: 'clearIssueClaim', args: [c.issue, c.userId] })}
          >{'×'}</button>
        </span>
      ))}
    </div>
  );
}

/** The whole card. `m.attrs` carries the outer element's data-*, role and title. */
export function DevCard({ model: m }: { model: DevCardModel }): ReactNode {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.attrs || {})) {
    // `tabindex` must reach React by its DOM-property name or React warns —
    // and a console error on any route fails proposal checks.
    if (k === 'tabindex') attrs.tabIndex = Number(v);
    else attrs[k] = v;
  }

  const dense = m.dense;
  // The vote pair leaves the action band for the status band, as one button
  // beside the bar — on the board card and on the topic head alike.
  const allActions = m.actions || [];
  const yesSpec = allActions.find((a) => isVoteSpec(a, 'yes'));
  const noSpec = allActions.find((a) => isVoteSpec(a, 'no'));
  const voteBtn = yesSpec && noSpec ? <VoteButton yes={yesSpec} no={noSpec} /> : null;
  const bandActions = voteBtn ? allActions.filter((a) => a !== yesSpec && a !== noSpec) : allActions;
  const chips = (m.badges || []).filter(Boolean);
  const kept = m.uncapped ? chips : chips.slice(0, BADGE_MAX);
  const linked = m.linked || [];
  // #1139: a status band with nothing a reader can see is emitted (the node
  // must stay — app.css caps the action band through the sibling chain) but
  // stamped data-empty and hidden by CSS. A 0 chat count is NOT content.
  const statusHasContent = chips.length > 0 || !!m.pill || linked.length > 0
    || (m.chatCount !== null && m.chatCount !== undefined && (m.chatCount || 0) > 0);
  const chat = m.chatCount !== null && m.chatCount !== undefined
    ? <Badge b={{ t: 'chat', key: 'chat', count: m.chatCount || 0 }} />
    : null;
  // The facts — linkage, metadata, message count — read as one muted text
  // line under the bar on a board card (app.css restyles the chips), so a
  // full-width break separates the bar row from them. Only when both exist:
  // an empty band must stay empty, and a bare facts line needs no break.
  const factsVisible = linked.length > 0 || kept.length > 0 || (m.chatCount || 0) > 0;
  const brk = (m.pill || voteBtn) && factsVisible
    ? <span className="dev-card-band-break" aria-hidden="true"></span>
    : null;
  const badgeRow = (
    <>
      {m.pill ? <StatusPill s={m.pill.state} inline={m.pill.inline} /> : null}
      {voteBtn}
      {brk}
      {linked.map((b) => <Badge key={b.key} b={b} />)}
      {kept.map((b) => <Badge key={b.key} b={b} />)}
      {chat}
    </>
  );
  const statusRow = dense ? (
    <div className="dev-card-badges dev-card-status" data-empty={statusHasContent ? undefined : '1'}>{badgeRow}</div>
  ) : (statusHasContent ? <div className="dev-card-badges">{badgeRow}</div> : null);

  const primary = bandActions.slice(0, ACTION_PRIMARY_MAX);
  // The board card's preview rides at the END of the band as a labelled pill
  // (the builders still hand it over as `rail.preview`; the model did not
  // move). The detail head's arrives as `actionPreview`, already labelled.
  const previewSpec = m.actionPreview
    || (m.rail.preview ? { ...m.rail.preview, iconOnly: false } : null);
  const bandPreview = previewSpec ? <Preview spec={previewSpec} /> : null;
  const hasActions = primary.length > 0 || !!bandPreview;
  const folded = useFoldedActions(primary, m.rail.menuKey || '', !!bandPreview);
  const actionRow = hasActions ? (
    <div className="gc-card-actions" ref={folded.ref}>
      {primary.map((a, i) => (
        <ActionButton key={a.key} a={a} fold={i > 0 && a.kudos == null ? i : undefined} hidden={i > 0 && i >= primary.length - folded.n} />
      ))}
      {bandPreview}
    </div>
  ) : (dense ? <div className="gc-card-actions"></div> : null);
  const rail: RailSpec = { ...m.rail, preview: null };
  const edge = edgeFor(m);

  // The meta line, ' · '-joined. Dense reserves the band even when empty;
  // the detail head collapses it, exactly as `_cardContentHtml` did.
  const metaNodes: ReactNode[] = [];
  (m.meta || []).forEach((p, i) => {
    if (i) metaNodes.push(' · ');
    metaNodes.push(<MetaPartView key={i} p={p} />);
  });
  const metaRow = dense || metaNodes.length
    ? <div className="dev-card-meta">{metaNodes}</div>
    : null;

  return (
    <div className={`${m.cls} ${dense ? 'dev-card-dense' : 'dev-card-topic'}`} data-edge={edge} {...attrs}>
      <div className="flex-1 min-w-0">
        <div className="dev-card-head">
          {m.icon ? <CardIcon spec={m.icon} /> : null}
          <div className="dev-card-head-main">
            <div
              className={dense ? 'dev-card-title dev-card-title-clamp' : 'dev-card-title'}
              data-issue-title={m.title.edit || m.title.editing
                ? (m.title.edit ? m.title.edit.issue : m.title.editing!.issue)
                : undefined}
              title={m.title.title || undefined}
            >
              <TitleContent t={m.title} />
            </div>
          </div>
        </div>
        {metaRow}
        {statusRow}
        {actionRow}
        {(m.extra || []).map((x) => <ExtraRow key={x.key} x={x} />)}
      </div>
      <Rail rail={rail} />
    </div>
  );
}

/**
 * The card's left edge: the bar's tone, and the card's TYPE where it has no
 * bar. 4px at a third strength (app.css `[data-edge]`), so a column reads as
 * a stack of tinted spines — blue while a vote is open, violet while merging,
 * amber behind main, red on a conflict, green once merged, grey while paused
 * — and an open issue, which has no state, wears its type's amber so the
 * Issues column is not the one bare column.
 */
function edgeFor(m: DevCardModel): string {
  const s = m.pill?.state;
  if (s && s.label) return isOpenVote(s) ? 'vote' : (s.tone || 'neutral');
  const kind = String(m.key || '').split(':')[0];
  if (kind === 'issue') return 'attention';
  if (kind === 'proposal') return 'vote';
  if (kind === 'gov') return 'progress';
  return 'ok';
}

/**
 * One line of actions, folding into ⋯.
 *
 * The dense band always clipped at one row, so a pill that did not fit
 * wrapped onto a row nobody saw. It folds now: after layout the band
 * measures its pills, keeps the first (the card's primary) and the Preview
 * pill, marks as many of the rest as do not fit `data-folded`, and publishes
 * those specs to app-view.js (`_setFoldedCardActions`) so `_toggleCardMenu`
 * lists them at the top of the card's ⋯ menu.
 *
 * A folded pill is NOT `hidden`: app.css sends it to the clipped second row
 * with `order` (so the Preview pill keeps the first row's right end) and
 * it stays rendered. That is deliberate — `innerText`, which the declared
 * checks read their `expectText` from, drops `display: none` content, and
 * "Claim this issue" is one of those texts. Measured in a layout effect,
 * before paint, re-measured on resize, and mirrored into React state so a
 * re-render draws what the measurement decided.
 */
function useFoldedActions(
  primary: ActionSpec[], menuKey: string, hasPreview: boolean,
): { ref: (el: HTMLDivElement | null) => void; n: number } {
  const bandRef = useRef<HTMLDivElement | null>(null);
  const [n, setN] = useState(0);
  const foldable = primary.filter((a, i) => i > 0 && a.kudos == null).length;
  useIsoLayoutEffect(() => {
    const band = bandRef.current;
    if (!band || !foldable) { if (n) setN(0); return undefined; }
    const measure = () => {
      const kids = Array.from(band.children) as HTMLElement[];
      const folds = kids.filter((k) => k.dataset.fold);
      folds.forEach((k) => { k.removeAttribute('data-folded'); });
      const gap = 6;
      const avail = band.clientWidth;
      let used = 0;
      let count = 0;
      for (const k of kids) {
        if (k.dataset.fold) continue;
        used += k.offsetWidth + (count ? gap : 0);
        count += 1;
      }
      let shown = 0;
      for (const k of folds) {
        const w = k.offsetWidth + (count ? gap : 0);
        if (used + w <= avail) { used += w; count += 1; shown += 1; } else break;
      }
      folds.forEach((k, i) => { if (i >= shown) k.setAttribute('data-folded', '1'); });
      // The arithmetic mirrors the flex line-break; if a rounding edge still
      // let one wrap, fold it too so the menu and the row agree.
      const row = kids.length ? kids[0].offsetTop : 0;
      folds.forEach((k, i) => {
        if (i < shown && k.offsetTop > row) { k.setAttribute('data-folded', '1'); shown = i; }
      });
      setN(folds.length - shown);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(band);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldable, hasPreview, primary.map((a) => a.key + a.label).join('|')]);
  // Tell the ⋯ menu which specs it now carries.
  useEffect(() => {
    if (!menuKey) return undefined;
    const av = typeof window !== 'undefined' ? (window as any).AppView : null;
    if (!av || typeof av._setFoldedCardActions !== 'function') return undefined;
    const hidden = n > 0 ? primary.filter((a, i) => i > 0 && a.kudos == null).slice(-n) : [];
    av._setFoldedCardActions(menuKey, hidden);
    return () => { av._setFoldedCardActions(menuKey, []); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuKey, n, primary.map((a) => a.key + a.label).join('|')]);
  return { ref: (el) => { bandRef.current = el; }, n };
}
