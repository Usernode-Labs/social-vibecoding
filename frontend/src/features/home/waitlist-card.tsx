/**
 * A PRIVATE MEMBER's waitlist card on Home (#home-waitlist-card).
 *
 * A private member is somebody an invite link let into a community's app
 * before they were let in off the waitlist (users.private_member_since,
 * src/routes/member-waitlist.js). They use and change their communities' apps;
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
  accountEmail: string | null;
  moreToken: string | null;
};

type Step = { kind: 'join' } | { kind: 'email' } | { kind: 'code'; email: string };

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
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const own = !!standing.accountEmail && email.trim().toLowerCase() === standing.accountEmail;

  const join = useCallback(async (address: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(JOIN_PATH, { email: address });
      if (!ok) { setError(data?.error || 'Could not join the waitlist. Try again.'); return; }
      if (data.next === 'code') { setCode(''); setStep({ kind: 'code', email: data.email }); return; }
      onListed(data as Standing);
    } catch {
      setError('Could not join the waitlist. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onListed]);

  const verify = useCallback(async (address: string, entered: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await post(VERIFY_PATH, { email: address, code: entered });
      if (!ok) { setError(data?.error || 'Could not check that code. Try again.'); return; }
      onListed(data as Standing);
    } catch {
      setError('Could not check that code. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onListed]);

  if (standing.state === 'listed') {
    return (
      <div className="flex flex-col gap-2 p-4" data-waitlist-card="listed">
        <Pill />
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Make and share your own apps</h3>
        <p className={BODY}>
          {standing.email
            ? `You’re on the waitlist. We’ll email ${standing.email} when your spot is ready.`
            : 'You’re on the waitlist. We’ll email you when your spot is ready.'}
        </p>
        <p className={SMALL}>We let people in a few at a time. Until then, you can use and change the apps in your communities.</p>
        {standing.moreToken ? <Sooner token={standing.moreToken} /> : null}
      </div>
    );
  }

  if (step.kind === 'code') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void verify(step.email, code.trim()); };
    return (
      <form className="flex flex-col gap-2 p-4" data-waitlist-card="code" onSubmit={submit}>
        <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Check your email</h3>
        <p className={BODY}>{`We sent a 6-digit code to ${step.email}. It expires in 15 minutes.`}</p>
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
          <button type="button" className={`${LINK} min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'email' }); }}>
            Use another email
          </button>
          <button type="button" className={`${SMALL} min-h-[44px] hover:underline`} disabled={busy} onClick={() => void join(step.email)}>
            Send a new code
          </button>
        </div>
      </form>
    );
  }

  if (step.kind === 'email') {
    const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void join(email.trim()); };
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
        <p className={SMALL}>We use it to tell you when your spot is ready, and you can sign in with it. Nobody else sees it.</p>
        <button type="button" className={`${LINK} self-start min-h-[44px]`} onClick={() => { setError(null); setStep({ kind: 'join' }); }}>
          Not now
        </button>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4" data-waitlist-card="join">
      <h3 className="text-[17px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">Make and share your own apps</h3>
      <p className={BODY}>
        You can use the apps in your communities and suggest changes to them now. To make apps of your own and share them with anyone, join the waitlist.
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
      <p className={`${SMALL} text-center`}>We let people in a few at a time.</p>
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
