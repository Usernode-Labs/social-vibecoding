/**
 * The Message button on a person's page — `#profile/<name>` and
 * `#leaderboard/users/<name>` — as the prototype draws it: a small filled
 * button at the right of the person's card. ./message-person.ts does the
 * work; this is the control, and how a refusal is reported.
 *
 * Callers decide WHETHER to draw it (never on your own page, never for a
 * visitor who cannot use Messages); this only draws it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { messagePerson } from './message-person';

export function MessageButton({ username }: { username: string }): ReactNode {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  async function start(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError('');
    const result = await messagePerson(username);
    if (!alive.current) return;
    // Success has already navigated to #messages/<id>; this page is on its
    // way out, but it is left usable in case the navigation was taken by a
    // side panel beside a running app.
    setPending(false);
    if (result.ok) return;
    // The platform's own transient feedback when the native kit is there
    // (every shell load ships it); the inline line below is the fallback, so
    // a refusal is never silent.
    const ui = (window as unknown as {
      PlatformUI?: { hasKit?: () => boolean; toast?: (m: string) => unknown };
    }).PlatformUI;
    if (ui?.hasKit?.() && typeof ui.toast === 'function') ui.toast(result.message);
    else setError(result.message);
  }

  return (
    <div className="relative shrink-0">
      <Button
        type="button"
        size="sm"
        data-message-person={username}
        aria-label={`Message @${username}`}
        disabled={pending}
        aria-busy={pending}
        className="disabled:opacity-60"
        onClick={() => { void start(); }}
      >
        Message
      </Button>
      {/*
          Out of the flow, under the button, so the card's name and bio keep
          their width: the button sits in the card's name row.
      */}
      {error ? (
        <p
          role="alert"
          className="absolute right-0 top-full z-10 mt-1 w-max max-w-[14rem] rounded-lg bg-white px-2 py-1 text-right text-xs text-red-700 shadow-sm dark:bg-zinc-800 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
