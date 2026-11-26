'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { phoneRecaptchaToken, RECAPTCHA_NOTICE } from '../auth/recaptcha';
import {
  Badge, EmptyState, ErrorState, Field, Figures, Input, List, Panel, ScreenHeader, SettingRow,
  SettingsGroup, Skeleton, TabPanel, Tabs,
} from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';

// SMS delivery section of the admin console (#admin/sms).
//
// Homeroom texts sign-in codes. Until this section grew a switch those texts
// went out one way: Firebase Phone Auth (src/services/firebase-phone-auth.js).
// Now a full admin chooses who sends them — Firebase, today's path, Brevo or
// Twilio (src/services/sms/) — and this section shows whether the choice is
// ready, which countries the gateway may text and with which Sender ID, and
// what the last texts did. It looks like Email delivery on purpose:
//
//   1. Who sends texts, and is it ready?  (provider card, PUT /api/admin/sms/provider)
//      And if Brevo or Twilio cannot?    (Firebase backup, PUT /api/admin/sms/fallback)
//   2. Is phone sign-in set up?           (status card, GET /api/admin/sms/status)
//   3. Which countries may it text?       (Sender IDs card, from the same read)
//   4. Does a text go out right now?      (send a test, POST /api/admin/sms/test)
//   5. What did the latest texts do?      (Recent texts, GET /api/admin/sms/deliveries)
//   6. What has been failing, and why?    (failure log, GET /api/admin/sms/failures)
//
// The test is the real send through the selected provider. With Firebase it
// is the Identity Toolkit call with the invisible reCAPTCHA the sign-in
// sheet earns; with Brevo or Twilio it is a plain test message, so nobody
// enters a code. The answer names the provider's own code, which users never see.
//
// The page is four tabs since 26 Nov 2026, built from the shared admin kit
// (topochain/ui.tsx): Provider (the status, the choice, the backup and the
// Sender IDs), Send a test SMS, Recent texts and Recent failures. It was one
// long page, and the two logs sat under everything else. Every panel stays
// mounted, so each id is in the document whichever tab is up.
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
  senderProvider?: string;
  stagingLogOnly?: boolean;
  fallback?: { enabled: boolean; ready: boolean };
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

// The providers that only carry a text (Homeroom makes and checks the code),
// with the registry variable each one's Sender IDs live in.
const GATEWAYS: Record<string, { label: string; registry: string }> = {
  brevo: { label: 'Brevo', registry: 'BREVO_SMS_SENDER_IDS' },
  twilio: { label: 'Twilio', registry: 'TWILIO_SMS_SENDER_IDS' },
};

function providerLabel(name: string | undefined): string {
  if (name && GATEWAYS[name]) return GATEWAYS[name].label;
  return 'Firebase';
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
  unsupported_country: 'That number’s calling code is not in the supported country list.',
  invalid_phone: 'Enter the number with its country code, starting with +.',
  not_enough_credits: 'The Brevo account has no SMS credits left.',
  unauthorized: 'Brevo did not accept the API key. Check BREVO_API_KEY.',
  // Twilio's numeric error codes.
  '20003': 'Twilio did not accept the credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
  '21211': 'Twilio could not read the number. Enter it with its country code, starting with +.',
  '21408': 'That country is not enabled in the Twilio account’s Geo Permissions.',
  '21610': 'That number replied STOP to this sender, so Twilio will not text it until it replies START.',
  '21612': 'Twilio cannot send from this Sender ID to that number. Check the country’s Sender ID rules.',
  '21614': 'That number cannot receive text messages.',
  '21606': 'The Sender ID is not a Twilio number or approved sender for this account.',
};

