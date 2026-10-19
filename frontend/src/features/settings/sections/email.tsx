import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GroupedList } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';

import { useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { returnKeyHandler } from '../../../lib/return-to-next';
import {
  EDITOR_ACTIONS, EDITOR_NOTE, ROW_ACTION, ROW_EDITOR, SignInRow,
} from './sign-in-row';

type AccountEmail = {
  email: string | null;
  verified: boolean;
  passwordRequired: boolean;
  recoveryAllowed: boolean;
};

/** The event the Account page's sign-in rows open and close by (#5281).
 * settings.js dispatches it for Username and Password, and listens for this
 * part's own, so only one form is open at a time. */
const EDITOR_EVENT = 'usernode:settings-account-editor';

/** How long the first read may take before the row says it failed. A read
 * that never settles must not leave "Loading" on screen for good. */
const LOAD_TIMEOUT_MS = 15000;

async function api(action = '', body?: Record<string, string>, signal?: AbortSignal) {
  const response = await fetch(`/api/me/email${action}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  // A body that is not JSON (a proxy's error page, a sign-in redirect) is a
  // failure with no reason, not a throw that skips the reason below.
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result || typeof result !== 'object') {
    throw new Error(result?.error || translate('settings:email.requestFailed'));
  }
  return result;
}

// Only the constant outer wrapper belongs to Settings' section router.
// Everything inside this component is React-owned, including async feedback.
function EmailForm() {
  const t = useMessages('settings');
  const [reload, setReload] = useState(0);
  const [account, setAccount] = useState<AccountEmail | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // TWO CLOCKS (#15). `read` is the account's own read; `form` is a send or
  // a verify in flight. Leaving for another page drops what was typed and
  // the send, never the read: one counter for both left the line saying
  // "Loading account email…" for good, because the read it threw away only
  // ran again on an 'email' event, and the event names the PAGE this part
  // is on ('account'), so that never came.
  const read = useRef(0);
  const form = useRef(0);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const clearForm = () => {
      ++form.current;
      setOpen(false); setPassword(''); setPending(''); setCode(''); setBusy(false);
    };
    const refresh = () => {
      const seq = ++read.current;
      if (timer) clearTimeout(timer);
      controller?.abort();
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      const ours = controller;
      clearForm();
      setAccount(null);
      setMessage(''); setError('');
      timer = setTimeout(() => ours?.abort(), LOAD_TIMEOUT_MS);
      void api('', undefined, ours?.signal).then((value: AccountEmail) => {
        if (seq !== read.current) return;
        setAccount(value); setEmail(value.email || '');
      }).catch((err: Error) => {
        if (seq !== read.current) return;
        setError(err?.name === 'AbortError' || !err?.message ? t('settings:email.requestFailed') : err.message);
      }).finally(() => {
        if (seq === read.current && timer) clearTimeout(timer);
      });
    };
    // #5281: the page key is 'account' since the settings restructure put
    // this part on the Account page, and this used to listen for 'email'
    // only. Every reveal of the page therefore bumped the generation and
    // threw the read that was in flight away, so "Loading account email…"
    // never went. Whether THIS part is on screen is its own wrapper's
    // `hidden`, which the router writes before it announces the page.
    const onSection = (event: Event) => {
      const wrapper = root.current?.closest('[data-settings-section]');
      const shown = (event as CustomEvent).detail?.section === 'email'
        || (event as CustomEvent).detail?.section === 'account'
        || (!!wrapper && !wrapper.classList.contains('hidden'));
      if (shown) refresh();
      else clearForm();
    };
    const onEditor = (event: Event) => {
      setOpen((event as CustomEvent).detail?.part === 'email');
    };
    window.addEventListener('usernode:settings-section', onSection);
    window.addEventListener(EDITOR_EVENT, onEditor);
    refresh();
    return () => {
      ++read.current;
      ++form.current;
      if (timer) clearTimeout(timer);
      controller?.abort();
      window.removeEventListener('usernode:settings-section', onSection);
      window.removeEventListener(EDITOR_EVENT, onEditor);
    };
    // `t` is read only for a message when a read fails.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const openEditor = () => {
    setMessage(''); setError('');
    setOpen(true);
    try {
      window.dispatchEvent(new CustomEvent(EDITOR_EVENT, { detail: { part: 'email' } }));
    } catch { /* the form is open either way */ }
  };
  const closeEditor = () => {
    setOpen(false); setPassword(''); setPending(''); setCode('');
    setEmail(account?.email || ''); setMessage(''); setError('');
  };

  const submit = async (verify: boolean) => {
    const seq = form.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api(verify ? '/verify' : '/request', verify
        ? { code } : { email, currentPassword: password });
      if (seq !== form.current) return;
      setPassword(''); setCode('');
      if (verify) {
        setAccount(result); setPending(''); setEmail(result.email);
        setOpen(false);
        setMessage(t('settings:email.verifiedNotice'));
      } else {
        setPending(result.email);
        setMessage(t('settings:email.codeSentNotice'));
      }
    } catch (err) {
      if (seq === form.current) setError((err as Error).message);
    } finally {
      if (seq === form.current) setBusy(false);
    }
  };

  // The row's second line: the address and whether it is verified, or that
  // there is none, or (until the read answers) that it is loading, or that
  // the read failed.
  let value: string;
  if (account) {
    value = !account.email ? t('settings:email.none')
      : account.verified ? account.email
        : t('settings:email.rowUnverified', { email: account.email });
  } else {
    value = error ? t('settings:email.rowFailed') : t('settings:email.loading');
  }

  return (
    <div ref={root} data-account-email-form className="space-y-3">
      <GroupedList className="mx-0">
        <SignInRow
          title={t('settings:email.title')}
          value={<span role={account || error ? undefined : 'status'}>{value}</span>}
          action={account ? (open ? null : (
            <button type="button" className={ROW_ACTION} aria-expanded="false" onClick={openEditor}>
              {account.email ? t('settings:account.change') : t('settings:account.add')}
            </button>
          )) : error ? (
            <button type="button" className={ROW_ACTION} onClick={() => setReload((n) => n + 1)}>
              {t('core:common.tryAgain')}
            </button>
          ) : null}
        />
        {account && open ? (
          <div className={ROW_EDITOR}>
            <p className={EDITOR_NOTE}>{t('settings:email.intro')}</p>
            <p className={EDITOR_NOTE}>
              {account.recoveryAllowed
                ? t('settings:email.recoveryAllowed')
                : t('settings:email.recoveryNotAllowed')}
            </p>
            {/* Return in the address goes on to the password when one is asked
                for, and the last field sends (#3907: no keyboard chevrons). */}
            <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(!!pending); }}
              onKeyDown={returnKeyHandler()}>
              {pending ? <>
                <p className="break-words text-sm">{t('settings:email.verifyPrompt', { email: pending })}</p>
                <Label htmlFor="account-email-code">{t('settings:email.codeLabel')}</Label>
                <Input id="account-email-code" value={code} onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric" autoComplete="one-time-code" enterKeyHint="go" pattern="[0-9]{6}" maxLength={6} required disabled={busy} />
              </> : <>
                <Label htmlFor="account-email-address">{t('settings:email.addressLabel')}</Label>
                <Input id="account-email-address" type="email" autoComplete="email" autoCapitalize="none"
                  enterKeyHint={account.passwordRequired ? 'next' : 'send'}
                  value={email} onChange={(event) => setEmail(event.target.value)} maxLength={255} required disabled={busy} />
                {account.passwordRequired ? <>
                  <Label htmlFor="account-email-password">{t('settings:email.passwordLabel')}</Label>
                  <PasswordInput id="account-email-password" autoComplete="current-password" enterKeyHint="send" value={password}
                    onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
                </> : null}
              </>}
              <div className={EDITOR_ACTIONS}>
                <Button type="submit" variant="pillAccent" size="pill" disabled={busy}>
                  {busy ? t('settings:email.submit.busy') : pending ? t('settings:email.submit.verify') : t('settings:email.submit.sendCode')}
                </Button>
                <Button type="button" variant="pillNeutral" size="pill" ink="neutral" disabled={busy} onClick={closeEditor}>
                  {t('core:common.cancel')}
                </Button>
              </div>
              {pending ? <button type="button" className={ROW_ACTION} disabled={busy} onClick={() => {
                setPending(''); setCode(''); setMessage(''); setError('');
              }}>{t('settings:email.startOver')}</button> : null}
            </form>
          </div>
        ) : null}
      </GroupedList>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

export function EmailSection() {
  return <div data-settings-section="email" className="hidden"><EmailForm /></div>;
}
