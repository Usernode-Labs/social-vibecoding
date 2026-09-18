/**
 * `#github-link-body` — the social-account ownership proofs and the daily
 * credit tier, as the only React writer below that host.
 *
 * settings.js keeps the fetch, the unlink DELETE, the `?demo=` variants and
 * the callback status line (a sibling); every branch that decides WHAT this
 * says is resolved there, in ./social-identity-store.js's shape. This file
 * spells it as markup.
 *
 * ── One list, not a card over two cards (#2370) ──────────────────────
 *
 * This was a tier card ("Layer 1 locked · $0/day" and a sentence about what
 * would unlock it) above one bordered card per provider, each carrying up to
 * five lines and four buttons whether or not the account was connected. On a
 * phone that was a screen of reading before the first Connect.
 *
 * It is ONE grouped list now, in the card language the sibling settings panes
 * already wear (sections/api-key.tsx, password.tsx): the first row is where
 * you stand, and each row under it is a thing that changes the figure — so the
 * relationship the sentence described is the layout. Three row shapes:
 *
 *   * NOT CONNECTED — the whole row is the Connect control (`ListRow as="a"`),
 *     a full-width tap target. "Connect" is a `<span>` inside it, an affordance
 *     rather than a nested control: an interactive inside an anchor is invalid
 *     markup and a second tab stop for one action.
 *   * CONNECTED — the row is a `<details>` summary. Its whole width opens the
 *     manage panel (visibility, refresh, change account, disconnect). Nothing
 *     destructive is ever one stray thumb away: Disconnect is inside.
 *   * NOT SET UP on this server — a row that is only read.
 *
 * What needs a decision or reports a failure is NOT folded away: the
 * replacement confirmation, the stranded-attempt note and the action status
 * render open under their row. dapp.json asserts two of them as visible text.
 *
 * ── Local interaction state ──────────────────────────────────────────
 *
 * The Copy control's "Copied" flash and the configuration check's
 * in-flight/verdict line were local variables closed over by a listener,
 * mutating `textContent` and `className` on nodes the same closure had
 * created. They are `useState` here, which is allowed for exactly the reason
 * AGENTS.md gives: nothing outside React writes anywhere in this subtree, so
 * the region may hold state.
 * Native Connect launch feedback also stays here. The system browser owns
 * OAuth; the app reloads its account status when it returns to the foreground.
 *
 * ── The check posts to `/x/check`, for either provider ────────────────
 *
 * That is the shipped behaviour, not a slip in the port: the endpoint exists
 * for X's credential pair, and the diagnostics panel is only ever served for a
 * provider whose OAuth setup can fail invisibly on its own page (#1291).
 * Preserved verbatim; changing it would be a behaviour change wearing a
 * renderer swap's clothes.
 */

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { CheckIcon, ChevronRightIcon } from '@/components/ui/icons';
import { Switch } from '@/components/ui/switch';

import { useStoreState } from '../../lib/use-store-state';
import { socialIdentityStore } from './social-identity-store.js';
import { openNativeSocialConnect, watchSocialConnectReturn } from './native-social-connect.js';

type TierCardView = {
  title: string;
  /** The figure, or `null` where there honestly is none to show. */
  amount: string | null;
  /** One sentence under the list. */
  note: string | null;
  done: boolean;
  /** `warn` is the one state reporting a fault: credits could not be checked. */
  tone: 'plain' | 'warn';
};

type DiagnosticsView = {
  source: string;
  callbackUrl: string;
  warning: string;
  demo: boolean;
  name: string;
  provider: string;
};

type OAuthIntent = 'connect' | 'refresh' | 'replace';
type OAuthActionView = { label: string; href: string | null; intent: OAuthIntent };

