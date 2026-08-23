/**
 * `#auth-login-screen` — the password form plus the three sub-views that share
 * its card (#1080, step 2 chunk C, screen 2 of 6).
 *
 * One screen element, four views, exactly as `public/js/auth-screens.js` had
 * it: `#login` shows the password form (with the optional wallet fast path
 * above it), `#signup` opens `#otp-view` (the email-code path, which is also
 * the account-creation path), "Forgot password?" opens `#recovery-view`, and
 * `#reset-password/<token>` opens `#reset-password-view`. The router calls one
 * per-route hook per navigation and the hook picks the view; here that is a
 * single `view` state and every `hidden` below is derived from it, so the four
 * views cannot be open at once no matter which order the hooks fire in.
 *
 * ── Like-for-like, including what is NOT in the shipped markup ─────────
 *
 * The ids, class strings, `hidden` semantics and `data-*` attributes are the
 * hand-written shell's, because `dapp.json` selects on them
 * (`body.is-offline #auth-login-screen:not(.hidden) .offline-only`) and
 * `public/css/app.css` styles `[data-offline-disabled]` / `.offline-only` /
 * `[data-auth-back]` by attribute.
 *
 * Two blocks are deliberately NOT in the initial render: `#recovery-email` (the
 * emailed-reset request form) and `#reset-password-view` (the redeem view the
 * emailed link lands on). `_ensureResetUi()` built both at runtime because the
 * shell's markup was frozen when the email reset shipped, and they stay out of
 * the prerendered document for the same reason it matters here: the id baseline
 * (`tests/baselines/shell-markup.json`) records what the hand-written shell
 * shipped, and this chunk is a conversion, not a markup change. So `resetUi`
 * starts false and flips on the first `ensureResetUi()` — the same trigger, the
 * same insertion points, the same class strings, and it also swaps
 * `#recovery-admin`'s lead paragraph to the "no confirmed email?" copy the way
 * the runtime build did.
 *
 * ── Inputs are uncontrolled ───────────────────────────────────────────
 *
 * Every field is read by ref on submit, never bound to state. React renders
 * `value=""` for a controlled input, which would show up in the prerendered
 * markup; the shipped markup has no `value` attribute, and a credential field
 * has no reason to re-render the screen per keystroke.
 *
 * ── One documented behaviour difference ───────────────────────────────
 *
 * The wallet block's visibility is derived (`view === 'base' && walletUi`)
 * rather than written when the probe resolves. The legacy probe unhid
 * `#wallet-auth` whenever `#otp-view` and `#recovery-view` happened to be
 * hidden at that moment — which included the reset view, so a probe that
 * resolved while `#reset-password/<token>` was open dropped the wallet block on
 * top of it. Deriving it cannot do that.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { KeyIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  AUTH_SCREEN_IDS,
  blockedOffline,
  finishLogin,
  hiddenFirst,
  hiddenLast,
  isNative,
  legacy,
  useAuthScreensPatch,
} from './shared';

/** Which of the four views on this screen is showing. */
type LoginView = 'base' | 'otp' | 'recovery' | 'reset';

/** Step within `#otp-view`. */
type OtpStep = 'email' | 'code' | 'password';

/** Which reset path the recovery view offers. */
type RecoveryPath = 'wallet' | 'email';

// Class strings shared by the sub-views' fields. Copied verbatim from the
// hand-written markup (and, for the two lazily-mounted blocks, from the
// runtime build that used the same constants), so the compiled Tailwind
// already covers every one of them.
const P = 'text-sm text-zinc-500 dark:text-zinc-400';
const LABEL = 'block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1';
const QUIET_BUTTON = 'w-full text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-300';

/**
 * What the retired `BUTTON` class constant is now: the same string, spelled as
 * <Button> props. `w-full rounded-lg bg-violet-600 hover:bg-violet-500 px-4
 * py-2 font-medium transition-colors text-white` — note `size="plain"` (these
 * forms set no text size of their own) and `ink="solidLate"` (the auth screens
 * write the colour after the transition; see button.tsx's header).
 *
 * Spread rather than repeated so the nine call sites stay a single decision,
 * exactly as the class constant made them.
 */
const SOLID = { layout: 'full', size: 'plain', ink: 'solidLate' } as const;

/**
 * And the retired `INPUT` class constant, likewise: `w-full rounded-lg
 * bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700
 * px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-500
 * focus:outline-none focus:ring-2 focus:ring-violet-500`.
 */
const FIELD = { box: 'auth', hint: 'dim' } as const;

/**
 * The login form's own two fields, which are the auth box again but with the
 * dialogs' lighter placeholder and the ring that also clears the border. Two
 * spellings of one field, hand-authored apart; kept apart here for the same
 * reason input.tsx keeps `default` and `auth` apart.
 */
