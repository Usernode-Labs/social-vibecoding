/**
 * A PRIVATE MEMBER's waitlist card on Home (#home-waitlist-card).
 *
 * A private member is somebody an invite link let into a community's app
 * before they were let in off the waitlist (users.private_member_since,
 * src/routes/member-waitlist.js). They use and change their communities' apps;
 * making and sharing apps of their own is what the waitlist is for, and this
 * card is where they join it. In order:
 *
 *   join    "Make your own apps", and Join the waitlist. An
 *           account with a verified phone and no confirmed email joins right
 *           there, with that one press and nothing asked (#4223);
 *   email   the address to join with: the account's own confirmed one joins
 *           with one press, another is sent a 6-digit code first. An address
 *           another account holds is refused (the server says so);
 *   code    the code from that mail;
 *   listed  "On the waitlist", how the news will come, and the optional
 *           "Want in sooner?" questions as one row (#more/<token>,
 *           ../auth/more.tsx).
 *           Joined by phone, it offers "Add an email too", which goes
 *           through the email and code steps above.
 *
 * NOT IN THE PRERENDER. Who is signed in arrives after hydration (the nav
 * store's `privateMember`, published by App._syncViewer), so the first render
 * is nothing at all, which is what the document ships, and the card appears
 * once the shell knows. Its state is read from the server in an effect.
 */

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';

import { Message, useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { QUEUE_PILL, SURVEY_FIELD, SURVEY_LABEL, msgClass, useSurveyAnswered } from '../auth/waitlist-shared';
import { navStore } from '../nav/nav-store.js';

type Standing = {
  state: 'none' | 'listed' | 'admitted';
  email: string | null;
  accountEmail: string | null;
  /** A verified phone on the account: with no accountEmail, it joins with one press. */
  hasPhone?: boolean;
  moreToken: string | null;
};

type Step = { kind: 'join' } | { kind: 'email' } | { kind: 'code'; email: string };

const STATE_PATH = '/api/me/waitlist';
const JOIN_PATH = '/api/me/waitlist/join';
const VERIFY_PATH = '/api/me/waitlist/verify';
const JOIN_PHONE_PATH = '/api/me/waitlist/join-phone';

const BODY = 'text-[15px] leading-snug text-zinc-700 dark:text-zinc-200';
const SMALL = 'text-[13px] leading-snug text-zinc-500 dark:text-zinc-400';
const LINK = 'text-sm font-semibold text-violet-700 dark:text-violet-300 hover:underline underline-offset-2';

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data && data.ok !== false, data };
}

function Pill(): ReactNode {
  const pill = QUEUE_PILL.confirmed;
  return (
    <span className={`self-start inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${pill.tint}`}>
      <Message id={pill.label} />
    </span>
  );
}

function Sooner({ token }: { token: string }): ReactNode {
  const answered = useSurveyAnswered(token);
  const t = useMessages('home');
  return (
    <div className="mt-1 flex items-center justify-between gap-3 border-t border-zinc-200 pt-1 dark:border-zinc-800">
      <span className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">{t('home:waitlist.sooner.title')}</span>
      <a id="home-waitlist-sooner" href={`#more/${token}`} className={`${LINK} min-h-[44px] inline-flex items-center`}>
        {answered ? t('home:waitlist.sooner.edit') : t('home:waitlist.sooner.answer')}
      </a>
    </div>
  );
}

