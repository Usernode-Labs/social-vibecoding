/**
 * The sign-in addresses, answered by the sign-in sheet (./sign-in-sheet.tsx).
 *
 * Signing in used to exist twice: the sheet, over the landing, and a set of
 * full pages (the sign-in screen with its email-code, recovery and reset
 * views, and the activation-code register screen). The sheet is the one
 * sign-in now, and the old addresses open it over the landing at the step
 * the page was for:
 *
 *   #login                     the password step
 *   #login/forgot              the reset-link step ("Forgot password?")
 *   #signup                    the email step (the code makes an account)
 *   #signup/<address>          the same, the address filled in and the code
 *                              sent once per tab
 *   #reset-password/<token>    the new-password step an emailed reset link
 *                              lands on (src/services/mail/index.js)
 *   #register[/<code>]         the activation-code step
 *
 * Mails already sent link to every one of these, so each keeps working.
 * AuthScreens.show() (public/js/auth-screens.js) keeps the route for the
 * landing, which takes it as it shows (`takeSignInRoute`) and opens the sheet
 * at the step `sheetOpening` names. Closing the sheet leaves the landing.
 *
 * Also here, for the sheet and the landing alike, what the sign-in screen
 * kept: the once-per-tab record of a code sent for a link, the lookup of the
 * address a waitlist "you're in" link's token names, the reset link's
 * exchange, the activation code's, and the Homeroom app's wallet sign-in.
 */

import { t, errorText } from '../../lib/i18n/runtime';
import {
  fetchSessionMint,
  isNative,
  legacy,
  NativeLoginPreparationError,
  type NativeLoginFailureDetails,
  sessionMintFailureMessage,
} from './shared';

/** The addresses the sheet answers (the routes AuthScreens.show() keeps for it). */
export type SheetRoute = 'login' | 'signup' | 'register' | 'reset-password';

export const SHEET_ROUTES: readonly SheetRoute[] = ['login', 'signup', 'register', 'reset-password'];

/** What AuthScreens.show() keeps: the route and the address's second segment. */
export interface SignInRoute {
  route: SheetRoute;
  seg: string | null;
}

/** The route the landing should open the sheet for, once: whoever shows it takes it. */
export function takeSignInRoute(): SignInRoute | null {
  const host = legacy().AuthScreens;
  const kept = host?._signInRoute as Partial<SignInRoute> | null | undefined;
  if (!host || !kept) return null;
  host._signInRoute = null;
  if (!SHEET_ROUTES.includes(kept.route as SheetRoute)) return null;
  return { route: kept.route as SheetRoute, seg: typeof kept.seg === 'string' && kept.seg ? kept.seg : null };
}

/** The steps an address opens the sheet on. */
export type RouteStep = 'password' | 'forgot' | 'email' | 'code' | 'reset' | 'register';

/**
 * Where an address opens the sheet, and what it carries there:
 *
 *   email        the address to fill in (#signup/<address>), whose code is
 *                sent once per tab (`addressArrival`);
 *   codeSent     the `signup-code-sent` screenshot state: the code step for
 *                that address, the resend held, and nothing sent;
 *   token        the reset link's token (#reset-password/<token>);
 *   code         the activation code (#register/<code>);
 *   resetSent    the `password-recovery-sent` state: the reset step saying
 *                its link went, with nothing sent;
 *   notice       the password step's notice: the password was changed (a
 *                reset just redeemed, or `password-reset-complete`), or this
 *                account signs in with its password
 *                (`email-code-password-account`, what a right code for such
 *                an account answers).
 */
export interface SheetOpening {
  route: SheetRoute;
  step: RouteStep;
  email: string | null;
  codeSent: boolean;
  token: string | null;
  code: string | null;
  resetSent: boolean;
  notice: 'password-changed' | 'password-account' | null;
}

/** The `?shot=` screenshot state on this document, or null. */
export function currentShot(): string | null {
  try {
    return new URLSearchParams(location.search).get('shot');
  } catch {
    return null;
  }
}

/**
 * The `#signup/<address>` segment, or null if it is not an address. The mail
 * carries a token now (#1548), but the `signup-code-sent` state still names
 * its address here, and it is harmless as an entry point: it fills in a
 * field, and the code only goes to the address that was typed.
 */
export function addressFromSegment(seg?: string | null): string | null {
  if (!seg) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    // A stray '%' in the fragment. Nothing to fill in.
    return null;
  }
  const email = decoded.trim().toLowerCase();
  return email.includes('@') && email.length <= 255 ? email : null;
}

