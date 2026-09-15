/**
 * A change in flight, as a row — the Improve panel's "Changes in progress"
 * and "Changes in other apps" lists.
 *
 * ── Why it stopped being one line ──────────────────────────────────────
 *
 * It was a 44px anchor: `[dot] (app) title (status) (time) (unread dot)`, one
 * line, everything in much the same grey. The problem was not the row, it was
 * the row's NEIGHBOURS: `ImproveRow` — "View on GitHub", "Share app",
 * "Developer terminal" — is `flex items-center gap-3 px-4 min-h-[44px]`, and so
 * was this. A running change and a menu entry were the same shape, in the same
 * ink, one after the other, and the only thing separating them was the colour
 * of a 10px dot. The list read as more menu.
 *
 * Three things fix that, and each is something no action row has:
 *
 *   * A SECOND LINE. The title leads; the app, the state and the time follow
 *     underneath in the caption size. Nothing else in this panel is two lines.
 *   * A LEADING TILE, not a dot. The app's own artwork at 32px. It answers
 *     "which app" by looking rather than by spending up to 35% of the row's
 *     width on a truncated name. It wore the state as a badge on its corner
 *     too, until #1946/#1947 — see "The badge went with it" below.
 *   * A STATUS PILL. Tinted, on the trailing edge — the one loud element in a
 *     row, and the thing a viewer is actually scanning for.
 *
 * The rows then sit in a bordered group (see improve-panel.tsx), because a
 * group says "these are records" where edge-to-edge rows say "these are
 * destinations".
 *
 * ── What did NOT change ────────────────────────────────────────────────
 *
 * `data-improve-row` and the `href` shape are what dapp.json's declared checks
 * select on, and `data-session-unread` is the notifications store's live hook —
 * all three are carried through untouched. The destination still arrives on the
 * row as `href` rather than being built here from an id (#1417): a session's id
 * addresses a session page, a work order's addresses nothing the browser can
 * open, and a component that assumed the first would send every task row to a
 * 404.
 *
 * `onNavigate` is the host surface's own dismissal (Improve.dismissForNav): a
 * row that navigates has to take its modal host down first, and only the host
 * knows which sheet that is.
 */


import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from '../notifications/notifications-store.js';

/** The app artwork, in the shape AppCard.iconViewFor publishes. */
export type SessionIconView =
  | { kind: 'image'; src: string }
  | { kind: 'emoji'; emoji: string }
  | { kind: 'letter'; letter: string };

export type SessionRowView = {
  key: string;
  kind: 'session' | 'task';
  id: number;
  appSlug: string | null;
  appName: string;
  icon: SessionIconView;
  title: string;
  href: string;
  status: string | null;
  busy: boolean;
  /** Waiting on the user — see awaitsInput in ./improve-controller.js (#1959). */
  awaitingInput: boolean;
  lastActivityAt?: string | null;
};

// `relTime` lived here. It ran a thirty-day bucket and then months, so a row
// last touched in the spring read "5mo ago" — which is roughly true and says
// nothing about which day. It is `agoStamp` from lib/timestamp.ts now (#1808).

