import { useMessages as useUiLanguage } from "../../../lib/i18n/react";
import { RichMessage } from "../../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../../lib/i18n/react";
import { t as tr } from "../../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';

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
  if (!response.ok) throw new Error(result.error || tr("settings:could_not_update_account_email_0b0c8b9e"));
  return result;
}

// Only the constant outer wrapper belongs to Settings' section router.
// Everything inside this component is React-owned, including async feedback.
function EmailForm() {
  useUiLanguage();
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
        setMessage(tr("settings:email_verified_and_linked_to_your_account_e1921e83"));
      } else {
        setPending(result.email);
        setMessage(tr("settings:check_your_inbox_for_a_six_digit_code_it_expires_d6f40d8c"));
      }
    } catch (err) {
      if (seq === generation.current) setError((err as Error).message);
    } finally {
      if (seq === generation.current) setBusy(false);
    }
  };

  return (
    <div data-account-email-form className="space-y-4">
      <Localized element={<SectionHeading title={catalogText("settings:email_recovery_4ee4c511")}><Message id="settings:link_a_private_email_address_to_help_you_get_bac_cbd3f673" /></SectionHeading>} messages={{"title":"settings:email_recovery_4ee4c511"}} />
      {!account && !error ? <p role="status"><Message id="settings:loading_account_email_fe67ad09" /></p> : null}
      {account ? <>
        <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 break-words">
          <p><LocalizedValue render={() => (account.email || tr("settings:no_email_linked_754cc606"))} /></p>
          {account.email ? <p className="text-sm text-zinc-500 dark:text-zinc-400">
            <LocalizedValue render={() => (account.verified ? tr("settings:verified_4f783840") : tr("settings:not_verified_verify_it_below_ab2039f4"))} />
          </p> : null}
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          <LocalizedValue render={() => (account.recoveryAllowed
            ? tr("settings:once_verified_use_this_email_to_sign_in_or_choos_6de309a2")
            : tr("settings:admin_accounts_cannot_use_email_sign_in_or_email_dc4b9774"))} />
        </p>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(!!pending); }}>
          {pending ? <>
            <p className="break-words"><RichMessage id="settings:sentence_de5d574f70d3" values={{ value1: pending }} /></p>
            <Label htmlFor="account-email-code"><Message id="settings:verification_code_3ee75029" /></Label>
            <Input id="account-email-code" value={code} onChange={(event) => setCode(event.target.value)}
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} />
          </> : <>
            <Label htmlFor="account-email-address"><Message id="settings:email_address_f2488fd4" /></Label>
            <Input id="account-email-address" type="email" autoComplete="email" autoCapitalize="none"
              value={email} onChange={(event) => setEmail(event.target.value)} maxLength={255} required disabled={busy} />
            {account.passwordRequired ? <>
              <Label htmlFor="account-email-password"><Message id="settings:current_password_72ed2bd7" /></Label>
              <PasswordInput id="account-email-password" autoComplete="current-password" value={password}
                onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
            </> : null}
          </>}
          <Button type="submit" variant="pillAccent" size="pillLg" disabled={busy}>
            <LocalizedValue render={() => (busy ? tr("settings:please_wait_4660a983") : pending ? tr("settings:verify_email_e89a77e7") : tr("settings:send_verification_code_19e86d2b"))} />
          </Button>
          {pending ? <Button type="button" disabled={busy} onClick={() => {
            setPending(''); setCode(''); setMessage(''); setError('');
          }}><Message id="settings:change_email_or_request_another_code_5dfc237e" /></Button> : null}
        </form>
      </> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {!account && error ? <Button onClick={() => setReload((value) => value + 1)}><Message id="settings:try_again_d8b8392e" /></Button> : null}
    </div>
  );
}

export function EmailSection() {
  return <div data-settings-section="email" className="hidden"><EmailForm /></div>;
}
