'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { phoneRecaptchaToken, RECAPTCHA_NOTICE } from '../auth/recaptcha';

// SMS delivery section of the admin console (#admin/sms).
//
// Homeroom texts sign-in codes. Until this section grew a switch those texts
// went out one way: Firebase Phone Auth (src/services/firebase-phone-auth.js).
// Now a full admin chooses who sends them — Firebase, today's path, or Brevo
// (src/services/sms/) — and this section shows whether the choice is ready,
// which countries Brevo may text and with which Sender ID, and what the last
// texts did. It looks like Email delivery on purpose:
//
//   1. Who sends texts, and is it ready?  (provider card, PUT /api/admin/sms/provider)
//   2. Is phone sign-in set up?           (status card, GET /api/admin/sms/status)
//   3. Which countries may Brevo text?    (Sender IDs card, from the same read)
//   4. Does a text go out right now?      (send a test, POST /api/admin/sms/test)
//   5. What did the latest texts do?      (Recent texts, GET /api/admin/sms/deliveries)
//   6. What has been failing, and why?    (failure log, GET /api/admin/sms/failures)
//
// The test is the real send through the selected provider. With Firebase it
// is the Identity Toolkit call with the invisible reCAPTCHA the sign-in
// sheet earns; with Brevo it is a plain test message, so nobody enters a
// code. The answer names the provider's own code, which users never see.
//
// PERMISSIONS: visible to any admin. Changing the provider and sending the
// test are full-admin-only; a view-only admin sees why. The server enforces
// both independently.

interface ProviderOption {
  name: string;
  label: string;
  ready: boolean;
  missing: string[];
}

interface ProviderInfo {
  selected: string;
  source: 'admin' | 'env' | 'default';
  options: ProviderOption[];
}

interface SenderRow {
  country: string;
  countryName: string;
  sender: string;
  needsRegistration: boolean;
  registered: boolean;
  ready: boolean;
}

interface DeliveryRow {
  id: number;
  kind: string;
  provider: string;
  country: string | null;
  sender_id: string | null;
  phone_last4: string | null;
  status: string;
  error_code: string | null;
  provider_code: string | null;
  provider_message_id: string | null;
  attempts: number;
  delivery_status: string | null;
  created_at: string;
}

interface SmsStatus {
  offered?: boolean;
  texts?: boolean;
  testNumbers?: boolean;
  enabled?: boolean;
  projectId?: string | null;
  missing?: string[];
  canSendTest?: boolean;
  provider?: ProviderInfo;
  senders?: SenderRow[];
  stagingLogOnly?: boolean;
}

interface Outcome {
  status?: 'sent' | 'refused' | 'unreachable' | 'logged';
  provider?: string;
  phoneNumber?: string;
  country?: string;
  senderId?: string;
  messageId?: string | null;
  providerCode?: string | null;
  httpStatus?: number | null;
  durationMs?: number;
  sentAt?: string;
}

type Result =
  | { kind: 'none' }
  | { kind: 'note'; text: string; bad?: boolean }
  | { kind: 'outcome'; outcome: Outcome };

interface PhoneFailure {
  id: number;
  kind: string;
  user_id: number | null;
  username: string | null;
  phone_last4: string | null;
  error_code: string;
  provider_code: string | null;
  message: string;
  created_at: string;
}

// One plain label per leg of the flow, the words the section already uses.
const KIND_LABELS: Record<string, string> = {
  code_request: 'Code request',
  verify: 'Verify code',
  link_request: 'Link code request',
  link_verify: 'Link number',
};

const DELIVERY_KINDS: Record<string, string> = {
  otp: 'Sign-in code',
  marketing: 'Marketing',
  test: 'Test',
};

const DELIVERY_RESULTS: Record<string, string> = {
  sent: 'Sent',
  logged: 'Logged only',
  refused: 'Refused',
  failed: 'Failed',
};

const SOURCE_NOTES: Record<string, string> = {
  admin: 'Saved by an admin. That choice wins over the deploy’s default.',
  env: 'The deploy’s default, from PLATFORM_SMS_PROVIDER. An admin can change it here.',
  default: 'The deploy’s default, which is Firebase until an admin saves a choice.',
};

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