/**
 * THE STATE, as a word rather than as a colour alone.
 *
 * The dot said all of this already, and said it only to someone who had
 * learned the code. Three states, because with paused rows filtered out of
 * these lists (see isParked in ./improve-controller.js) three is all there is:
 *
 *   - WORKING, amber, with the platform's arc spinner in the pill while an AI
 *     turn is in flight. The amber is the platform's own "something is
 *     building" colour, borrowed from the header's deploy dot.
 *   - READY, solid emerald once it stops: the success green that says the
 *     change is back with you. It reads "Ready for your input" ONLY when the
 *     session is actually waiting on the user — a question with answer chips
 *     still up, or a finished spec whose Questions section is open (#1959,
 *     `awaitingInput`). A finished spec with nothing to ask and a finished
 *     build are plain "Ready": the feedback that asked for the longer label
 *     asked for it to be true, and a pill that says "for your input" on
 *     every idle row says it on none. Same state, same tone — the words
 *     carry the qualification, not a fourth colour.
 *   - HANDED OFF, outlined, for a work order (#1417). Its agent runs on the
 *     user's own machine, where the platform cannot see whether a turn is in
 *     flight, so the row states what it knows instead of borrowing a liveness
 *     claim this side has no way to make. NO SPINNER, for the same reason the
 *     row is never `busy`: an arc turning here would claim a liveness this
 *     side has no way to observe.
 *
 * ── The pulse moved, and became a spinner (#1597) ──────────────────────
 *
 * The working row used to say "in progress" by PULSING its tile badge, which
 * was the one in-progress cue on the platform that was not the arc every other
 * surface draws: the dev screen's own session list (features/dev-chat/
 * session-list.tsx), a proposal running its checks, "Preview building…" on a
 * board card, "Proposing…" in a transcript, the merge-status badges, the
 * app-launch cover. All of those are `.dc-status-spinner-arc`, so this is now
 * too — and the reporter of #1597 read the difference exactly that way.
 *
 * The badge KEPT its amber and LOST its animation. Both halves were
 * deliberate: the colour was meant to make a column of tiles scannable
 * without reading any of them, and the motion became the pill's, because one
 * fact wants one cue — the same reasoning that retired #improve-version-dot
 * from the button that opens this panel, where a glyph and a dot were saying
 * the same thing twice.
 *
 * ── The badge went with it (#1946, #1947) ──────────────────────────────
 *
 * That last argument finished the job a round later. App feedback triage
 * 2026-09-10 filed the corner badge twice, once per colour: row 39a asked to
 * "replace the static green dot with an active work indicator", row 39b to
 * remove the yellow one and say "sessions actively thinking" some other way.
 * Two rows, one dot — and both readings are right about it:
 *
 *   - EMERALD said "this change is not doing anything", in the platform's
 *     success colour, on nearly every row in the list. It never moved and it
 *     never meant work; a reader scanning for what was running had to know
 *     that green was the colour of NOT running.
 *   - AMBER said "a turn is in flight" — on a row whose pill was already
 *     saying exactly that, in the same amber, in a word, with the arc
 *     turning. A second unlabelled voice for one fact is what #1597 took off
 *     this badge's motion and #1610 took off the button that opens the panel.
 *
 * So the corner badge is gone, and the activity indicator the feedback asked
 * for is the PILL — which is where it already was. It says `Working` with the
 * platform's arc while a turn is in flight and drops both the moment the turn
 * ends, and it reads that from the live session store rather than from the
 * last payload (#1958, `SessionState.isBusy`), so it is about work happening
 * rather than about a lifecycle. The arc is `aria-hidden`; the word beside it
 * is what a screen reader gets. An idle row carries no dot at all — nothing
 * on it is green any more except the pill's own tinted `Ready`, which says
 * what it means in words.
 */
function stateOf(session: SessionRowView): {
  label: string; pill: string; spinner: boolean;
} {
  if (session.busy) {
    return {
      label: 'Working',
      pill: 'bg-amber-400/20 text-amber-700 dark:text-amber-300',
      spinner: true,
    };
  }
  if (session.kind === 'task') {
    return {
      label: 'Handed off',
      pill: 'border border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400',
      spinner: false,
    };
  }
  return {
    label: session.awaitingInput ? 'Ready for your input' : 'Ready',
    pill: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
    spinner: false,
  };
}

/**
 * THE PILL'S CONSTANT HALF, and the one thing in it that is not shape.
 *
 * `inline-flex items-center gap-1` because the pill has two children while a
 * turn is in flight — 4px is the gap `.gc-checks-running-badge` puts between
 * the same arc and the same 11px semibold label on a board card, so the two
 * surfaces space their spinner identically.
 *
 * The two arbitrary variants are the COLOUR. `.dc-status-spinner-arc` borders
 * in `var(--accent)`, which is blue (#0a6ee0 light, #5aa9ff dark), and a blue
 * arc inside an amber pill is off-palette. `border-current` takes the arc to
 * whatever ink the pill is already carrying, so one pair of literals covers
 * both themes and every state; `border-r-transparent` puts the gap back, since
 * `border-current` would otherwise fill it in and draw a closed ring.
 *
 * Scoped HERE rather than added to app.css on purpose. `.dc-pr-btn-promote
 * .dc-status-spinner-arc` (public/css/app.css) is the precedent for recolouring
 * the shared arc for one surface — "the shared class stays untouched everywhere
 * else" — and this panel is a fully React-owned island, so its override belongs
 * in its own class run. The compiled child selector outspecifies the base class
 * and tailwind.css loads after app.css, so it wins on both counts.
 */
