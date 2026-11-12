/**
 * Settings › Linked devices (#4938, #5974): the devices signed in to your
 * account, in two groups, and a way to sign each one out.
 *
 * Phones are the installations of the Homeroom app holding a credential of
 * the account (one row per install, so a reinstalled app is a new row, which
 * the line under the heading says). Each row is its kind (Android or iPhone,
 * when the phone has registered for notifications; "Phone" otherwise), when
 * it was linked and when the app last used it. The phone this page is open
 * on, when it is one of them, is marked "This phone". Unlink asks once more
 * on the row, then signs that phone out and stops its notifications; on this
 * phone that signs you out here too.
 *
 * Browsers (#5974) are the account's web sessions that are not a phone's:
 * what each is ("Chrome on Mac", from the short class the server kept, never
 * the User-Agent itself), when it signed in and when it last used the
 * account. The browser this page is open in is marked "This browser". Sign
 * out asks once more on the row, then deletes that session; in this browser
 * that signs you out here and the page starts again signed out.
 *
 * A device not used for more than 30 days says "Not used since …" instead
 * of "Last used …", so a forgotten one reads as forgotten.
 *
 * The lists and the actions live on the server (src/services/linked-phones.js
 * with GET /api/me/phones and DELETE /api/me/phones/:id, which the mobile app
 * may read and which do not change; src/services/linked-browsers.js with
 * GET /api/me/browser-sessions and DELETE /api/me/browser-sessions/:id), and
 * only ever act on the signed-in account's own rows.
 *
 * A STATEFUL pane, like ./privacy.tsx: nothing in ../settings.js binds
 * inside it. The initial render is the headings alone, and the reads happen
 * in an effect: on mount and every time a settings page is shown, so a device
 * signed in meanwhile is there when you come back.
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

interface LinkedBrowser {
  id: string;
  browser: string | null;
  os: string | null;
  signedInAt: string | null;
  lastUsedAt: string | null;
  current: boolean;
}

const ENDPOINT = '/api/me/phones';
const BROWSERS_ENDPOINT = '/api/me/browser-sessions';

/** A device last used longer ago than this says "Not used since …". */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const GROUP_HEAD = 'text-xs font-semibold text-zinc-700 dark:text-zinc-300';
const GROUP_NOTE = 'text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-1 leading-relaxed';
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

const BROWSER_LABEL: Record<string, string> = {
  chrome: 'settings:phones.browsers.browser.chrome',
  safari: 'settings:phones.browsers.browser.safari',
  firefox: 'settings:phones.browsers.browser.firefox',
  edge: 'settings:phones.browsers.browser.edge',
  opera: 'settings:phones.browsers.browser.opera',
  samsung: 'settings:phones.browsers.browser.samsung',
};

const OS_LABEL: Record<string, string> = {
  mac: 'settings:phones.browsers.os.mac',
  windows: 'settings:phones.browsers.os.windows',
  linux: 'settings:phones.browsers.os.linux',
  android: 'settings:phones.browsers.os.android',
  ios: 'settings:phones.browsers.os.ios',
  ipad: 'settings:phones.browsers.os.ipad',
  chromeos: 'settings:phones.browsers.os.chromeos',
};

