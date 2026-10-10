import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { WarningTriangleIcon } from '@/components/ui/icons';
import { ensureSettings } from './facade.js';
import { useMessages } from '../../lib/i18n/react';

export function DeleteAccount() {
  const t = useMessages('settings');
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
      if (!res.ok) throw new Error(data.error || t('settings:deleteAccount.loadFailed'));
      setPasswordRequired(data.passwordRequired);
    } catch (err: any) { setError(err.message || t('settings:deleteAccount.connectionError')); }
  }

  async function finish() {
    const settings = await ensureSettings();
    if (!settings || await settings.logout({ accountDeleted: true }) === false) {
      throw new Error(t('settings:deleteAccount.signOutFailed'));
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
      if (!res.ok) throw new Error(data.error || t('settings:deleteAccount.failed'));
      setDeleted(true); setPassword('');
      await finish();
    } catch (err: any) { setError(err.message || t('settings:deleteAccount.connectionError')); }
    finally { pending.current = false; setBusy(false); }
  }

  if (!open) return <Button type="button" variant="pillDanger" ink="dangerTint" layout="full" className="mt-2 flex items-center justify-center gap-2" onClick={() => void show()}><WarningTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{t('settings:deleteAccount.open')}</span></Button>;
  return <form onSubmit={remove} className="mt-4 rounded-xl border border-red-200 dark:border-red-900 p-4 space-y-3" aria-label={t('settings:deleteAccount.formName')}>
    <p className="font-semibold">{deleted ? t('settings:deleteAccount.deleted') : t('settings:deleteAccount.question')}</p>
    {!deleted && <>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('settings:deleteAccount.whatIsRemoved')}</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('settings:deleteAccount.whatStays')}</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('settings:deleteAccount.retention')}</p>
      {/* A failed check leaves passwordRequired null, so without this branch the
          loading line would sit beside the error forever with the submit
          disabled and no way back in (#2993). show() clears the error and
          re-arms the loading line; submit stays disabled until it succeeds. */}
      {passwordRequired === null ? (error ?
        <Button type="button" variant="pillNeutral" ink="neutral" onClick={() => void show()}>{t('core:common.tryAgain')}</Button> :
        <p role="status">{t('settings:deleteAccount.loading')}</p>) : passwordRequired ?
        <label className="block text-sm">{t('settings:deleteAccount.passwordLabel')}<PasswordInput autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required /></label> :
        <p className="text-sm">{t('settings:deleteAccount.recentSignIn')}</p>}
      <label className="block text-sm">{t('settings:deleteAccount.confirmLabel', { word: 'DELETE' })}<Input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="pillDanger" ink="dangerTint" disabled={busy || confirmation !== 'DELETE' || passwordRequired === null || (passwordRequired && !password)}>{busy ? t('settings:deleteAccount.submitting') : t('settings:deleteAccount.submit')}</Button>
        <Button type="button" disabled={busy} onClick={() => { setOpen(false); setConfirmation(''); setPassword(''); }}>{t('core:common.cancel')}</Button>
      </div>
    </>}
    {deleted && <Button type="button" onClick={() => void finish().catch(err => setError(err.message))}>{t('settings:deleteAccount.finishSignOut')}</Button>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
  </form>;
}