const PILL_BASE =
  'shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 '
  + 'text-[11px] font-semibold '
  + '[&>.dc-status-spinner-arc]:border-current '
  + '[&>.dc-status-spinner-arc]:border-r-transparent ';

/**
 * The 32px app tile. `xs` in the widget language's own scale
 * (@/components/ui/icon-tile), hand-rolled here rather than borrowed: this
 * one is a <span> inside an anchor and it CLIPS the app's artwork behind a
 * hairline, neither of which IconTile does. Everything else about it — the
 * neutral face, the size, the rounding — is that component's, deliberately,
 * so a change to the launcher's tiles is a change to these.
 *
 * It was a positioning context as well until #1946: the state's corner badge
 * was absolutely positioned against it. With the badge retired the tile
 * answers "which app" and nothing else, so `relative` and the wrapper that
 * carried it are gone with it.
 */
function AppTile({ session }: { session: SessionRowView }) {
  const { icon } = session;
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800">
      {icon.kind === 'image' ? (
        <img
          src={icon.src}
          alt=""
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : icon.kind === 'emoji' ? (
        <span className="text-base leading-none" aria-hidden="true">{icon.emoji}</span>
      ) : (
        <span className="text-sm font-semibold leading-none text-zinc-600 dark:text-zinc-300">
          {icon.letter}
        </span>
      )}
    </span>
  );
}

export function SessionRow({
  session,
  showApp,
  onNavigate,
}: {
  session: SessionRowView;
  showApp: boolean;
  onNavigate: () => void;
}) {
  const { sessionUnreadIds } = useStoreState(notificationsStore) as {
    sessionUnreadIds: number[];
  };
  const unread = sessionUnreadIds.includes(session.id);
  const time = agoStamp(session.lastActivityAt);
  const state = stateOf(session);

  // The caption line. `showApp` is the "other apps" list, where which app a
  // change belongs to is the thing being said; on the focused list the tile
  // has already answered it, so the line spends its width on the status the
  // controller wrote (`session.status`) instead — "3 commits", the agent
  // holding a work order, whatever it knows.
  // Everything before the stamp is one string; the stamp is its own element
  // so it can carry the unelided instant in `title` (#1808).
  const caption = [
    showApp ? session.appName : null,
    session.status,
  ].filter(Boolean).join(' · ');

  return (
    <a
      href={session.href}
      data-improve-row={session.kind}
      className="flex items-center gap-3 px-3 min-h-[60px] text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors"
      onClick={onNavigate}
    >
      <AppTile session={session} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {session.title}
        </span>
        {/* The caption can be empty — a session with no status, no time and no
            app name to show — and an empty line would still take its height,
            leaving the title floating above nothing. */}
        {caption || time.text ? (
          <span className="mt-0.5 block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {caption}
            {time.text ? (
              <time title={time.title}>{caption ? ` · ${time.text}` : time.text}</time>
            ) : null}
          </span>
        ) : null}
      </span>
      <span className={PILL_BASE + state.pill}>
        {/* The platform's in-flight arc — `.dc-status-spinner-arc` everywhere,
            and a DIRECT child of the pill because the colour override above
            selects it as one. `aria-hidden`: the label beside it is what a
            screen reader should read, and "Working" already says it. */}
        {state.spinner ? (
          <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>
        ) : null}
        {state.label}
      </span>
      {unread ? (
        <span
          className="w-2 h-2 rounded-full bg-violet-500 shrink-0"
          role="img"
          aria-label="Unread activity"
          data-session-unread={session.id}
        />
      ) : null}
      {/* NO CHEVRON. The whole row is an anchor and the state pill already
          says this is a live thing you can open; an affordance glyph on every
          row only bought a redundant hint, and it bought it with the width a
          change's TITLE needs — which is the one part of the row a reader
          actually has to read. */}
    </a>
  );
}
