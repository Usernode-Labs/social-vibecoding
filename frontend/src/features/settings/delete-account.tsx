import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { WarningTriangleIcon } from '@/components/ui/icons';
import { ensureSettings } from './facade.js';

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [passwordRequired, setPasswordRequired] = useState<boolean | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);

  async function show() {
    setOpen(true); setError(''); setPasswordRequired(null);
    try {
      const res = await fetch('/api/auth/account-deletion');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load account details.');
      setPasswordRequired(data.passwordRequired);
    } catch (err: any) { setError(err.message || 'Check your connection and try again.'); }
  }

  async function finish() {
    const settings = await ensureSettings();
    if (!settings || await settings.logout({ accountDeleted: true }) === false) {
      throw new Error('Your account is deleted. Retry signing out to clear this device.');
    }
  }

  async function remove(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const res = await fetch('/api/auth/account', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Account deletion failed.');
      setDeleted(true); setPassword('');
      await finish();
    } catch (err: any) { setError(err.message || 'Check your connection and try again.'); }
    finally { pending.current = false; setBusy(false); }
  }

  if (!open) return <Button type="button" variant="pillDanger" ink="dangerTint" layout="full" className="mt-2 flex items-center justify-center gap-2" onClick={() => void show()}><WarningTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" /><span>Delete account…</span></Button>;
  return <form onSubmit={remove} className="mt-4 rounded-xl border border-red-200 dark:border-red-900 p-4 space-y-3" aria-label="Delete account">
    <p className="font-semibold">{deleted ? 'Account deleted' : 'Permanently delete your account?'}</p>
    {!deleted && <>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Your profile, sign-in access and private account data will be removed. You will be signed out on all devices. This cannot be undone.</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Messages, shared attachments and public contributions stay available to other participants under “Deleted user.” Their contents are kept, including any personal information you shared in them.</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">Necessary financial and moderation records are retained without your account link. External cleanup may take longer. Copies in backups, other apps, GitHub or the blockchain follow their own retention rules.</p>
      {passwordRequired === null ? <p role="status">Loading account details…</p> : passwordRequired ?
        <label className="block text-sm">Current password<PasswordInput autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required /></label> :
        <p className="text-sm">For security, sign out and sign in again if you signed in more than 10 minutes ago.</p>}
      <label className="block text-sm">Type DELETE to confirm<Input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="pillDanger" ink="dangerTint" disabled={busy || confirmation !== 'DELETE' || passwordRequired === null || (passwordRequired && !password)}>{busy ? 'Deleting…' : 'Delete my account permanently'}</Button>
        <Button type="button" disabled={busy} onClick={() => { setOpen(false); setConfirmation(''); setPassword(''); }}>Cancel</Button>
      </div>
    </>}
    {deleted && <Button type="button" onClick={() => void finish().catch(err => setError(err.message))}>Finish signing out</Button>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
  </form>;
}
