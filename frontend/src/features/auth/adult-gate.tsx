/**
 * "Are you 18 or older?" (#5095, compliance A-02).
 *
 * Homeroom asks no age at sign-up. Wallets, tokens and transfers, staking,
 * running a node and passport proofs are for adults, so the first time a
 * signed-in person opens one of them this sheet asks, once:
 *
 *   - "I'm 18 or older" records the answer (POST /api/me/adult-attestation,
 *     `users.adult_attested_at`) and the feature opens.
 *   - "I'm under 18" records nothing, closes the sheet, leaves the person
 *     where they were and says why. The next time they open one of these
 *     features they are asked again. No birthdate is asked for or kept.
 *
 * Where it is asked:
 *
 *   - on OPEN: the native Wallet sheet (../header/wallet-sheet.js
 *     `openFromRow`, which the challenge page's "Manage delegation" opens
 *     too), the Node sheet (../header/node-pill.js) and the Staking sheet
 *     (../profile/staking-sheet.tsx). Their screenshot states (`?shot=` and
 *     `?demo=`) open without asking: they read a fixed preview, write
 *     nothing, and the declared checks draw them.
 *   - on a WRITE: the server refuses the wallet, staking, node and passport
 *     writes with 403 `adult_attestation_required` until the answer is
 *     recorded (src/services/adult-attestation.js). `installAdultGate`
 *     wraps `fetch` the way ../../lib/join-required.ts does, so a refused
 *     write from any caller (Settings' "Link wallet" and "Ask to produce
 *     blocks", the challenge page's request, wallet recovery) asks the same
 *     question and is sent again on a yes. On a no the original 403 goes
 *     back to the caller untouched.
 *
 * Accounts that used these features before the check are asked once too;
 * nothing they hold changes.
 *
 * Later: a zkPassport proof can show over-18 without sharing the passport,
 * and could replace this self-declaration.
 *
 * The kit owns the sheet (PlatformUI.sheet); React owns what is in it, a
 * legacy portal mounted on open and dropped on dismiss, as in
 * ./verify-identity.tsx. Nothing here is in the prerendered shell.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useMessages } from '../../lib/i18n/react';
import { t } from '../../lib/i18n/runtime';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

export const ADULT_CODE = 'adult_attestation_required';

type SessionUser = { adultAttested?: boolean } & Record<string, unknown>;
type AppHost = { App?: { user?: SessionUser | null; saveSessionSnapshot?: (user: unknown) => void } };
type SheetKit = { sheet?: (opts: { contentEl: HTMLElement; onDismiss?: () => void }) => { dismiss: () => void } | null; toast?: (msg: string, opts?: unknown) => void };

export function isAdultAttestationRequired(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { code?: unknown }).code === ADULT_CODE;
}

function sessionUser(): SessionUser | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as AppHost).App?.user || null;
}

/** Whether the shell's copy of the account already said yes. */
export function adultAttestedHere(): boolean {
  return sessionUser()?.adultAttested === true;
}

/** The yes is recorded: the shell's copy of the account and this device's snapshot say so. */
function noteAttested(): void {
  const app = (window as unknown as AppHost).App;
  if (app?.user) {
    app.user.adultAttested = true;
    try { app.saveSessionSnapshot?.(app.user); } catch { /* the next boot reads the server */ }
  }
}

// The un-wrapped fetch, once installAdultGate has run: the yes must not be
// asked about itself.
let send: typeof fetch | null = null;

async function recordYes(): Promise<boolean> {
  const go = send || fetch;
  const res = await go('/api/me/adult-attestation', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) return false;
  noteAttested();
  return true;
}

