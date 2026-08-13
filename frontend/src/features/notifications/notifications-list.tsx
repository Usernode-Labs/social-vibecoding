/**
 * The bell drawer's contents — the pinned invites section, the grouped list
 * and the empty hint (#1191 slice 6, conversion 2).
 *
 * ── What changed, and what deliberately did not ────────────────────────
 *
 * ./notifications.js used to build all three by `innerHTML` and then wire the
 * handlers back on with four `querySelectorAll` sweeps. It now computes a
 * descriptor tree (`rowView` / `groupView` / `inviteView`) and pushes it into
 * ./notifications-store.js; this file is the only writer of the DOM below
 * #notifications-invites and #notifications-list.
 *
 * The markup is like-for-like: same class strings, same `data-notif-id` /
 * `data-invite-app` / `data-group-toggle` attributes, same between-apps
 * divider (between entries only — never before the first or after the last).
 * The attributes stay because they are how the rows were addressed, and
 * because #work-drawer-list still renders the identical HTML flavour of these
 * rows until slice 6's fourth conversion.
 *
 * ── stopPropagation, everywhere ────────────────────────────────────────
 *
 * Every handler here stops the click. That is not defensive habit: the drawer
 * dismisses on a document-level outside click, and each of these actions
 * re-renders the list. React unmounts the clicked node before the event
 * finishes bubbling, so the document handler would see a target that is no
 * longer inside #notifications-panel and close the drawer under the user.
 * This is the same reason the imperative version passed `e.stopPropagation()`
 * to all four sweeps.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `invites: null` / `list: null` render nothing and the hint renders `hidden`,
 * which is exactly the markup the hand-written shell shipped. The SSG pass in
 * frontend/scripts/build-shell.mjs prerenders this island in Node, so anything
 * else here would be a hydration mismatch — and a console error on any route
 * fails proposal checks.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from './notifications-store.js';

type Segment = { t: 'who' | 'strong' | 'text'; v: string };

type RowView = {
  id: number;
  unread: boolean;
  unreadCls: string;
  time: string;
  mb: boolean;
  metaFlex: boolean;
  wrap: boolean;
  icon: string | null;
  segments: Segment[];
  body: { text: string; medium: boolean; mention: boolean } | null;
};

type GroupView = {
  key: string;
  appId: number | '';
  expanded: boolean;
  hasUnread: boolean;
  accent: string;
  chevron: string;
  appName: string;
  count: number;
  preview: string;
  leaves: RowView[];
  more: { key: string; label: string } | null;
};

type InviteView = {
  appId: number;
  slug: string;
  kind: string;
  icon: string;
  who: string;
  verb: string;
  appName: string;
  time: string;
};

type Entry = { type: 'row'; row: RowView } | { type: 'group'; group: GroupView };

// The controller is a classic-script-shaped global; this island reads it the
// same way app.js does rather than importing it, because ./notifications.js
// must stay import-free (see ./notifications-store.js).
function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Notifications : null) || null;
}

function kit(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

const ROW_CLASS = 'w-full text-left px-3 py-2.5 border-b border-zinc-200 '
  + 'dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors';

// Unread indicator dot. When unread it's a solid violet dot carrying an
// accessible "Unread" label; when read it's an equal-width invisible spacer so
// read/unread rows stay horizontally aligned (no jitter when a row is marked
// read live).
function UnreadDot({ unread }: { unread: boolean }): ReactNode {
  return unread ? (
    <span
      role="img"
      aria-label="Unread"
      className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 align-middle mr-1.5 shrink-0"
    >
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="inline-block w-1.5 h-1.5 align-middle mr-1.5 shrink-0"
    >
    </span>
  );
}

function metaClass(v: RowView): string {
  return 'text-xs text-zinc-500 dark:text-zinc-400'
    + (v.mb ? ' mb-1' : '')
    + (v.metaFlex ? ' flex items-center gap-1' : '')
    + (v.wrap ? ' flex-wrap' : '');
}

/**
 * A mention snippet, split on @tokens. The imperative version highlighted them
 * by regex-replacing into an escaped HTML string; splitting the raw text and
 * letting React place the pieces is the same output without the string step.
 */
