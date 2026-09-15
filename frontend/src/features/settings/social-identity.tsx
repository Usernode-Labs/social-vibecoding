/**
 * `#github-link-body` — the social-account ownership proofs and the daily
 * credit tier, as the only React writer below that host.
 *
 * settings.js keeps the fetch, the unlink DELETE, the `?demo=` variants and
 * the callback status line (a sibling); every branch that decides WHAT this
 * says is resolved there, in ./social-identity-store.js's shape. This file
 * spells it as markup, class string for class string.
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
import { Switch } from '@/components/ui/switch';

import { useStoreState } from '../../lib/use-store-state';
import { socialIdentityStore } from './social-identity-store.js';
import { openNativeSocialConnect, watchSocialConnectReturn } from './native-social-connect.js';

type TierCardView = { title: string; detail: string; tone: 'plain' | 'warn' | 'ok' };

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
  /** #1557 — the row's own state, as a pill. `null` when not connected. */
  badge: { text: string; tone: 'emerald' | 'amber' } | null;
  state: { text: string; tone: 'amber' | 'emerald' | 'muted' };
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

const TIER_TONE = {
  plain: '',
  warn: ' border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20',
  ok: ' border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20',
};

/**
 * The Connect control's surface, shared by BOTH spellings of it.
 *
 * The live one is an `<a href>` — normal browsers navigate directly, while
 * native taps open the system browser — and its ?demo= twin is a disabled `<button>`, because a
 * fixture must not navigate out of itself. They have to render identically,
 * and `@/components/ui/button` cannot spell an anchor (this install is
 * hand-rolled and has no `asChild`), so routing the button through the
 * primitive would leave the pair written two different ways and free to drift.
 * One constant instead, and this file is on
 * tests/shell-primitive-adoption.test.js's allow-list for exactly that reason.
 */
const CONNECT_SURFACE =
  'rounded-md bg-violet-600 px-2 py-1 text-xs font-medium text-white inline-flex min-h-[36px] items-center justify-center';
const SECONDARY_ACTION_SURFACE =
  'rounded-md bg-zinc-200 dark:bg-zinc-700 px-2 py-1 text-xs font-medium text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors inline-flex min-h-[36px] items-center justify-center';

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

function TierCard({ tier }: { tier: TierCardView }) {
  return (
    <div
      className={`rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 mb-3${TIER_TONE[tier.tone]}`}
    >
      <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{tier.title}</div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{tier.detail}</div>
    </div>
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
      className="text-xs text-zinc-500 dark:text-zinc-500 mt-2"
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

  return (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 sm:flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">
              {row.heading}
            </div>
            {row.badge ? (
              <span
                id={`${row.provider}-link-badge`}
                className={`${BADGE_BASE} ${BADGE_TONE[row.badge.tone]}`}
              >
                {row.badge.text}
              </span>
            ) : null}
          </div>
          <div className={`text-xs mt-1 ${STATE_TONE[row.state.tone]}`}>{row.state.text}</div>
          {row.linkedAt ? (
            <div className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">{row.linkedAt}</div>
          ) : null}
          {row.noToken ? (
            <div
              {...(row.provider === 'github' ? { id: 'github-link-no-token' } : null)}
              className="text-xs text-zinc-500 dark:text-zinc-400 mt-1"
            >
              {row.noToken}
            </div>
          ) : null}
          {row.visibility ? (
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer select-none">
              <Switch
                id={`${row.provider}-profile-visible`}
                checked={publicVisible}
                disabled={row.visibility.disabled || busy === 'visibility'}
                onChange={(e) => { void changeVisibility(e.currentTarget.checked); }}
              />
              Show on public profile
            </label>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 sm:max-w-[17rem] sm:shrink-0 sm:justify-end">
          {oauthAction(row.connect, true)}
          {oauthAction(row.refresh)}
          {oauthAction(row.replace, true)}
          {row.unlink ? (
            <button
              type="button"
              disabled={row.unlink.disabled}
              className="rounded-md border border-red-400 dark:border-red-700 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50 transition-colors"
              onClick={(e) => {
                if (row.unlink?.disabled) return;
                controller()?._unlinkGithub?.(e.currentTarget, row.provider);
              }}
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </div>

      {row.pendingReplacement ? (
        <section
          id={`${row.provider}-replacement-confirmation`}
          aria-label={`Confirm ${row.name} account replacement`}
          className="mt-3 rounded-lg border border-violet-300 dark:border-violet-800 bg-white dark:bg-zinc-900 p-3"
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
        <p role="status" className={`text-xs mt-2 ${actionFailed ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
          {actionStatus}
        </p>
      ) : null}
      <AuditNote provider={row.provider} />
      {/*
          A provider that rejects our callback address errors on its own page
          and never redirects back, so the only trace of that failure is the
          stranded attempt the server spotted (#1291).
      */}
      {row.strandedNote ? (
        <p
          id={`${row.provider}-link-pending-note`}
          className="text-xs text-amber-800 dark:text-amber-400 mt-2"
        >
          {row.strandedNote}
        </p>
      ) : null}
      {row.diagnostics ? <Diagnostics view={row.diagnostics} /> : null}
    </div>
  );
}

export function SocialIdentityView({ phase, message, tier, providers }: SocialIdentityState) {
  if (phase === 'idle') return null;
  // Bare text nodes, as the two `body.textContent = …` writes produced.
  if (phase === 'loading' || phase === 'error') return <>{message}</>;
  return (
    <>
      {tier ? <TierCard tier={tier} /> : null}
      {providers.map((row) => <ProviderRow key={row.provider} row={row} />)}
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