const AUTHFIELD = { box: 'auth', hint: 'muted', ring: 'seamless' } as const;
const ERROR = 'text-red-400 text-sm';
const STATUS = 'text-sm text-zinc-400';

const EXPIRED_MSG =
  'This reset link is invalid or has expired. Go back to login and request a new one from "Forgot password?".';

/**
 * The emailed-reset confirmation is a success state, not ambient status text:
 * a green-tinted rounded box (both palettes) so "the link was sent" is
 * unmistakable. Whole class literals — the Tailwind extractor is a regex.
 */
const SENT_BOX =
  'rounded-lg border border-green-300 bg-green-100 px-3 py-2 text-sm font-medium text-green-800 dark:border-green-800 dark:bg-green-950/60 dark:text-green-300';
/** Anti-enumeration: the same copy whether or not the address matched. */
const SENT_MSG =
  'If that address matches an account, a reset link is on its way. It expires in 30 minutes.';

/** The pre-email copy the frozen markup shipped, and its replacement. */
const ADMIN_LEAD_SHIPPED =
  "Accounts here have no email on file, so a password can't be reset automatically from the web.";
const ADMIN_LEAD_WITH_EMAIL =
  'No confirmed email on your account? The link above can only go to a confirmed address — but an admin can still get you back in.';

