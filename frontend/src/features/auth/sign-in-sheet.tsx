/**
 * Sign-in as a sheet: the email code, asked for over the screen that led
 * to it rather than on a screen of its own, so what you are joining stays in
 * view behind it. "Made for you" opens it from its Join button
 * (./invite-card.tsx), titled for the project.
 *
 * It is the same exchange as the sign-in screen's email-code panel
 * (./login.tsx), against the same routes:
 *
 *   email    POST /api/auth/otp/request sends a six-digit code.
 *   code     POST /api/auth/otp/verify. An account that has a password is
 *            signed straight in; a new one (or one with no password yet)
 *            moves on to
 *   account  POST /api/auth/otp/set-password: a password, and the username
 *            when the account has none, which mints the session.
 *
 * Continue with Apple and Continue with Google come first when an admin has
 * set them up (`providers`, from the waitlist options; never inside the
 * Homeroom app, whose web view the providers' pages refuse). Either leaves
 * the page for the provider (GET /api/auth/oauth/:provider/start) and comes
 * back to it signed in, or (`resume`) to this sheet: at
 *
 *   username POST /api/auth/oauth/finish, when the provider's sign-in made
 *            an account that has no username yet, which mints the session;
 *   or the first step again, with what went wrong.
 *
 * Every success ends in finishLogin(), so where the person lands is the
 * shell's decision (AuthScreens.finishLogin, then the invite link's path).
 * `followInvite` tells the verify route that this sign-in is the Join the
 * person just pressed on an invite's page: an account that already existed
 * follows the link too (routes/auth.js), rather than being asked again.
 *
 * A password sign-in stays on the sign-in screen (#login); the sheet's last
 * line goes there.
 *
 * Rendered in place inside the landing's React-owned tree (no portal, for
 * the reasons ui/dialog.tsx gives), closed by default, and only ever opened
 * by a tap — never in the first render — so the prerendered document is
 * unchanged.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { AppleIcon, GoogleIcon, XIcon } from '@/components/ui/icons';

import {
  blockedOffline,
  fetchSessionMint,
  finishLogin,
  HANDLE_FIELD,
  sessionMintFailureMessage,
  USERNAME_RULE,
} from './shared';

type Step = 'choose' | 'email' | 'code' | 'account' | 'username';

export type SignInProvider = 'apple' | 'google';

/** What the provider's way back left for the sheet (routes/sign-in-providers.js). */
export type SignInResume = 'username' | `error-${string}`;

// What went wrong at the provider, in words. The codes are the server's.
const RESUME_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  expired: 'That sign-in took too long, or started somewhere else. Try again.',
  no_verified_email: 'That account has no verified email address to sign in with. Use your email instead.',
  password_required: 'This account signs in with a password. Use "Sign in with a password" below.',
  admin_password_required: 'This admin account signs in with a password. Use "Sign in with a password" below.',
  linked_elsewhere: 'Your Homeroom account is linked to a different account there. Use your email instead.',
  logout_required: 'You are already signed in. Reload the page.',
};
const RESUME_FALLBACK = 'That did not work. Try again, or use your email.';

export function resumeError(resume: SignInResume | null | undefined): string | null {
  if (!resume || !resume.startsWith('error-')) return null;
  return RESUME_ERRORS[resume.slice('error-'.length)] || RESUME_FALLBACK;
}

/** Where the provider's sign-in starts: carries what the sheet knows across the trip. */
export function providerStartUrl(provider: SignInProvider, { from, followInvite, returnTo }: {
  from: 'invite' | 'story' | 'signin';
  followInvite: boolean;
  returnTo: string;
}): string {
  const params = new URLSearchParams({ from, return: returnTo });
  if (followInvite) params.set('follow', '1');
  return `/api/auth/oauth/${provider}/start?${params.toString()}`;
}

const PROVIDER_LABEL: Record<SignInProvider, string> = { apple: 'Apple', google: 'Google' };
// Apple's button is solid black (white on dark), Google's is white with a
// hairline, as their sign-in guidelines draw them; both the sheet's pill shape.
const PROVIDER_BUTTON: Record<SignInProvider, string> = {
  apple: 'flex h-[50px] w-full items-center justify-center gap-2 rounded-full bg-black text-[17px] font-semibold text-white dark:bg-white dark:text-black disabled:opacity-60',
  google: 'flex h-[50px] w-full items-center justify-center gap-2 rounded-full bg-white text-[17px] font-semibold text-zinc-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.15)] dark:bg-zinc-800 dark:text-zinc-100 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)] disabled:opacity-60',
};
const EMAIL_BUTTON = 'flex h-[50px] w-full items-center justify-center rounded-full bg-zinc-200 text-[17px] font-semibold text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 disabled:opacity-60';

