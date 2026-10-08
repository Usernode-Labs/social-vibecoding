'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { phoneRecaptchaToken, RECAPTCHA_NOTICE } from '../auth/recaptcha';

// SMS delivery section of the admin console (#admin/sms).
//
// Homeroom sends texts only one way: Firebase Phone Auth texts a sign-in
// code (src/services/firebase-phone-auth.js). Nothing else in the platform
// tells an operator whether that works, so this section answers it the way
// Email delivery answers it for mail, and looks like that section on
// purpose:
//
//   1. Is phone sign-in set up?        (status card, GET /api/admin/sms/status)
//   2. Does a text go out right now?   (send a test, POST /api/admin/sms/test)
//
// The test is the real send: the same Identity Toolkit call, with the same
// invisible reCAPTCHA token the sign-in sheet earns (auth/recaptcha.ts), so
// what arrives is Firebase's own code message. The answer is Firebase's own
// code, which the user-facing routes deliberately hide.
//
// PERMISSIONS: visible to any admin. The send is full-admin-only; a
// view-only admin gets a note where the form would be. The server enforces
// that independently via requireAdminWrite.

interface SmsStatus {
  offered?: boolean;
  texts?: boolean;
  testNumbers?: boolean;
  enabled?: boolean;
  projectId?: string | null;
  missing?: string[];
  canSendTest?: boolean;
}

interface Outcome {
  status?: 'sent' | 'refused' | 'unreachable';
  phoneNumber?: string;
  providerCode?: string | null;
  httpStatus?: number | null;
  durationMs?: number;
  sentAt?: string;
}

type Result =
  | { kind: 'none' }
  | { kind: 'note'; text: string; bad?: boolean }
  | { kind: 'outcome'; outcome: Outcome };

const canWrite = () => !!(typeof window !== 'undefined'
  && (window as any).AdminConsole && (window as any).AdminConsole.canWrite());

// Non-throwing fetch, as in admin-mail.tsx: `status: 0` means no answer came
// back at all.
async function fetchJson(url: string, opts?: RequestInit): Promise<{ status: number; ok: boolean; data: any }> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { status: res.status, ok: res.ok, data: null };
    try { return { status: res.status, ok: res.ok, data: await res.json() }; } catch {
      return { status: res.status, ok: res.ok, data: null };
    }
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

// One plain sentence per Firebase code an operator is likely to meet.
const PROVIDER_HINTS: Record<string, string> = {
  INVALID_PHONE_NUMBER: 'Firebase could not read the number. Enter it with its country code, starting with +.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Firebase is throttling this number or this server. Wait before trying again: real sign-in to this number is held back too.',
  QUOTA_EXCEEDED: 'The Firebase project has used up its SMS quota. Raise it in the Firebase console.',
  OPERATION_NOT_ALLOWED: 'Phone sign-in is switched off in the Firebase project. Enable the Phone provider in Firebase Authentication.',
  BILLING_NOT_ENABLED: 'The Firebase project needs billing switched on before it sends texts.',
  MISSING_APP_CREDENTIAL: 'The “I’m not a robot” check gave no answer. Try again.',
  INVALID_APP_CREDENTIAL: 'Firebase did not accept the “I’m not a robot” answer. Check that this site is an authorised domain in the Firebase project.',
  MISSING_RECAPTCHA_TOKEN: 'The “I’m not a robot” check gave no answer. Try again.',
  INVALID_RECAPTCHA_TOKEN: 'Firebase did not accept the “I’m not a robot” answer. Check that this site is an authorised domain in the Firebase project.',
  CAPTCHA_CHECK_FAILED: 'Firebase did not accept the “I’m not a robot” answer. Try again.',
  NO_SESSION_INFO: 'Firebase answered without confirming the send.',
};

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>;
}

