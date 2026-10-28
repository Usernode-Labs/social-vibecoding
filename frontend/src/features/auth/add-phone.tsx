/**
 * "Join Best brunch spots now": a phone number for an account that is
 * waiting (./waiting.tsx). An invite makes a private member only of an
 * account with a verified phone or a confirmed email
 * (src/services/community-invites.js joinAsPrivateMember), so somebody
 * with neither (an address never confirmed) waits in the queue with the
 * links they followed. This card adds the phone and, with it, lets them in
 * to those groups now, as the invite's own Join would have:
 *
 *   phone  POST /api/auth/phone-link/request texts a code, after the same
 *          invisible reCAPTCHA as the sign-in sheet (./recaptcha.ts).
 *   code   POST /api/auth/phone-link/verify links the number to this
 *          account and follows its queued links again as a private member
 *          (routes/phone-auth.js). `onJoined` hears which groups it joined.
 *
 * Shown only when the server offers phone sign-in and the account has a
 * group waiting for it. Rendered after the waiting room's own reads, never
 * in the prerender.
 */

import { useRef, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';
import { CodeBoxes } from './code-boxes';
import { postPhoneCodeRequest } from './recaptcha';
import { blockedOffline } from './shared';
import { PhoneInput, readPhone } from './phone-input';
import { RecaptchaNotice } from './sign-in-sheet';

export type JoinedGroup = { slug: string; name: string };

const PRIMARY = `${buttonVariants({
  layout: 'full',
  variant: 'pillAccent',
  size: 'pillLg',
  ink: 'solidLate',
})} flex items-center justify-center disabled:opacity-60`;
const FIELD_GROUP = 'overflow-hidden rounded-2xl bg-zinc-50 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-800';
const LABEL = 'block px-4 pt-3 text-[13px] text-zinc-500 dark:text-zinc-400';
// The code step's label sits above the boxes rather than in a field card, so
// it carries its own spacing and no card padding.
const CODE_LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400 mb-1.5';
const QUIET = 'py-1 text-[15px] font-medium text-violet-700 dark:text-violet-400 hover:underline disabled:text-zinc-500 disabled:no-underline';

const RESEND_MS = 60 * 1000;

export function AddPhoneCard({ groups, title: titleOverride, lead, onJoined }: {
  /** The groups this account is queued for, the first named in the title. */
  groups: readonly string[];
  /** Instead of "Join … now": the verify sheet before a public vote (./verify-identity.tsx). */
  title?: string;
  lead?: string;
  onJoined: (joined: JoinedGroup[]) => void;
}) {
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [number, setNumber] = useState('');
  /** The digits in the code's boxes (./code-boxes.tsx), reset with each send. */
  const [codeValue, setCodeValue] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const session = useRef('');
  const phoneField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const t = useMessages('auth');

  const title = titleOverride || (groups.length === 1 ? t('auth:addPhone.titleOne', { community: groups[0] }) : t('auth:addPhone.titleSeveral'));

  // `value` is the E.164 number the field built (./phone-input.tsx), or the
  // one sent before, for "Send a new code".
  async function requestCode(value: string) {
    setError(null);
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const { res, data } = await postPhoneCodeRequest('/api/auth/phone-link/request', value);
      if (!res.ok || !data.ok || typeof data.sessionInfo !== 'string') {
        setError(data.error || t('auth:addPhone.sendFailed'));
        return;
      }
      session.current = data.sessionInfo;
      setNumber(value);
      // The keyed code form mounts empty, so its boxes start empty too.
      setCodeValue('');
      setResendAt(Date.now() + RESEND_MS);
      setStep('code');
    } catch {
      setError(t('auth:addPhone.networkError'));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    const code = (codeField.current?.value || '').trim();
    if (!code) { setError(t('auth:addPhone.codeMissing')); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/auth/phone-link/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionInfo: session.current, code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setError(data.error || t('auth:addPhone.codeRejected'));
        return;
      }
      onJoined(Array.isArray(data.joined) ? data.joined : []);
    } catch {
      setError(t('auth:addPhone.networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-add-phone={step} className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left">
      <h2 className="text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">{step === 'phone' ? title : t('auth:addPhone.codeTitle')}</h2>
      <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">
        {step === 'phone'
          ? lead || t('auth:addPhone.lead')
          : t('auth:addPhone.codeSent', { lastDigits: number.slice(-4) })}
      </p>
      {/* Keyed: the two forms are one ternary, so without a key React keeps
          the same uncontrolled <input> across the step and the number typed
          into it shows up in the Code field (#4143). */}
      {step === 'phone' ? (
        <form key="phone" className="mt-4 flex flex-col gap-3" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const read = await readPhone(phoneField.current);
          if (!read.ok) { setError(read.error); return; }
          void requestCode(read.e164);
        }}>
          <div className={FIELD_GROUP}>
            <label htmlFor="add-phone-number" className={LABEL}>{t('auth:addPhone.numberLabel')}</label>
            <PhoneInput inputRef={phoneField} id="add-phone-number" defaultValue={number} className="px-4 pb-1" />
          </div>
          <button type="submit" disabled={busy} className={PRIMARY}>{busy ? t('auth:addPhone.sending') : t('auth:addPhone.send')}</button>
          <RecaptchaNotice />
        </form>
      ) : (
        <form key="code" className="mt-4 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
          <div>
            <label htmlFor="add-phone-code" className={CODE_LABEL}>{t('auth:addPhone.codeLabel')}</label>
            <CodeBoxes id="add-phone-code" inputRef={codeField} digits={codeValue} onDigits={setCodeValue} />
          </div>
          <button type="submit" disabled={busy} className={PRIMARY}>{busy ? t('auth:addPhone.checking') : t('auth:addPhone.verify')}</button>
          <div className="flex items-center justify-between">
            <button type="button" className={QUIET} onClick={() => { setError(null); setCodeValue(''); setStep('phone'); }}>{t('auth:addPhone.changeNumber')}</button>
            <button type="button" className={QUIET} disabled={busy} onClick={() => { if (Date.now() >= resendAt) void requestCode(number); else setError(t('auth:addPhone.resendTooSoon')); }}>
              {t('auth:addPhone.resend')}
            </button>
          </div>
        </form>
      )}
      {error ? <p role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