export function LoginScreen() {
  const rootRef = useRef<HTMLElement>(null);
  useVisibilityHiddenClass(rootRef, AUTH_SCREEN_IDS.login, false);

  // Everything below starts at the value the prerendered markup shipped with:
  // the base view, no wallet, no errors, and the reset UI unbuilt.
  const [view, setView] = useState<LoginView>('base');
  const [otpStep, setOtpStep] = useState<OtpStep>('email');
  const [recoveryPath, setRecoveryPath] = useState<RecoveryPath>('email');
  const [resetUi, setResetUi] = useState(false);
  const [walletUi, setWalletUi] = useState(false);
  const [walletControls, setWalletControls] = useState(false);

  const [loginError, setLoginError] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpStatus, setOtpStatus] = useState<string | null>(null);
  const [otpEmailEcho, setOtpEmailEcho] = useState('');
  const [walletError, setWalletError] = useState<string | null>(null);
  const [walletStatus, setWalletStatus] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [emailResetError, setEmailResetError] = useState<string | null>(null);
  const [emailResetStatus, setEmailResetStatus] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Non-render state, mirroring the legacy module's fields one for one.
  const st = useRef({
    walletPubkey: null as string | null,
    cachedChallenge: null as string | null,
    walletLinked: false,
    walletDetectRan: false,
    resetToken: null as string | null,
    otpEmail: null as string | null,
    otpSetPasswordToken: null as string | null,
  }).current;

  // The probe resolves long after its own render, and it needs the view that is
  // showing THEN. Assigned during render so it is never a frame stale.
  const viewRef = useRef(view);
  viewRef.current = view;

  const username = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const otpEmailInput = useRef<HTMLInputElement>(null);
  const otpCode = useRef<HTMLInputElement>(null);
  const otpNewPassword = useRef<HTMLInputElement>(null);
  const otpConfirmPassword = useRef<HTMLInputElement>(null);
  const recoveryNewPassword = useRef<HTMLInputElement>(null);
  const recoveryConfirmPassword = useRef<HTMLInputElement>(null);
  const recoveryEmailInput = useRef<HTMLInputElement>(null);
  const resetNewPassword = useRef<HTMLInputElement>(null);
  const resetConfirmPassword = useRef<HTMLInputElement>(null);

  // ── View switching (the router's per-route hooks) ─────────────────────

  const showLoginBaseView = useCallback(() => {
    setView('base');
  }, []);

  const otpShowStep = useCallback((step: OtpStep) => {
    setOtpError(null);
    setOtpStep(step);
  }, []);

  const showOtpView = useCallback(() => {
    setOtpStatus(null);
    otpShowStep('email');
    setView('otp');
  }, [otpShowStep]);

  /**
   * The lazily-mounted half of the reset UI (see the file header). Idempotent,
   * like the `_resetUiBuilt` guard it replaces.
   */
  const ensureResetUi = useCallback(() => {
    setResetUi(true);
  }, []);

  const showRecovery = useCallback(() => {
    setRecoveryError(null);
    setRecoveryStatus(null);
    ensureResetUi();
    // Wallet self-reset only when in the native app with a linked wallet;
    // everyone else gets the emailed magic link, with the admin-temporary-
    // password instructions as the fallback below it.
    setRecoveryPath(isNative() && st.walletPubkey && st.walletLinked ? 'wallet' : 'email');
    setView('recovery');
  }, [ensureResetUi, st]);

  /**
   * Per-route side effect for `#reset-password/<token>`. The inputs it clears
   * may not be mounted yet on the first call — `ensureResetUi()` has only just
   * queued their render — and that is fine: a fresh mount is empty, and a
   * `resetError` set now paints with them.
   */
  const resetOnShow = useCallback(
    (token?: string) => {
      ensureResetUi();
      st.resetToken = token || null;
      setResetError(null);
      setResetStatus(null);
      if (resetNewPassword.current) resetNewPassword.current.value = '';
      if (resetConfirmPassword.current) resetConfirmPassword.current.value = '';
      setView('reset');
      // A mangled link can be refused without a round trip — same message the
      // server would return.
      if (!st.resetToken || !/^[0-9a-f]{64}$/.test(st.resetToken)) {
        setResetError(EXPIRED_MSG);
      }
    },
    [ensureResetUi, st],
  );

  // ── The wallet fast-path probe ───────────────────────────────────────
  //
  // Strictly OPTIONAL and additive: the standard login form stays visible
  // throughout, and every failure mode (no wallet in a fresh shell, transport
  // error, non-genesis, unlinked) quietly leaves the standard form as the only
  // option. Wallet custody follows platform login (custodial provisioning over
  // the bridge), so a wallet-less shell at login time is the NORMAL state, not
  // an error.
  const walletDetect = useCallback(async () => {
    const w = legacy();
    if (!isNative()) return;
    try {
      st.walletPubkey = (await w.getNodeAddress?.()) || null;
    } catch (e) {
      console.warn(
        '[auth-login] no native wallet available:',
        e instanceof Error ? e.message : e,
      );
      return;
    }
    if (!st.walletPubkey) return;

    try {
      const checkRes = await fetch('/api/auth/wallet-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: st.walletPubkey }),
      });
      const checkData = await checkRes.json();
      if (!checkRes.ok) {
        console.warn('[auth-login] wallet-check failed (HTTP ' + checkRes.status + ')');
        return;
      }

      // Track link status independent of the genesis gate: password RESET is
      // allowed for any linked wallet (no genesis requirement, issue #282).
      // This lets a linked non-genesis wallet still reach the wallet-reset path
      // from "Forgot password?".
      st.walletLinked = checkData.status === 'linked';

      // Only a linked, genesis wallet gets the sign-in fast path.
      if (checkData.isGenesis === false) return;
      if (checkData.status !== 'linked' || !checkData.challenge) return;

      st.cachedChallenge = checkData.challenge;
      setWalletUi(true);
      // Don't fight the email-code / recovery sub-views if one is open (e.g.
      // arrived on #signup) — the base view brings the wallet UI back with it.
      if (viewRef.current === 'base') setWalletControls(true);
    } catch (e) {
      console.warn('[auth-login] wallet probe failed:', e instanceof Error ? e.message : e);
    }
  }, [st]);

  const loginOnShow = useCallback(
    (openSignup?: boolean) => {
      // Reset to the requested base view every time the route changes — login
      // ↔ signup share the screen element.
      if (openSignup) showOtpView();
      else showLoginBaseView();
      // Screenshot-state deep link (`?shot=password-recovery#login`): boots
      // straight into the forgot-password view, pinned to the emailed-link
      // path so the shot is deterministic regardless of wallet state
      // (issue #1158). Same idiom as ?shot=waitlist-joined; display-only,
      // no writes, so it works in every environment.
      let shot: string | null = null;
      try {
        shot = new URLSearchParams(location.search).get('shot');
      } catch {
        shot = null;
      }
      if (!openSignup && (shot === 'password-recovery' || shot === 'password-recovery-sent')) {
        showRecovery();
        setRecoveryPath('email');
        // `password-recovery-sent` also paints the post-submit confirmation
        // so the green success box is URL-reachable for screenshots and
        // checks. Display-only, no writes, works in every environment.
        setEmailResetStatus(shot === 'password-recovery-sent' ? SENT_MSG : null);
      }
      // Wallet detection runs once, the first time the screen appears (needs
      // the native bridge; quietly does nothing on desktop web).
      if (!st.walletDetectRan) {
        st.walletDetectRan = true;
        void walletDetect();
      }
    },
    [showLoginBaseView, showOtpView, showRecovery, st, walletDetect],
  );

  // ── Password login ───────────────────────────────────────────────────

  const onLoginSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoginError(null);
    if (blockedOffline(setLoginError)) return;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.current?.value.trim() || '',
          password: password.current?.value || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Login failed');
        return;
      }
      finishLogin();
    } catch {
      setLoginError('Network error');
    }
  }, []);

  // ── Email-code sign-in (the #signup route) ───────────────────────────
  //
  // Steps: request a code (public v4 endpoint, also creates the account at
  // verify time) → verify → choose a password → immediately log in with it for
  // the web session.

  const otpRequestCode = useCallback(async () => {
    setOtpError(null);
    const email = (otpEmailInput.current?.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setOtpError('Enter a valid email address');
      return;
    }
    if (blockedOffline(setOtpError)) return;
    setOtpStatus('Sending code...');
    try {
      const res = await fetch('/api/v4/mobile/auth/otp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      setOtpStatus(null);
      if (!res.ok || !data.success) {
        setOtpError(data.error || 'Could not send a code');
        return;
      }
      st.otpEmail = email;
      setOtpEmailEcho(email);
      if (otpCode.current) otpCode.current.value = '';
      otpShowStep('code');
    } catch {
      setOtpStatus(null);
      setOtpError('Network error');
    }
  }, [otpShowStep, st]);

  const onOtpResend = useCallback(async () => {
    // Same request, from the code step — jump back visually so the user sees
    // the send happen, then land back on the code entry.
    if (otpEmailInput.current) otpEmailInput.current.value = st.otpEmail || '';
    await otpRequestCode();
  }, [otpRequestCode, st]);

  const onOtpVerify = useCallback(async () => {
    setOtpError(null);
    const code = (otpCode.current?.value || '').trim();
    if (!code) {
      setOtpError('Enter the code from the email');
      return;
    }
    if (blockedOffline(setOtpError)) return;
    setOtpStatus('Verifying...');
    try {
      const res = await fetch('/api/v4/mobile/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: st.otpEmail, code }),
      });
      const data = await res.json();
      setOtpStatus(null);
      if (!res.ok || !data.success || !data.set_password_token) {
        // The server's one generic message covers wrong/expired codes — and
        // also accounts that already have a password (they must use the
        // password form instead). Say both.
        setOtpError(
          (data.error || 'Invalid or expired code.') +
            ' If your account already has a password, sign in with it instead.',
        );
        return;
      }
      st.otpSetPasswordToken = data.set_password_token;
      otpShowStep('password');
    } catch {
      setOtpStatus(null);
      setOtpError('Network error');
    }
  }, [otpShowStep, st]);

  const onOtpSetPassword = useCallback(async () => {
    setOtpError(null);
    const value = otpNewPassword.current?.value || '';
    const confirm = otpConfirmPassword.current?.value || '';
    if (value.length < 8) {
      setOtpError('Password must be at least 8 characters');
      return;
    }
    if (value !== confirm) {
      setOtpError('Passwords do not match');
      return;
    }
    if (blockedOffline(setOtpError)) return;
    setOtpStatus('Setting password...');
    try {
      const res = await fetch('/api/v4/mobile/auth/set-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + st.otpSetPasswordToken,
        },
        body: JSON.stringify({ password: value, password_confirmation: confirm }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setOtpStatus(null);
        setOtpError(data.error || 'Could not set the password');
        return;
      }
      st.otpSetPasswordToken = null;
      // Password is set — now open the WEB session with it (the v4 token in
      // `data.token` is a mobile bearer, not a cookie; the shell mints its own
      // via /from-session after this login).
      setOtpStatus('Signing you in...');
      const loginRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: st.otpEmail, password: value }),
      });
      const loginData = await loginRes.json();
      if (!loginRes.ok) {
        setOtpStatus(null);
        setOtpError(loginData.error || 'Sign-in failed — try the password form');
        return;
      }
      setOtpStatus('Signed in!');
      finishLogin();
    } catch {
      setOtpStatus(null);
      setOtpError('Network error');
    }
  }, [st]);

  // ── Wallet sign-in ───────────────────────────────────────────────────

  const onWalletSignIn = useCallback(async () => {
    setWalletError(null);
    if (blockedOffline(setWalletError)) return;
    setWalletStatus('Verifying identity...');
    setWalletControls(false);

    const fail = (msg: string) => {
      setWalletStatus('');
      setWalletControls(true);
      setWalletError(msg);
    };

    try {
      if (!st.cachedChallenge) {
        const checkRes = await fetch('/api/auth/wallet-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pubkey: st.walletPubkey }),
        });
        const checkData = await checkRes.json();
        st.cachedChallenge = checkData.challenge;
      }

      if (!st.cachedChallenge) {
        fail('Could not get challenge from server');
        return;
      }

      const sigResult = await legacy().signMessage!(st.cachedChallenge);
      const verifyRes = await fetch('/api/auth/wallet-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: st.walletPubkey,
          publicKey: sigResult.publicKey,
          challenge: st.cachedChallenge,
          signature: sigResult.signature,
        }),
      });
      const verifyData = await verifyRes.json();
      st.cachedChallenge = null;

      if (verifyRes.ok) {
        setWalletStatus('Logged in!');
        finishLogin();
        return;
      }
      fail(verifyData.error || 'Verification failed');
    } catch (e) {
      st.cachedChallenge = null;
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.includes('denied')) fail('Signature request was denied.');
      else fail('Signature failed: ' + message);
    }
  }, [st]);

  // ── Wallet password reset (issue #282) ───────────────────────────────

  const onWalletReset = useCallback(async () => {
    setRecoveryError(null);
    const value = recoveryNewPassword.current?.value || '';
    const confirm = recoveryConfirmPassword.current?.value || '';
    if (value.length < 8) {
      setRecoveryError('Password must be at least 8 characters');
      return;
    }
    if (value !== confirm) {
      setRecoveryError('Passwords do not match');
      return;
    }
    setRecoveryStatus('Verifying identity...');
    try {
      // Get a fresh challenge — the sign-in cached one may be consumed or
      // absent. wallet-check returns one for any linked wallet.
      const checkRes = await fetch('/api/auth/wallet-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pubkey: st.walletPubkey }),
      });
      const checkData = await checkRes.json();
      const challenge = checkData.challenge;
      if (!challenge) {
        setRecoveryStatus(null);
        setRecoveryError('Could not get a challenge from the server');
        return;
      }

      const sigResult = await legacy().signMessage!(challenge);
      const res = await fetch('/api/auth/wallet-reset-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: st.walletPubkey,
          publicKey: sigResult.publicKey,
          challenge,
          signature: sigResult.signature,
          newPassword: value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRecoveryStatus(null);
        setRecoveryError(data.error || 'Reset failed');
        return;
      }
      setRecoveryStatus('Password reset! Signing you in...');
      finishLogin();
    } catch (e) {
      setRecoveryStatus(null);
      const message = e instanceof Error ? e.message : String(e);
      if (message && message.includes('denied')) {
        setRecoveryError('Signature request was denied.');
      } else {
        setRecoveryError('Reset failed: ' + message);
      }
    }
  }, [st]);

  // ── Emailed password reset (magic link) ──────────────────────────────

  const onEmailReset = useCallback(async () => {
    setEmailResetError(null);
    setEmailResetStatus(null);
    if (blockedOffline(setEmailResetError)) return;
    const email = (recoveryEmailInput.current?.value || '').trim();
    if (!email || email.indexOf('@') === -1) {
      setEmailResetError('Enter the email address on your account');
      return;
    }
    setBusy('btn-email-reset');
    try {
      const res = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setEmailResetError(data.error || 'Could not send the link — try again in a minute');
        return;
      }
      // Anti-enumeration: the server answers the same whether or not the
      // address matched, and so does this copy.
      setEmailResetStatus(SENT_MSG);
    } catch {
      setEmailResetError('Network error');
    } finally {
      setBusy(null);
    }
  }, []);

  const onResetConfirm = useCallback(async () => {
    setResetError(null);
    setResetStatus(null);
    if (blockedOffline(setResetError)) return;
    const value = resetNewPassword.current?.value || '';
    const confirm = resetConfirmPassword.current?.value || '';
    if (value.length < 8) {
      setResetError('Password must be at least 8 characters');
      return;
    }
    if (value !== confirm) {
      setResetError('Passwords do not match');
      return;
    }
    setBusy('btn-reset-confirm');
    try {
      const res = await fetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: st.resetToken, newPassword: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResetError(res.status === 401 ? EXPIRED_MSG : data.error || 'Reset failed — try again');
        return;
      }
      // The reset revoked every session on purpose; signing in with the new
      // password is the one remaining step.
      setResetStatus('Your password has been reset. Head back to login and sign in with it.');
    } catch {
      setResetError('Network error');
    } finally {
      setBusy(null);
    }
  }, [st]);

  // ── The seam back into public/js/** ──────────────────────────────────
  //
  // `AuthScreens.show()` looks these up by name at call time, so patching them
  // here replaces the legacy login half wholesale. Forwarders keep the
  // installed identity stable while reading the current closures.
  const live = useRef({ loginOnShow, resetOnShow, showLoginBaseView, showOtpView });
  live.current = { loginOnShow, resetOnShow, showLoginBaseView, showOtpView };
  useAuthScreensPatch({
    _wireLogin: () => {},
    _loginOnShow: (openSignup?: boolean) => live.current.loginOnShow(openSignup),
    _resetOnShow: (token?: string) => live.current.resetOnShow(token),
    _showLoginBaseView: () => live.current.showLoginBaseView(),
    _showOtpView: () => live.current.showOtpView(),
  });

  /**
   * Coming back online re-enables the controls via CSS (`body.is-offline` drops
   * off), so the "you're offline" error left on screen would be the only thing
   * still saying otherwise. Clear it — the legacy module did this for this
   * screen's three error slots plus the register screen's, which still owns its
   * own until that chunk lands.
   */
  useEffect(() => {
    const dropOfflineMessage = (current: string | null) =>
      current && /offline/i.test(current) ? null : current;
    const onOfflineChange = (e: Event) => {
      const detail = (e as CustomEvent<{ offline?: boolean }>).detail;
      if (!detail || detail.offline !== false) return;
      // Only the offline message goes; a real "wrong password" stays put.
      setLoginError(dropOfflineMessage);
      setOtpError(dropOfflineMessage);
      setWalletError(dropOfflineMessage);
    };
    window.addEventListener('usernode:offline-change', onOfflineChange);
    return () => window.removeEventListener('usernode:offline-change', onOfflineChange);
  }, []);

  // ── Derived visibility ───────────────────────────────────────────────

  const base = view === 'base';

  return (
    <main
      ref={rootRef}
      id="auth-login-screen"
      className="hidden fixed inset-0 z-40 overflow-y-auto platform-safe-scroll bg-white dark:bg-zinc-950"
    >
      {/*
          The corner Back link. `location.hash` rather than the anchor's own
          href: the href is '#' so the link is inert without JS, exactly as
          shipped. auth-screens.js delegates the same click for the screens it
          still owns; both do the same thing, and this one outlives it.
      */}
      <a
        href="#"
        data-auth-back=""
        className="fixed left-4 z-10 text-sm text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
        style={{ top: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
        onClick={(e) => {
          e.preventDefault();
          location.hash = '#landing';
        }}
      >
        &larr; Back
      </a>
      <div className="min-h-full flex items-center justify-center">
        <div className="w-full max-w-sm px-6 py-16">
          <h1 className="text-2xl font-bold text-center mb-1">
            Usernode Social Vibecoding
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center mb-8 italic">
            A place where users own and build apps together
          </p>
          {/*
              Offline explanation (#1021). Signing in REQUIRES the network —
              the credential check happens on the server — so an offline
              visitor previously typed a password, waited, and got a bare
              "Network error" with no hint that the whole screen was
              unusable. Shown by `body.is-offline` (app.css); the controls
              below carry data-offline-disabled so it's obvious which parts
              are the ones that can't work.
          */}
          <div className="offline-only mb-8 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
            <h2 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
              You're offline
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Signing in needs a connection — your username and password are checked on the server.
            Reconnect and try again; if you were signed in on this device before, reloading once
            you're back online will take you straight in.
            </p>
            <button
              type="button"
              data-offline-retry=""
              className="mt-3 rounded-lg border border-amber-500/50 px-3 py-1.5 text-sm font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 transition-colors"
            >
              Try again
            </button>
          </div>
          {/* Wallet auth status (shown when native bridge detected) */}
          <div id="wallet-auth" className={hiddenFirst(!(base && walletUi), 'space-y-4')}>
            <div id="wallet-status" className="text-center text-sm text-zinc-400">
              {walletStatus}
            </div>
            <div id="wallet-error" className={hiddenLast(!walletError, ERROR)}>
              {walletError}
            </div>
            <div id="wallet-sign-in" className={hiddenFirst(!walletControls, 'space-y-3')}>
              <Button
                id="btn-wallet-sign-in"
                data-offline-disabled=""
                {...SOLID}
                className="flex items-center justify-center gap-2"
                onClick={onWalletSignIn}
              >
                <KeyIcon className="w-5 h-5" />
                Sign in with Wallet
              </Button>
            </div>
            <div
              id="wallet-divider"
              className={hiddenFirst(!walletControls, 'flex items-center gap-3 text-xs text-zinc-500')}
            >
              <div className="flex-1 h-px bg-zinc-300 dark:bg-zinc-800">
              </div>
              or
              <div className="flex-1 h-px bg-zinc-300 dark:bg-zinc-800">
              </div>
            </div>
          </div>
          {/*
              Standard login form (always available; wallet sign-in above is
              an optional fast path when the native app carries a linked
              wallet)
          */}
          <form id="login-form" className={hiddenLast(!base, 'space-y-4')} onSubmit={onLoginSubmit}>
            <div>
              <label
                htmlFor="login-username"
                className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
              >
                Username or email
              </label>
              <Input
                ref={username}
                id="login-username"
                name="username"
                type="text"
                required={true}
                autoComplete="username"
                {...AUTHFIELD}
                placeholder="username or email"
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
              >
                Password
              </label>
              <Input
                ref={password}
                id="login-password"
                name="password"
                type="password"
                required={true}
                autoComplete="current-password"
                {...AUTHFIELD}
                placeholder="password"
              />
            </div>
            <div id="login-error" className={hiddenLast(!loginError, ERROR)}>
              {loginError}
            </div>
            <Button type="submit" data-offline-disabled="" {...SOLID}>
              Log in
            </Button>
          </form>
          <p id="forgot-link-wrap" className={hiddenLast(!base, 'text-center text-sm mt-3')}>
            <a
              id="forgot-password-link"
              href="#"
              className="text-zinc-500 dark:text-zinc-400 hover:text-violet-400"
              onClick={(e) => {
                e.preventDefault();
                showRecovery();
              }}
            >
              Forgot password?
            </a>
          </p>
          <p id="otp-link-wrap" className={hiddenLast(!base, 'text-center text-sm mt-1')}>
            <a id="otp-link" href="#signup" className="text-zinc-500 dark:text-zinc-400 hover:text-violet-400">
              Sign in with an email code
            </a>
          </p>
          <p
            id="register-link"
            className={hiddenLast(!base, 'text-center text-sm text-zinc-500 dark:text-zinc-400 mt-6')}
          >
            {'Have an activation code? '}
            <a href="#register" className="text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300">
              Register
            </a>
          </p>
          {/*
              Email-code sign-in sub-view (thin-shell migration). The ONE
              email-code path, backed by the public v4 endpoints
              (otp/request, otp/verify, set-password). It serves both
              first-time sign-ups (otp/verify creates the account — this is
              the #signup route) and migrated password-less participants.
          */}
          <div id="otp-view" className={hiddenFirst(view !== 'otp', 'space-y-4')}>
            <h2 className="text-lg font-bold text-center">
              Sign in with email
            </h2>
            <div id="otp-step-email" className={hiddenFirst(otpStep !== 'email', 'space-y-3')}>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                We'll email you a 6-digit code. New here? This also creates your account.
              </p>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Email
                </label>
                <Input
                  ref={otpEmailInput}
                  id="otp-email"
                  type="email"
                  autoComplete="email"
                  {...FIELD}
                  placeholder="you@example.com"
                />
              </div>
              <Button
                id="btn-otp-request"
                type="button"
                data-offline-disabled=""
                {...SOLID}
                onClick={otpRequestCode}
              >
                Email me a code
              </Button>
            </div>
            <div id="otp-step-code" className={hiddenFirst(otpStep !== 'code', 'space-y-3')}>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {'Enter the 6-digit code we sent to '}
                <span id="otp-email-echo" className="font-medium text-zinc-700 dark:text-zinc-300">
                  {otpEmailEcho}
                </span>
                .
              </p>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Code
                </label>
                <Input
                  ref={otpCode}
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  {...FIELD}
                  className="tracking-widest text-center"
                  placeholder="123456"
                />
              </div>
              <Button
                id="btn-otp-verify"
                type="button"
                data-offline-disabled=""
                {...SOLID}
                onClick={onOtpVerify}
              >
                Verify code
              </Button>
              <button
                id="btn-otp-resend"
                type="button"
                data-offline-disabled=""
                className={QUIET_BUTTON}
                onClick={onOtpResend}
              >
                Send a new code
              </button>
            </div>
            <div id="otp-step-password" className={hiddenFirst(otpStep !== 'password', 'space-y-3')}>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Code verified — now choose a password for your account.
              </p>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  New password
                </label>
                <Input
                  ref={otpNewPassword}
                  id="otp-new-password"
                  type="password"
                  autoComplete="new-password"
                  {...FIELD}
                  placeholder="at least 8 characters"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Confirm password
                </label>
                <Input
                  ref={otpConfirmPassword}
                  id="otp-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  {...FIELD}
                  placeholder="re-enter password"
                />
              </div>
              <Button
                id="btn-otp-set-password"
                type="button"
                data-offline-disabled=""
                {...SOLID}
                onClick={onOtpSetPassword}
              >
                Set password &amp; sign in
              </Button>
            </div>
            <div id="otp-error" className={hiddenLast(!otpError, ERROR)}>
              {otpError}
            </div>
            <div id="otp-status" className={hiddenLast(!otpStatus, STATUS)}>
              {otpStatus}
            </div>
            <button
              id="btn-otp-back"
              type="button"
              className={QUIET_BUTTON}
              onClick={() => {
                // Route change so browser back stays coherent (#signup → #login).
                location.hash = '#login';
              }}
            >
              Back to login
            </button>
          </div>
          {/*
              Password recovery sub-view (issue #282). Hidden until "Forgot
              password?" is tapped. Picks one of two paths by context: a
              wallet-signature self-reset when running inside the Usernode
              app with a linked wallet, otherwise the emailed magic link
              with the "ask an admin" message as its fallback.
          */}
          <div id="recovery-view" className={hiddenFirst(view !== 'recovery', 'space-y-4')}>
            <h2 className="text-lg font-bold text-center">
              Reset your password
            </h2>
            <div
              id="recovery-wallet"
              className={hiddenFirst(!(view === 'recovery' && recoveryPath === 'wallet'), 'space-y-3')}
            >
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Your wallet is linked to this account. Approve a signature request, then choose a new password.
              </p>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  New password
                </label>
                <Input
                  ref={recoveryNewPassword}
                  id="recovery-new-password"
                  type="password"
                  autoComplete="new-password"
                  {...FIELD}
                  placeholder="at least 8 characters"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  Confirm new password
                </label>
                <Input
                  ref={recoveryConfirmPassword}
                  id="recovery-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  {...FIELD}
                  placeholder="re-enter new password"
                />
              </div>
              <div id="recovery-error" className={hiddenLast(!recoveryError, ERROR)}>
                {recoveryError}
              </div>
              <div id="recovery-status" className={hiddenLast(!recoveryStatus, STATUS)}>
                {recoveryStatus}
              </div>
              <Button id="btn-wallet-reset" type="button" {...SOLID} onClick={onWalletReset}>
                Reset password with your wallet
              </Button>
            </div>
            {/*
                The emailed-reset request form. Mounted on the first
                ensureResetUi() — see the file header — and rendered where
                _ensureResetUi inserted it: directly above the admin block.
            */}
            {resetUi ? (
              <div
                id="recovery-email"
                className={hiddenFirst(!(view === 'recovery' && recoveryPath === 'email'), 'space-y-3')}
              >
                {/*
                    The instruction line steps aside while the sent
                    confirmation is up, so the message reads from exactly one
                    place — the success box below the field (dev-chat request:
                    it appeared to render twice).
                */}
                <p className={hiddenFirst(!!emailResetStatus, P)}>
                  Enter the email address on your account and we'll send you a link to choose a new password.
                </p>
                <div>
                  <label className={LABEL} htmlFor="recovery-email-input">Email</label>
                  <Input
                    ref={recoveryEmailInput}
                    id="recovery-email-input"
                    type="email"
                    autoComplete="email"
                    {...FIELD}
                    placeholder="you@example.com"
                  />
                </div>
                <div id="recovery-email-error" className={hiddenLast(!emailResetError, ERROR)}>
                  {emailResetError}
                </div>
                <div id="recovery-email-status" className={hiddenLast(!emailResetStatus, SENT_BOX)}>
                  {emailResetStatus}
                </div>
                <Button
                  id="btn-email-reset"
                  type="button"
                  {...SOLID}
                  disabled={busy === 'btn-email-reset'}
                  onClick={onEmailReset}
                >
                  Email me a reset link
                </Button>
              </div>
            ) : null}
            <div
              id="recovery-admin"
              className={hiddenFirst(!(view === 'recovery' && recoveryPath === 'email'), 'space-y-3')}
            >
              {/*
                  Once the email path exists, the admin route is the FALLBACK:
                  the shipped lead still claimed accounts have no email on
                  file, which stopped being true when email became a login
                  identifier. _ensureResetUi rewrote this paragraph; the same
                  flag rewrites it here.
              */}
              {/*
                  The divider marks the admin route as the separated, final
                  alternative below the email flow (issue #1158).
              */}
              <hr className="border-zinc-200 dark:border-zinc-800" />
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {resetUi ? ADMIN_LEAD_WITH_EMAIL : ADMIN_LEAD_SHIPPED}
              </p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {/* JSX drops a line-ending space, so the separators before the
                    inline elements must live inside the string expressions —
                    without them the text renders as "atemporary" /
                    "fromSettings" (issue #1158). */}
                {'Ask a Usernode platform admin to issue you a '}
                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                  temporary password
                </span>
                {". Once you're back in, set a password you choose from "}
                <a href="#settings/password" className="text-violet-500 hover:text-violet-400 underline">
                  Settings → Change password
                </a>
                .
              </p>
            </div>
            <button
              id="btn-recovery-back"
              type="button"
              className="w-full text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-300"
              onClick={showLoginBaseView}
            >
              Back to login
            </button>
          </div>
          {/*
              The redeem view the emailed link lands on — a sibling sub-view
              of #recovery-view on the same login card, where _ensureResetUi
              inserted it.
          */}
          {resetUi ? (
            <div id="reset-password-view" className={hiddenFirst(view !== 'reset', 'space-y-4')}>
              <h2 className="text-lg font-bold text-center">Choose a new password</h2>
              <div>
                <label className={LABEL} htmlFor="reset-new-password">New password</label>
                <Input
                  ref={resetNewPassword}
                  id="reset-new-password"
                  type="password"
                  autoComplete="new-password"
                  {...FIELD}
                  placeholder="at least 8 characters"
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="reset-confirm-password">Confirm new password</label>
                <Input
                  ref={resetConfirmPassword}
                  id="reset-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  {...FIELD}
                  placeholder="re-enter new password"
                />
              </div>
              <div id="reset-error" className={hiddenLast(!resetError, ERROR)}>
                {resetError}
              </div>
              <div id="reset-status" className={hiddenLast(!resetStatus, STATUS)}>
                {resetStatus}
              </div>
              <Button
                id="btn-reset-confirm"
                type="button"
                {...SOLID}
                disabled={busy === 'btn-reset-confirm'}
                onClick={onResetConfirm}
              >
                Set new password
              </Button>
              <button
                id="btn-reset-back"
                type="button"
                className={QUIET_BUTTON}
                onClick={() => {
                  // Route change so browser back stays coherent; the direct
                  // call covers the no-hashchange case (already on #login).
                  location.hash = '#login';
                  showLoginBaseView();
                }}
              >
                Back to login
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