function StatusCard({ status, failed }: { status: SmsStatus | null; failed: boolean }) {
  if (failed) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Could not load the SMS configuration.</p>;
  if (!status) return <p className={AdminUI.loading}>Loading…</p>;

  // Test numbers (PHONE_TEST_CODE, never in production): the fictional
  // +1 … 555 01xx numbers sign in with one code and are never texted.
  const testLine = status.testNumbers ? (
    <p className="text-zinc-500 dark:text-zinc-400 mt-1">
      {'Test numbers are on: +1, any area code, then 555 0100 to 0199, sign in with the code in '}
      <Mono>PHONE_TEST_CODE</Mono>
      {' and get no text. Each account one makes is a test account.'}
    </p>
  ) : null;

  if (status.offered && status.texts !== false) {
    return (
      <div className={`${AdminUI.card} px-4 py-3 text-sm`}>
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">SMS is set up:</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {' phone sign-in is offered, and its codes are texted by Firebase project '}
          <Mono>{status.projectId || 'unknown'}</Mono>{'.'}
        </span>
        {testLine}
      </div>
    );
  }

  if (status.offered) {
    return (
      <div className={`${AdminUI.card} px-4 py-3 text-sm`}>
        <span className="font-semibold">Test numbers only:</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {' phone sign-in is offered, but SMS is not set up, so no text is ever sent and any other number is refused.'}
        </span>
        {testLine}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm">
      <div className="font-semibold text-amber-800 dark:text-amber-300">
        SMS is not set up: phone sign-in is not offered
      </div>
      <p className="text-amber-800/80 dark:text-amber-300/80 mt-1">
        {'Set '}
        {(status.missing || []).map((k, i) => <span key={k}>{i ? ', ' : ''}<Mono>{k}</Mono></span>)}
        {' in the platform’s Platform variables panel, then redeploy. Until then no text can be sent, and the test below stays off.'}
      </p>
    </div>
  );
}

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  const at = outcome.sentAt ? `${outcome.sentAt.replace('T', ' ').slice(11, 16)} UTC` : '';
  if (outcome.status === 'sent') {
    return (
      <div className="mt-3">
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          {`Sent: Firebase accepted the text for ${outcome.phoneNumber || 'that number'}${at ? ` at ${at}` : ''}.`}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          Accepted means Firebase took the send; it does not report when the phone receives it. A number
          set up as a test number in the Firebase console is answered the same way and gets no text.
        </p>
      </div>
    );
  }
  if (outcome.status === 'refused') {
    const code = outcome.providerCode || 'no code given';
    const hint = (outcome.providerCode && PROVIDER_HINTS[outcome.providerCode])
      || 'Firebase refused the send. Its code says why.';
    return (
      <p className="text-sm mt-3 text-rose-600 dark:text-rose-400">
        {'Not sent: Firebase refused the text ('}<Mono>{code}</Mono>{`). ${hint}`}
      </p>
    );
  }
  return (
    <p className="text-sm mt-3 text-rose-600 dark:text-rose-400">
      Could not reach Firebase: the request timed out or the network failed, so no text was sent.
    </p>
  );
}

function SmsSection() {
  const write = canWrite();
  const [status, setStatus] = useState<SmsStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'none' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/admin/sms/status');
      if (!alive.current) return;
      if (!ok || !data) { setStatusFailed(true); return; }
      setStatus(data);
    })();
  }, []);

  // The test is a real text, so it needs Firebase, not just test numbers.
  const offered = !!status && (status.texts ?? !!status.offered);

  const sendTest = async () => {
    if (sending || !offered) return;
    const phoneNumber = to.trim();
    if (!phoneNumber) { setResult({ kind: 'note', text: 'Enter a phone number first.', bad: true }); return; }
    setSending(true);
    setResult({ kind: 'note', text: 'Sending…' });

    // Firebase texts a web caller only with a reCAPTCHA answer, the same
    // one the sign-in sheet earns. A null token still goes: the server
    // answers with Firebase's refusal code, which is the diagnostic.
    const recaptchaToken = await phoneRecaptchaToken();
    if (!alive.current) return;

    const res = await fetchJson('/api/admin/sms/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, recaptchaToken }),
    });
    if (!alive.current) return;
    setSending(false);

    if (res.status === 0) {
      setResult({ kind: 'note', text: 'Could not reach the platform, so whether a text was sent is unknown.', bad: true });
      return;
    }
    if (!res.ok || !res.data || !res.data.outcome) {
      setResult({
        kind: 'note',
        text: (res.data && res.data.error) || 'The platform refused the request.',
        bad: true,
      });
      return;
    }
    setResult({ kind: 'outcome', outcome: res.data.outcome });
  };

  const n = RECAPTCHA_NOTICE;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className={AdminUI.cardTitle}>SMS delivery</h2>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
        Sign-in codes by text are sent by Firebase, not by Homeroom.
        This is where you check that a text actually goes out.
      </p>
      <div id="admin-sms-status" className="mb-4">
        <StatusCard status={status} failed={statusFailed} />
      </div>
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 mb-4">
        <h3 className="text-sm font-semibold mb-2">Send a test SMS</h3>
        {write ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block text-xs grow max-w-md">
                <span className="text-zinc-500 dark:text-zinc-400">Phone number</span>
                <input id="admin-sms-to" type="tel" autoComplete="off" spellCheck={false}
                  placeholder="+44 7700 900123"
                  className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm"
                  value={to}
                  disabled={!offered}
                  onChange={(e) => setTo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendTest(); } }} />
              </label>
              <button id="admin-sms-send" type="button" className={AdminUI.btn.primary}
                disabled={sending || !offered} onClick={sendTest}>
                {sending ? 'Sending…' : 'Send test SMS'}
              </button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
              Sends one sign-in code text to this number through Firebase and shows exactly what
              Firebase answered. The text is Firebase’s own code message, and nobody has to enter
              the code. Up to 5 per hour, and one per number per minute.
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              {n.lead}
              {n.sep}
              <a href={n.privacy.href} target="_blank" rel="noopener noreferrer" className="underline">{n.privacy.label}</a>
              {n.sep}
              <a href={n.terms.href} target="_blank" rel="noopener noreferrer" className="underline">{n.terms.label}</a>
            </p>
          </>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Sending a test SMS needs full admin access. The configuration above is readable by any admin.
          </p>
        )}
        <div id="admin-sms-result">
          {result.kind === 'outcome' ? <OutcomeLine outcome={result.outcome} /> : null}
          {result.kind === 'note' ? (
            <p className={`text-sm mt-3 ${result.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {result.text}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminSms = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <SmsSection />);
  },

  // Nothing polls; dropping the portal is the teardown, and the `alive` ref
  // turns an in-flight answer into a no-op.
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminSms = AdminSms;

export { AdminSms };
