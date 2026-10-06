/**
 * A PRIVATE MEMBER's waitlist card on Home (#home-waitlist-card).
 *
 * A private member is somebody an invite link let into its group's app
 * before they were let in off the waitlist (users.private_member_since,
 * src/routes/member-waitlist.js). They use and change their group's apps;
 * making and sharing apps of their own is what the waitlist is for, and this
 * card is where they join it. In order:
 *
 *   join    "Make and share your own apps", and Join the waitlist;
 *   email   the address to join with: the account's own confirmed one joins
 *           with one press, another is sent a 6-digit code first. An address
 *           another account holds is refused (the server says so);
 *   code    the code from that mail;
 *   listed  "On the waitlist", where the news will go, and the optional
 *           "Want in sooner?" questions (#more/<token>, ../auth/more.tsx).
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

import { useStoreState } from '../../lib/use-store-state';
import { QUEUE_PILL, SURVEY_FIELD, SURVEY_LABEL, msgClass, useSurveyAnswered } from '../auth/waitlist-shared';
import { navStore } from '../nav/nav-store.js';

type Standing = {
  state: 'none' | 'listed' | 'admitted';
  email: string | null;
  /** The number on a phone-keyed row; null on an email-keyed one (#SMS). */
  phone?: string | null;
  accountEmail: string | null;
  /** The account's own verified number, when it has one — the one-press
   *  choice, the role accountEmail plays for the email half (#SMS). */
  accountPhone?: string | null;
  moreToken: string | null;
};

type Step =
  | { kind: 'join' }
  | { kind: 'email' }
  | { kind: 'phone' }
  | { kind: 'code'; key: 'email' | 'phone'; to: string };

const STATE_PATH = '/api/me/waitlist';
const JOIN_PATH = '/api/me/waitlist/join';
const VERIFY_PATH = '/api/me/waitlist/verify';

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
      {pill.label}
    </span>
  );
}

function Sooner({ token }: { token: string }): ReactNode {
  const answered = useSurveyAnswered(token);
  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
      <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-violet-700 dark:text-violet-300">
        Optional (moves you up the list)
      </span>
      <span className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">Want in sooner?</span>
      <span className={SMALL}>
        {answered
          ? 'Your answers are saved. Add to them any time.'
          : 'Four more questions, about three minutes: the group you’d bring, a tool you’ve lost, where else you are.'}
      </span>
      <a id="home-waitlist-sooner" href={`#more/${token}`} className={`${LINK} mt-1 self-start min-h-[44px] inline-flex items-center`}>
        {answered ? 'Edit my answers' : 'Answer them now'}
      </a>
    </div>
  );
}