type ProviderRowView = {
  provider: 'github' | 'x';
  name: string;
  heading: string;
  /** `@name` once connected — the row's second line leads with it. */
  handle?: string | null;
  /** #1557 — the row's own state, as a pill. `null` when not connected. */
  badge: { text: string; tone: 'emerald' | 'amber' } | null;
  state: { text: string; tone: 'amber' | 'emerald' | 'muted' };
  /** Ticked once this row counts; an empty ring while it is still to do. */
  done?: boolean;
  /** The row's figure on the credit ladder; `null` off it. See settings.js. */
  amount?: string | null;
  linkedAt: string | null;
  noToken: string | null;
  /** `href: null` is the ?demo= variant — a disabled button, not a link. */
  connect: OAuthActionView | null;
  refresh: OAuthActionView | null;
  replace: OAuthActionView | null;
  visibility: { checked: boolean; disabled: boolean } | null;
  pendingReplacement: {
    currentHandle: string;
    replacementHandle: string;
    expiresAt: string | null;
    disabled: boolean;
  } | null;
  unlink: { disabled: boolean } | null;
  strandedNote: string | null;
  diagnostics: DiagnosticsView | null;
};

type SocialIdentityState = {
  phase: 'idle' | 'loading' | 'error' | 'ready';
  message: string | null;
  tier: TierCardView | null;
  providers: ProviderRowView[];
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

async function refreshIdentitySurfaces() {
  const settings = controller();
  if (settings?._refreshSocialIdentitySurfaces) {
    await settings._refreshSocialIdentitySurfaces();
    return;
  }
  await settings?._loadGithubLink?.();
}

/**
 * The primary OAuth control's surface, shared by BOTH spellings of it.
 *
 * The live one is an `<a href>` — normal browsers navigate directly, while
 * native taps open the system browser — and its ?demo= twin is a disabled `<button>`, because a
 * fixture must not navigate out of itself. They have to render identically,
 * and `@/components/ui/button` cannot spell an anchor (this install is
 * hand-rolled and has no `asChild`), so routing the button through the
 * primitive would leave the pair written two different ways and free to drift.
 * One constant instead, and this file is on
 * tests/shell-primitive-adoption.test.js's allow-list for exactly that reason.
 *
 * #2370: a NOT-connected row no longer uses this — the row itself is the
 * control there, and `ListRow` spells the anchor and the button from one
 * component. What is left is Reconnect, inside a connected row's panel.
 */
const CONNECT_SURFACE =
  'inline-flex min-h-[44px] items-center justify-center rounded-full bg-violet-600 px-4 text-[0.9375rem] font-semibold text-white';
const SECONDARY_ACTION_SURFACE =
  'inline-flex min-h-[44px] items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-4 text-[0.9375rem] font-medium text-zinc-900 dark:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors';
const DESTRUCTIVE_ACTION_SURFACE =
  'inline-flex min-h-[44px] items-center justify-center rounded-full bg-red-500/10 px-4 text-[0.9375rem] font-medium text-red-700 dark:text-red-400 hover:bg-red-500/15 disabled:opacity-50 transition-colors';

/**
 * "Connect", as it sits on the trailing edge of a not-connected row. A
 * `<span>`: the ROW is the control (see the header), and this is what tells a
 * thumb the row does something. Tinted rather than filled — two filled pills
 * stacked in one list shout over the figures they sit beside.
 */
const CONNECT_PILL =
  'inline-flex h-[30px] shrink-0 items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-3.5 text-[0.875rem] font-semibold text-violet-700 dark:text-violet-400';

const STATE_TONE = {
  amber: 'text-amber-800 dark:text-amber-400',
  emerald: 'text-emerald-700 dark:text-emerald-400',
  muted: 'text-zinc-500 dark:text-zinc-400',
};

/*
 * #1557: the connected badge, in the platform's read-only pill shape.
 *
 * A `<span>`, not @/components/ui/chip: that component is a
 * `<button aria-pressed>` for filter toggles, and announcing a status as a
 * pressed button is wrong for anyone on a screen reader. Same reasoning, and
 * the same class run, as the stage-2 survey's verified pill.
 *
 * Whole class strings, because Tailwind's extractor is a regex over source
 * text and a tint assembled at runtime never compiles.
 */
const BADGE_BASE =
  'shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-medium';
const BADGE_TONE = {
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  amber: 'bg-amber-500/10 text-amber-800 dark:text-amber-400',
};

/** A row's leading mark: ticked once it counts, a ring while it is to do. */
function Mark({ done }: { done: boolean }) {
  return done ? (
    <span
      aria-hidden="true"
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-violet-600 text-white"
    >
      <CheckIcon className="h-3.5 w-3.5" strokeWidth="3" />
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="h-[22px] w-[22px] shrink-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600"
    />
  );
}

/*
 * What every row of this list passes to ListRow.
 *
 *   * `gap-3 py-2.5` over the primitive's `gap-4 py-3.5`: those are tuned for
 *     a 2.75rem icon tile. A 22px mark sits too far from its title at that
 *     gap, and three two-line rows at that padding cost a phone 24px for
 *     nothing. The row is still 68px — well over a 44px target.
 *   * `inset="none"`: three short rows read as one checklist, and a hairline
 *     under each would make them three records.
 *   * a medium title: ListRow bolds for rows whose title is a SUBJECT with a
 *     subtitle under it (a conversation, an app). These are settings rows —
 *     the same call settings-nav.tsx makes.
 *   * the subtitle wraps. The primitive truncates, which is right for a
 *     timestamp and wrong for the one sentence that says why a legacy link
 *     needs reconnecting.
 */
const ROW_CLASS = 'gap-3 py-2.5';
const ROW_TITLE = 'font-medium';
const ROW_SUBTITLE = 'whitespace-normal tabular-nums';

/** The first row: where this account stands today. Read, never tapped. */
function TierRow({ tier }: { tier: TierCardView }) {
  return (
    <ListRow
      className={ROW_CLASS}
      inset="none"
      chevron={false}
      leading={<Mark done={tier.done} />}
      title={tier.title}
      titleClassName={tier.tone === 'warn' ? `${ROW_TITLE} ${STATE_TONE.amber}` : ROW_TITLE}
      subtitle={tier.amount}
      subtitleClassName={ROW_SUBTITLE}
    />
  );
}

/**
 * "Don't take our word for it": the provider's own page lists what every
 * authorized OAuth app can reach, so the claim above is checkable in one
 * click. Deliberately a top-level link (`target=_blank` + `noopener`) — the
 * shell is framed, and neither provider allows being framed.
 */
function AuditNote({ provider }: { provider: 'github' | 'x' }) {
  const href = provider === 'github'
    ? 'https://github.com/settings/applications'
    : 'https://x.com/settings/connected_apps';
  const label = provider === 'github'
    ? 'github.com/settings/applications'
    : 'x.com/settings/connected_apps';
  return (
    <p
      {...(provider === 'github' ? { id: 'github-link-audit-note' } : null)}
      className="mt-1 text-[0.8125rem] text-zinc-500 dark:text-zinc-500"
    >
      {'Review or revoke this authorization at '}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-violet-700 dark:text-violet-400 hover:underline"
      >
        {label}
      </a>
      .
    </p>
  );
}

/**
 * The admin-only configuration panel for a provider whose OAuth setup can fail
 * invisibly on the provider's own page (#1291): the credential pair in use,
 * the exact callback URL the developer app must register, and a live check of
 * the pair against the token endpoint.
 */
function Diagnostics({ view }: { view: DiagnosticsView }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<{ tone: string; text: string } | null>(null);

  return (
    <div
      id={`${view.provider}-link-diagnostics`}
      className="mt-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-2.5 py-2 text-xs"
    >
      <div className="font-medium text-zinc-700 dark:text-zinc-300">{view.source}</div>
      <div className="mt-1 flex items-center gap-2 min-w-0">
        <span className="text-zinc-500 dark:text-zinc-400 shrink-0">Callback URI:</span>
        <code className="truncate text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 rounded px-1 py-0.5">
          {view.callbackUrl}
        </code>
        <button
          type="button"
          className="shrink-0 rounded border border-zinc-300 dark:border-zinc-600 px-1.5 py-0.5 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(view.callbackUrl || '');
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch { /* clipboard unavailable — the address is still visible */ }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-1 text-zinc-500 dark:text-zinc-400">{view.warning}</p>
      <div className="mt-2 flex items-start gap-2">
        <button
          type="button"
          id={`${view.provider}-link-check`}
          disabled={checking}
          className="shrink-0 rounded-md border border-violet-400 dark:border-violet-700 px-2 py-1 font-medium text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950 disabled:opacity-50 transition-colors"
          onClick={async () => {
            setChecking(true);
            setVerdict({ tone: 'text-zinc-500 dark:text-zinc-400', text: 'Checking…' });
            try {
              let answer;
              if (view.demo) {
                answer = { clientAuth: 'ok' };
              } else {
                const response = await fetch('/api/me/social-identities/x/check', {
                  method: 'POST',
                  credentials: 'same-origin',
                  cache: 'no-store',
                });
                if (!response.ok) throw new Error(`Check failed (${response.status})`);
                answer = await response.json();
              }
              if (answer.clientAuth === 'ok') {
                setVerdict({
                  tone: 'text-emerald-700 dark:text-emerald-400',
                  text: `${view.name} accepted the platform’s client credentials. `
                    + `If connecting still fails on ${view.name}’s own page, the callback address above `
                    + `is not registered on the ${view.name} app.`,
                });
              } else if (answer.clientAuth === 'rejected') {
                setVerdict({
                  tone: 'text-red-700 dark:text-red-400',
                  text: `${view.name} rejected the platform’s client ID or secret. `
                    + 'the configured credential pair is wrong.',
                });
              } else {
                setVerdict({
                  tone: 'text-amber-800 dark:text-amber-400',
                  text: `Couldn’t reach ${view.name} to verify the credentials. Try again shortly.`,
                });
              }
            } catch {
              setVerdict({
                tone: 'text-red-700 dark:text-red-400',
                text: 'The configuration check failed to run. Try again shortly.',
              });
            } finally {
              setChecking(false);
            }
          }}
        >
          Run configuration check
        </button>
        <span className={`${verdict ? verdict.tone : 'text-zinc-500 dark:text-zinc-400'} pt-1`}>
          {verdict ? verdict.text : null}
        </span>
      </div>
    </div>
  );
}

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return typeof body?.message === 'string' ? body.message : fallback;
  } catch {
    return fallback;
  }
}