function mentionParts(text: string): Array<{ text: string; at: boolean }> {
  const out: Array<{ text: string; at: boolean }> = [];
  const re = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    out.push({ text: text.slice(last, m.index) + m[1], at: false });
    out.push({ text: `@${m[2]}`, at: true });
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  out.push({ text: text.slice(last), at: false });
  return out.filter((p) => p.text !== '');
}

function Body({ body }: { body: RowView['body'] }): ReactNode {
  if (!body) return null;
  const cls = 'text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2'
    + (body.medium ? ' font-medium' : '');
  if (!body.mention) return <div className={cls}>{body.text}</div>;
  return (
    <div className={cls}>
      {mentionParts(body.text).map((p, i) => (p.at
        ? <span key={i} className="text-violet-400 font-medium">{p.text}</span>
        : <span key={i}>{p.text}</span>))}
    </div>
  );
}

function Meta({ view }: { view: RowView }): ReactNode {
  const nodes: ReactNode[] = [<UnreadDot key="dot" unread={view.unread} />];
  if (view.icon) nodes.push(<span key="icon" aria-hidden="true">{view.icon}</span>);
  view.segments.forEach((s, i) => {
    if (s.t === 'who') {
      nodes.push(
        <span key={`s${i}`} className="font-medium text-zinc-800 dark:text-zinc-200">
          {`@${s.v}`}
        </span>,
      );
    } else if (s.t === 'strong') {
      nodes.push(
        <span key={`s${i}`} className="font-medium text-zinc-700 dark:text-zinc-300">{s.v}</span>,
      );
    } else {
      nodes.push(<span key={`s${i}`}>{s.v}</span>);
    }
  });
  nodes.push(<span key="time" className="text-zinc-500">{`· ${view.time}`}</span>);
  // The flex rows space themselves with `gap-1`; the mention/reply row is
  // ordinary inline flow, where the source newlines used to supply the space.
  const spaced = view.metaFlex
    ? nodes
    : nodes.flatMap((n, i) => (i === 0 ? [n] : [' ', n]));
  return <div className={metaClass(view)}>{spaced}</div>;
}

/**
 * One leaf row. Clicking marks it read and routes (see
 * `Notifications._onItemClick`); on touch it also carries the kit's
 * swipe-to-mark-read tray, which only makes sense while it is unread.
 */
function Row({ view, touch }: { view: RowView; touch: boolean }): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const ui = kit();
    if (!touch || !el || !ui?.swipeActions || !view.unread) return;
    ui.swipeActions(el, {
      actions: [{
        label: 'Mark read',
        handler: () => {
          const N = controller();
          N?._markOneRead(view.id);
          N?._renderList();
        },
      }],
    });
  }, [touch, view.id, view.unread]);

  return (
    <button
      ref={ref}
      data-notif-id={view.id}
      className={`${ROW_CLASS} ${view.unreadCls}`}
      onClick={(e) => {
        e.stopPropagation();
        controller()?._onItemClick(view.id);
      }}
    >
      <Meta view={view} />
      <Body body={view.body} />
    </button>
  );
}