// The server holds a second code back for this long (routes/auth.js); the
// resend counts it down rather than pretending to send.
const RESEND_COOLDOWN_MS = 60 * 1000;

const FIELD_GROUP = 'rounded-2xl bg-white dark:bg-zinc-800 overflow-hidden';
const FIELD = 'px-4 pt-3 pb-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-zinc-200 dark:[&:not(:last-child)]:border-zinc-700';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const INPUT = 'w-full border-0 bg-transparent px-0 py-1 text-[17px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 focus:outline-none';
const QUIET = 'py-1 text-[15px] font-medium text-violet-700 dark:text-violet-400 hover:underline';

export type SignInSheetProps = {
  open: boolean;
  /** "Join Sunday Run Club" */
  title: string;
  /** The line under the title on the first step. */
  intro: string;
  /** This sign-in is the Join pressed on an invite's page. */
  followInvite?: boolean;
  /** Apple and Google, when an admin has set them up; empty inside the app. */
  providers?: readonly SignInProvider[];
  /** Which screen opened it, carried across a provider's trip. */
  from?: 'invite' | 'story' | 'signin';
  /** Where a provider's trip comes back to: Home, or the invite link. */
  returnTo?: string;
  /** Back from a provider: the username step, or what went wrong. */
  resume?: SignInResume | null;
  /**
   * Runs once the session exists and before the shell takes over:
   * 'existing' for an account that signed straight in, 'new' for one that
   * just set its password (in practice, one the code just made).
   */
  beforeFinish?: (kind: 'existing' | 'new') => void | Promise<void>;
  onClose: () => void;
  primaryClass: string;
};

