/**
 * The sign-up form's opt-in boxes (#6044): "Send me Homeroom news by email"
 * and "Text me Homeroom news". Asked only where an account is being created
 * (the sign-in sheet's account, username and invite phone steps, the
 * full-page Welcome, the sign-in screen's set-password step), never when an
 * existing account signs in. Both start unticked: consent is something a
 * person gives, so a box that arrives ticked would not be one.
 *
 * Not a condition of anything: the account is made either way, and the
 * server saves a box only when it is ticked
 * (src/services/contact-preferences.js recordSignupChoices). Settings ›
 * Privacy › Email & texts changes either answer later.
 *
 * Each box's words go with a wording version on the server
 * (contact-preferences.js WORDING), recorded with the answer as proof of
 * what the person agreed to: change the words and that version together.
 */

import { useMessages } from '../../lib/i18n/react';

export type SignupOptInKind = 'email' | 'sms';

const BOX = 'mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 accent-violet-600 dark:border-zinc-600';

export function SignupOptIn({
  id,
  kind,
  checked,
  onChange,
}: {
  id: string;
  kind: SignupOptInKind;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const t = useMessages('auth');
  const label = kind === 'email' ? t('auth:signupOptIn.email') : t('auth:signupOptIn.sms');
  const note = kind === 'email' ? t('auth:signupOptIn.emailNote') : t('auth:signupOptIn.smsNote');
  return (
    <div data-signup-opt-in={kind} className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        className={BOX}
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        aria-describedby={`${id}-note`}
      />
      <label htmlFor={id} className="min-w-0 text-[14px] leading-snug text-zinc-700 dark:text-zinc-300">
        {label}
        <span id={`${id}-note`} className="mt-0.5 block text-[12px] text-zinc-500 dark:text-zinc-400">{note}</span>
      </label>
    </div>
  );
}
