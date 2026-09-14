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
  if (!response.ok) throw new Error(result.error || 'Could not update account email.');
  return result;
}

// Only the constant outer wrapper belongs to Settings' section router.
// Everything inside this component is React-owned, including async feedback.
function EmailForm() {
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
        setMessage('Email verified and linked to your account.');
      } else {
        setPending(result.email);
        setMessage('Check your inbox for a six-digit code. It expires in 10 minutes.');
      }
    } catch (err) {
      if (seq === generation.current) setError((err as Error).message);
    } finally {
      if (seq === generation.current) setBusy(false);
    }
  };

  return (
    <div data-account-email-form className="space-y-4">
      <SectionHeading title="Email & recovery">
        Link a private email address to help you get back into your account.
        It does not appear on your public profile.
      </SectionHeading>
      {!account && !error ? <p role="status">Loading account email…</p> : null}
      {account ? <>
        <div className="rounded-2xl bg-white dark:bg-zinc-900 px-4 py-3 break-words">
          <p>{account.email || 'No email linked'}</p>
          {account.email ? <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {account.verified ? 'Verified' : 'Not verified. Verify it below.'}
          </p> : null}
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {account.recoveryAllowed
            ? 'Once verified, use this email to sign in or choose “Forgot password?” on the sign-in screen.'
            : 'Admin accounts cannot use email sign-in or email password recovery. Keep your password safe.'}
        </p>
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void submit(!!pending); }}>
          {pending ? <>
            <p className="break-words">Verify {pending}. Your current email stays linked until this succeeds.</p>
            <Label htmlFor="account-email-code">Verification code</Label>
            <Input id="account-email-code" value={code} onChange={(event) => setCode(event.target.value)}
              inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy} />
          </> : <>
            <Label htmlFor="account-email-address">Email address</Label>
            <Input id="account-email-address" type="email" autoComplete="email" autoCapitalize="none"
              value={email} onChange={(event) => setEmail(event.target.value)} maxLength={255} required disabled={busy} />
            {account.passwordRequired ? <>
              <Label htmlFor="account-email-password">Current password</Label>
              <PasswordInput id="account-email-password" autoComplete="current-password" value={password}
                onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
            </> : null}
          </>}
          <Button type="submit" variant="pillAccent" size="pillLg" disabled={busy}>
            {busy ? 'Please wait…' : pending ? 'Verify email' : 'Send verification code'}
          </Button>
          {pending ? <Button type="button" disabled={busy} onClick={() => {
            setPending(''); setCode(''); setMessage(''); setError('');
          }}>Change email or request another code</Button> : null}
        </form>
      </> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {!account && error ? <Button onClick={() => setReload((value) => value + 1)}>Try again</Button> : null}
    </div>
  );
}

export function EmailSection() {
  return <div data-settings-section="email" className="hidden"><EmailForm /></div>;
}
