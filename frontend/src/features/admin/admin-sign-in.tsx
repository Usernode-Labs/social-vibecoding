'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { returnKeyHandler } from '../../lib/return-to-next';

// Sign-in providers (#admin/sign-in): Continue with Apple and Continue with
// Google on the sign-in sheet, beside the email code
// (src/services/sign-in-providers.js). Each provider is set up here with the
// keys from its developer console, and is offered only once it is complete
// and switched on.
//
// PERMISSIONS: visible to any admin; the fields, Save, Check and Remove are
// gated on AdminConsole.canWrite() (canAdminWrite), and the server enforces
// the same on PUT and POST /api/admin/sign-in-providers/:provider.
//
// SECRETS GO ONE WAY. Google's client secret and Apple's private key are
// sent once, kept encrypted, and never come back: the screen only says
// whether one is saved, and an empty field on Save keeps it.
//
// The callback address is text, not a link: it is for pasting into the
// provider's console, and an API-supplied URL is never rendered as an anchor.
//
// IN THE HOMEROOM APP the app signs in with its own Apple or Google sheet
// (NATIVE-BRIDGE.md, Native sign-in), whose ID tokens name the app, not the
// web client: its client IDs go in "App client IDs", and the app offers a
// provider only once they are saved beside a complete, switched-on setup.
//
// RETURN walks the single-line fields (#3907, the iOS keyboard's chevrons
// are gone). The private key and the app client IDs are textareas, where
// Return stays a new line; Save is still a press.

type Provider = 'apple' | 'google';
type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

interface ProviderView {
  provider: Provider; label: string;
  enabled: boolean; complete: boolean; offered: boolean; nativeOffered: boolean; missing: string[];
  clientId: string | null; teamId: string | null; keyId: string | null; appClientIds: string[];
  secretSaved: boolean; secretUnreadable: boolean;
  callbackUrl: string | null;
  updatedAt: string | null; updatedBy: string | null;
}
interface Payload { callbackOrigin: string | null; providers: ProviderView[] }

const LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const HELP = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';

const APP_IDS_HELP: Record<Provider, string> = {
  apple: 'The app\'s bundle ID (com.onhomeroom.app), with Sign in with Apple switched on for its App ID. One per line.',
  google: 'The app\'s iOS OAuth client ID. Android sign-ins carry the Client ID above, so it needs nothing here. One per line.',
};

const WHERE: Record<Provider, string> = {
  google: 'Google Cloud console → APIs & Services → Credentials: an OAuth client ID of type Web application. Add the address below as an Authorized redirect URI.',
  apple: 'Apple Developer → Certificates, Identifiers & Profiles: a Services ID with Sign in with Apple, whose Return URL is the address below and whose domain is its host; and a key with Sign in with Apple, whose .p8 file and Key ID go here.',
};

function badgeFor(p: ProviderView): { text: string; cls: string } {
  if (p.offered) return { text: 'Offered', cls: AdminUI.badge.success };
  if (p.enabled) return { text: 'On, not offered', cls: AdminUI.badge.warn };
  if (p.complete) return { text: 'Off', cls: AdminUI.badge.default };
  return { text: 'Not set up', cls: AdminUI.badge.default };
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return ''; }
}

