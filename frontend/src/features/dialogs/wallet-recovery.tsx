import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Recovery for a pre-merge email account's current-season wallet.
 *
 * Native admission is still the only path that publishes wallet authority.
 * When that path reports that the seeded pool is empty, native-chrome.js
 * RECORDS the failure (NativeChrome.lastSessionFailure()) and nothing more;
 * Settings → Homeroom app → connection reads that record and offers a
 * "Connect existing wallet" button, whose press is the ONLY thing that opens
 * this dialog (Settings._openWalletRecovery → UsernodeReact.dialogs
 * .walletRecovery.open). It used to open itself — on a
 * `usernode:wallet-recovery-required` event and again on mount — and, since
 * admission is retried on every online / pageshow / visibilitychange, that
 * meant a modal nobody asked for popping up several times a session over a
 * minor feature. The dialog proves the legacy email through the existing OTP
 * service, asks the database transaction to move the wallet, then replays the
 * SAME native admission attempt. No handoff ticket or wallet secret enters
 * React.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useDialog } from './use-dialog';

/**
 * Settings passes the signed-in user's id so the dialog can notice a session
 * change under it (see stillOwns); a bare open() falls back to the current
 * user.
 */
interface RecoveryRequest {
  userId?: string;
}

interface ApiBody {
  ok?: boolean;
  success?: boolean;
  claimed?: boolean;
  error?: string;
  code?: string;
}

interface NativeChromeRecovery {
  recoverSessionAdmission?(): Promise<unknown>;
}

function nativeChrome(): NativeChromeRecovery | undefined {
  return (window as unknown as { NativeChrome?: NativeChromeRecovery }).NativeChrome;
}

function currentUserId(): string | null {
  const raw = window.App?.user?.id;
  const id = raw == null ? '' : String(raw);
  return /^[1-9][0-9]*$/.test(id) ? id : null;
}

async function readBody(response: Response): Promise<ApiBody> {
  try {
    return await response.json() as ApiBody;
  } catch {
    return {};
  }
}

function claimError(body: ApiBody): string {
  if (body.code === 'wallet_claim_requires_key_rotation') {
    return tr("core:that_wallet_was_already_installed_elsewhere_movi_ffd5a351");
  }
  return body.error || tr("core:could_not_connect_that_wallet_check_the_email_an_67ae3fc9");
}

