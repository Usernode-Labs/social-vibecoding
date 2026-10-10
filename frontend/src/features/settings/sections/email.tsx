import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';

import { useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { returnKeyHandler } from '../../../lib/return-to-next';

type AccountEmail = {
  email: string | null;
  verified: boolean;
  passwordRequired: boolean;
  recoveryAllowed: boolean;
};

async function api(action = '', body?: Record<string, string>) {
  const response = await fetch(`/api/me/email${action}`, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || translate('settings:email.requestFailed'));
  return result;
}

// Only the constant outer wrapper belongs to Settings' section router.
// Everything inside this component is React-owned, including async feedback.
function EmailForm() {
  const t = useMessages('settings');
  const [reload, setReload] = useState(0);
  const [account, setAccount] = useState<AccountEmail | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const seq = ++generation.current;
      setAccount(null); setPassword(''); setPending(''); setCode('');
      setMessage(''); setError(''); setBusy(false);
      void api().then((value: AccountEmail) => {
        if (seq !== generation.current) return;
        setAccount(value); setEmail(value.email || '');
      }).catch((err: Error) => {
        if (seq === generation.current) setError(err.message);
      });
    };
    const onSection = (event: Event) => {
      if ((event as CustomEvent).detail?.section === 'email') refresh();
      else { ++generation.current; setPassword(''); setPending(''); setCode(''); }
    };
    window.addEventListener('usernode:settings-section', onSection);
    refresh();
    return () => {
      ++generation.current;
      window.removeEventListener('usernode:settings-section', onSection);
    };
  }, [reload]);

  const submit = async (verify: boolean) => {
    const seq = generation.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api(verify ? '/verify' : '/request', verify
        ? { code } : { email, currentPassword: password });
      if (seq !== generation.current) return;
      setPassword(''); setCode('');
      if (verify) {
        setAccount(result); setPending(''); setEmail(result.email);
        setMessage(t('settings:email.verifiedNotice'));
      } else {
        setPending(result.email);
        setMessage(t('settings:email.codeSentNotice'));
      }
    } catch (err) {
      if (seq === generation.current) setError((err as Error).message);
    } finally {
      if (seq === generation.current) setBusy(false);
    }
  };

  return (
    <div data-account-email-form className="space-y-4">
      <SectionHeading title={t('settings:email.title')}>
        {t('settings:email.intro')}
      </SectionHeading>
      {!account && !error ? <p role="status">{t('settings:email.loading')}</p> : null}
      {account ? <>
        <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 break-words">
          <p>{account.email || t('settings:email.none')}</p>
          {account.email ? <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {account.verified ? t('settings:email.verified') : t('settings:email.notVerified')}
          </p> : null}
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {account.recoveryAllowed
            ? t('settings:email.recoveryAllowed')
            : t('settings:email.recoveryNotAllowed')}
        </p>
        {/* Return in the address goes on to the password when one is asked
            for, and the last field sends (#3907: no keyboard chevrons). */}
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(!!pending); }}
          onKeyDown={returnKeyHandler()}>
          {pending ? <>
            <p className="break-words">{t('settings:email.verifyPrompt', { email: pending })}</p>
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
          <Button type="submit" variant="pillAccent" size="pillLg" disabled={busy}>
            {busy ? t('settings:email.submit.busy') : pending ? t('settings:email.submit.verify') : t('settings:email.submit.sendCode')}
          </Button>
          {pending ? <Button type="button" disabled={busy} onClick={() => {
            setPending(''); setCode(''); setMessage(''); setError('');
          }}>{t('settings:email.startOver')}</Button> : null}
        </form>
      </> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {!account && error ? <Button onClick={() => setReload((value) => value + 1)}>{t('core:common.tryAgain')}</Button> : null}
    </div>
  );
}

export function EmailSection() {
  return <div data-settings-section="email" className="hidden"><EmailForm /></div>;
}
