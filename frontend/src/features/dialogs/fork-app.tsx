/**
 * Fork-app dialog (#fork-modal), which people see as "Remix".
 *
 * Makes the viewer their own copy of an app: its code and look, in a new
 * project that starts as Just you, with its own repo, an empty database and
 * its own web address.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. The render output is still
 * byte-identical to what the shell shipped — same ids, same class strings,
 * same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html in
 * this commit are the proof.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `AppView._forkSource`, `.promptFork`, `.closeForkModal` and `.submitFork`
 * were public/js/app-view.js:12838-12918; the cancel, backdrop and submit
 * listeners were public/js/app.js's `bindEvents`. `AppView.promptFork(source)`
 * survives as a one-line forward because it has TWO callers with different
 * arguments: the app-view header's "+" menu passes nothing (fork the open
 * app) and the home-screen card dropdown passes an arbitrary `{slug, name}`
 * with no app open. That argument is now the island's open payload, which is
 * why `_forkSource` no longer needs to exist as shared state.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppAllowance, useAppAllowance } from './app-allowance';
import { invalidateAppAllowance } from './app-allowance-store.js';
import { CreateProgress } from './create-progress';
import {
  creationProgressStore,
  fetchCreationProgress,
  outcomeOf,
  publishAppStatus,
  stopWatchingCreation,
  watchCreation,
} from './creation-progress-store.js';
import { useDialog } from './use-dialog';

const POLL_INTERVAL_MS = 4000;

/**
 * What a remix copies, what starts fresh and what stays behind, in that
 * order: the box under the name field. Each line must stay true of what
 * src/services/app-forker.js does (an empty database, no stored keys, the
 * original's visibility, approval rule and admins stripped from dapp.json).
 * tests/remix-safe-defaults.test.js pins the words as the shell ships them.
 */
const FORK_INFO_LINES: ReadonlyArray<{ lead: string | null; text: string }> = [
  { lead: 'Copied:', text: 'the code, the look and the icon.' },
  {
    lead: 'Starts fresh:',
    text: 'it’s Just you, with an empty database. Invite people or open it up later.',
  },
  {
    lead: 'Not copied:',
    text: 'anyone’s data, keys, chat or members. If the app needs a key, you’ll add your own before it goes live.',
  },
  { lead: null, text: 'Its code is public on GitHub.' },
];

export interface ForkSource {
  slug: string;
  name?: string;
}

