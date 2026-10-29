/**
 * Settings › Linked phones (#4938): the phones signed in to your account
 * through the Homeroom app, and Unlink for each.
 *
 * Each row is one phone: its kind (Android or iPhone, when the phone has
 * registered for notifications; "Phone" otherwise), when it was linked and
 * when the app last used it. The phone this page is open on, when it is one
 * of them, is marked "This phone". Unlink asks once more on the row, then
 * signs that phone out and stops its notifications; on this phone that
 * signs you out here too.
 *
 * The list and the unlink live on the server (src/services/linked-phones.js,
 * GET /api/me/phones and DELETE /api/me/phones/:id), which only ever acts on
 * the signed-in account's own phones.
 *
 * A STATEFUL pane, like ./privacy.tsx: nothing in ../settings.js binds
 * inside it. The initial render is the empty list's heading alone, and the
 * read happens in an effect: on mount and every time a settings page is
 * shown, so a phone linked meanwhile is there when you come back.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';
import { useWindowEvent } from '../../../lib/legacy-dom';

interface LinkedPhone {
  id: string;
  platform: 'android' | 'ios' | null;
  linkedAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
}

const ENDPOINT = '/api/me/phones';

const ROW_FIRST = 'flex items-start justify-between gap-3 py-2.5';
const ROW_NEXT = `${ROW_FIRST} border-t border-zinc-200 dark:border-zinc-800`;
const UNLINK_CLASS = 'shrink-0 rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32 disabled:opacity-50';
const CANCEL_CLASS = 'shrink-0 rounded px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800 transition-colors touch-target-32 disabled:opacity-50';

function parse(value: unknown): LinkedPhone[] | null {
  if (!value || typeof value !== 'object') return null;
  const list = (value as { phones?: unknown }).phones;
  if (!Array.isArray(list)) return null;
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) return [];
    return [{
      id: row.id,
      platform: row.platform === 'android' || row.platform === 'ios' ? row.platform : null,
      linkedAt: typeof row.linkedAt === 'string' ? row.linkedAt : null,
      lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : null,
      current: row.current === true,
    }];
  });
}

function day(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const PLATFORM_LABEL: Record<string, string> = {
  android: 'settings:phones.platform.android',
  ios: 'settings:phones.platform.ios',
};

/** #5995: the Settings menu's count on this row, or null for none. */
function reportPhones(count: number | null) {
  (window as { Settings?: { _setNavStatus?(key: string, count: number | null): void } })
    .Settings?._setNavStatus?.('phones', count);
}

export function LinkedPhonesSection() {
  const t = useMessages('settings');
  const [phones, setPhones] = useState<LinkedPhone[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // A read that started before an unlink must not paint the phone back.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const seq = ++generation.current;
    try {
      const res = await fetch(ENDPOINT, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const next = parse(await res.json());
      if (seq !== generation.current) return;
      if (next) { setPhones(next); setError(''); }
    } catch {
      if (seq !== generation.current) return;
      setError(t('settings:phones.loadFailed'));
      // #5995: a failed reload clears the menu's count rather than leaving
      // an old one; the next good load reports again (it sets a new list).
      reportPhones(null);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  // #5995: the Settings menu's "1 linked" on this row. A loaded list (or one
  // an unlink shortened) reports its length; a failed load reports nothing.
  useEffect(() => {
    if (phones) reportPhones(phones.length);
  }, [phones]);
  useWindowEvent('usernode:settings-section', () => { void load(); });

  const unlink = async (phone: LinkedPhone) => {
    if (busy) return;
    ++generation.current;
    setBusy(phone.id);
    setError('');
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(phone.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      // 404: already unlinked (from the phone itself, or another tab).
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setPhones((list) => (list || []).filter((p) => p.id !== phone.id));
      setConfirming(null);
      // The phone in your hand is signed out with it: start again signed out.
      if (phone.current && typeof window !== 'undefined') window.location.reload();
    } catch {
      setError(t('settings:phones.unlinkFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-settings-section="phones" className="hidden">
      <div id="settings-phones-section">
        <SectionHeading title={t('settings:phones.title')} blurbClassName="leading-relaxed">
          {t('settings:phones.intro')}
        </SectionHeading>
        <div id="settings-phones-list" className="flex flex-col">
          {phones && !phones.length ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2.5">{t('settings:phones.empty')}</p>
          ) : null}
          {(phones || []).map((phone, index) => {
            const asking = confirming === phone.id;
            const lastUsed = day(phone.lastUsedAt);
            const linked = day(phone.linkedAt);
            return (
              <div key={phone.id} className={index === 0 ? ROW_FIRST : ROW_NEXT} data-linked-phone={phone.id}>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                    {t(phone.platform ? PLATFORM_LABEL[phone.platform] : 'settings:phones.platform.unknown')}
                    {phone.current ? (
                      <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                        {t('settings:phones.thisPhone')}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {asking
                      ? t(phone.current ? 'settings:phones.confirmThisPhone' : 'settings:phones.confirm')
                      : t('settings:phones.detail', { lastUsed, linked })}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {asking ? (
                    <button
                      type="button"
                      className={CANCEL_CLASS}
                      disabled={busy === phone.id}
                      onClick={() => setConfirming(null)}
                    >
                      {t('settings:phones.cancel')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={UNLINK_CLASS}
                    disabled={busy === phone.id}
                    onClick={() => { if (asking) void unlink(phone); else setConfirming(phone.id); }}
                  >
                    {t('settings:phones.unlink')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        {error ? (
          <p id="settings-phones-status" role="status" className="text-xs mt-3 text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
