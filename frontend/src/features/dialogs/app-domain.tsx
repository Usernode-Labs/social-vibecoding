/**
 * Custom domain dialog (#app-domain-modal, #4405).
 *
 * A project's own web address, beside its Homeroom address. The dialog's one
 * job is to get one hostname from "typed in" to "live" and to show where it
 * is on that path: Waiting for DNS, Getting a certificate, Live, or Not
 * working, each with the sentence that says why. Its primary action follows
 * the state: Add domain when there is none, Check now while it is on its
 * way, Open once it is live. Remove domain is a quiet red text action beside
 * it.
 *
 * Reads GET /api/apps/:slug/domain; writes POST (claim), POST …/check and
 * DELETE (routes/apps.js). The server decides who may change it
 * (canManageApp); `can_manage` in the payload decides what this draws.
 *
 * Shape and behaviour follow App settings (./app-settings.tsx): the same
 * small card, the title with the project's name under it, a neutral Close
 * pill at the bottom, and `useDialog` for the whole lifecycle. The hostname
 * input stays uncontrolled (a ref) so the prerender carries no `value`.
 */

import { useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { useDialog } from './use-dialog';

type DomainStatus = 'pending' | 'verified' | 'live' | 'failed' | 'disabled';

interface DomainRow {
  hostname: string;
  status: DomainStatus;
  last_error: string | null;
  checked_at: string | null;
  verified_at: string | null;
  live_at: string | null;
  cert_expires_at: string | null;
  created_at: string | null;
}

interface DomainRecord { type: 'CNAME' | 'TXT'; name: string; value: string }

interface DomainPayload {
  domain: DomainRow | null;
  records: DomainRecord[];
  homeroom_host: string;
  can_manage: boolean;
}

/** The status alone, as a sentence: what the line says when there is nothing to add. */
const STATUS_LINE: Record<DomainStatus, string> = {
  pending: 'dialogs:appDomain.status.pending.plain',
  verified: 'dialogs:appDomain.status.verified',
  live: 'dialogs:appDomain.status.live',
  failed: 'dialogs:appDomain.status.failed',
  disabled: 'dialogs:appDomain.status.disabled',
};

/** The status, then the server's own sentence saying why ({{reason}}). */
const STATUS_WITH_REASON: Record<Exclude<DomainStatus, 'live'>, string> = {
  pending: 'dialogs:appDomain.status.pendingReason',
  verified: 'dialogs:appDomain.status.verifiedReason',
  failed: 'dialogs:appDomain.status.failedReason',
  disabled: 'dialogs:appDomain.status.disabledReason',
};

/** Waiting for DNS, with how long ago it was last checked: one whole line for each unit. */
function pendingCheckedText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60000) return translate('dialogs:appDomain.status.pending.checkedJustNow');
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return translate('dialogs:appDomain.status.pending.checkedMinutes', { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return translate('dialogs:appDomain.status.pending.checkedHours', { count: hours });
  return translate('dialogs:appDomain.status.pending.checkedDays', { count: Math.floor(hours / 24) });
}

/** The status line: the state in words, then the sentence that says why. */
function statusText(row: DomainRow): string {
  // A status this build does not know is shown as the server names it.
  if (!STATUS_LINE[row.status]) return row.last_error ? `${row.status}. ${row.last_error}` : `${row.status}.`;
  if (row.status === 'live') {
    return row.live_at
      ? translate('dialogs:appDomain.status.liveSince', { date: new Date(row.live_at).toLocaleDateString() })
      : translate('dialogs:appDomain.status.live');
  }
  if (row.last_error) return translate(STATUS_WITH_REASON[row.status], { reason: row.last_error });
  if (row.status === 'pending' && row.checked_at) return pendingCheckedText(row.checked_at);
  return translate(STATUS_LINE[row.status]);
}

/** Where to type a record: the part of each name under the domain's zone. */
function recordName(record: DomainRecord, hostname: string): string {
  const zone = hostname.split('.').slice(1).join('.');
  if (record.name === zone) return '@';
  return record.name.endsWith(`.${zone}`) ? record.name.slice(0, -(zone.length + 1)) : record.name;
}

export function AppDomainDialog() {
  const t = useMessages('dialogs');
  const inputRef = useRef<HTMLInputElement>(null);
  const [appName, setAppName] = useState('');
  const [data, setData] = useState<DomainPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const pending = useRef(false);
  const generation = useRef(0);
  const slug = useRef('');

  async function load(target: string) {
    const current = ++generation.current;
    setData(null);
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}/domain`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('dialogs:appDomain.error.load'));
      if (current === generation.current) setData(body as DomainPayload);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : t('dialogs:appDomain.error.load'));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  const dialog = useDialog<{ slug: string }>('appDomain', {
    onOpen: (payload) => {
      slug.current = payload?.slug || '';
      setAppName((window.AppView?.appData?.name as string) || '');
      setCopied('');
      if (inputRef.current) inputRef.current.value = '';
      if (slug.current) void load(slug.current);
    },
    onClose: () => {
      ++generation.current;
      setData(null);
      setError('');
      setCopied('');
      if (inputRef.current) inputRef.current.value = '';
    },
    canClose: () => !pending.current,
  });

  async function send(path: string, init: RequestInit): Promise<DomainPayload | null> {
    const response = await fetch(`/api/apps/${encodeURIComponent(slug.current)}/domain${path}`, init);
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || t('dialogs:appDomain.error.generic'));
    return body as DomainPayload;
  }

  async function act(run: () => Promise<DomainPayload | null>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await run();
      if (next) setData(next);
      else await load(slug.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dialogs:appDomain.error.generic'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const hostname = (inputRef.current?.value || '').trim();
    if (!hostname) return setError(t('dialogs:appDomain.error.empty'));
    void act(() => send('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname }),
    }));
  }

  function check() {
    void act(() => send('/check', { method: 'POST' }));
  }

  function remove() {
    void act(() => send('', { method: 'DELETE' }));
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      setError(t('dialogs:appDomain.error.copy'));
    }
  }

  const domain = data?.domain || null;
  const canManage = !!data?.can_manage;
  const working = !!domain && (domain.status === 'pending' || domain.status === 'verified' || domain.status === 'failed');
  const statusIsProblem = !!domain && (domain.status === 'failed' || domain.status === 'disabled' || !!domain.last_error);
  const statusClass = !domain
    ? 'hidden'
    : domain.status === 'live'
      ? 'mt-1 text-sm text-zinc-600 dark:text-zinc-300'
      : statusIsProblem
        ? 'mt-1 text-sm text-amber-800 dark:text-amber-300'
        : 'mt-1 text-sm text-zinc-600 dark:text-zinc-300';

  return <DialogRoot id="app-domain-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard size="sm">
      <h2 className="text-lg font-bold mb-1">{t('dialogs:appDomain.title')}</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{appName}</p>
      {loading ? <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{t('dialogs:appDomain.loading')}</p> : null}
      <p
        id="app-domain-error"
        role="alert"
        className={`${error ? '' : 'hidden'} text-sm text-red-700 dark:text-red-400 mb-4`}
      >{error}</p>

      {data && !domain ? (
        <form onSubmit={add} className="space-y-3">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {t('dialogs:appDomain.add.intro', { host: data.homeroom_host })}
          </p>
          <label htmlFor="app-domain-input" className="block text-sm font-medium">{t('dialogs:appDomain.add.label')}</label>
          <Input
            id="app-domain-input"
            ref={inputRef}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="app.example.com"
            disabled={busy || !canManage}
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {t('dialogs:appDomain.add.hint')}
          </p>
          <Button id="app-domain-add" type="submit" size="sm" disabled={busy || !canManage}>
            {busy ? t('dialogs:appDomain.add.adding') : t('dialogs:appDomain.add.submit')}
          </Button>
        </form>
      ) : null}

      {domain ? (
        <section id="app-domain-section">
          <p className="text-sm font-semibold break-all">{domain.hostname}</p>
          <p id="app-domain-status" role="status" className={statusClass}>
            {domain.status === 'live' ? <span aria-hidden="true">✓ </span> : null}
            {statusText(domain)}
          </p>
          {domain.status !== 'disabled' ? <>
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400 mb-2">
              {domain.status === 'live'
                ? t('dialogs:appDomain.records.keep', { zone: domain.hostname.split('.').slice(1).join('.') })
                : t('dialogs:appDomain.records.add', { zone: domain.hostname.split('.').slice(1).join('.') })}
            </p>
            <table id="app-domain-records" className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400">
                  <th className="py-1 pr-2 font-semibold">{t('dialogs:appDomain.records.type')}</th>
                  <th className="py-1 pr-2 font-semibold">{t('dialogs:appDomain.records.name')}</th>
                  <th className="py-1 font-semibold">{t('dialogs:appDomain.records.value')}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.records || []).map((record) => (
                  <tr key={record.type} className="border-t border-zinc-200 dark:border-zinc-800 align-top">
                    <td className="py-1.5 pr-2">{record.type}</td>
                    <td className="py-1.5 pr-2 font-mono break-all">{recordName(record, domain.hostname)}</td>
                    <td className="py-1.5">
                      <span className="font-mono break-all">{record.value}</span>
                      <button
                        type="button"
                        className="ml-1 text-violet-700 hover:text-violet-400 dark:text-violet-400 transition-colors"
                        onClick={() => void copy(record.value)}
                      >{copied === record.value ? t('dialogs:appDomain.records.copied') : t('dialogs:appDomain.records.copy')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              {domain.status === 'live'
                ? t('dialogs:appDomain.records.staysLive', { host: data?.homeroom_host })
                : t('dialogs:appDomain.records.staysChecking', { host: data?.homeroom_host })}
            </p>
          </> : null}
          {canManage ? <div className="mt-4 flex items-center gap-2">
            {working ? <Button id="app-domain-check" type="button" size="sm" disabled={busy} onClick={check}>
              {busy ? t('dialogs:appDomain.check.checking') : t('dialogs:appDomain.check.submit')}
            </Button> : null}
            {domain.status === 'live' ? <a
              id="app-domain-open"
              href={`https://${domain.hostname}`}
              target="_blank"
              rel="noopener"
              className="text-sm font-medium text-violet-700 hover:text-violet-400 transition-colors dark:text-violet-400"
            >{t('dialogs:appDomain.open')}</a> : null}
            <button
              id="app-domain-remove"
              type="button"
              className="px-2 py-1 text-sm text-red-700 hover:text-red-500 dark:text-red-400 transition-colors disabled:opacity-60"
              disabled={busy}
              onClick={remove}
            >{t('dialogs:appDomain.remove')}</button>
          </div> : null}
        </section>
      ) : null}

      <Button
        type="button"
        variant="neutral"
        ink="neutral"
        className="mt-4"
        disabled={busy}
        onClick={() => dialog.close()}
      >{t('core:common.close')}</Button>
    </DialogCard>
  </DialogRoot>;
}
