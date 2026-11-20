'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';

// Text alerts (Admin › Limits): the numbers Homeroom texts when a platform
// limit is near, reached or over, or the bot's OpenRouter credit runs out.
// The same limits the Platform limits card at the top of Notifications shows
// (services/platform-limits-view.js); the rules are services/limit-texts.js.
//
// FULL ADMINS ONLY. The numbers are people's phone numbers, so a view-only
// admin is told so and nothing is read: GET /api/admin/limit-texts answers
// 403 to them, as every write here does.
//
// A NUMBER IS ACTIVE ONCE ITS CODE IS ENTERED. Adding one texts it a code;
// until the code is entered it is shown in full (so a typo can be seen and
// removed) and is never sent an alert. Once confirmed it shows only its last
// four digits.
//
// TEXTS NEED BREVO OR TWILIO. When Admin › Platform › SMS delivery is on
// Firebase (which only sends sign-in codes) or the provider is not set up,
// the card says so and adding a number is off: never a silent failure.

type Phone = {
  id: number;
  label: string;
  country: string;
  number: string;
  verified: boolean;
  verifiedAt: string | null;
  waitingForCode: boolean;
  addedBy: string | null;
  createdAt: string | null;
  lastTextedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

type Availability = { ready: boolean; reason: 'firebase' | 'not_configured' | null; provider: string; countries: string[] };

export type LimitTextsData = { availability: Availability; phones: Phone[]; maxPhones: number };

type Status = { text: string; tone: 'ok' | 'err' };

const LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';

const UNAVAILABLE: Record<string, string> = {
  firebase: 'Texts can\'t go out: Admin › Platform › SMS delivery uses Firebase, which only sends sign-in codes. Switch it to Brevo or Twilio to add numbers.',
  not_configured: 'Texts can\'t go out: the selected text provider is missing its key or its Sender IDs. Finish it in Admin › Platform › SMS delivery to add numbers.',
};

const PROVIDER_NAME: Record<string, string> = { brevo: 'Brevo', twilio: 'Twilio' };

function when(iso: string | null): string | null {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Pure: the line under a number saying what it was last sent. */
export function lastLine(phone: Phone): { text: string; err: boolean } {
  const at = when(phone.lastTextedAt);
  if (phone.lastStatus === 'refused' || phone.lastStatus === 'failed') {
    const why = phone.lastError ? ` (${phone.lastError})` : '';
    return { text: `The last text was ${phone.lastStatus === 'failed' ? 'not delivered' : 'refused'}${why}.${at ? ` Last texted ${at}.` : ''}`, err: true };
  }
  if (at) return { text: `Last texted ${at}.`, err: false };
  return { text: 'Not texted yet.', err: false };
}

async function call(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
  return data;
}

export function LimitTextsCard({ canWrite, initialData = null }: { canWrite: boolean; initialData?: LimitTextsData | null }) {
  const [data, setData] = useState<LimitTextsData | null>(initialData);
  const [label, setLabel] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [codes, setCodes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const next = await call('GET', '/api/admin/limit-texts');
      if (alive.current) setData(next);
    } catch (err: any) {
      if (alive.current) setStatus({ text: err.message, tone: 'err' });
    }
  }, []);

  useEffect(() => { if (canWrite && !initialData) void load(); }, [canWrite, initialData, load]);

  const act = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setStatus(null);
    try {
      const text = await run();
      await load();
      if (alive.current) setStatus({ text, tone: 'ok' });
    } catch (err: any) {
      if (alive.current) setStatus({ text: err.message, tone: 'err' });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const ready = !!data && data.availability.ready;
  const full = !!data && data.phones.length >= data.maxPhones;
  const addOff = !canWrite || !ready || full || busy !== null;

  return (
    <div id="admin-limit-texts" className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Text alerts</h2>
        {data && canWrite ? (
          <span id="admin-limit-texts-count" className="text-xs text-zinc-500 dark:text-zinc-400">
            {data.phones.filter((p) => p.verified).length} of {data.phones.length} numbers confirmed
          </span>
        ) : null}
      </div>
      <p className={`${AdminUI.muted} mb-3`}>
        Text these numbers when a platform limit is near, reached or over, or the bot's OpenRouter
        credit runs out: the same limits the Platform limits card at the top of Notifications shows.
        Each limit is texted once when it becomes near and once when it is reached, then at most every
        6 hours while it stays full. Near texts wait out quiet hours. A new number is texted a code,
        and gets alerts only once the code is entered.
      </p>

      {!canWrite ? (
        <p id="admin-limit-texts-view-only" className={AdminUI.muted}>Only full admins can see or change the numbers texted.</p>
      ) : !data ? (
        <p className={AdminUI.loading}>Loading…</p>
      ) : (
        <>
          {!ready ? (
            <p id="admin-limit-texts-unavailable" className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
              {UNAVAILABLE[data.availability.reason || 'not_configured']}
            </p>
          ) : (
            <p id="admin-limit-texts-provider" className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
              Sent through {PROVIDER_NAME[data.availability.provider] || data.availability.provider} to numbers in{' '}
              {data.availability.countries.join(', ')}.
            </p>
          )}

          {data.phones.length ? (
            <ul id="admin-limit-texts-list" className="mb-4 divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.phones.map((phone) => {
                const line = lastLine(phone);
                return (
                  <li key={phone.id} id={`admin-limit-text-${phone.id}`} data-verified={phone.verified ? 'true' : 'false'} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{phone.label}</span>
                      <span className="font-mono text-sm text-zinc-600 dark:text-zinc-300">{phone.number}</span>
                      {phone.verified ? (
                        <span className={AdminUI.badge.success}>Confirmed</span>
                      ) : phone.waitingForCode ? (
                        <span className={AdminUI.badge.warn}>Waiting for its code</span>
                      ) : (
                        <span className={AdminUI.badge.outline}>Code expired</span>
                      )}
                    </div>
                    <p className={`mt-1 text-xs ${line.err ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      {phone.verified ? line.text : 'Gets no alerts until its code is entered.'}
                      {phone.addedBy ? ` Added by @${phone.addedBy}.` : ''}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {phone.verified ? (
                        <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== null || !ready}
                          data-limit-text-action="test"
                          onClick={() => act(`test-${phone.id}`, async () => {
                            await call('POST', `/api/admin/limit-texts/${phone.id}/test`);
                            return `Test text sent to ${phone.label}.`;
                          })}>
                          Send a test text
                        </button>
                      ) : (
                        <>
                          <label className="sr-only" htmlFor={`admin-limit-text-code-${phone.id}`}>Code texted to {phone.label}</label>
                          <input id={`admin-limit-text-code-${phone.id}`} type="text" inputMode="numeric" autoComplete="one-time-code"
                            maxLength={6} placeholder="6-digit code"
                            className={`${AdminUI.input} w-32 font-mono`}
                            value={codes[phone.id] || ''}
                            onChange={(e) => setCodes({ ...codes, [phone.id]: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
                          <button type="button" className={AdminUI.btn.primarySm}
                            disabled={busy !== null || (codes[phone.id] || '').length !== 6}
                            data-limit-text-action="verify"
                            onClick={() => act(`verify-${phone.id}`, async () => {
                              await call('POST', `/api/admin/limit-texts/${phone.id}/verify`, { code: codes[phone.id] });
                              return `${phone.label} is confirmed. It gets alerts from now on.`;
                            })}>
                            Confirm
                          </button>
                          <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== null || !ready}
                            data-limit-text-action="resend"
                            onClick={() => act(`resend-${phone.id}`, async () => {
                              await call('POST', `/api/admin/limit-texts/${phone.id}/resend`);
                              return `A new code was texted to ${phone.label}.`;
                            })}>
                            Send a new code
                          </button>
                        </>
                      )}
                      <button type="button" className={AdminUI.btn.ghost} disabled={busy !== null}
                        data-limit-text-action="remove"
                        onClick={() => {
                          if (!window.confirm(`Stop texting ${phone.label}?`)) return;
                          void act(`remove-${phone.id}`, async () => {
                            await call('DELETE', `/api/admin/limit-texts/${phone.id}`);
                            return `${phone.label} is no longer texted.`;
                          });
                        }}>
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p id="admin-limit-texts-empty" className={`${AdminUI.muted} mb-4`}>No numbers yet.</p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] items-end gap-3">
            <label className="block">
              <span className={LABEL}>Label</span>
              <input id="admin-limit-texts-label" type="text" maxLength={60} placeholder="Evan's phone"
                disabled={addOff} className={`${AdminUI.input} mt-1 disabled:opacity-60`}
                value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="block">
              <span className={LABEL}>Phone number, with its country code</span>
              <input id="admin-limit-texts-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+44 7700 900123"
                disabled={addOff} className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
                value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
            </label>
            <button id="admin-limit-texts-add" type="button" className={AdminUI.btn.primary}
              disabled={addOff || !label.trim() || !phoneNumber.trim()}
              onClick={() => act('add', async () => {
                const out = await call('POST', '/api/admin/limit-texts', { label: label.trim(), phoneNumber: phoneNumber.trim() });
                setLabel('');
                setPhoneNumber('');
                return `A code was texted to ${out.phone ? out.phone.label : 'the number'}. Enter it to confirm the number.`;
              })}>
              Text a code
            </button>
          </div>
          {full ? (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">At most {data.maxPhones} numbers. Remove one to add another.</p>
          ) : null}
        </>
      )}
      <p id="admin-limit-texts-status" className={status
        ? `text-xs mt-2 ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
        : 'text-xs mt-2 hidden'}>
        {status ? status.text : ''}
      </p>
    </div>
  );
}