function decoded(seg: string | null): string | null {
  if (!seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** The step and what it carries, for an address and the page's screenshot state. */
export function sheetOpening(route: SheetRoute, seg: string | null, shot: string | null = currentShot()): SheetOpening {
  const base: SheetOpening = {
    route, step: 'password', email: null, codeSent: false, token: null, code: null, resetSent: false, notice: null,
  };
  if (route === 'signup') {
    const email = addressFromSegment(seg);
    if (email && shot === 'signup-code-sent') return { ...base, step: 'code', email, codeSent: true };
    return { ...base, step: 'email', email };
  }
  if (route === 'reset-password') return { ...base, step: 'reset', token: seg };
  if (route === 'register') return { ...base, step: 'register', code: decoded(seg) };
  if (seg === 'forgot' || shot === 'password-recovery') return { ...base, step: 'forgot' };
  if (shot === 'password-recovery-sent') return { ...base, step: 'forgot', resetSent: true };
  if (shot === 'password-reset-complete') return { ...base, notice: 'password-changed' };
  if (shot === 'email-code-password-account') return { ...base, notice: 'password-account' };
  return base;
}

// ── A code sent for a link, once per tab ──────────────────────────────

/**
 * Per-tab record of the code a link sent by itself, so a reload of the link
 * (or a trip away and back) does not send a second. sessionStorage rather
 * than a ref: the reload is the case a ref forgets. `sentAt` also restores
 * the resend's wait across the reload, since the server's own gap survived
 * it. The key is the one the sign-in screen used, so a tab that sent a code
 * before this change still counts it.
 */
const AUTO_SEND_KEY = 'usernode.signup.otp.v1';

type AutoSendRecord = { email: string; sentAt: number };

export function readAutoSend(): AutoSendRecord | null {
  try {
    const raw = sessionStorage.getItem(AUTO_SEND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutoSendRecord;
    if (!parsed || typeof parsed.email !== 'string' || typeof parsed.sentAt !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    // Private mode, or a value some other tab wrote. Treat it as absent.
    return null;
  }
}

export function writeAutoSend(email: string) {
  try {
    sessionStorage.setItem(AUTO_SEND_KEY, JSON.stringify({ email, sentAt: Date.now() }));
  } catch {
    // Storage refused: the send still happened, it just cannot be remembered.
  }
}

// ── A waitlist "you're in" link's address ─────────────────────────────

/**
 * Resolve a release link's token to its address. Null on anything
 * unexpected: a prefill is a convenience, and the sheet is usable without it.
 */
export async function inviteEmailFromToken(token: string): Promise<string | null> {
  return (await releaseAccountFromToken(token))?.email ?? null;
}

/** What a waitlist "you're in" link's token says about its account. */
export type ReleaseAccount = {
  email: string;
  /**
   * The account the address would sign in to is still new: none yet, or one
   * with no username and no password (src/services/release-links.js
   * isNewAccount). Only then does the story spend the mail's one-time
   * sign-in as the page opens (./landing.tsx).
   */
  newAccount: boolean;
};

/**
 * The same lookup, with `new_account` beside the address. A GET, so it spends
 * nothing: no link, no session. Null on anything unexpected, and anything
 * but a literal `true` is not a new account. `fromAdmitMail`: the read the
 * "You're in" mail's page makes as it opens, which Admin › Journey records as
 * that page opened (src/routes/public-api.js).
 */
export async function releaseAccountFromToken(
  token: string,
  { fromAdmitMail = false }: { fromAdmitMail?: boolean } = {},
): Promise<ReleaseAccount | null> {
  try {
    const res = await fetch(`/api/public/waitlist/more/${encodeURIComponent(token)}${fromAdmitMail ? '?from=admit' : ''}`);
    if (!res.ok) return null;
    const data = await res.json();
    const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (!email.includes('@') || email.length > 255) return null;
    return { email, newAccount: data?.new_account === true };
  } catch {
    return null;
  }
}

/**
 * The `?t=` token of a waitlist "you're in" link that reached #signup some
 * other way than AuthScreens.enter(), which takes the mail's own query off
 * the address as it lands. Null when there is none, or it is not one.
 */
export function releaseTokenFromQuery(): string | null {
  try {
    const value = new URLSearchParams(location.search).get('t');
    return value && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

// ── The emailed reset link (#reset-password/<token>) ──────────────────

/** A reset token as the server mints it: 64 hex characters (src/routes/auth.js). */
export const RESET_TOKEN_RE = /^[0-9a-f]{64}$/;

/** What choosing the new password came to: done, or what to say. */
export type ResetResult = { ok: true } | { ok: false; error: string };

/**
 * Redeem the emailed link with the new password: POST
 * /api/auth/password-reset/confirm, which spends the token and signs the
 * account out everywhere, so the person signs in again with the new password
 * after it. A mangled link is refused without a round trip, with the words
 * the server would use.
 */
export async function confirmPasswordReset(token: string | null, password: string, confirm: string): Promise<ResetResult> {
  if (!token || !RESET_TOKEN_RE.test(token)) return { ok: false, error: t('auth:signInSheet.reset.expired') };
  if (password.length < 8) return { ok: false, error: t('auth:signInSheet.reset.passwordTooShort') };
  if (password !== confirm) return { ok: false, error: t('auth:signInSheet.reset.passwordMismatch') };
  try {
    const res = await fetch('/api/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword: password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: res.status === 401 ? t('auth:signInSheet.reset.expired') : errorText(data) || t('auth:signInSheet.reset.failed') };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: t('auth:signInSheet.networkError') };
  }
}

// ── An activation code (#register/<code>) ─────────────────────────────

/** The fields the server can pin a refusal to. */
export type RegisterField = 'username' | 'password';

export type RegisterResult =
  | { ok: true }
  | { ok: false; error: string; field: RegisterField | null; details: NativeLoginFailureDetails | null };

/**
 * Make an account with an activation code, a username and a password: POST
 * /api/auth/register, which mints the session. A refusal the server pins to
 * one field (`field` on the 400/409) is said under that field.
 */
export async function registerWithCode(code: string, username: string, password: string): Promise<RegisterResult> {
  try {
    const res = await fetchSessionMint('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), username: username.trim(), password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const field = data.field === 'username' || data.field === 'password' ? data.field as RegisterField : null;
      return { ok: false, error: errorText(data) || t('auth:signInSheet.register.failed'), field: field && data.error ? field : null, details: null };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: sessionMintFailureMessage(error),
      field: null,
      details: error instanceof NativeLoginPreparationError ? error.details : null,
    };
  }
}

// ── The Homeroom app's wallet (issue #282) ────────────────────────────

/**
 * What the app's wallet can do here. Wallet custody follows sign-in, so a
 * signed-out app with no wallet is the NORMAL state, and every failure
 * (no wallet, a transport error, an unlinked or non-genesis wallet) leaves
 * the sheet as it is.
 *
 *   linked     the wallet is linked to an account: "Forgot password?" can
 *              reset its password with a signature (no genesis gate);
 *   challenge  a linked genesis wallet's sign-in challenge: the password step
 *              offers "Sign in with Wallet".
 */
export interface WalletProbe {
  pubkey: string;
  linked: boolean;
  challenge: string | null;
}

async function walletCheck(pubkey: string): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch('/api/auth/wallet-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pubkey }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data: data && typeof data === 'object' ? data : {} };
}

/** Inside the Homeroom app only: the wallet, and what it is linked to. */
export async function probeWallet(): Promise<WalletProbe | null> {
  if (!isNative()) return null;
  let pubkey: string | null = null;
  try {
    pubkey = (await legacy().getNodeAddress?.()) || null;
  } catch {
    return null;
  }
  if (!pubkey) return null;
  try {
    const { ok, data } = await walletCheck(pubkey);
    if (!ok) return null;
    const linked = data.status === 'linked';
    const challenge = linked && data.isGenesis !== false && typeof data.challenge === 'string' && data.challenge
      ? data.challenge : null;
    return { pubkey, linked, challenge };
  } catch {
    return null;
  }
}

/** What a wallet exchange came to: in, or what to say. */
export type WalletResult = { ok: true } | { ok: false; error: string };

function walletFailure(error: unknown, denied: string, failed: (reason: string) => string): WalletResult {
  if (error instanceof NativeLoginPreparationError) return { ok: false, error: error.message };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: message && message.includes('denied') ? denied : failed(message) };
}

/** Sign in with the wallet's signature over a challenge (POST /api/auth/wallet-verify). */
export async function walletSignIn(wallet: WalletProbe): Promise<WalletResult> {
  try {
    let challenge = wallet.challenge;
    if (!challenge) {
      const { data } = await walletCheck(wallet.pubkey);
      challenge = typeof data.challenge === 'string' ? data.challenge : null;
    }
    // A challenge is single-use: the next press asks for a fresh one.
    wallet.challenge = null;
    if (!challenge) return { ok: false, error: t('auth:signInSheet.wallet.noChallenge') };
    const signed = await legacy().signMessage!(challenge);
    const res = await fetchSessionMint('/api/auth/wallet-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pubkey: wallet.pubkey, publicKey: signed.publicKey, challenge, signature: signed.signature }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true };
    return { ok: false, error: errorText(data) || t('auth:signInSheet.wallet.failed') };
  } catch (error) {
    return walletFailure(error, t('auth:signInSheet.wallet.denied'), (reason) => t('auth:signInSheet.wallet.signatureFailed', { reason }));
  }
}

/** Choose a new password with the wallet's signature (POST /api/auth/wallet-reset-verify), which signs in. */
export async function walletReset(wallet: WalletProbe, password: string, confirm: string): Promise<WalletResult> {
  if (password.length < 8) return { ok: false, error: t('auth:signInSheet.reset.passwordTooShort') };
  if (password !== confirm) return { ok: false, error: t('auth:signInSheet.reset.passwordMismatch') };
  try {
    // A fresh challenge: the sign-in's may be spent or absent.
    const { data } = await walletCheck(wallet.pubkey);
    const challenge = typeof data.challenge === 'string' ? data.challenge : null;
    if (!challenge) return { ok: false, error: t('auth:signInSheet.wallet.noChallenge') };
    const signed = await legacy().signMessage!(challenge);
    const res = await fetchSessionMint('/api/auth/wallet-reset-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pubkey: wallet.pubkey, publicKey: signed.publicKey, challenge, signature: signed.signature, newPassword: password,
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true };
    return { ok: false, error: errorText(result) || t('auth:signInSheet.wallet.resetFailed') };
  } catch (error) {
    return walletFailure(error, t('auth:signInSheet.wallet.denied'), (reason) => t('auth:signInSheet.wallet.resetFailedReason', { reason }));
  }
}
