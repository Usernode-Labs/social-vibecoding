import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
import { useCallback, useRef, useState } from 'react';

import { alertVariants } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { finishLogin as confirmSession, legacy, type LoginCompletionFailure } from './shared';

export interface SessionConfirmationDetails extends LoginCompletionFailure {
  timestamp: string;
  platformBuild: string | null;
  browser: string;
  operatingSystem: string;
  surface: 'web' | 'native';
  appVersion: string | null;
  appBuild: string | null;
}

/** Parse only known public version strings; never copy a raw user agent. */
export function browserVersions(agent: string): { browser: string; operatingSystem: string } {
  const ios = /(?:CPU (?:iPhone )?OS|iPhone OS) (\d+(?:_\d+){0,2})/.exec(agent);
  const android = /Android (\d+(?:\.\d+){0,2})/.exec(agent);
  const browser = /\b(CriOS|FxiOS|EdgiOS|Edg|Chrome|Firefox)\/(\d+(?:\.\d+){0,3})/.exec(agent);
  const safari = /Version\/(\d+(?:\.\d+){0,3})[^\n]*Safari\//.exec(agent);
  const names: Record<string, string> = {
    get CriOS() { return tr("auth:chrome_ios_6727dc85"); }, get FxiOS() { return tr("auth:firefox_ios_9b08cf7b"); }, get EdgiOS() { return tr("auth:edge_ios_76ed771c"); },
    Edg: 'Edge', Chrome: 'Chrome', Firefox: 'Firefox',
  };
  return {
    browser: browser ? `${names[browser[1]]} ${browser[2]}` : safari ? tr("auth:safari_value1_6f8f8316", { value1: safari[1] }) : tr("auth:unknown_b764cdc0"),
    operatingSystem: ios ? tr("auth:ios_value1_a9d9bcce", { value1: ios[1].replace(/_/g, '.') }) : android ? tr("auth:android_value1_3a9871c0", { value1: android[1] })
      : /Windows NT/.test(agent) ? 'Windows' : /Mac OS X/.test(agent) ? 'macOS' : tr("auth:unknown_b764cdc0"),
  };
}

function buildLabel(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9]+(?:\.[0-9]+){0,3}$/.test(value) && value.length <= 40
    ? value : null;
}

function snapshot(failure: LoginCompletionFailure): SessionConfirmationDetails {
  let bridge: Record<string, unknown> | null = null;
  try {
    const value = legacy().usernode?.getBridgeDiagnostics?.();
    if (value && typeof value === 'object') bridge = value as Record<string, unknown>;
  } catch { /* optional native build metadata */ }
  const build = document.querySelector('meta[name="platform-build"]')?.getAttribute('content');
  return {
    ...failure,
    timestamp: new Date().toISOString(),
    platformBuild: build && /^(?:[0-9a-f]{7,40}|dev)$/.test(build) ? build : null,
    ...browserVersions(navigator.userAgent),
    surface: legacy().usernode?.isNative ? 'native' : 'web',
    appVersion: buildLabel(bridge?.appVersion),
    appBuild: buildLabel(bridge?.buildNumber),
  };
}

export function sessionConfirmationText(details: SessionConfirmationDetails): string {
  return [
    'Homeroom sign-in session diagnostics',
    `Time: ${details.timestamp}`,
    `Step: ${details.stage}`,
    `Result: ${details.code}`,
    `HTTP status: ${details.status ?? tr("auth:no_response_961136f9")}`,
    `Platform build: ${details.platformBuild ?? tr("auth:unknown_b764cdc0")}`,
    `Surface: ${details.surface}`,
    `Browser: ${details.browser}`,
    `Operating system: ${details.operatingSystem}`,
    `App version: ${details.appVersion ?? tr("auth:unknown_b764cdc0")}`,
    `App build: ${details.appBuild ?? tr("auth:unknown_b764cdc0")}`,
  ].join('\n');
}

const MESSAGES: Record<LoginCompletionFailure['code'], string> = {
  'session-rejected': 'Sign-in was accepted, but the server did not recognise your session. Check that this browser allows cookies for Homeroom, then retry the session check.',
  'server-response': 'Sign-in was accepted, but the server could not confirm your session. Wait a moment, then retry the session check.',
  'network-error': 'Sign-in was accepted, but we could not reach the server to confirm your session. Check your connection, then retry the session check.',
  timeout: 'Sign-in was accepted, but confirming your session took too long. Check your connection, then retry the session check.',
  'invalid-response': 'Sign-in was accepted, but the session response could not be read. Retry the session check. If it keeps failing, copy the details for support.',
  get 'client-error'() { return tr("auth:your_session_could_not_be_opened_on_this_device__1d84fc76"); },
};

export function useSessionConfirmation() {
  const [failure, setFailure] = useState<SessionConfirmationDetails | null>(null);
  const [checking, setChecking] = useState(false);
  const pending = useRef<Promise<void> | null>(null);
  const finishLogin = useCallback((): Promise<void> => {
    if (pending.current) return pending.current;
    setChecking(true);
    const run = async () => {
      try {
        const result = await confirmSession();
        setFailure(result ? snapshot(result) : null);
      } catch {
        setFailure(snapshot({ stage: 'open-session', status: null, code: 'client-error' }));
      } finally {
        setChecking(false);
        pending.current = null;
      }
    };
    pending.current = run();
    return pending.current;
  }, []);
  const clear = useCallback(() => { setFailure(null); }, []);
  return { failure, checking, finishLogin, clear };
}

export function SessionConfirmationNotice({ completion }: {
  completion: ReturnType<typeof useSessionConfirmation>;
}) {
  useUiLanguage();
  const [copyStatus, setCopyStatus] = useState('');
  if (!completion.failure) return null;
  const details = sessionConfirmationText(completion.failure);
  return (
    <div className={`${alertVariants({ variant: 'notice', density: 'roomy' })} my-4 space-y-3`}>
      <p role="alert">{MESSAGES[completion.failure.code]}</p>
      <Button type="button" variant="neutral" ink="neutral" disabled={completion.checking}
        onClick={() => { setCopyStatus(''); void completion.finishLogin(); }}>
        <LocalizedValue render={() => (completion.checking ? tr("auth:checking_session_b952cab7") : tr("auth:retry_session_check_73306833"))} />
      </Button>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm font-medium leading-[44px]"><Message id="auth:sign_in_details_e348d653" /></summary>
        <pre className="whitespace-pre-wrap break-words rounded-lg bg-zinc-100 p-3 text-xs text-zinc-800 select-text dark:bg-zinc-800 dark:text-zinc-100">{details}</pre>
        <Button type="button" variant="neutral" ink="neutral" onClick={async () => {
          try { await navigator.clipboard.writeText(details); setCopyStatus(tr("auth:details_copied_e2acabb2")); }
          catch { setCopyStatus(tr("auth:could_not_copy_you_can_select_the_details_above_e37a2f53")); }
        }}><Message id="auth:copy_details_ec7ee282" /></Button>
        <p role="status" className="text-sm">{copyStatus}</p>
      </details>
    </div>
  );
}
