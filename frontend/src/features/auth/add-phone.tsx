/**
 * "Join Best brunch spots now": a phone number for an account that is
 * waiting (./waiting.tsx). An invite makes a private member only of an
 * account with a verified phone (src/services/community-invites.js
 * joinAsPrivateMember), so somebody who made their account by email, or
 * before phones were asked for, waits in the queue with the links they
 * followed. This card adds the phone and, with it, lets them in to those
 * groups now, as the invite's own Join would have:
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

import { phoneRecaptchaToken } from './recaptcha';
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
const INPUT = 'w-full border-0 bg-transparent px-4 pt-1 pb-2 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
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
  const [resendAt, setResendAt] = useState(0);
  const session = useRef('');
  const phoneField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);

  const title = titleOverride || (groups.length === 1 ? `Join ${groups[0]} now` : 'Join them now');

  // `value` is the E.164 number the field built (./phone-input.tsx), or the
  // one sent before, for "Send a new code".
  async function requestCode(value: string) {
    setError(null);
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const recaptchaToken = await phoneRecaptchaToken();
      const res = await fetch('/api/auth/phone-link/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ phoneNumber: value, ...(recaptchaToken ? { recaptchaToken } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || typeof data.sessionInfo !== 'string') {
        setError(data.error || 'Could not send a code');
        return;
      }
      session.current = data.sessionInfo;
      setNumber(value);
      setResendAt(Date.now() + RESEND_MS);
      setStep('code');
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    const code = (codeField.current?.value || '').trim();
    if (!code) { setError('Enter the code from the text'); return; }
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
        setError(data.error || 'Invalid or expired code.');
        return;
      }
      onJoined(Array.isArray(data.joined) ? data.joined : []);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-add-phone={step} className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left">
      <h2 className="text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">{step === 'phone' ? title : 'Check your texts'}</h2>
      <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">
        {step === 'phone'
          ? lead || 'Add your phone number and you’re in, no waiting. The group sees your name, never your number.'
          : `We sent a 6-digit code to the number ending ${number.slice(-4)}.`}
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
            <label htmlFor="add-phone-number" className={LABEL}>Phone number</label>
            <PhoneInput inputRef={phoneField} id="add-phone-number" defaultValue={number} className="px-4 pb-1" />
          </div>
          <button type="submit" disabled={busy} className={PRIMARY}>{busy ? 'Sending code…' : 'Text me a code'}</button>
          <RecaptchaNotice />
        </form>
      ) : (
        <form key="code" className="mt-4 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
          <div className={FIELD_GROUP}>
            <label htmlFor="add-phone-code" className={LABEL}>Code</label>
            <input ref={codeField} id="add-phone-code" inputMode="numeric" autoComplete="one-time-code" enterKeyHint="go" maxLength={6} className={`${INPUT} tracking-[0.4em]`} />
          </div>
          <button type="submit" disabled={busy} className={PRIMARY}>{busy ? 'Checking…' : 'Continue'}</button>
          <div className="flex items-center justify-between">
            <button type="button" className={QUIET} onClick={() => { setError(null); setStep('phone'); }}>Use another number</button>
            <button type="button" className={QUIET} disabled={busy} onClick={() => { if (Date.now() >= resendAt) void requestCode(number); else setError('Wait a minute before asking for a new code.'); }}>
              Send a new code
            </button>
          </div>
        </form>
      )}
      {error ? <p role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