// One plain sentence per provider code an operator is likely to meet.
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
  no_sender_id: 'No Sender ID is registered for that country. Register one in Brevo, then add it to BREVO_SMS_SENDER_IDS.',
  country_not_registered: 'That country needs its registration recorded first: a numeric sender and registered: true in BREVO_SMS_SENDER_IDS.',
  unsupported_country: 'That number’s calling code is not in the supported country list.',
  invalid_phone: 'Enter the number with its country code, starting with +.',
  not_enough_credits: 'The Brevo account has no SMS credits left.',
  unauthorized: 'Brevo did not accept the API key. Check BREVO_API_KEY.',
  provider_refused: 'Brevo refused the message. Its code says why.',
  provider_unreachable: 'Brevo could not be reached after three attempts, so no text was sent.',
  timeout: 'Brevo did not answer in time. It may already have sent the text, so it was not retried.',
};

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>;
}

function MissingList({ missing }: { missing: string[] }) {
  return (
    <>
      {(missing || []).map((k, i) => <span key={k}>{i ? ', ' : ''}<Mono>{k}</Mono></span>)}
    </>
  );
}

function ProviderCard({ provider, write, onSaved }: {
  provider: ProviderInfo; write: boolean; onSaved: () => void;
}) {
  const [picked, setPicked] = useState(provider.selected);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => { setPicked(provider.selected); }, [provider.selected]);

  const option = provider.options.find((o) => o.name === picked);
  const changed = picked !== provider.selected;

  const save = async () => {
    if (!write || saving || !option || !option.ready) return;
    setSaving(true);
    setNote(null);
    const res = await fetchJson('/api/admin/sms/provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: picked }),
    });
    setSaving(false);
    if (res.status === 0) {
      setNote({ text: 'Could not reach the platform. The provider was not changed.', bad: true });
      return;
    }
    if (!res.ok) {
      const missing = res.data && Array.isArray(res.data.missing) ? res.data.missing : [];
      setNote({
        text: `${(res.data && res.data.error) || 'The platform refused the change.'}${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}`,
        bad: true,
      });
      return;
    }
    setNote({ text: `Saved. Texts are now sent by ${option.label}.` });
    onSaved();
  };

  return (
    <div id="admin-sms-provider" className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 mb-4">
      <h3 className="text-sm font-semibold mb-2">Text messages are sent by</h3>
      {provider.options.map((o) => (
        <label key={o.name} className="flex items-start gap-2 text-sm py-1">
          <input
            type="radio"
            name="admin-sms-provider"
            value={o.name}
            checked={picked === o.name}
            disabled={!write || !o.ready}
            onChange={() => setPicked(o.name)}
            className="mt-1"
          />
          <span>
            <span className="font-medium">{o.label}</span>{' '}
            {o.ready ? (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">Ready</span>
            ) : (
              <span className="text-xs text-amber-700 dark:text-amber-400">
                {'Needs '}<MissingList missing={o.missing} />
              </span>
            )}
          </span>
        </label>
      ))}
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
        {SOURCE_NOTES[provider.source] || SOURCE_NOTES.default}
        {' A provider that is not ready cannot be chosen.'}
      </p>
      {!write ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">
          Changing who sends texts needs full admin access. Any admin can read this section.
        </p>
      ) : (
        <button
          id="admin-sms-provider-save"
          type="button"
          className={`${AdminUI.btn.primary} mt-2`}
          disabled={saving || !changed || !option || !option.ready}
          onClick={save}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      {note ? (
        <p className={`text-sm mt-2 ${note.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

function StatusCard({ status, failed }: { status: SmsStatus | null; failed: boolean }) {
  if (failed) return <p className="text-sm text-zinc-500 dark:text-zinc-400">Could not load the SMS configuration.</p>;
  if (!status) return <p className={AdminUI.loading}>Loading…</p>;

  const testLine = status.testNumbers ? (
    <p className="text-zinc-500 dark:text-zinc-400 mt-1">
      {'Test numbers are on: +1, any area code, then 555 0100 to 0199, sign in with the code in '}
      <Mono>PHONE_TEST_CODE</Mono>
      {' and get no text. Each account one makes is a test account.'}
    </p>
  ) : null;

  const stagingLine = status.stagingLogOnly ? (
    <p className="text-zinc-500 dark:text-zinc-400 mt-1">
      This is a staging preview: no text is ever sent. Sign-in codes are written to the preview’s log instead.
    </p>
  ) : null;

  const provider = status.provider;
  const selected = provider ? provider.options.find((o) => o.name === provider.selected) : null;

  if (status.offered && status.texts !== false) {
    return (
      <div className={`${AdminUI.card} px-4 py-3 text-sm`}>
        <span className="font-semibold text-emerald-700 dark:text-emerald-400">SMS is set up:</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          {provider && provider.selected === 'brevo' ? (
            ' phone sign-in is offered, and its codes are texted by Brevo to the countries listed under Sender IDs.'
          ) : (
            <>
              {' phone sign-in is offered, and its codes are texted by Firebase project '}
              <Mono>{status.projectId || 'unknown'}</Mono>{'.'}
            </>
          )}
        </span>
        {testLine}
        {stagingLine}
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
        {stagingLine}
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
        <MissingList missing={(selected && selected.missing && selected.missing.length
          ? selected.missing
          : (status.missing || []))} />
        {' in the platform’s Platform variables panel, then redeploy. Until then no text can be sent, and the test below stays off.'}
      </p>
      {stagingLine}
    </div>
  );
}

function SendersCard({ senders, selected }: { senders: SenderRow[]; selected: string }) {
  return (
    <div id="admin-sms-senders" className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 mb-4">
      <h3 className="text-sm font-semibold mb-2">Sender IDs</h3>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
        {'Brevo texts only these countries. Register a Sender ID in Brevo first, then add it to '}
        <Mono>BREVO_SMS_SENDER_IDS</Mono>
        {'. A country that is not on this list is refused.'}
      </p>
      {senders.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No Sender IDs are registered, so Brevo texts no country.
          {selected === 'brevo' ? ' Phone sign-in cannot text a real number until one is added.' : ''}
        </p>
      ) : (
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table}>
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>Country</th>
                <th className={AdminUI.th}>Sender ID</th>
                <th className={AdminUI.th}>Ready</th>
              </tr>
            </thead>
            <tbody>
              {senders.map((s) => (
                <tr key={s.country}>
                  <td className={AdminUI.td}>{`${s.countryName} (${s.country})`}</td>
                  <td className={`${AdminUI.td} font-mono text-xs`}>{s.sender}</td>
                  <td className={AdminUI.td}>
                    {s.ready ? (
                      <span className="text-emerald-700 dark:text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-rose-600 dark:text-rose-400">
                        {s.needsRegistration && !s.registered
                          ? 'No: needs registration marked'
                          : 'No'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  const at = outcome.sentAt ? `${outcome.sentAt.replace('T', ' ').slice(11, 16)} UTC` : '';
  const brevo = outcome.provider === 'brevo';
  const name = brevo ? 'Brevo' : 'Firebase';
  const place = [
    outcome.country ? `country ${outcome.country}` : '',
    outcome.senderId ? `Sender ID ${outcome.senderId}` : '',
    outcome.messageId ? `message ${outcome.messageId}` : '',
  ].filter(Boolean).join(', ');

  if (outcome.status === 'sent' || outcome.status === 'logged') {
    return (
      <div className="mt-3">
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          {outcome.status === 'logged'
            ? `Logged only: this staging preview did not send the text to ${outcome.phoneNumber || 'that number'}${at ? ` at ${at}` : ''}.`
            : `Sent: ${name} accepted the text for ${outcome.phoneNumber || 'that number'}${at ? ` at ${at}` : ''}${place ? ` (${place})` : ''}.`}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          {brevo
            ? 'Accepted means Brevo took the send; a delivery receipt arrives at the webhook when its carrier reports one.'
            : 'Accepted means Firebase took the send; it does not report when the phone receives it. A number set up as a test number in the Firebase console is answered the same way and gets no text.'}
        </p>
      </div>
    );
  }
  if (outcome.status === 'refused') {
    const code = outcome.providerCode || 'no code given';
    const hint = (outcome.providerCode && PROVIDER_HINTS[outcome.providerCode])
      || `${name} refused the send. Its code says why.`;
    return (
      <p className="text-sm mt-3 text-rose-600 dark:text-rose-400">
        {'Not sent: '}{name}{' refused the text ('}<Mono>{code}</Mono>{`). ${hint}`}
      </p>
    );
  }
  return (
    <p className="text-sm mt-3 text-rose-600 dark:text-rose-400">
      {`Could not reach ${name}: the request timed out or the network failed, so no text was sent.`}
    </p>
  );
}

function DeliveriesCard({ deliveries, failed }: { deliveries: DeliveryRow[] | null; failed: boolean }) {
  return (
    <div id="admin-sms-deliveries" className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 mb-4">
      <h3 className="text-sm font-semibold mb-2">Recent texts</h3>
      {failed ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Could not load the delivery log.</p>
      ) : deliveries === null ? (
        <p className={AdminUI.loading}>Loading…</p>
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No texts have been sent yet. Each send, whatever its outcome, appears here.
        </p>
      ) : (
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table}>
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>When (UTC)</th>
                <th className={AdminUI.th}>Kind</th>
                <th className={AdminUI.th}>Country</th>
                <th className={AdminUI.th}>Sender ID</th>
                <th className={AdminUI.th}>Number</th>
                <th className={AdminUI.th}>Result</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => {
                const result = DELIVERY_RESULTS[d.status] || d.status;
                const bad = d.status === 'refused' || d.status === 'failed';
                return (
                  <tr key={d.id}>
                    <td className={`${AdminUI.td} whitespace-nowrap text-zinc-500 dark:text-zinc-400`}>
                      {d.created_at ? d.created_at.replace('T', ' ').slice(0, 16) : ''}
                    </td>
                    <td className={AdminUI.td}>{DELIVERY_KINDS[d.kind] || d.kind}</td>
                    <td className={AdminUI.td}>{d.country || ''}</td>
                    <td className={`${AdminUI.td} font-mono text-xs`}>{d.sender_id || ''}</td>
                    <td className={`${AdminUI.td} font-mono text-xs`}>{d.phone_last4 ? `…${d.phone_last4}` : ''}</td>
                    <td className={AdminUI.td}>
                      <span className={bad ? 'text-rose-600 dark:text-rose-400' : undefined}>{result}</span>
                      {d.error_code ? <span className="text-xs text-zinc-500 dark:text-zinc-400"> <Mono>{d.error_code}</Mono></span> : null}
                      {d.provider_code && d.provider_code !== d.error_code ? (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400"> (<Mono>{d.provider_code}</Mono>)</span>
                      ) : null}
                      {d.provider_message_id ? (
                        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{` id ${d.provider_message_id}`}</span>
                      ) : null}
                      {d.delivery_status ? <div className="text-xs text-zinc-500 dark:text-zinc-400">{d.delivery_status}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FailuresCard({ failures, total7d, failed }: { failures: PhoneFailure[] | null; total7d: number | null; failed: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
      <h3 className="text-sm font-semibold mb-2">Recent failures</h3>
      {failed ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Could not load the failure log.</p>
      ) : failures === null ? (
        <p className={AdminUI.loading}>Loading…</p>
      ) : failures.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No failures recorded. Every failed code request, verification and link attempt
          would appear here with the reason the provider gave.
        </p>
      ) : (
        <>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            {`The 50 most recent, newest first. ${total7d === 1 ? '1 failure' : `${total7d ?? failures.length} failures`} in the last 7 days.`}
          </p>
          <div className={AdminUI.tableWrap} id="admin-sms-failures-table">
            <table className={AdminUI.table}>
              <thead className={AdminUI.thead}>
                <tr>
                  <th className={AdminUI.th}>When (UTC)</th>
                  <th className={AdminUI.th}>Step</th>
                  <th className={AdminUI.th}>Account</th>
                  <th className={AdminUI.th}>Number</th>
                  <th className={AdminUI.th}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={f.id}>
                    <td className={`${AdminUI.td} whitespace-nowrap text-zinc-500 dark:text-zinc-400`}>
                      {f.created_at ? f.created_at.replace('T', ' ').slice(0, 16) : ''}
                    </td>
                    <td className={AdminUI.td}>{KIND_LABELS[f.kind] || f.kind}</td>
                    <td className={AdminUI.td}>
                      {f.username ? (
                        <span className="font-mono text-xs">{f.username}</span>
                      ) : (
                        <span className="text-zinc-400 dark:text-zinc-600">not signed in</span>
                      )}
                    </td>
                    <td className={`${AdminUI.td} font-mono text-xs`}>
                      {f.phone_last4 ? `…${f.phone_last4}` : ''}
                    </td>
                    <td className={AdminUI.td}>
                      <Mono>{f.error_code}</Mono>
                      {f.provider_code && f.provider_code !== f.error_code ? (
                        <span className="text-zinc-500 dark:text-zinc-400">
                          {' (Provider: '}<Mono>{f.provider_code}</Mono>{')'}
                        </span>
                      ) : null}
                      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{f.message}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SmsSection() {
  const write = canWrite();
  const [status, setStatus] = useState<SmsStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [failures, setFailures] = useState<PhoneFailure[] | null>(null);
  const [total7d, setTotal7d] = useState<number | null>(null);
  const [failuresFailed, setFailuresFailed] = useState(false);
  const [deliveries, setDeliveries] = useState<DeliveryRow[] | null>(null);
  const [deliveriesFailed, setDeliveriesFailed] = useState(false);
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>({ kind: 'none' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadStatus = async () => {
    const { ok, data } = await fetchJson('/api/admin/sms/status');
    if (!alive.current) return;
    if (!ok || !data) { setStatusFailed(true); return; }
    setStatusFailed(false);
    setStatus(data);
  };

  useEffect(() => {
    loadStatus();
    (async () => {
      const { ok, data } = await fetchJson('/api/admin/sms/failures');
      if (!alive.current) return;
      if (!ok || !data || !Array.isArray(data.failures)) { setFailuresFailed(true); return; }
      setFailures(data.failures);
      setTotal7d(typeof data.total7d === 'number' ? data.total7d : null);
    })();
    (async () => {
      const { ok, data } = await fetchJson('/api/admin/sms/deliveries');
      if (!alive.current) return;
      if (!ok || !data || !Array.isArray(data.deliveries)) { setDeliveriesFailed(true); return; }
      setDeliveries(data.deliveries);
    })();
  }, []);

  const provider = status?.provider || null;
  const isBrevo = provider ? provider.selected === 'brevo' : false;

  // The test is a real text, so it needs a ready provider, not just test numbers.
  const offered = !!status && (status.texts ?? !!status.offered);

  const sendTest = async () => {
    if (sending || !offered) return;
    const phoneNumber = to.trim();
    if (!phoneNumber) { setResult({ kind: 'note', text: 'Enter a phone number first.', bad: true }); return; }
    setSending(true);
    setResult({ kind: 'note', text: 'Sending…' });

    // Firebase texts a web caller only with a reCAPTCHA answer. Brevo needs
    // none, so it is earned only when Firebase is the selected provider.
    const recaptchaToken = isBrevo ? undefined : await phoneRecaptchaToken();
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
    loadStatus();
  };

  const n = RECAPTCHA_NOTICE;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className={AdminUI.cardTitle}>SMS delivery</h2>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
        Sign-in codes by text are sent by the provider chosen below, not by Homeroom.
        This is where you choose it and check that a text actually goes out.
      </p>
      {provider ? (
        <ProviderCard provider={provider} write={write} onSaved={loadStatus} />
      ) : null}
      <div id="admin-sms-status" className="mb-4">
        <StatusCard status={status} failed={statusFailed} />
      </div>
      {status && status.senders && (isBrevo || (provider && provider.options.some((o) => o.name === 'brevo' && o.ready))) ? (
        <SendersCard senders={status.senders} selected={provider ? provider.selected : 'firebase'} />
      ) : null}
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
              {isBrevo ? (
                'Sends one test text to this number through Brevo, from the Sender ID for its country, and shows exactly what Brevo answered. It is a plain test message, so nobody has to enter a code.'
              ) : (
                'Sends one sign-in code text to this number through Firebase and shows exactly what Firebase answered. The text is Firebase’s own code message, and nobody has to enter the code.'
              )}
              {' Up to 5 per hour, and one per number per minute.'}
            </p>
            {!isBrevo ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                {n.lead}
                <a href={n.privacy.href} target="_blank" rel="noopener noreferrer" className="underline">{n.privacy.label}</a>
                {n.and}
                <a href={n.terms.href} target="_blank" rel="noopener noreferrer" className="underline">{n.terms.label}</a>
                {n.tail}
              </p>
            ) : null}
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
      <DeliveriesCard deliveries={deliveries} failed={deliveriesFailed} />
      <div id="admin-sms-failures" className="mb-4">
        <FailuresCard failures={failures} total7d={total7d} failed={failuresFailed} />
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