export function AdultGateBody({ onYes, onUnder }: {
  onYes: () => Promise<boolean>;
  onUnder: () => void;
}) {
  const tr = useMessages('auth');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const yes = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    let ok = false;
    try { ok = await onYes(); } catch { ok = false; }
    if (!ok) { setFailed(true); setSaving(false); }
  };
  return (
    <div data-adult-gate="" className="px-4 pb-5">
      <section className="mt-3 rounded-2xl bg-white dark:bg-zinc-900 p-5 text-left">
        <h2 className="text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">{tr('auth:adult.title')}</h2>
        <p className="mt-1 text-[15px] leading-snug text-zinc-500 dark:text-zinc-400">{tr('auth:adult.lead')}</p>
        <p className="mt-2 text-[13px] leading-snug text-zinc-500 dark:text-zinc-400">{tr('auth:adult.privacy')}</p>
        {failed ? (
          <p data-adult-gate-error="" role="alert" className="mt-3 text-[13px] text-red-700 dark:text-red-400">{tr('auth:adult.failed')}</p>
        ) : null}
        <div className="mt-4 flex flex-col gap-2">
          <Button type="button" data-adult-gate-yes="" layout="full" variant="pillAccent" size="pill" disabled={saving} onClick={() => { void yes(); }}>
            {tr('auth:adult.yes')}
          </Button>
          <Button type="button" data-adult-gate-under="" layout="full" variant="pillNeutral" size="pill" ink="neutral" disabled={saving} onClick={() => onUnder()}>
            {tr('auth:adult.under')}
          </Button>
        </div>
      </section>
    </div>
  );
}

let open: Promise<boolean> | null = null;

/**
 * Ask. Resolves true once the yes is recorded, false for "I'm under 18", a
 * closed sheet, or no kit to show it with. One question at a time: a second
 * ask while one is open gets the open one's answer.
 */
export function openAdultGate(): Promise<boolean> {
  if (open) return open;
  const kit = typeof window !== 'undefined' ? (window as unknown as { PlatformUI?: SheetKit }).PlatformUI : null;
  if (!kit || typeof kit.sheet !== 'function' || typeof document === 'undefined') return Promise.resolve(false);
  open = new Promise<boolean>((resolve) => {
    const panel = document.createElement('div');
    let handle: { dismiss: () => void } | null = null;
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      open = null;
      unmountLegacyPortal(panel);
      resolve(answer);
    };
    const leave = (answer: boolean) => { finish(answer); handle?.dismiss(); };
    handle = kit.sheet!({ contentEl: panel, onDismiss: () => finish(false) });
    if (!handle) { finish(false); return; }
    mountLegacyPortal(panel, (
      <AdultGateBody
        onYes={async () => {
          const ok = await recordYes();
          if (ok) leave(true);
          return ok;
        }}
        onUnder={() => {
          leave(false);
          try { kit.toast?.(t('auth:adult.underToast')); } catch { /* the sheet is closed either way */ }
        }}
      />
    ));
  });
  return open;
}

/**
 * Before a wallet, staking, node or passport feature opens: true when the
 * person may go on. Signed out there is nothing to ask (the server answers
 * 401 to anything that writes).
 */
export function requireAdult(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (!sessionUser() || adultAttestedHere()) return Promise.resolve(true);
  return openAdultGate();
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  const own = init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : '');
  return String(own || 'GET').toUpperCase();
}

/**
 * Wrap `window.fetch` once: a write refused `adult_attestation_required` asks
 * the question and, on a yes, is sent again with the original fetch (so a
 * second refusal goes back to the caller; there is no loop). Exported for
 * the test, which hands in its own window and question.
 */
export function installAdultGate(win: any = typeof window !== 'undefined' ? window : null, ask: () => Promise<boolean> = openAdultGate): void {
  if (!win || typeof win.fetch !== 'function' || win.__adultGateInstalled) return;
  const original: typeof fetch = win.fetch.bind(win);
  send = original;
  win.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = methodOf(input, init);
    if (method === 'GET' || method === 'HEAD') return original(input, init);
    const again = typeof Request !== 'undefined' && input instanceof Request ? input.clone() : input;
    const res = await original(input, init);
    if (res.status !== 403) return res;
    let body: unknown = null;
    try {
      body = await res.clone().json();
    } catch {
      return res;
    }
    if (!isAdultAttestationRequired(body)) return res;
    if (await ask()) return original(again, init);
    return res;
  };
  win.__adultGateInstalled = true;
  const bridge = (win.UsernodeReact ||= {});
  bridge.adultGate = { require: requireAdult, open: openAdultGate };
}

// `?shot=adult-gate`: the question for the before/after shots, once the
// shell has a signed-in viewer, whatever that viewer answered before.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  let shot: string | null = null;
  try { shot = new URLSearchParams(window.location.search).get('shot'); } catch { /* no shot */ }
  if (shot === 'adult-gate') {
    const show = () => { setTimeout(() => { void openAdultGate(); }, 450); };
    if (sessionUser()) show();
    else document.addEventListener('sv:authed', show, { once: true });
  }
}