export function SignInSheet({
  open, title, intro, followInvite = false, providers = [], from = 'signin', returnTo = '/', resume = null,
  beforeFinish, onClose, primaryClass,
}: SignInSheetProps) {
  const firstStep: Step = providers.length ? 'choose' : 'email';
  const [step, setStep] = useState<Step>(firstStep);
  const [email, setEmail] = useState('');
  const [needsUsername, setNeedsUsername] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // Slides up one frame after it mounts, so the transition has a start.
  const [shown, setShown] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  const usernameField = useRef<HTMLInputElement>(null);
  const providerUsernameField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const confirmField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setShown(false); return undefined; }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // A fresh start each time it opens: the address stays, the rest goes. Back
  // from a provider, it opens where that left off.
  useEffect(() => {
    if (!open) return;
    setStep(resume === 'username' ? 'username' : firstStep);
    setError(resumeError(resume));
    setBusy(false);
  }, [open, resume, firstStep]);

  useEffect(() => {
    if (!open || step === 'choose') return;
    const field = step === 'email' ? firstField : step === 'code' ? codeField
      : step === 'username' ? providerUsernameField
        : (needsUsername ? usernameField : passwordField);
    field.current?.focus();
  }, [open, step, needsUsername]);

  // Back from the provider's page by the browser's Back button, the page can
  // come out of the back-forward cache as it was left: busy. Undo that.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) setBusy(false); };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  // Escape closes, like every sheet in the shell.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // The resend's countdown.
  useEffect(() => {
    if (!open || cooldownUntil <= Date.now()) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [open, cooldownUntil]);

  const requestCode = useCallback(async (address: string) => {
    setError(null);
    const value = address.trim().toLowerCase();
    if (!value || !value.includes('@')) { setError('Enter a valid email address'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      setEmail(value);
      if (!res.ok || !data.ok) {
        // A code went out a moment ago and is still the live one: the code
        // step is where they should be, with the resend held as long as the
        // limiter says.
        if (res.status === 429) {
          setStep('code');
          setError(data.error || 'Too many requests. Wait a moment and try again.');
          const retryAfter = Number(res.headers.get('Retry-After'));
          setCooldownUntil(Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 900) * 1000 : RESEND_COOLDOWN_MS));
          return;
        }
        setStep('email');
        setError(data.error || 'Could not send a code');
        return;
      }
      if (codeField.current) codeField.current.value = '';
      setStep('code');
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
      setNow(Date.now());
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, []);

  const verify = useCallback(async () => {
    setError(null);
    const code = (codeField.current?.value || '').trim();
    if (!code) { setError('Enter the code from the email'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetchSessionMint('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, code, ...(followInvite ? { followInvite: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (data.code === 'password_required' || data.code === 'admin_password_required') {
          setError(data.error || 'This account signs in with its password.');
          return;
        }
        setError(res.status === 429
          ? data.error || 'Too many code attempts. Try again shortly.'
          : data.error || 'Invalid or expired code.');
        return;
      }
      if (data.next === 'signed-in') {
        await beforeFinish?.('existing');
        await finishLogin();
        return;
      }
      setNeedsUsername(data.needsUsername === true);
      setCooldownUntil(0);
      setStep('account');
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [email, followInvite, beforeFinish]);

  const finishAccount = useCallback(async () => {
    setError(null);
    const handle = needsUsername ? (usernameField.current?.value || '').trim() : null;
    if (handle === '') { setError('Enter a username.'); usernameField.current?.focus(); return; }
    const password = passwordField.current?.value || '';
    const confirm = confirmField.current?.value || '';
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetchSessionMint('/api/auth/otp/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password, passwordConfirmation: confirm, ...(handle ? { username: handle } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) {
        setError(data.error || 'Could not finish setting up your account');
        if (data.field === 'username') usernameField.current?.focus();
        return;
      }
      await beforeFinish?.('new');
      await finishLogin();
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [needsUsername, beforeFinish]);

  // Off to the provider. The page leaves, so busy stays on until it does.
  const continueWith = useCallback((provider: SignInProvider) => {
    setError(null);
    if (blockedOffline(setError)) return;
    setBusy(true);
    window.location.assign(providerStartUrl(provider, { from, followInvite, returnTo }));
  }, [from, followInvite, returnTo]);

  const finishProviderAccount = useCallback(async () => {
    setError(null);
    const handle = (providerUsernameField.current?.value || '').trim();
    if (!handle) { setError('Enter a username.'); providerUsernameField.current?.focus(); return; }
    if (blockedOffline(setError)) return;
    setBusy(true);
    try {
      const res = await fetchSessionMint('/api/auth/oauth/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: handle }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user) {
        if (data.field === 'username') {
          setError(data.error || 'Choose another username.');
          providerUsernameField.current?.focus();
          return;
        }
        // The continuation is gone: start over from the first step.
        setStep(firstStep);
        setError(data.error || 'Your sign-in expired. Start again.');
        return;
      }
      await beforeFinish?.('new');
      await finishLogin();
    } catch (err) {
      setError(sessionMintFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }, [beforeFinish, firstStep]);

  if (!open) return null;

  const waitLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const heading = step === 'choose' || step === 'email' ? title
    : step === 'code' ? 'Check your email'
      : step === 'username' ? 'Pick a username' : 'Finish your account';
  const sub = step === 'choose' || (step === 'email' && !providers.length)
    ? intro
    : step === 'email'
      ? 'We\'ll email you a 6-digit code.'
      : step === 'code'
        ? `We sent a 6-digit code to ${email}. It expires in 10 minutes.`
        : step === 'username'
          ? 'Your username is public on Homeroom. It is how people @mention you.'
          : (needsUsername ? 'Pick a username and a password. Your username is public on Homeroom.' : 'Pick a password for next time.');

  return (
    <div data-sign-in-sheet={step} className="fixed inset-0 z-50">
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-in-sheet-title"
        className={`absolute inset-x-0 bottom-0 max-h-[92%] overflow-y-auto rounded-t-[20px] bg-zinc-100 dark:bg-zinc-900 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))] transition-transform duration-200 ease-out md:inset-x-auto md:left-1/2 md:bottom-auto md:top-1/2 md:w-full md:max-w-md md:rounded-[20px] md:pb-6 ${shown ? 'translate-y-0 md:-translate-x-1/2 md:-translate-y-1/2' : 'translate-y-full md:-translate-x-1/2 md:-translate-y-1/2'}`}
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-700 md:hidden" aria-hidden="true" />
        <div className="mt-3 flex items-center gap-3">
          <h2 id="sign-in-sheet-title" className="min-w-0 flex-1 text-[17px] font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
          >
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">{sub}</p>

        {step === 'choose' ? (
          <div className="mt-5 flex flex-col gap-2.5">
            {providers.map((provider) => (
              <button
                key={provider}
                type="button"
                data-sign-in-provider={provider}
                disabled={busy}
                className={PROVIDER_BUTTON[provider]}
                onClick={() => continueWith(provider)}
              >
                {provider === 'apple'
                  ? <AppleIcon className="h-[18px] w-[18px] -mt-0.5" aria-hidden="true" />
                  : <GoogleIcon className="h-[18px] w-[18px]" aria-hidden="true" />}
                {`Continue with ${PROVIDER_LABEL[provider]}`}
              </button>
            ))}
            <button type="button" data-sign-in-provider="email" disabled={busy} className={EMAIL_BUTTON} onClick={() => { setError(null); setStep('email'); }}>
              Continue with email
            </button>
          </div>
        ) : null}

        {step === 'email' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void requestCode(firstField.current?.value || ''); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-email" className={LABEL}>Email</label>
                <input ref={firstField} id="sign-in-sheet-email" type="email" autoComplete="email" inputMode="email" defaultValue={email} className={INPUT} {...HANDLE_FIELD} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`}>{busy ? 'Sending code…' : 'Send code'}</button>
            {providers.length ? (
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('choose'); }}>Other ways to continue</button>
            ) : null}
          </form>
        ) : null}

        {step === 'username' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishProviderAccount(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-provider-username" className={LABEL}>Username</label>
                <input ref={providerUsernameField} id="sign-in-sheet-provider-username" autoComplete="username" className={INPUT} placeholder={USERNAME_RULE} {...HANDLE_FIELD} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`}>{busy ? 'Finishing…' : 'Continue'}</button>
          </form>
        ) : null}

        {step === 'code' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <div className={FIELD_GROUP}>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-code" className={LABEL}>Code</label>
                <input ref={codeField} id="sign-in-sheet-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={`${INPUT} tracking-[0.4em]`} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`}>{busy ? 'Checking…' : 'Continue'}</button>
            <div className="flex items-center justify-between">
              <button type="button" className={QUIET} onClick={() => { setError(null); setStep('email'); }}>Use another email</button>
              <button type="button" className={`${QUIET} disabled:text-zinc-500 disabled:dark:text-zinc-400 disabled:no-underline`} disabled={busy || waitLeft > 0} onClick={() => { void requestCode(email); }}>
                {waitLeft > 0 ? `Send a new code in ${waitLeft}s` : 'Send a new code'}
              </button>
            </div>
          </form>
        ) : null}

        {step === 'account' ? (
          <form className="mt-5 flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void finishAccount(); }}>
            <div className={FIELD_GROUP}>
              {needsUsername ? (
                <div className={FIELD}>
                  <label htmlFor="sign-in-sheet-username" className={LABEL}>Username</label>
                  <input ref={usernameField} id="sign-in-sheet-username" autoComplete="username" className={INPUT} placeholder={USERNAME_RULE} {...HANDLE_FIELD} />
                </div>
              ) : null}
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-password" className={LABEL}>Password</label>
                <input ref={passwordField} id="sign-in-sheet-password" type="password" autoComplete="new-password" className={INPUT} placeholder="At least 8 characters" />
              </div>
              <div className={FIELD}>
                <label htmlFor="sign-in-sheet-confirm" className={LABEL}>Password again</label>
                <input ref={confirmField} id="sign-in-sheet-confirm" type="password" autoComplete="new-password" className={INPUT} />
              </div>
            </div>
            <button type="submit" disabled={busy} className={`${primaryClass} disabled:opacity-60`}>{busy ? 'Finishing…' : 'Continue'}</button>
          </form>
        ) : null}

        {error ? <p role="alert" className="mt-3 text-[14px] text-red-600 dark:text-red-400">{error}</p> : null}

        {step === 'choose' || step === 'email' ? (
          <p className="mt-4 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
            {'New to Homeroom? This makes your account. '}
            <a href="#login" onClick={onClose} className="font-medium text-violet-700 dark:text-violet-400 hover:underline">Sign in with a password</a>
          </p>
        ) : null}
      </div>
    </div>
  );
}
