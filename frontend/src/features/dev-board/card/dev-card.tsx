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
 * `statusPillHtml` baked "Merging in ~2h" into the string and a 30s module
 * interval rewrote the label in place. The model still carries the baked
 * label (so the first paint needs no store), plus the window's epoch; the
 * module interval now publishes `Date.now()` through `cardNowStore` and
 * every pill with a `countdown` re-derives its label here. `fmtCountdown`
 * is transcribed from `AppView._fmtCountdown` — this bundle cannot import
 * a classic script — and tests/dev-status-pill.test.js reads both ends.
 */

import type { KeyboardEvent, ReactNode } from 'react';

import {
  ChevronRightIcon,
  EllipsisHorizontalIcon,
  EyeIcon,
  EyeOffIcon,
  Glyph,
  PencilSquareIcon,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { openmojiSrcFor } from '../../../lib/openmoji';
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

/** The in-flight arc — `.dc-status-spinner-arc` everywhere on the platform. */
function Spinner(): ReactNode {
  return <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>;
}

/**
 * The per-type icon chip (`_devCardIcon`'s markup).
 *
 * subtle-y2k v2: the chip prefers the spec's OpenMoji glyph (an <img> from
 * the vendored slice — lib/openmoji.js resolves it, and a miss falls back
 * to the stroked glyph, never to a blank). `<Glyph>` rather than a named
 * icon for that fallback: the shapes come out of app-view.js’s
 * DEV_CARD_ICONS table at render time, which is exactly the case the
 * escape hatch exists for (see @/components/ui/icons.tsx).
 */
export function CardIcon({ spec }: { spec: CardIconSpec }): ReactNode {
  const box = spec.small ? 'w-7 h-7' : 'w-9 h-9';
  const glyph = spec.small ? 'w-4 h-4' : 'w-5 h-5';
  const illustrated = spec.emoji ? openmojiSrcFor(spec.emoji) : null;
  return (
    <span
      className={`${box} rounded-lg ${spec.tint} flex items-center justify-center shrink-0${spec.pulse ? ' animate-pulse' : ''}`}
      title={spec.title}
    >
      {illustrated ? (
        <img
          src={illustrated}
          alt=""
          loading="lazy"
          draggable="false"
          aria-hidden="true"
          className={`${spec.small ? 'w-5 h-5' : 'w-6 h-6'} object-contain`}
        />
      ) : (
        <Glyph className={glyph} shapes={spec.shapes} aria-hidden="true" />
      )}
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
    ? `${s.reject ? 'Rejecting' : 'Merging'} in ${fmtCountdown(s.countdown - now)}${s.suffix || ''}`
    : s.label;
  const extra = Array.isArray(s.reasons) ? Math.max(0, s.reasons.length - 1) : 0;
  const titleParts: string[] = [];
  if (s.title) titleParts.push(s.title);
  else if (s.reasons && s.reasons[0]) titleParts.push(s.reasons[0].detail);
  if (s.tier === 2 && extra > 0) {
    titleParts.push(`and ${extra} more reason${extra === 1 ? '' : 's'}, open for details`);
  }
  const cd = s.countdown ? (s.reject ? ' gc-reject-countdown' : ' gc-merge-countdown') : '';
  const block = inline ? '' : ' dev-status-pill-block';
  return (
    <span
      className={`gc-vote-count gc-vote-count-${s.tone} dev-status-pill${block}${cd}`}
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

/** The Preview affordance in its three states (`cardPreviewHtml`'s markup). */
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
        {spec.iconOnly ? <EyeIcon aria-hidden="true" /> : 'Preview'}
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

/** One action pill; the kudos slot and the Explore pill are its two specials. */
export function ActionButton({ a }: { a: ActionSpec }): ReactNode {
  const { enabled } = useStoreState(aiEnabledStore);
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
      data-act={a.act?.fn}
      onClick={a.act ? (e) => call(a.act, a.passNode ? e.currentTarget : undefined) : undefined}
    >
      {a.label}
    </button>
  );
}

/** The card's right-edge rail (`_cardRailHtml`): ⋯ up top, the eye at the bottom. */
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
  const badgeRow = (
    <>
      {m.pill ? <StatusPill s={m.pill.state} inline={m.pill.inline} /> : null}
      {linked.map((b) => <Badge key={b.key} b={b} />)}
      {kept.map((b) => <Badge key={b.key} b={b} />)}
      {chat}
    </>
  );
  const statusRow = dense ? (
    <div className="dev-card-badges dev-card-status" data-empty={statusHasContent ? undefined : '1'}>{badgeRow}</div>
  ) : (statusHasContent ? <div className="dev-card-badges">{badgeRow}</div> : null);

  const primary = (m.actions || []).slice(0, ACTION_PRIMARY_MAX);
  const bandPreview = m.actionPreview ? <Preview spec={m.actionPreview} /> : null;
  const hasActions = primary.length > 0 || !!bandPreview;
  const actionRow = hasActions ? (
    <div className="gc-card-actions">
      {primary.map((a) => <ActionButton key={a.key} a={a} />)}
      {bandPreview}
    </div>
  ) : (dense ? <div className="gc-card-actions"></div> : null);

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
    <div className={m.cls} {...attrs}>
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
      <Rail rail={m.rail} />
    </div>
  );
}
