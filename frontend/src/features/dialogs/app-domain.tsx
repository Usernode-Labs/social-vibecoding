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

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending: 'Waiting for DNS',
  verified: 'Getting a certificate',
  live: 'Live',
  failed: 'Not working',
  disabled: 'Disabled by an admin',
};

function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60000) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The status line: the state in words, then the sentence that says why. */
function statusText(row: DomainRow): string {
  const label = STATUS_LABEL[row.status] || row.status;
  if (row.status === 'live') {
    return row.live_at ? `${label} since ${new Date(row.live_at).toLocaleDateString()}.` : `${label}.`;
  }
  if (row.last_error) return `${label}. ${row.last_error}`;
  if (row.status === 'pending') {
    const checked = row.checked_at ? ` Checked ${ago(row.checked_at)}.` : '';
    return `${label}.${checked} DNS changes can take up to an hour to show.`;
  }
  if (row.status === 'verified') return `${label}. This usually takes a minute or two.`;
  return `${label}.`;
}

/** Where to type a record: the part of each name under the domain's zone. */
function recordName(record: DomainRecord, hostname: string): string {
  const zone = hostname.split('.').slice(1).join('.');
  if (record.name === zone) return '@';
  return record.name.endsWith(`.${zone}`) ? record.name.slice(0, -(zone.length + 1)) : record.name;
}

export function AppDomainDialog() {
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
      if (!response.ok) throw new Error(body.error || 'Could not load the custom domain.');
      if (current === generation.current) setData(body as DomainPayload);
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not load the custom domain.');
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
    if (!response.ok) throw new Error(body.error || 'Something went wrong. Try again.');
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
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const hostname = (inputRef.current?.value || '').trim();
    if (!hostname) return setError('Enter a web address, for example app.example.com.');
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
      setError('Could not copy. Select the value and copy it yourself.');
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
      <h2 className="text-lg font-bold mb-1">Custom domain</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{appName}</p>
      {loading ? <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Loading…</p> : null}
      <p
        id="app-domain-error"
        role="alert"
        className={`${error ? '' : 'hidden'} text-sm text-red-700 dark:text-red-400 mb-4`}
      >{error}</p>

      {data && !domain ? (
        <form onSubmit={add} className="space-y-3">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Give this project a web address you own, beside {data.homeroom_host}.
          </p>
          <label htmlFor="app-domain-input" className="block text-sm font-medium">Web address</label>
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
            A subdomain, for example app.example.com or www.example.com. Apex domains like example.com are not supported yet.
          </p>
          <Button id="app-domain-add" type="submit" size="sm" disabled={busy || !canManage}>
            {busy ? 'Adding…' : 'Add domain'}
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
                ? `Keep these two records where you manage DNS for ${domain.hostname.split('.').slice(1).join('.')}:`
                : `Add these two records where you manage DNS for ${domain.hostname.split('.').slice(1).join('.')}:`}
            </p>
            <table id="app-domain-records" className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-zinc-500 dark:text-zinc-400">
                  <th className="py-1 pr-2 font-semibold">Type</th>
                  <th className="py-1 pr-2 font-semibold">Name</th>
                  <th className="py-1 font-semibold">Value</th>
                </tr>
              </thead>
              <tbody>
                {(data?.records || []).map((record) => (
                  <tr key={record.type} className="border-t border-zinc-200 dark:border-zinc-800 align-top">
                    <td className="py-1.5 pr-2">{record.type}</td>
                    <td className="py-1.5 pr-2 font-mono break-all">{recordName(record, domain.hostname)}</td>
                    <td className="py-1.5">
                      <span className="font-mono break-all">{record.value}</span>{' '}
                      <button
                        type="button"
                        className="text-violet-700 hover:text-violet-400 dark:text-violet-400 transition-colors"
                        onClick={() => void copy(record.value)}
                      >{copied === record.value ? 'Copied' : 'Copy'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              {domain.status === 'live'
                ? `The project stays at ${data?.homeroom_host} as well.`
                : `Homeroom checks every minute. The project stays at ${data?.homeroom_host} as well.`}
            </p>
          </> : null}
          {canManage ? <div className="mt-4 flex items-center gap-2">
            {working ? <Button id="app-domain-check" type="button" size="sm" disabled={busy} onClick={check}>
              {busy ? 'Checking…' : 'Check now'}
            </Button> : null}
            {domain.status === 'live' ? <a
              id="app-domain-open"
              href={`https://${domain.hostname}`}
              target="_blank"
              rel="noopener"
              className="text-sm font-medium text-violet-700 hover:text-violet-400 transition-colors dark:text-violet-400"
            >Open</a> : null}
            <button
              id="app-domain-remove"
              type="button"
              className="px-2 py-1 text-sm text-red-700 hover:text-red-500 dark:text-red-400 transition-colors disabled:opacity-60"
              disabled={busy}
              onClick={remove}
            >Remove domain</button>
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
      >Close</Button>
    </DialogCard>
  </DialogRoot>;
}