export function WaitlistCardBody({ standing, onListed }: {
  standing: Standing;
  onListed: (next: Standing) => void;
}): ReactNode {
  const t = useMessages('home');
  const [step, setStep] = useState<Step>({ kind: 'join' });
  const [email, setEmail] = useState(standing.accountEmail || '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const own = !!standing.accountEmail && email.trim().toLowerCase() === standing.accountEmail;

  const join = useCallback(async (address: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(JOIN_PATH, { email: address });
      if (!ok) { setError(data?.error || t('home:waitlist.error.join')); return; }
      if (data.next === 'code') { setCode(''); setStep({ kind: 'code', email: data.email }); return; }
      setStep({ kind: 'join' });
      onListed(data as Standing);
    } catch {
      setError(t('home:waitlist.error.join'));
    } finally {
      setBusy(false);
    }
  }, [onListed, t]);

  const verify = useCallback(async (address: string, entered: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(VERIFY_PATH, { email: address, code: entered });
      if (!ok) { setError(data?.error || t('home:waitlist.error.code')); return; }
      setStep({ kind: 'join' });
      onListed(data as Standing);
    } catch {
      setError(t('home:waitlist.error.code'));
    } finally {
      setBusy(false);
    }
  }, [onListed, t]);

  const joinByPhone = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(JOIN_PHONE_PATH, {});
      if (!ok) { setError(data?.error || t('home:waitlist.error.join')); return; }
      onListed(data as Standing);
    } catch {
      setError(t('home:waitlist.error.join'));
    } finally {
      setBusy(false);
    }
  }, [onListed, t]);

  const listed = standing.state === 'listed';
  // Joined by phone: no address on the row, so the news goes by text.
  const byPhone = listed && !standing.email;
  const phoneOnly = !!standing.hasPhone && !standing.accountEmail;

  if (listed && step.kind === 'join') {
    return (
      <div className="flex flex-col gap-2 p-4" data-waitlist-card="listed">
        <Pill />
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{t('home:waitlist.title')}</h3>
        <p className={BODY}>
          {byPhone ? t('home:waitlist.listed.byText') : t('home:waitlist.listed.byEmail')}
        </p>
        {byPhone ? (
          <button
            id="home-waitlist-add-email"
            type="button"
            className={`${LINK} self-start min-h-[44px]`}
            onClick={() => { setError(null); setEmail(''); setStep({ kind: 'email' }); }}
          >
            {t('home:waitlist.addEmail.link')}
          </button>
        ) : null}
        {standing.moreToken ? <Sooner token={standing.moreToken} /> : null}
      </div>
    );
  }

  if (step.kind === 'code') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void verify(step.email, code.trim()); };
    return (
      <form className="flex flex-col gap-2 p-4" data-waitlist-card="code" onSubmit={submit}>
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{t('home:waitlist.code.title')}</h3>
        <p className={BODY}>{t('home:waitlist.code.sent', { email: step.email })}</p>
        <label htmlFor="home-waitlist-code" className={SURVEY_LABEL}>{t('home:waitlist.code.label')}</label>
        <Input
          id="home-waitlist-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          {...SURVEY_FIELD}
        />
        <Button type="submit" variant="pillAccent" size="pill" layout="full" disabled={busy || code.length !== 6} className="mt-1 disabled:opacity-60">
          {t('home:waitlist.code.submit')}
        </Button>
        <p role="alert" className={msgClass(error ? 'error' : null)}>{error}</p>
        <div className="flex items-center justify-between gap-3">
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'email' }); }}>
            {t('home:waitlist.code.otherEmail')}
          </button>
          <button type="button" className={`${SMALL} min-h-[44px] hover:underline`} disabled={busy} onClick={() => void join(step.email)}>
            {t('home:waitlist.code.resend')}
          </button>
        </div>
      </form>
    );
  }

  if (step.kind === 'email') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void join(email.trim()); };
    return (
      <form className="flex flex-col gap-2 p-4" data-waitlist-card="email" onSubmit={submit}>
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
          {listed ? t('home:waitlist.email.titleAdd') : t('home:waitlist.email.titleJoin')}
        </h3>
        <p className={BODY}>
          {standing.accountEmail ? t('home:waitlist.email.leadOwn') : t('home:waitlist.email.leadAdd')}
        </p>
        <label htmlFor="home-waitlist-email" className={SURVEY_LABEL}>{t('home:waitlist.email.label')}</label>
        <Input
          id="home-waitlist-email"
          type="email"
          autoComplete="email"
          maxLength={255}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('home:waitlist.email.placeholder')}
          {...SURVEY_FIELD}
        />
        <Button type="submit" variant="pillAccent" size="pill" layout="full" disabled={busy || !email.trim()} className="mt-1 disabled:opacity-60">
          {own ? t('home:waitlist.email.submitJoin') : t('home:waitlist.email.submitCode')}
        </Button>
        <p role="alert" className={msgClass(error ? 'error' : null)}>{error}</p>
        <p className={SMALL}>{t('home:waitlist.email.privacy')}</p>
        <button type="button" className={`${LINK} self-start min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'join' }); }}>
          {t('home:waitlist.email.notNow')}
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4" data-waitlist-card="join">
      <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{t('home:waitlist.title')}</h3>
      <Button
        id="home-waitlist-join"
        type="button"
        variant="pillAccent"
        size="pill"
        layout="full"
        className="mt-1 disabled:opacity-60"
        disabled={busy}
        onClick={() => (phoneOnly ? void joinByPhone() : setStep({ kind: 'email' }))}
      >
        {t('home:waitlist.join.button')}
      </Button>
      {phoneOnly ? <p role="alert" className={msgClass(error ? 'error' : null)}>{error}</p> : null}
      <p className={`${SMALL} text-center`}>{t('home:waitlist.join.note')}</p>
    </div>
  );
}

export function WaitlistCard(): ReactNode {
  const t = useMessages('home');
  const { privateMember } = useStoreState(navStore);
  const [standing, setStanding] = useState<Standing | null>(null);

  useEffect(() => {
    if (!privateMember) { setStanding(null); return undefined; }
    let live = true;
    fetch(STATE_PATH, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (live && data && typeof data.state === 'string') setStanding(data as Standing); })
      .catch(() => { /* the card waits for the next visit */ });
    return () => { live = false; };
  }, [privateMember]);

  if (!privateMember || !standing || standing.state === 'admitted') return null;
  return (
    <section id="home-waitlist-card" className="px-3 pb-2 pt-3" aria-label={t('home:waitlist.regionLabel')}>
      <GroupedList tone="plane" className="mx-0">
        <WaitlistCardBody standing={standing} onListed={setStanding} />
      </GroupedList>
    </section>
  );
}