// The same answer means the same thing from either gateway, so these are
// written once and name the one that sent.
function providerHint(code: string, name: string): string | undefined {
  if (PROVIDER_HINTS[code]) return PROVIDER_HINTS[code];
  const gateway = Object.values(GATEWAYS).find((g) => g.label === name);
  const registry = gateway ? gateway.registry : 'the Sender ID registry';
  switch (code) {
    case 'no_sender_id':
      return `No Sender ID is registered for that country. Register one in ${name}, then add it to ${registry}.`;
    case 'country_not_registered':
      return `That country needs its registration recorded first: a numeric sender and registered: true in ${registry}.`;
    case 'provider_refused':
      return `${name} refused the message. Its code says why.`;
    case 'provider_unreachable':
      return `${name} could not be reached after three attempts, so no text was sent.`;
    case 'timeout':
      return `${name} did not answer in time. It may already have sent the text, so it was not retried.`;
    default:
      return undefined;
  }
}

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
    <div id="admin-sms-provider">
      <Panel
        title="Text messages are sent by"
        footer={write ? (
          <button
            id="admin-sms-provider-save"
            type="button"
            className={AdminUI.btn.primary}
            disabled={saving || !changed || !option || !option.ready}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        ) : undefined}
      >
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
              <span className="font-medium">{o.label}</span>
              {o.ready ? (
                <span className="text-xs text-emerald-700 dark:text-emerald-400">{' Ready'}</span>
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
        ) : null}
        {note ? (
          <p className={`text-sm mt-2 ${note.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {note.text}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

// While Brevo or Twilio sends, Firebase can send the sign-in codes the
// gateway could not: a refusal, an outage, a country with no Sender ID, or a
// resend while the first code is still live (services/firebase-phone-auth.js,
// FIREBASE BACKUP).
function FallbackCard({ fallback, write, onSaved }: {
  fallback: { enabled: boolean; ready: boolean }; write: boolean; onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);

  const toggle = async (enabled: boolean) => {
    if (!write || saving) return;
    setSaving(true);
    setNote(null);
    const res = await fetchJson('/api/admin/sms/fallback', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    setSaving(false);
    if (!res.ok) {
      setNote({ text: (res.data && res.data.error) || 'The platform refused the change.', bad: true });
      return;
    }
    setNote({ text: enabled ? 'Saved. Firebase now backs up sign-in codes.' : 'Saved. Sign-in codes go by the gateway only.' });
    onSaved();
  };

  // A switch that saves when it is changed, so it is a settings row
  // (26 Nov 2026). It was a checkbox in a card of its own.
  return (
    <div id="admin-sms-fallback">
      <SettingsGroup title="Firebase backup for sign-in codes">
        <SettingRow
          id="admin-sms-fallback-enabled"
          title="When the gateway cannot send a sign-in code, or someone asks for a new one while the first is still unused, Firebase sends it instead."
          help={fallback.ready
            ? 'Firebase is set up. A backup text asks the person for Google’s reCAPTCHA check first; other sign-ins skip it. Marketing and test texts never use the backup.'
            : 'Firebase is not set up, so there is no backup whatever this says.'}
          checked={fallback.enabled}
          canEdit={write}
          onChange={toggle}
        >
          {!write ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">
              Changing this needs full admin access.
            </p>
          ) : null}
          {note ? (
            <p className={`text-sm mt-2 ${note.bad ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
              {note.text}
            </p>
          ) : null}
        </SettingRow>
      </SettingsGroup>
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
          {provider && GATEWAYS[provider.selected] ? (
            ` phone sign-in is offered, and its codes are texted by ${GATEWAYS[provider.selected].label} to the countries listed under Sender IDs.`
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

const SENDER_COLUMNS: Column<SenderRow>[] = [
  { label: 'Country', primary: true, cell: (s) => `${s.countryName} (${s.country})` },
  { label: 'Sender ID', tdClass: 'font-mono text-xs', cell: (s) => s.sender },
  {
    label: 'Ready',
    cell: (s) => (s.ready
      ? <Badge tone="mint" label="Yes" />
      : <Badge tone="red" label={s.needsRegistration && !s.registered ? 'No: needs registration marked' : 'No'} />),
  },
];

function SendersCard({ senders, selected, gateway }: {
  senders: SenderRow[]; selected: string; gateway: string;
}) {
  const g = GATEWAYS[gateway] || GATEWAYS.brevo;
  return (
    <div id="admin-sms-senders">
      <Panel
        title="Sender IDs"
        subtitle={(
          <>
            {`${g.label} texts only these countries. Register a Sender ID in ${g.label} first, then add it to `}
            <Mono>{g.registry}</Mono>
            {'. A country that is not on this list is refused.'}
          </>
        )}
      >
        {senders.length === 0 ? (
          <EmptyState
            title={`No Sender IDs are registered, so ${g.label} texts no country.`}
            body={selected === gateway ? 'Phone sign-in cannot text a real number until one is added.' : undefined}
          />
        ) : (
          <List<SenderRow> items={senders} columns={SENDER_COLUMNS} rowKey={(s) => s.country} />
        )}
      </Panel>
    </div>
  );
}

function OutcomeLine({ outcome }: { outcome: Outcome }) {
  const at = outcome.sentAt ? `${outcome.sentAt.replace('T', ' ').slice(11, 16)} UTC` : '';
  const gateway = !!(outcome.provider && GATEWAYS[outcome.provider]);
  const name = providerLabel(outcome.provider);
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
          {gateway
            ? `Accepted means ${name} took the send; a delivery receipt arrives at the webhook when its carrier reports one.`
            : 'Accepted means Firebase took the send; it does not report when the phone receives it. A number set up as a test number in the Firebase console is answered the same way and gets no text.'}
        </p>
      </div>
    );
  }
  if (outcome.status === 'refused') {
    const code = outcome.providerCode || 'no code given';
    const hint = (outcome.providerCode && providerHint(outcome.providerCode, name))
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

// A result repeated down the log is a soft pill: green for sent, red for a
// text that did not go, grey for one only written to a preview's log.
const DELIVERY_TONES: Record<string, string> = {
  sent: 'mint',
  logged: 'zinc',
  refused: 'red',
  failed: 'red',
};

const DELIVERY_COLUMNS: Column<DeliveryRow>[] = [
  {
    label: 'When (UTC)',
    primary: true,
    tdClass: 'whitespace-nowrap text-zinc-500 dark:text-zinc-400',
    cell: (d) => (d.created_at ? d.created_at.replace('T', ' ').slice(0, 16) : ''),
  },
  { label: 'Kind', cell: (d) => DELIVERY_KINDS[d.kind] || d.kind },
  { label: 'Country', cell: (d) => d.country || '' },
  { label: 'Sender ID', tdClass: 'font-mono text-xs', cell: (d) => d.sender_id || '' },
  { label: 'Number', tdClass: 'font-mono text-xs', cell: (d) => (d.phone_last4 ? `…${d.phone_last4}` : '') },
  {
    label: 'Result',
    cell: (d) => (
      <>
        <Badge tone={DELIVERY_TONES[d.status] || 'zinc'} label={DELIVERY_RESULTS[d.status] || d.status} />
        {d.error_code ? <span className="text-xs text-zinc-500 dark:text-zinc-400"> <Mono>{d.error_code}</Mono></span> : null}
        {d.provider_code && d.provider_code !== d.error_code ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400"> (<Mono>{d.provider_code}</Mono>)</span>
        ) : null}
        {d.provider_message_id ? (
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{` id ${d.provider_message_id}`}</span>
        ) : null}
        {d.delivery_status ? <div className="text-xs text-zinc-500 dark:text-zinc-400">{d.delivery_status}</div> : null}
      </>
    ),
  },
];

// The tab is named Recent texts, so the list carries no heading of its own.
function DeliveriesCard({ deliveries, failed }: { deliveries: DeliveryRow[] | null; failed: boolean }) {
  return (
    <div id="admin-sms-deliveries">
      {failed ? (
        <ErrorState title="Could not load the delivery log." />
      ) : deliveries === null ? (
        <Skeleton rows={6} />
      ) : deliveries.length === 0 ? (
        <EmptyState
          title="No texts have been sent yet."
          body="Each send, whatever its outcome, appears here."
        />
      ) : (
        <List<DeliveryRow> items={deliveries} columns={DELIVERY_COLUMNS} rowKey={(d) => d.id} />
      )}
    </div>
  );
}

const FAILURE_COLUMNS: Column<PhoneFailure>[] = [
  {
    label: 'When (UTC)',
    primary: true,
    tdClass: 'whitespace-nowrap text-zinc-500 dark:text-zinc-400',
    cell: (f) => (f.created_at ? f.created_at.replace('T', ' ').slice(0, 16) : ''),
  },
  { label: 'Step', cell: (f) => KIND_LABELS[f.kind] || f.kind },
  {
    label: 'Account',
    cell: (f) => (f.username ? (
      <span className="font-mono text-xs">{f.username}</span>
    ) : (
      <span className="text-zinc-400 dark:text-zinc-600">not signed in</span>
    )),
  },
  { label: 'Number', tdClass: 'font-mono text-xs', cell: (f) => (f.phone_last4 ? `…${f.phone_last4}` : '') },
  {
    label: 'Reason',
    cell: (f) => (
      <>
        <Mono>{f.error_code}</Mono>
        {f.provider_code && f.provider_code !== f.error_code ? (
          <span className="text-zinc-500 dark:text-zinc-400">
            {' (Provider: '}<Mono>{f.provider_code}</Mono>{')'}
          </span>
        ) : null}
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{f.message}</div>
      </>
    ),
  },
];

// The tab is named Recent failures, so the list carries no heading of its own.
function FailuresCard({ failures, total7d, failed }: { failures: PhoneFailure[] | null; total7d: number | null; failed: boolean }) {
  if (failed) return <ErrorState title="Could not load the failure log." />;
  if (failures === null) return <Skeleton rows={6} />;
  if (failures.length === 0) {
    return (
      <EmptyState
        title="No failures recorded."
        body="Every failed code request, verification and link attempt would appear here with the reason the provider gave."
      />
    );
  }
  return (
    <>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
        {`The 50 most recent, newest first. ${total7d === 1 ? '1 failure' : `${total7d ?? failures.length} failures`} in the last 7 days.`}
      </p>
      <div id="admin-sms-failures-table">
        <List<PhoneFailure> items={failures} columns={FAILURE_COLUMNS} rowKey={(f) => f.id} />
      </div>
    </>
  );
}

type SmsTab = 'provider' | 'test' | 'texts' | 'failures';
const SMS_TABS_ID = 'admin-sms-tabs';

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
  const [tab, setTab] = useState<SmsTab>('provider');
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
  const gateway = provider && GATEWAYS[provider.selected] ? provider.selected : null;
  const isGateway = !!gateway;

  // The test is a real text, so it needs a ready provider, not just test numbers.
  const offered = !!status && (status.texts ?? !!status.offered);

  const sendTest = async () => {
    if (sending || !offered) return;
    const phoneNumber = to.trim();
    if (!phoneNumber) { setResult({ kind: 'note', text: 'Enter a phone number first.', bad: true }); return; }
    setSending(true);
    setResult({ kind: 'note', text: 'Sending…' });

    // Firebase texts a web caller only with a reCAPTCHA answer. Brevo and
    // Twilio need none, so it is earned only when Firebase is the selected
    // provider.
    const recaptchaToken = isGateway ? undefined : await phoneRecaptchaToken();
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

  const showSenders = !!(status && status.senders
    && (isGateway || (provider && provider.options.some((o) => GATEWAYS[o.name] && o.ready))));

  // Only what the three reads above already brought: nothing is fetched to
  // fill a tile, and one that has not arrived is a dash.
  const notSent = deliveries ? deliveries.filter((d) => d.status === 'refused' || d.status === 'failed').length : null;
  const failed7d = failures ? (total7d ?? failures.length) : null;
  const figures: Figure[] = [];
  if (showSenders && status && status.senders) {
    figures.push({
      key: 'countries',
      label: 'Countries with a ready Sender ID',
      value: status.senders.filter((s) => s.ready).length,
    });
  }
  figures.push({
    key: 'not-sent',
    label: 'Recent texts refused or failed',
    value: notSent,
    tone: notSent ? 'yellow' : 'sky',
    onClick: () => setTab('texts'),
  });
  figures.push({
    key: 'failures',
    label: 'Sign-in failures, last 7 days',
    value: failed7d,
    tone: failed7d ? 'yellow' : 'sky',
    onClick: () => setTab('failures'),
  });

  return (
    <div>
      <ScreenHeader
        title="SMS delivery"
        subtitle="Sign-in codes by text are sent by the provider chosen below, not by Homeroom. This is where you choose it and check that a text actually goes out."
      />
      <Figures id="admin-sms-figures" items={figures} />
      <Tabs<SmsTab>
        id={SMS_TABS_ID}
        label="SMS delivery"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'provider', label: 'Provider' },
          { key: 'test', label: 'Send a test SMS' },
          { key: 'texts', label: 'Recent texts' },
          { key: 'failures', label: 'Recent failures' },
        ]}
      />
      <TabPanel tabsId={SMS_TABS_ID} tab="provider" active={tab === 'provider'}>
        {provider ? (
          <ProviderCard provider={provider} write={write} onSaved={loadStatus} />
        ) : null}
        {isGateway && status?.fallback ? (
          <FallbackCard fallback={status.fallback} write={write} onSaved={loadStatus} />
        ) : null}
        <div id="admin-sms-status" className="mb-4">
          <StatusCard status={status} failed={statusFailed} />
        </div>
        {showSenders && status && status.senders ? (
          <SendersCard senders={status.senders} selected={provider ? provider.selected : 'firebase'}
            gateway={status.senderProvider || gateway || 'brevo'} />
        ) : null}
      </TabPanel>
      <TabPanel tabsId={SMS_TABS_ID} tab="test" active={tab === 'test'}>
        <Panel title="Send a test SMS">
          {write ? (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Phone number" htmlFor="admin-sms-to" className="grow max-w-md">
                  <Input id="admin-sms-to" type="tel" autoComplete="off" spellCheck={false}
                    placeholder="+44 7700 900123"
                    value={to}
                    disabled={!offered}
                    onChange={(e) => setTo(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendTest(); } }} />
                </Field>
                <button id="admin-sms-send" type="button" className={AdminUI.btn.primary}
                  disabled={sending || !offered} onClick={sendTest}>
                  {sending ? 'Sending…' : 'Send test SMS'}
                </button>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                {gateway ? (
                  `Sends one test text to this number through ${GATEWAYS[gateway].label}, from the Sender ID for its country, and shows exactly what ${GATEWAYS[gateway].label} answered. It is a plain test message, so nobody has to enter a code.`
                ) : (
                  'Sends one sign-in code text to this number through Firebase and shows exactly what Firebase answered. The text is Firebase’s own code message, and nobody has to enter the code.'
                )}
                {' Up to 5 per hour, and one per number per minute.'}
              </p>
              {!isGateway ? (
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
              Sending a test SMS needs full admin access. The configuration on the Provider tab is readable by any admin.
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
        </Panel>
      </TabPanel>
      <TabPanel tabsId={SMS_TABS_ID} tab="texts" active={tab === 'texts'}>
        <DeliveriesCard deliveries={deliveries} failed={deliveriesFailed} />
      </TabPanel>
      <TabPanel tabsId={SMS_TABS_ID} tab="failures" active={tab === 'failures'}>
        <div id="admin-sms-failures" className="mb-4">
          <FailuresCard failures={failures} total7d={total7d} failed={failuresFailed} />
        </div>
      </TabPanel>
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
