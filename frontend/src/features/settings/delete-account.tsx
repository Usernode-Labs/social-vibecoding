import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { WarningTriangleIcon } from '@/components/ui/icons';
import { ensureSettings } from './facade.js';

export function DeleteAccount() {
  useUiLanguage();
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
      if (!res.ok) throw new Error(data.error || tr("settings:could_not_load_account_details_26b8969f"));
      setPasswordRequired(data.passwordRequired);
    } catch (err: any) { setError(err.message || tr("settings:check_your_connection_and_try_again_481859b6")); }
  }

  async function finish() {
    const settings = await ensureSettings();
    if (!settings || await settings.logout({ accountDeleted: true }) === false) {
      throw new Error(tr("settings:your_account_is_deleted_retry_signing_out_to_cle_a68357ed"));
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
      if (!res.ok) throw new Error(data.error || tr("settings:account_deletion_failed_4ab5c712"));
      setDeleted(true); setPassword('');
      await finish();
    } catch (err: any) { setError(err.message || tr("settings:check_your_connection_and_try_again_481859b6")); }
    finally { pending.current = false; setBusy(false); }
  }

  if (!open) return <Button type="button" variant="pillDanger" ink="dangerTint" layout="full" className="mt-2 flex items-center justify-center gap-2" onClick={() => void show()}><WarningTriangleIcon className="h-4 w-4 shrink-0" aria-hidden="true" /><span><Message id="settings:delete_account_619e3be2" /></span></Button>;
  return <Localized element={<form onSubmit={remove} className="mt-4 rounded-xl border border-red-200 dark:border-red-900 p-4 space-y-3" aria-label={catalogText("settings:delete_account_a2e20a33")}>
    <p className="font-semibold"><LocalizedValue render={() => (deleted ? tr("settings:account_deleted_5d670c14") : tr("settings:permanently_delete_your_account_79594f2e"))} /></p>
    {!deleted && <>
      <p className="text-sm text-zinc-600 dark:text-zinc-400"><Message id="settings:your_account_is_anonymised_not_erased_your_name__c42108fe" /></p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400"><Message id="settings:messages_votes_shared_attachments_and_public_con_7be3ec0d" /></p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400"><Message id="settings:necessary_financial_and_moderation_records_are_r_d903f070" /></p>
      {/* A failed check leaves passwordRequired null, so without this branch the
          loading line would sit beside the error forever with the submit
          disabled and no way back in (#2993). show() clears the error and
          re-arms the loading line; submit stays disabled until it succeeds. */}
      {passwordRequired === null ? (error ?
        <Button type="button" variant="pillNeutral" ink="neutral" onClick={() => void show()}><Message id="settings:try_again_d8b8392e" /></Button> :
        <p role="status"><Message id="settings:loading_account_details_135a022f" /></p>) : passwordRequired ?
        <label className="block text-sm"><Message id="settings:current_password_72ed2bd7" /><PasswordInput autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} required /></label> :
        <p className="text-sm"><Message id="settings:for_security_sign_out_and_sign_in_again_if_you_s_210573d4" /></p>}
      <label className="block text-sm"><Message id="settings:type_delete_to_confirm_d4856f41" /><Input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="pillDanger" ink="dangerTint" disabled={busy || confirmation !== 'DELETE' || passwordRequired === null || (passwordRequired && !password)}><LocalizedValue render={() => (busy ? tr("settings:deleting_43b5894c") : tr("settings:delete_my_account_permanently_e65fb685"))} /></Button>
        <Button type="button" disabled={busy} onClick={() => { setOpen(false); setConfirmation(''); setPassword(''); }}><Message id="settings:cancel_19766ed6" /></Button>
      </div>
    </>}
    {deleted && <Button type="button" onClick={() => void finish().catch(err => setError(err.message))}><Message id="settings:finish_signing_out_dad9ac67" /></Button>}
    {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
  </form>} messages={{"aria-label":"settings:delete_account_a2e20a33"}} />;
}