export function WalletRecoveryDialog() {
  useUiLanguage();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const targetUserId = useRef<string | null>(null);
  const recoveryGeneration = useRef(0);
  const busyRef = useRef(false);

  const [busyAction, setBusyAction] = useState<'send' | 'claim' | 'resume' | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [claimed, setClaimed] = useState(false);

  function setBusy(action: 'send' | 'claim' | 'resume' | null) {
    busyRef.current = action !== null;
    setBusyAction(action);
  }

  function resetFields() {
    setBusy(null);
    setError('');
    setStatus('');
    setClaimed(false);
    if (emailRef.current) emailRef.current.value = '';
    if (codeRef.current) codeRef.current.value = '';
  }

  const dialog = useDialog<RecoveryRequest>('walletRecovery', {
    canClose: () => !busyRef.current,
    onOpen: (request) => {
      recoveryGeneration.current++;
      targetUserId.current = request?.userId || currentUserId();
      resetFields();
    },
    onClose: () => {
      recoveryGeneration.current++;
      targetUserId.current = null;
      resetFields();
    },
  });

  function stillOwns(userId: string, generation: number): boolean {
    return recoveryGeneration.current === generation
      && targetUserId.current === userId
      && currentUserId() === userId;
  }

  function forceClose() {
    recoveryGeneration.current++;
    targetUserId.current = null;
    setBusy(null);
    dialog.close();
  }

  // Nothing here OPENS the dialog — see the header comment. The one listener
  // left is the close: a sign-out (or any realm close) while the form is up
  // must not leave it addressing a user who is no longer signed in.
  useEffect(() => {
    const onRealmClose = () => forceClose();
    window.addEventListener('sv:native-realm-close', onRealmClose);
    return () => {
      window.removeEventListener('sv:native-realm-close', onRealmClose);
    };
  }, [dialog.close]);

  async function sendCode() {
    if (busyRef.current) return;
    const userId = targetUserId.current;
    const generation = recoveryGeneration.current;
    const email = emailRef.current?.value.trim().toLowerCase() || '';
    if (!userId || !stillOwns(userId, generation)) return forceClose();
    if (!email || !email.includes('@')) {
      setError(tr("core:enter_the_email_address_used_by_your_previous_ac_ff785d89"));
      return;
    }

    setError('');
    setStatus('');
    setBusy('send');
    try {
      const response = await fetch('/api/auth/otp/request', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const body = await readBody(response);
      if (!stillOwns(userId, generation)) return;
      if (!response.ok || body.ok !== true) {
        setError(body.error || tr("core:could_not_send_a_code_please_try_again_f98e4216"));
        return;
      }
      setStatus(tr("core:check_that_email_for_a_six_digit_code_7b4fb67e"));
      codeRef.current?.focus();
    } catch {
      if (stillOwns(userId, generation)) {
        setError(tr("core:could_not_send_a_code_please_try_again_f98e4216"));
      }
    } finally {
      if (recoveryGeneration.current === generation) setBusy(null);
    }
  }

  async function resumeNativeSession(userId: string, generation: number) {
    const chrome = nativeChrome();
    if (!chrome || typeof chrome.recoverSessionAdmission !== 'function') {
      setError(tr("core:update_the_homeroom_app_to_finish_connecting_thi_c8602377"));
      return;
    }

    setBusy('resume');
    const result = await chrome.recoverSessionAdmission().catch(() => null);
    if (!stillOwns(userId, generation)) return;
    if (!result) {
      setError(tr("core:the_wallet_is_connected_but_app_sign_in_did_not__15f8e3c6"));
      return;
    }
    setBusy(null);
    dialog.close();
  }

  async function claimWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const userId = targetUserId.current;
    const generation = recoveryGeneration.current;
    if (!userId || !stillOwns(userId, generation)) return forceClose();
    if (claimed) {
      await resumeNativeSession(userId, generation);
      if (recoveryGeneration.current === generation) setBusy(null);
      return;
    }

    const email = emailRef.current?.value.trim().toLowerCase() || '';
    const code = codeRef.current?.value.trim() || '';
    if (!email || !email.includes('@')) {
      setError(tr("core:enter_the_email_address_used_by_your_previous_ac_ff785d89"));
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError(tr("core:enter_the_six_digit_code_from_the_email_7863806d"));
      return;
    }

    setError('');
    setStatus('');
    setBusy('claim');
    try {
      const response = await fetch('/api/v4/mobile/wallet/claim', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const body = await readBody(response);
      if (!stillOwns(userId, generation)) return;

      // A concurrent tab may have completed the same recovery. The ordinary
      // native admission API is the authority on whether this user can now
      // enter, so a target-wallet conflict can safely take the same path.
      const ready = response.ok && body.success === true && body.claimed === true;
      if (!ready && body.code !== 'wallet_claim_conflict') {
        setError(claimError(body));
        return;
      }

      setClaimed(true);
      setStatus(tr("core:wallet_connected_finishing_app_sign_in_90abc292"));
      await resumeNativeSession(userId, generation);
    } catch {
      if (stillOwns(userId, generation)) {
        setError(tr("core:could_not_connect_that_wallet_please_try_again_1a49deb2"));
      }
    } finally {
      if (recoveryGeneration.current === generation) setBusy(null);
    }
  }

  return (
    <DialogRoot
      id="wallet-recovery-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        <h2 className="text-lg font-bold mb-1 text-zinc-900 dark:text-zinc-100"><Message id="core:connect_your_existing_wallet_28e3996e" /></h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4"><Message id="core:no_new_mobile_wallet_is_available_if_you_previou_666f7692" /></p>
        <form className="space-y-4" onSubmit={claimWallet}>
          <label className="block">
            <span className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="core:previous_account_email_b23674c7" /></span>
            <div className="flex gap-2">
              <Localized element={<Input
                ref={emailRef}
                type="email"
                autoComplete="email"
                width="flex"
                box="dialog"
                hint="muted"
                ring="seamless"
                disabled={claimed} placeholder={catalogText("core:you_example_com_53e6cdc3")}
              />} messages={{"placeholder":"core:you_example_com_53e6cdc3"}} />
              <Button
                type="button"
                layout="shrink"
                disabledStyle="block"
                disabled={busyAction !== null || claimed}
                onClick={sendCode}
              >
                <LocalizedValue render={() => (busyAction === 'send' ? tr("core:sending_b8ed5279") : tr("core:send_code_66a5b409"))} />
              </Button>
            </div>
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"><Message id="core:email_code_0adcdb5d" /></span>
            <Input
              ref={codeRef}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              box="dialog"
              hint="muted"
              ring="seamless"
              disabled={claimed}
              placeholder="123456"
            />
          </label>
          {status ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {status}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-red-700 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-3">
            <Button
              type="button"
              layout="flex"
              variant="neutral"
              ink="neutral"
              disabled={busyAction !== null}
              onClick={() => dialog.close()}
            ><Message id="core:cancel_19766ed6" /></Button>
            <Button
              type="submit"
              layout="flex"
              disabledStyle="block"
              disabled={busyAction !== null}
            >
              <LocalizedValue render={() => (busyAction === 'claim' || busyAction === 'resume'
                ? tr("core:connecting_72021eb7")
                : claimed ? tr("core:try_again_d8b8392e") : tr("core:connect_wallet_7b1f1181"))} />
            </Button>
          </div>
        </form>
      </DialogCard>
    </DialogRoot>
  );
}