async function sendJson(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function ProviderCard({ view, canWrite, onSaved }: {
  view: ProviderView; canWrite: boolean; onSaved: (next: Payload) => void;
}) {
  const id = `admin-sign-in-${view.provider}`;
  const [clientId, setClientId] = useState(view.clientId || '');
  const [teamId, setTeamId] = useState(view.teamId || '');
  const [keyId, setKeyId] = useState(view.keyId || '');
  const [appClientIds, setAppClientIds] = useState((view.appClientIds || []).join('\n'));
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(view.enabled);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // A save answers with the whole view; the card takes its saved values.
  useEffect(() => {
    setClientId(view.clientId || '');
    setTeamId(view.teamId || '');
    setKeyId(view.keyId || '');
    setAppClientIds((view.appClientIds || []).join('\n'));
    setEnabled(view.enabled);
  }, [view]);

  const apple = view.provider === 'apple';
  const dis = !canWrite || busy;
  const badge = badgeFor(view);

  const run = async (what: () => Promise<Status>) => {
    setStatus(null);
    setBusy(true);
    try {
      const next = await what();
      if (alive.current) setStatus(next);
    } catch (err: any) {
      if (alive.current) setStatus({ text: err.message, tone: 'err' });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = () => run(async () => {
    const body: Record<string, unknown> = { clientId, enabled, appClientIds };
    if (apple) { body.teamId = teamId; body.keyId = keyId; }
    if (secret.trim()) body.secret = secret;
    const next = await sendJson('PUT', `/api/admin/sign-in-providers/${view.provider}`, body);
    setSecret('');
    onSaved(next);
    const saved = (next.providers || []).find((p: ProviderView) => p.provider === view.provider);
    return {
      text: saved?.offered
        ? `Saved. The sign-in sheet offers Continue with ${view.label}${saved?.nativeOffered ? ', in the app too' : ''}.`
        : `Saved. Continue with ${view.label} is not offered${saved?.enabled ? ' yet' : ' while this is off'}.`,
      tone: 'ok',
    };
  });

  const check = () => run(async () => {
    const result = await sendJson('POST', `/api/admin/sign-in-providers/${view.provider}/check`);
    return { text: result.message || (result.ok ? 'OK.' : 'Not working.'), tone: result.ok ? 'ok' : 'err' };
  });

  const remove = () => run(async () => {
    const ok = await (window as any).AdminConsole?._confirm({
      title: `Remove ${view.label} sign-in?`,
      message: 'Its keys are deleted and the sign-in sheet stops offering it. People who signed '
        + 'in with it keep their accounts, and sign in with an email code instead.',
      confirmLabel: 'Remove',
    });
    if (!ok) return { text: 'Nothing was removed.', tone: 'ok' };
    const next = await sendJson('PUT', `/api/admin/sign-in-providers/${view.provider}`, { clear: true });
    setSecret('');
    onSaved(next);
    return { text: `Removed. ${view.label} sign-in is not set up.`, tone: 'ok' };
  });

  let source = '';
  if (view.updatedAt) {
    const who = view.updatedBy ? ` by @${view.updatedBy}` : '';
    source = `Last changed${who} on ${String(view.updatedAt).slice(0, 10)}.`;
  }
  const secretLabel = apple ? 'Private key (.p8)' : 'Client secret';
  const secretHint = view.secretUnreadable
    ? 'A secret is saved, but this server cannot read it. Paste it again.'
    : view.secretSaved ? 'Saved. Leave empty to keep it, or paste a new one to replace it.' : '';

  return (
    <div id={id} data-sign-in-provider={view.provider} className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>{view.label}</h2>
        <span id={`${id}-state`} className={badge.cls}>{badge.text}</span>
      </div>
      <p className={`${AdminUI.muted} mb-4`}>{WHERE[view.provider]}</p>

      <div className="space-y-4" onKeyDown={returnKeyHandler()}>
        <div>
          <p className={LABEL}>{apple ? 'Return URL' : 'Authorized redirect URI'}</p>
          {view.callbackUrl ? (
            <p className="mt-1 flex flex-wrap items-center gap-2">
              <code id={`${id}-callback`} className={`${AdminUI.kbd} select-all break-all`}>{view.callbackUrl}</code>
              {apple ? (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {'Domain: '}
                  <code className={`${AdminUI.kbd} select-all`}>{hostOf(view.callbackUrl)}</code>
                </span>
              ) : null}
            </p>
          ) : (
            <p className={HELP}>This server has no canonical origin, so there is no address to register.</p>
          )}
        </div>

        <label className="block" htmlFor={`${id}-client-id`}>
          <span className={LABEL}>{apple ? 'Services ID' : 'Client ID'}</span>
          <input
            id={`${id}-client-id`} type="text" autoComplete="off" spellCheck={false} enterKeyHint="next"
            className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
            placeholder={apple ? 'com.example.web' : '1234567890-abc.apps.googleusercontent.com'}
            disabled={dis} value={clientId} onChange={(e) => setClientId(e.target.value)}
          />
        </label>

        {apple ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block" htmlFor={`${id}-team-id`}>
              <span className={LABEL}>Team ID</span>
              <input
                id={`${id}-team-id`} type="text" autoComplete="off" spellCheck={false} maxLength={10} enterKeyHint="next"
                className={`${AdminUI.input} mt-1 font-mono uppercase disabled:opacity-60`}
                placeholder="ABCDE12345" disabled={dis} value={teamId} onChange={(e) => setTeamId(e.target.value)}
              />
            </label>
            <label className="block" htmlFor={`${id}-key-id`}>
              <span className={LABEL}>Key ID</span>
              <input
                id={`${id}-key-id`} type="text" autoComplete="off" spellCheck={false} maxLength={10} enterKeyHint="next"
                className={`${AdminUI.input} mt-1 font-mono uppercase disabled:opacity-60`}
                placeholder="XYZ9876543" disabled={dis} value={keyId} onChange={(e) => setKeyId(e.target.value)}
              />
            </label>
          </div>
        ) : null}

        <label className="block" htmlFor={`${id}-secret`}>
          <span className={LABEL}>{secretLabel}</span>
          {apple ? (
            <textarea
              id={`${id}-secret`} rows={4} autoComplete="off" spellCheck={false}
              className={`${AdminUI.textarea} mt-1 font-mono text-xs disabled:opacity-60`}
              placeholder={view.secretSaved ? 'Saved' : '-----BEGIN PRIVATE KEY-----'}
              disabled={dis} value={secret} onChange={(e) => setSecret(e.target.value)}
            />
          ) : (
            <input
              id={`${id}-secret`} type="password" autoComplete="new-password" spellCheck={false} enterKeyHint="next"
              className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
              placeholder={view.secretSaved ? 'Saved' : ''}
              disabled={dis} value={secret} onChange={(e) => setSecret(e.target.value)}
            />
          )}
          {secretHint ? <p id={`${id}-secret-hint`} className={HELP}>{secretHint}</p> : null}
        </label>

        <label className="block" htmlFor={`${id}-app-client-ids`}>
          <span className={LABEL}>App client IDs</span>
          <textarea
            id={`${id}-app-client-ids`} rows={2} autoComplete="off" spellCheck={false}
            className={`${AdminUI.textarea} mt-1 font-mono text-xs disabled:opacity-60`}
            placeholder={apple ? 'com.onhomeroom.app' : '1234567890-ios.apps.googleusercontent.com'}
            disabled={dis} value={appClientIds} onChange={(e) => setAppClientIds(e.target.value)}
          />
          <p className={HELP}>{APP_IDS_HELP[view.provider]}</p>
          <p id={`${id}-native`} className={HELP}>{view.nativeOffered
            ? `The Homeroom app offers Continue with ${view.label}, on builds that can show its sheet.`
            : `The Homeroom app does not offer Continue with ${view.label}.`}</p>
        </label>

        <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100" htmlFor={`${id}-enabled`}>
          <input
            id={`${id}-enabled`} type="checkbox"
            className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
            checked={enabled} disabled={dis}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{`Offer Continue with ${view.label} on the sign-in sheet`}</span>
        </label>
        {view.missing.length ? (
          <p id={`${id}-missing`} className={HELP}>{`Still needed before it can be offered: ${view.missing.join(', ')}.`}</p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{source}</p>
          {canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              {view.clientId || view.secretSaved ? (
                <button id={`${id}-remove`} type="button" className={AdminUI.btn.outlineSm} disabled={busy} onClick={remove}>Remove</button>
              ) : null}
              {view.complete ? (
                <button id={`${id}-check`} type="button" className={AdminUI.btn.outlineSm} disabled={busy} onClick={check}>{`Check with ${view.label}`}</button>
              ) : null}
              <button id={`${id}-save`} type="button" className={AdminUI.btn.primarySm} disabled={busy} onClick={save}>Save</button>
            </div>
          ) : null}
        </div>
        <p id={`${id}-status`} className={status
          ? `text-xs ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
          : 'text-xs hidden'}>
          {status ? status.text : ''}
        </p>
      </div>
    </div>
  );
}

function SignInSection({ initial = null }: { initial?: Payload | null }) {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();
  const [data, setData] = useState<Payload | null>(initial);
  const [loadFailed, setLoadFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (initial) return;
    (async () => {
      const { data: next } = await console_().fetchJson('/api/admin/sign-in-providers');
      if (!alive.current) return;
      if (next && typeof next === 'object' && Array.isArray(next.providers)) setData(next);
      else setLoadFailed(true);
    })();
  }, [initial]);

  return (
    <div id="admin-sign-in" className="space-y-4">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Sign-in providers</h2>
        </div>
        <p id="admin-sign-in-intro" className={AdminUI.muted}>
          The sign-in sheet offers Continue with Apple and Continue with Google beside the email
          code once each is set up here and switched on. Somebody new gets an account from the
          address the provider verified and picks a username; an existing account with that
          address is signed in. Secrets are kept encrypted and never shown again. Inside the
          Homeroom app the sheet offers the email code only.
        </p>
        {data && !data.callbackOrigin ? (
          <p id="admin-sign-in-no-origin" className={`${AdminUI.muted} mt-2`}>
            This server has no canonical origin (CLI_CANONICAL_ORIGIN), so neither provider can
            be offered here.
          </p>
        ) : null}
        {!data ? (
          <p className={`${AdminUI.loading} mt-4`}>{loadFailed ? 'Could not load the providers.' : 'Loading…'}</p>
        ) : null}
      </div>
      {data ? data.providers.map((view) => (
        <ProviderCard key={view.provider} view={view} canWrite={canWrite} onSaved={setData} />
      )) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminSignIn = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <SignInSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminSignIn = AdminSignIn;

// The components are exported for tests/sign-in-providers.test.js, which renders them.
export { AdminSignIn, SignInSection, ProviderCard };