function ProviderRow({ row }: { row: ProviderRowView }) {
  const opening = useRef(false);
  const [actionStatus, setActionStatus] = useState('');
  const [actionFailed, setActionFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [publicVisible, setPublicVisible] = useState(row.visibility?.checked ?? false);
  const [replacementVisible, setReplacementVisible] = useState(row.visibility?.checked ?? true);

  useEffect(() => {
    setPublicVisible(row.visibility?.checked ?? false);
  }, [row.visibility?.checked]);
  useEffect(() => {
    setReplacementVisible(row.visibility?.checked ?? true);
  }, [row.pendingReplacement?.replacementHandle, row.visibility?.checked]);

  const launch = async (
    e: React.MouseEvent<HTMLAnchorElement>, action: OAuthActionView
  ) => {
    const bridge = (window as any).usernode;
    if (!bridge?.isNative) return;
    e.preventDefault();
    if (opening.current) return;
    opening.current = true;
    setActionFailed(false);
    setActionStatus('Opening your browser…');
    try {
      await openNativeSocialConnect({
        bridge,
        provider: row.provider,
        intent: action.intent,
        accountId: (window as any).App?.user?.id,
        origin: window.location.origin,
      });
      setActionStatus(
        `Finish ${action.intent === 'connect' ? 'connecting' : 'verification'} in your browser, `
        + 'then return to the app. Sign in with the same Homeroom account if asked.'
      );
    } catch (err) {
      setActionFailed(true);
      setActionStatus((err as Error).message);
    } finally {
      opening.current = false;
    }
  };

  const oauthAction = (action: OAuthActionView | null, primary = false) => {
    if (!action) return null;
    const classes = primary
      ? `${CONNECT_SURFACE} hover:bg-violet-500 transition-colors`
      : SECONDARY_ACTION_SURFACE;
    return action.href ? (
      <a href={action.href} className={classes} onClick={(e) => { void launch(e, action); }}>
        {action.label}
      </a>
    ) : (
      <button type="button" disabled className={`${classes} opacity-50`}>
        {action.label}
      </button>
    );
  };

  const changeVisibility = async (next: boolean) => {
    const previous = publicVisible;
    setPublicVisible(next);
    setBusy('visibility');
    setActionFailed(false);
    setActionStatus('Saving profile visibility…');
    try {
      const response = await fetch(
        `/api/me/social-identities/${encodeURIComponent(row.provider)}/visibility`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ publicVisible: next }),
        }
      );
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Could not change profile visibility.'));
      }
      await refreshIdentitySurfaces();
      setActionStatus(next ? 'Shown on your public profile.' : 'Hidden from your public profile.');
    } catch (err) {
      setPublicVisible(previous);
      setActionFailed(true);
      setActionStatus((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const confirmReplacement = async () => {
    setBusy('replace');
    setActionFailed(false);
    setActionStatus('Replacing account…');
    try {
      const response = await fetch(
        `/api/me/social-identities/${encodeURIComponent(row.provider)}/replacement`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ publicVisible: replacementVisible }),
        }
      );
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Could not replace this account.'));
      }
      await refreshIdentitySurfaces();
      setActionStatus(`${row.name} account replaced.`);
    } catch (err) {
      setActionFailed(true);
      setActionStatus((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  const cancelReplacement = async () => {
    setBusy('cancel');
    setActionFailed(false);
    try {
      const response = await fetch(
        `/api/me/social-identities/${encodeURIComponent(row.provider)}/replacement`,
        { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' }
      );
      if (!response.ok) {
        throw new Error(await errorMessage(response, 'Could not cancel this replacement.'));
      }
      await refreshIdentitySurfaces();
      setActionStatus(`No changes made. @${row.pendingReplacement?.currentHandle} is still connected.`);
    } catch (err) {
      setActionFailed(true);
      setActionStatus((err as Error).message);
    } finally {
      setBusy('');
    }
  };

  // The second line: who, then what it is worth. A middle dot joins them only
  // when both halves exist. An AMBER state is a sentence, not a figure — it
  // explains a legacy link that needs one reconnect — so on a connected row it
  // is the first line of the panel (which arrives open) rather than three
  // wrapped lines squeezed beside the badge.
  const linked = !!(row.unlink || row.visibility || row.refresh || row.replace);
  const panelNote = linked && row.state.tone === 'amber' ? row.state.text : '';
  const detail = panelNote ? '' : (row.state.text || row.amount || '');
  const subtitle = [row.handle, detail].filter(Boolean).join(' · ') || null;
  const subtitleClass = `${ROW_SUBTITLE} ${STATE_TONE[detail && row.state.text ? row.state.tone : 'muted']}`;
  // #1557's badge rides the TITLE line, where the old card had it: the title
  // is one word now, so there is room, and the second line keeps its width.
  const title = row.badge ? (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate">{row.heading}</span>
      <span
        id={`${row.provider}-link-badge`}
        className={`${BADGE_BASE} ${BADGE_TONE[row.badge.tone]}`}
      >
        {row.badge.text}
      </span>
    </span>
  ) : row.heading;

  let head;
  if (linked) {
    // A connected row. The summary is the row, so its whole width opens the
    // panel; a link that needs a reconnect, or a replacement waiting on a
    // decision, arrives open because the thing to do is inside.
    head = (
      <details className="group" open={!!(row.connect || row.pendingReplacement) || undefined}>
        <summary className="list-none cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800">
          <ListRow
            className={ROW_CLASS}
            inset="none"
            chevron={false}
            leading={<Mark done={!!row.done} />}
            title={title}
            titleClassName={ROW_TITLE}
            subtitle={subtitle}
            subtitleClassName={subtitleClass}
            trailing={(
              <ChevronRightIcon
                aria-hidden="true"
                className="h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600 transition-transform group-open:rotate-90"
              />
            )}
          />
        </summary>
        <div className="px-4 pb-4 pl-[3.125rem]">
          {panelNote ? (
            <p className={`mb-3 text-[0.9375rem] ${STATE_TONE.amber}`}>{panelNote}</p>
          ) : null}
          {row.visibility ? (
            <label className="flex min-h-[44px] items-center justify-between gap-3 text-[0.9375rem] text-zinc-900 dark:text-zinc-100 cursor-pointer select-none">
              Show on public profile
              <Switch
                id={`${row.provider}-profile-visible`}
                checked={publicVisible}
                disabled={row.visibility.disabled || busy === 'visibility'}
                onChange={(e) => { void changeVisibility(e.currentTarget.checked); }}
              />
            </label>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {oauthAction(row.connect, true)}
            {oauthAction(row.refresh)}
            {oauthAction(row.replace)}
            {row.unlink ? (
              <button
                type="button"
                disabled={row.unlink.disabled}
                className={DESTRUCTIVE_ACTION_SURFACE}
                onClick={(e) => {
                  if (row.unlink?.disabled) return;
                  controller()?._unlinkGithub?.(e.currentTarget, row.provider);
                }}
              >
                Disconnect
              </button>
            ) : null}
          </div>
          {row.linkedAt ? (
            <div className="mt-3 text-[0.8125rem] text-zinc-500 dark:text-zinc-500">{row.linkedAt}</div>
          ) : null}
          {row.noToken ? (
            <div
              {...(row.provider === 'github' ? { id: 'github-link-no-token' } : null)}
              className="mt-1 text-[0.8125rem] text-zinc-500 dark:text-zinc-400"
            >
              {row.noToken}
            </div>
          ) : null}
          <AuditNote provider={row.provider} />
        </div>
      </details>
    );
  } else if (row.connect) {
    // Not connected: the row IS the control. The live one is an anchor — the
    // OAuth flow is a top-level navigation — and its ?demo= twin a disabled
    // button, because a fixture must not navigate out of itself. ListRow
    // spells both from one component, so the pair cannot drift apart.
    const action = row.connect;
    const shared = {
      className: ROW_CLASS,
      inset: 'none' as const,
      chevron: false,
      leading: <Mark done={false} />,
      title: row.heading,
      titleClassName: ROW_TITLE,
      subtitle,
      subtitleClassName: subtitleClass,
      // The ?demo= twin dims the PILL, not the row: the fixture is inert, and
      // the title and figure it exists to show should stay at full strength.
      trailing: (
        <span className={action.href ? CONNECT_PILL : `${CONNECT_PILL} opacity-50`}>{action.label}</span>
      ),
    };
    head = action.href ? (
      <ListRow
        as="a"
        href={action.href}
        onClick={(e) => { void launch(e as React.MouseEvent<HTMLAnchorElement>, action); }}
        {...shared}
      />
    ) : (
      <ListRow as="button" disabled {...shared} />
    );
  } else {
    head = (
      <ListRow
        className={ROW_CLASS}
        inset="none"
        chevron={false}
        leading={<Mark done={false} />}
        title={row.heading}
        titleClassName={ROW_TITLE}
        subtitle={subtitle}
        subtitleClassName={subtitleClass}
      />
    );
  }

  const notes = 'px-4 pb-3 pl-[3.125rem]';
  return (
    <div>
      {head}

      {row.pendingReplacement ? (
        <section
          id={`${row.provider}-replacement-confirmation`}
          aria-label={`Confirm ${row.name} account replacement`}
          className="mx-4 mb-4 rounded-xl border border-violet-300 dark:border-violet-800 bg-white dark:bg-zinc-900 p-3"
        >
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Replace {row.name} account?
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            The new account is verified. Nothing changes until you confirm.
          </p>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <div className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2.5 py-2 min-w-0">
              <div className="text-[0.65rem] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Current</div>
              <div className="text-sm font-medium truncate">@{row.pendingReplacement.currentHandle}</div>
            </div>
            <span aria-hidden="true" className="text-zinc-500 dark:text-zinc-400">→</span>
            <div className="rounded-md border border-violet-400 dark:border-violet-700 bg-violet-50 dark:bg-violet-950/30 px-2.5 py-2 min-w-0">
              <div className="text-[0.65rem] uppercase tracking-wide text-violet-700 dark:text-violet-300">Verified replacement</div>
              <div className="text-sm font-medium truncate">@{row.pendingReplacement.replacementHandle}</div>
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer select-none">
            <Switch
              id={`${row.provider}-replacement-visible`}
              checked={replacementVisible}
              disabled={row.pendingReplacement.disabled || !!busy}
              onChange={(e) => setReplacementVisible(e.currentTarget.checked)}
            />
            Show the replacement on my public profile
          </label>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Cancelling keeps @{row.pendingReplacement.currentHandle} connected with its current visibility.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              type="button"
              disabled={row.pendingReplacement.disabled || !!busy}
              variant="neutral"
              size="xsText"
              ink="neutral"
              disabledStyle="dim"
              className="min-h-[36px]"
              onClick={() => { void cancelReplacement(); }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={row.pendingReplacement.disabled || !!busy}
              variant="pill"
              size="xsText"
              disabledStyle="dim"
              className="min-h-[36px]"
              onClick={() => { void confirmReplacement(); }}
            >
              {busy === 'replace' ? 'Replacing…' : 'Replace account'}
            </Button>
          </div>
        </section>
      ) : null}

      {actionStatus ? (
        <p role="status" className={`${notes} text-[0.8125rem] ${actionFailed ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
          {actionStatus}
        </p>
      ) : null}
      {/*
          A provider that rejects our callback address errors on its own page
          and never redirects back, so the only trace of that failure is the
          stranded attempt the server spotted (#1291). Open, never folded: it
          is the one line that explains why Connect appeared to do nothing.
      */}
      {row.strandedNote ? (
        <p
          id={`${row.provider}-link-pending-note`}
          className={`${notes} text-[0.8125rem] text-amber-800 dark:text-amber-400`}
        >
          {row.strandedNote}
        </p>
      ) : null}
      {/*
          The admin-only configuration panel (#1291). The server attaches it for
          EVERY administrator on every load, not only when something is wrong,
          so it is folded by default — open, it was a permanent block of
          credentials prose inside the owner's own credit list. It arrives open
          when an attempt has stranded, which is the moment it is for. dapp.json
          asserts #x-link-check by selector, and a closed <details> keeps its
          body in the document.
      */}
      {row.diagnostics ? (
        <details className="group/diag px-4 pb-3 pl-[3.125rem]" open={!!row.strandedNote || undefined}>
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
            {`${row.name} setup · admins only`}
            <ChevronRightIcon
              aria-hidden="true"
              className="h-4 w-4 shrink-0 transition-transform group-open/diag:rotate-90"
            />
          </summary>
          <Diagnostics view={row.diagnostics} />
        </details>
      ) : null}
    </div>
  );
}

export function SocialIdentityView({ phase, message, tier, providers }: SocialIdentityState) {
  if (phase === 'idle') return null;
  // Bare text nodes, as the two `body.textContent = …` writes produced.
  if (phase === 'loading' || phase === 'error') return <>{message}</>;
  return (
    <>
      <h4 id="github-link-credits-label" className="px-4 text-[0.9375rem] font-normal text-zinc-500 dark:text-zinc-500">
        Daily credits
      </h4>
      <GroupedList className="mx-0 py-1.5" role="group" aria-labelledby="github-link-credits-label">
        {tier ? <TierRow tier={tier} /> : null}
        {providers.map((row) => <ProviderRow key={row.provider} row={row} />)}
      </GroupedList>
      {tier?.note ? (
        <p id="github-link-tier-note" className="px-4 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
          {tier.note}
        </p>
      ) : null}
    </>
  );
}

export function SocialIdentity() {
  useEffect(() => {
    if (!(window as any).usernode?.isNative) return;
    return watchSocialConnectReturn({
      win: window, doc: document,
      refresh: () => {
        if (document.querySelector('#settings-screen:not(.hidden)')) {
          return refreshIdentitySurfaces();
        }
      },
    });
  }, []);
  return <SocialIdentityView {...useStoreState<SocialIdentityState>(socialIdentityStore)} />;
}