export function ForkAppDialog() {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<ForkSource | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forked, setForked] = useState<{ slug: string; name: string } | null>(null);
  const progress = useStoreState(creationProgressStore);
  const { blocked: quotaBlocksCreation } = useAppAllowance();

  const dialog = useDialog<ForkSource>('fork', {
    onOpen: (payload) => {
      void invalidateAppAllowance();
      const src = payload || null;
      sourceRef.current = src;
      setSourceName(src?.name || '');
      setError('');
      setForked(null);
      stopWatchingCreation();
      if (inputRef.current) inputRef.current.value = `${src?.name || 'App'} (remix)`;
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
    },
    onClose: () => {
      setError('');
      setBusy(false);
      setForked(null);
      stopWatchingCreation();
      if (inputRef.current) inputRef.current.value = '';
    },
  });

  useHiddenClass(errorRef, !error);

  // Forking is asynchronous just like creating/importing. Follow the shared
  // phase stream, with a poll as the recovery path if the terminal websocket
  // event is missed while the source app remains open behind this dialog.
  const creatingSlug = forked && outcomeOf(progress.status) === 'pending' ? forked.slug : null;
  useEffect(() => {
    if (!creatingSlug) return undefined;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      void fetchCreationProgress(creatingSlug, (url: string) => fetch(url));
    };
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [creatingSlug]);

  // Verbatim from AppView.submitFork.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const source = sourceRef.current;
    if (!source?.slug) return;
    const name = (inputRef.current?.value || '').trim();
    if (name.length < 3) return setError('Name must be at least 3 characters.');

    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(source.slug)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      void invalidateAppAllowance();
      if (!res.ok) {
        setError(data.error || 'Could not make your copy.');
        return;
      }
      const slug = data.app?.slug;
      if (!slug) {
        // A malformed success cannot be followed. Preserve the old fallback
        // rather than rendering a progress card with no app to poll. Going
        // Home writes an address right after the close (#3683).
        dialog.closeForNavigation();
        window.PlatformUI?.toast?.(
          'Your copy is being made. It will appear in your apps when it is ready.',
        );
        (window.App?.navigateHome as (() => void) | undefined)?.();
        return;
      }
      watchCreation(slug);
      setForked({ slug, name: data.app?.name || name });
      // Put the new tile behind the still-open report immediately. The dialog
      // owns the detailed status; the tile remains a useful destination after
      // the user closes it.
      (window.Home?.load as (() => void) | undefined)?.();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogRoot
      id="fork-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        {forked ? (
          <CreateProgress
            appName={forked.name}
            mode="fork"
            progress={progress}
            onOpenApp={() => {
              // Both buttons write history right after the close: the fork's
              // address, or the back-button record the secrets dialog pushes
              // as it opens. A plain close queues a history.back() that lands
              // after either one and undoes it, so the button seemed to do
              // nothing (#3683; create-app.tsx's progress card is the same).
              const slug = forked.slug;
              dialog.closeForNavigation();
              (window.App?.openAppTab as ((s: string, t: string) => void) | undefined)?.(slug, 'app');
            }}
            onSetSecrets={() => {
              const slug = forked.slug;
              dialog.closeForNavigation();
              (window.Secrets?.open as ((s: string) => void) | undefined)?.(slug);
            }}
            onRetry={() => {
              const slug = forked.slug;
              watchCreation(slug);
              void fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' })
                .then(async (res) => {
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    publishAppStatus({
                      slug,
                      status: 'error',
                      errorReason: data.error || `Retry failed (HTTP ${res.status}).`,
                    });
                    return;
                  }
                  (window.Home?.load as (() => void) | undefined)?.();
                })
                .catch(() => {
                  publishAppStatus({
                    slug,
                    status: 'error',
                    errorReason: 'Could not reach the server to retry. Try again from the app tile.',
                  });
                });
            }}
            onClose={() => dialog.close()}
          />
        ) : (
          <>
        {/*
            People see a fork as a "Remix": their own copy, which starts as
            Just you with an empty database (src/services/app-forker.js says
            what is copied and what is not). The ids keep "fork": the route
            is /fork and the shell baseline pins them.

            Every space beside an inline element is written inside a string:
            JSX drops the line break between text and a tag, which once ran
            the name into its sentence ("ForkingBook Clubstands up").
        */}
        <h2 className="text-lg font-bold mb-1 break-words">
          {'Remix '}
          <span id="fork-source-name">{sourceName || 'this app'}</span>
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
          Make your own copy. You get the code and the look, and it starts as Just you.
        </p>
        <AppAllowance />
        <form id="fork-form" className="space-y-4" onSubmit={submit}>
          <div>
            <label
              htmlFor="fork-input"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              Name for your copy
            </label>
            <Input
              id="fork-input"
              ref={inputRef}
              type="text"
              required={true}
              minLength={3}
              maxLength={64}
              autoComplete="off"
              box="dialog"
              hint="muted"
              ring="seamless"
              placeholder="My copy"
            />
          </div>
          <div
            className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 p-3"
          >
            {FORK_INFO_LINES.map((line) => (
              <p key={line.lead || line.text}>
                {line.lead ? (
                  <strong className="font-semibold text-zinc-900 dark:text-zinc-100">{line.lead}</strong>
                ) : null}
                {/* One text child, its leading space inside the string: two
                    adjacent text runs do not survive the prerender. */}
                {line.lead ? ` ${line.text}` : line.text}
              </p>
            ))}
          </div>
          <div id="fork-error" ref={errorRef} className="text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="fork-cancel"
              className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button
              type="submit"
              id="fork-submit"
              layout="flex"
              disabled={busy || quotaBlocksCreation}
              disabledStyle="block"
            >
              {busy ? 'Remixing…' : 'Remix'}
            </Button>
          </div>
        </form>
          </>
        )}
      </DialogCard>
    </DialogRoot>
  );
}