function parseBrowsers(value: unknown): LinkedBrowser[] | null {
  if (!value || typeof value !== 'object') return null;
  const list = (value as { browsers?: unknown }).browsers;
  if (!Array.isArray(list)) return null;
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) return [];
    return [{
      id: row.id,
      browser: typeof row.browser === 'string' && row.browser in BROWSER_LABEL ? row.browser : null,
      os: typeof row.os === 'string' && row.os in OS_LABEL ? row.os : null,
      signedInAt: typeof row.signedInAt === 'string' ? row.signedInAt : null,
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

/** True when the device's last use is more than 30 days ago. */
function stale(lastUsedAt: string | null): boolean {
  if (!lastUsedAt) return false;
  const at = Date.parse(lastUsedAt);
  return Number.isFinite(at) && Date.now() - at > STALE_AFTER_MS;
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

interface DeviceRowProps {
  first: boolean;
  name: string;
  /** "This phone" / "This browser", when the row is the device in hand. */
  here: string | null;
  detail: string;
  asking: boolean;
  busy: boolean;
  actionLabel: string;
  cancelLabel: string;
  onAction(): void;
  onCancel(): void;
  attrs: Record<string, string>;
}

/** One device, in either group: its name, its line, and its action. */
function DeviceRow({ first, name, here, detail, asking, busy, actionLabel, cancelLabel, onAction, onCancel, attrs }: DeviceRowProps) {
  return (
    <div className={first ? ROW_FIRST : ROW_NEXT} {...attrs}>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          {name}
          {here ? (
            <span className="ms-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">{here}</span>
          ) : null}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {asking ? (
          <button type="button" className={CANCEL_CLASS} disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
        ) : null}
        <button type="button" className={UNLINK_CLASS} disabled={busy} onClick={onAction}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}

export function LinkedPhonesSection() {
  const t = useMessages('settings');
  const [phones, setPhones] = useState<LinkedPhone[] | null>(null);
  const [browsers, setBrowsers] = useState<LinkedBrowser[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  // A read that started before an unlink must not paint the device back.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const seq = ++generation.current;
    const read = async (url: string) => {
      const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    };
    const [phonesRead, browsersRead] = await Promise.allSettled([read(ENDPOINT), read(BROWSERS_ENDPOINT)]);
    if (seq !== generation.current) return;
    const nextPhones = phonesRead.status === 'fulfilled' ? parse(phonesRead.value) : null;
    const nextBrowsers = browsersRead.status === 'fulfilled' ? parseBrowsers(browsersRead.value) : null;
    if (nextPhones) setPhones(nextPhones);
    if (nextBrowsers) setBrowsers(nextBrowsers);
    if (!nextPhones) setError(t('settings:phones.loadFailed'));
    else if (!nextBrowsers) setError(t('settings:phones.browsers.loadFailed'));
    else setError('');
    // #5995: a failed reload clears the menu's count rather than leaving an
    // old one; the next good load reports again (it sets a new list).
    if (!nextPhones && !nextBrowsers) reportPhones(null);
  }, [t]);

  useEffect(() => { void load(); }, [load]);
  // #5995: the Settings menu's "3 linked" on this row counts every device: a
  // loaded list (or one an unlink shortened) reports; a failed load reports
  // nothing.
  useEffect(() => {
    if (phones || browsers) reportPhones((phones?.length || 0) + (browsers?.length || 0));
  }, [phones, browsers]);
  // Read again when this page is opened, never when another one is (#6591:
  // every page of Settings re-read both lists, hidden, on each switch).
  useWindowEvent('usernode:settings-section', (event) => {
    if ((event as CustomEvent<{ section?: string }>).detail?.section === 'phones') void load();
  });

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

  const signOut = async (browser: LinkedBrowser) => {
    if (busy) return;
    ++generation.current;
    setBusy(browser.id);
    setError('');
    try {
      const res = await fetch(`${BROWSERS_ENDPOINT}/${encodeURIComponent(browser.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      // 404: already signed out (from that browser itself, or another tab).
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      setBrowsers((list) => (list || []).filter((b) => b.id !== browser.id));
      setConfirming(null);
      // This browser was signed out with it: start again signed out.
      if (browser.current && typeof window !== 'undefined') window.location.reload();
    } catch {
      setError(t('settings:phones.browsers.signOutFailed'));
    } finally {
      setBusy(null);
    }
  };

  const browserName = (browser: LinkedBrowser): string => {
    const os = browser.os ? t(OS_LABEL[browser.os]) : '';
    if (browser.browser) {
      const name = t(BROWSER_LABEL[browser.browser]);
      return os ? t('settings:phones.browsers.name', { browser: name, os }) : name;
    }
    return os ? t('settings:phones.browsers.nameSystemOnly', { os }) : t('settings:phones.browsers.unknown');
  };

  return (
    <div data-settings-section="phones" className="hidden">
      <div id="settings-phones-section">
        <SectionHeading title={t('settings:phones.title')} blurbClassName="leading-relaxed">
          {t('settings:phones.intro')}
        </SectionHeading>
        <h4 className={GROUP_HEAD}>{t('settings:phones.group.phones')}</h4>
        <p className={GROUP_NOTE}>{t('settings:phones.phonesNote')}</p>
        <div id="settings-phones-list" className="flex flex-col">
          {phones && !phones.length ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2.5">{t('settings:phones.empty')}</p>
          ) : null}
          {(phones || []).map((phone, index) => {
            const asking = confirming === phone.id;
            const lastUsed = day(phone.lastUsedAt);
            const linked = day(phone.linkedAt);
            return (
              <DeviceRow
                key={phone.id}
                first={index === 0}
                attrs={{ 'data-linked-phone': phone.id }}
                name={t(phone.platform ? PLATFORM_LABEL[phone.platform] : 'settings:phones.platform.unknown')}
                here={phone.current ? t('settings:phones.thisPhone') : null}
                detail={asking
                  ? t(phone.current ? 'settings:phones.confirmThisPhone' : 'settings:phones.confirm')
                  : t(stale(phone.lastUsedAt) ? 'settings:phones.detailStale' : 'settings:phones.detail', { lastUsed, linked })}
                asking={asking}
                busy={busy === phone.id}
                actionLabel={t('settings:phones.unlink')}
                cancelLabel={t('settings:phones.cancel')}
                onAction={() => { if (asking) void unlink(phone); else setConfirming(phone.id); }}
                onCancel={() => setConfirming(null)}
              />
            );
          })}
        </div>
        <h4 className={`${GROUP_HEAD} mt-5`}>{t('settings:phones.group.browsers')}</h4>
        <p className={GROUP_NOTE}>{t('settings:phones.browsers.note')}</p>
        <div id="settings-browsers-list" className="flex flex-col">
          {browsers && !browsers.length ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2.5">{t('settings:phones.browsers.empty')}</p>
          ) : null}
          {(browsers || []).map((browser, index) => {
            const asking = confirming === browser.id;
            const lastUsed = day(browser.lastUsedAt);
            const signedIn = day(browser.signedInAt);
            return (
              <DeviceRow
                key={browser.id}
                first={index === 0}
                attrs={{ 'data-linked-browser': browser.id }}
                name={browserName(browser)}
                here={browser.current ? t('settings:phones.browsers.thisBrowser') : null}
                detail={asking
                  ? t(browser.current ? 'settings:phones.browsers.confirmThisBrowser' : 'settings:phones.browsers.confirm')
                  : t(stale(browser.lastUsedAt) ? 'settings:phones.browsers.detailStale' : 'settings:phones.browsers.detail', { lastUsed, signedIn })}
                asking={asking}
                busy={busy === browser.id}
                actionLabel={t('settings:phones.browsers.signOut')}
                cancelLabel={t('settings:phones.cancel')}
                onAction={() => { if (asking) void signOut(browser); else setConfirming(browser.id); }}
                onCancel={() => setConfirming(null)}
              />
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