export function WaitlistCardBody({ standing, onListed }: {
  standing: Standing;
  onListed: (next: Standing) => void;
}): ReactNode {
  const [step, setStep] = useState<Step>({ kind: 'join' });
  const [email, setEmail] = useState(standing.accountEmail || '');
  const [phone, setPhone] = useState(standing.accountPhone || '');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const own = !!standing.accountEmail && email.trim().toLowerCase() === standing.accountEmail;
  const ownPhone = !!standing.accountPhone && phone.trim() === standing.accountPhone;

  // One join path per channel: the body carries the key the server keys the
  // row on, and a phone join rides the same always-200 join endpoint.
  const join = useCallback(async (key: 'email' | 'phone', value: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(JOIN_PATH, key === 'phone' ? { phone: value } : { email: value });
      if (!ok) { setError(data?.error || 'Could not join the waitlist. Try again.'); return; }
      if (data.next === 'code') { setCode(''); setStep({ kind: 'code', key, to: data.phone || data.email }); return; }
      onListed(data as Standing);
    } catch {
      setError('Could not join the waitlist. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onListed]);

  const verify = useCallback(async (key: 'email' | 'phone', value: string, entered: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(
        VERIFY_PATH,
        key === 'phone' ? { phone: value, code: entered } : { email: value, code: entered },
      );
      if (!ok) { setError(data?.error || 'Could not check that code. Try again.'); return; }
      onListed(data as Standing);
    } catch {
      setError('Could not check that code. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onListed]);

  if (standing.state === 'listed') {
    // A row is keyed by exactly one channel, so the panel names the one it
    // has: the number for a phone row, the address otherwise (#SMS).
    const reach = standing.phone
      ? `We’ll text ${standing.phone} when it’s your turn.`
      : standing.email
        ? `You’re on the waitlist. We’ll email ${standing.email} when it’s your turn.`
        : 'You’re on the waitlist. We’ll email you when it’s your turn.';
    return (
      <div className="flex flex-col gap-2 p-4" data-waitlist-card="listed">
        <Pill />
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Make and share your own apps</h3>
        <p className={BODY}>{reach}</p>
        <p className={SMALL}>We let people in from the waitlist in batches. Until then, your group&rsquo;s apps are yours to use and change.</p>
        {standing.moreToken ? <Sooner token={standing.moreToken} /> : null}
      </div>
    );
  }

  if (step.kind === 'code') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void verify(step.key, step.to, code.trim()); };
    return (
      <form className="flex flex-col gap-2 p-4" data-waitlist-card="code" onSubmit={submit}>
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">
          {step.key === 'phone' ? 'Check your text messages' : 'Check your email'}
        </h3>
        <p className={BODY}>{`We sent a 6-digit code to ${step.to}. It expires in 15 minutes.`}</p>
        <label htmlFor="home-waitlist-code" className={SURVEY_LABEL}>Code</label>
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
          Join the waitlist
        </Button>
        <p role="alert" className={msgClass(error ? 'error' : null)}>{error}</p>
        <div className="flex items-center justify-between gap-3">
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: step.key }); }}>
            {step.key === 'phone' ? 'Use another number' : 'Use another email'}
          </button>
          <button type="button" className={`${SMALL} min-h-[44px] hover:underline`} disabled={busy} onClick={() => void join(step.key, step.to)}>
            Send a new code
          </button>
        </div>
      </form>
    );
  }

  if (step.kind === 'phone') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void join('phone', phone.trim()); };
    return (
      <form className="flex flex-col gap-2 p-4" data-waitlist-card="phone" onSubmit={submit}>
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Join the waitlist</h3>
        <p className={BODY}>
          {standing.accountPhone ? 'With your phone number, or another one.' : 'Add your phone number. We’ll text you a 6-digit code.'}
        </p>
        <label htmlFor="home-waitlist-phone" className={SURVEY_LABEL}>Phone number</label>
        <Input
          id="home-waitlist-phone"
          type="tel"
          autoComplete="tel"
          maxLength={20}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 415 555 0123"
          {...SURVEY_FIELD}
        />
        <Button type="submit" variant="pillAccent" size="pill" layout="full" disabled={busy || !phone.trim()} className="mt-1 disabled:opacity-60">
          {ownPhone ? 'Join the waitlist' : 'Text me a code'}
        </Button>
        <p role="alert" className={msgClass(error ? 'error' : null)}>{error}</p>
        <p className={SMALL}>We use it to tell you when it&rsquo;s your turn. The group doesn&rsquo;t see it.</p>
        <div className="flex items-center justify-between gap-3">
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'email' }); }}>
            Use email instead
          </button>
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'join' }); }}>
            Not now
          </button>
        </div>
      </form>
    );
  }

  if (step.kind === 'email') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void join('email', email.trim()); };
    return (
      <form className="flex flex-col gap-2 p-4" data-waitlist-card="email" onSubmit={submit}>
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Join the waitlist</h3>
        <p className={BODY}>
          {standing.accountEmail ? 'With your email, or another one.' : 'Add your email. We’ll email you a 6-digit code.'}
        </p>
        <label htmlFor="home-waitlist-email" className={SURVEY_LABEL}>Email</label>
        <Input
          id="home-waitlist-email"
          type="email"
          autoComplete="email"
          maxLength={255}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          {...SURVEY_FIELD}
        />
        <Button type="submit" variant="pillAccent" size="pill" layout="full" disabled={busy || !email.trim()} className="mt-1 disabled:opacity-60">
          {own ? 'Join the waitlist' : 'Email me a code'}
        </Button>
        <p role="alert" className={msgClass(error ? 'error' : null)}>{error}</p>
        <p className={SMALL}>We use it to tell you when it&rsquo;s your turn, and you can sign in with it. The group doesn&rsquo;t see it.</p>
        <div className="flex items-center justify-between gap-3">
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'phone' }); }}>
            Use a phone number
          </button>
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'join' }); }}>
            Not now
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4" data-waitlist-card="join">
      <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Make and share your own apps</h3>
      <p className={BODY}>
        You can use your group&rsquo;s apps and suggest changes to them now. To make apps of your own and share them with anyone, join the waitlist.
      </p>
      <Button
        id="home-waitlist-join"
        type="button"
        variant="pillAccent"
        size="pill"
        layout="full"
        className="mt-1 disabled:opacity-60"
        onClick={() => setStep({ kind: 'email' })}
      >
        Join the waitlist
      </Button>
      <p className={`${SMALL} text-center`}>We let people in from the waitlist in batches.</p>
    </div>
  );
}

export function WaitlistCard(): ReactNode {
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
    <section id="home-waitlist-card" className="px-3 pb-2 pt-3" aria-label="Waitlist">
      <GroupedList tone="plane" className="mx-0">
        <WaitlistCardBody standing={standing} onListed={setStanding} />
      </GroupedList>
    </section>
  );
}