/** The collapsed/expanded app header, plus its leaves when expanded. */
function Group({ view, touch }: { view: GroupView; touch: boolean }): ReactNode {
  return (
    <>
      <div className={`flex items-stretch border-b border-zinc-200 dark:border-zinc-800 ${view.accent}`}>
        <button
          data-group-toggle={view.key}
          aria-expanded={view.expanded}
          className="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            controller()?._toggleGroup(view.key);
          }}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <span aria-hidden="true" className="text-zinc-400 dark:text-zinc-500">{view.chevron}</span>
            {view.hasUnread ? <UnreadDot unread={true} /> : null}
            <span className="font-medium text-zinc-800 dark:text-zinc-200 truncate">{view.appName}</span>
            {/*
                Just the number, centered in a fixed-size pill (no "new"
                wording). Unread groups show the unread count in the violet
                accent pill; fully read groups show the total in a muted one.
            */}
            {view.hasUnread ? (
              <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[0.65rem] font-bold leading-none text-white bg-violet-500 rounded-full">
                {view.count}
              </span>
            ) : (
              <span className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 text-[0.65rem] font-medium leading-none text-zinc-500 dark:text-zinc-400 bg-zinc-200 dark:bg-zinc-800 rounded-full">
                {view.count}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 truncate pl-5">{view.preview}</div>
        </button>
        {view.hasUnread ? (
          <button
            data-group-markread={view.key}
            data-app-id={view.appId}
            className="shrink-0 text-[0.7rem] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 px-1.5 py-1"
            onClick={(e) => {
              e.stopPropagation();
              controller()?._markGroupRead(view.key, view.appId);
            }}
          >
            Mark read
          </button>
        ) : null}
      </div>
      {view.expanded ? (
        <div className="pl-2 bg-zinc-50/50 dark:bg-zinc-950/30">
          {view.leaves.map((leaf) => <Row key={leaf.id} view={leaf} touch={touch} />)}
          {view.more ? (
            <button
              data-group-showmore={view.more.key}
              className="w-full text-left px-3 py-2 text-xs text-violet-500 hover:text-violet-400 border-b border-zinc-200 dark:border-zinc-800"
              onClick={(e) => {
                e.stopPropagation();
                controller()?._showMoreGroup(view.more!.key);
              }}
            >
              {view.more.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * One pinned invite. On touch the whole row is also a swipe target, with the
 * same two actions the buttons carry — the buttons stay for desktop and as the
 * tap path everywhere.
 */
function Invite({ view, touch }: { view: InviteView; touch: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const ui = kit();
    if (!touch || !el || !ui?.swipeActions) return;
    ui.swipeActions(el, {
      actions: [
        {
          label: 'Accept',
          handler: () => controller()?._acceptInvite(view.appId, view.slug, view.kind),
        },
        {
          label: 'Decline',
          destructive: true,
          handler: () => controller()?._declineInvite(view.appId, view.kind),
        },
      ],
    });
  }, [touch, view.appId, view.slug, view.kind]);

  return (
    <div
      ref={ref}
      className="px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-violet-500/5 border-l-2 border-l-violet-500"
      data-invite-app={view.appId}
    >
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
        <span aria-hidden="true">{view.icon}</span>{' '}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{view.who}</span>{' '}
        {view.verb}{' '}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{view.appName}</span>{' '}
        <span className="text-zinc-500">{`· ${view.time}`}</span>
      </div>
      <div className="flex gap-2">
        <Button
          data-invite-accept={view.appId}
          data-invite-slug={view.slug}
          data-invite-kind={view.kind}
          variant="pill"
          size="xsText"
          onClick={(e) => {
            e.stopPropagation();
            controller()?._acceptInvite(view.appId, view.slug, view.kind);
          }}
        >
          Accept
        </Button>
        <button
          data-invite-decline={view.appId}
          data-invite-kind={view.kind}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            controller()?._declineInvite(view.appId, view.kind);
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}

const DIVIDER = <div role="separator" className="border-t-2 border-zinc-200 dark:border-zinc-700"></div>;

export function NotificationsBody(): ReactNode {
  const state = useStoreState(notificationsStore) as {
    invites: InviteView[] | null;
    list: Entry[] | null;
    empty: boolean;
    touch: boolean;
  };
  const invites = state.invites || [];
  const entries = state.list || [];

  return (
    <>
      {/*
          Pinned collaborator-invites section: rendered above the grouped
          notification list, driven by the authoritative pendingInvites
          payload (see ./notifications.js _renderInvites).
      */}
      <div id="notifications-invites" className="shrink-0 overflow-y-auto max-h-48">
        {invites.length ? (
          <div className="px-3 py-1.5 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
            Invites
          </div>
        ) : null}
        {invites.map((inv) => (
          <Invite key={`${inv.kind}:${inv.appId}`} view={inv} touch={state.touch} />
        ))}
      </div>
      <div id="notifications-list" className="flex-1 overflow-y-auto">
        {entries.map((entry, i) => (
          <div key={entry.type === 'row' ? `r${entry.row.id}` : `g${entry.group.key}`}>
            {i > 0 ? DIVIDER : null}
            {entry.type === 'row'
              ? <Row view={entry.row} touch={state.touch} />
              : <Group view={entry.group} touch={state.touch} />}
          </div>
        ))}
      </div>
      <div
        id="notifications-empty"
        className={state.empty
          ? 'px-4 py-6 text-sm text-zinc-500 text-center'
          : 'hidden px-4 py-6 text-sm text-zinc-500 text-center'}
      >
        You'll get pinged here when someone proposes a change to an app you use.
      </div>
    </>
  );
}
