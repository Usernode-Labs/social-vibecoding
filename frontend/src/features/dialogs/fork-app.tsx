import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
  { lead: 'Copied:', get text() { return tr("core:the_code_the_look_and_the_icon_9f03a6ac"); } },
  {
    get lead() { return tr("core:starts_fresh_bcafdf4b"); },
    get text() { return tr("core:it_s_just_you_with_an_empty_database_invite_peop_09b6731b"); },
  },
  {
    get lead() { return tr("core:not_copied_c9824ba4"); },
    get text() { return tr("core:anyone_s_data_keys_chat_or_members_if_the_app_ne_562cacfb"); },
  },
  { lead: null, get text() { return tr("core:its_code_is_public_on_github_b4e29b5e"); } },
];

export interface ForkSource {
  slug: string;
  name?: string;
}

export function ForkAppDialog() {
  useUiLanguage();
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
      if (inputRef.current) inputRef.current.value = tr("core:value1_remix_3e9e5264", { value1: src?.name || tr("core:message_0d04bfeb7d64") });
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
    if (name.length < 3) return setError(tr("core:name_must_be_at_least_3_characters_7cd487b2"));

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
        setError(data.error || tr("core:could_not_make_your_copy_ba5bbed0"));
        return;
      }
      const slug = data.app?.slug;
      if (!slug) {
        // A malformed success cannot be followed. Preserve the old fallback
        // rather than rendering a progress card with no app to poll. Going
        // Home writes an address right after the close (#3683).
        dialog.closeForNavigation();
        window.PlatformUI?.toast?.(
          tr("core:your_copy_is_being_made_it_will_appear_in_your_a_c06c296e"),
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
      setError(tr("core:network_error_please_try_again_9ff8cfaf"));
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
                      errorReason: data.error || tr("core:retry_failed_http_value1_16e2772d", { value1: res.status }),
                    });
                    return;
                  }
                  (window.Home?.load as (() => void) | undefined)?.();
                })
                .catch(() => {
                  publishAppStatus({
                    slug,
                    status: 'error',
                    get errorReason() { return tr("core:could_not_reach_the_server_to_retry_try_again_fr_2e49f76e"); },
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
          <Message id="core:remix_ab20b589" />
          <span id="fork-source-name"><LocalizedValue render={() => (sourceName || tr("core:this_app_d2c823cf"))} /></span>
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4"><Message id="core:make_your_own_copy_you_get_the_code_and_the_look_4f82d061" /></p>
        <AppAllowance />
        <form id="fork-form" className="space-y-4" onSubmit={submit}>
          <div>
            <label
              htmlFor="fork-input"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            ><Message id="core:name_for_your_copy_e68edc1a" /></label>
            <Localized element={<Input
              id="fork-input"
              ref={inputRef}
              type="text"
              required={true}
              minLength={3}
              maxLength={64}
              autoComplete="off"
              box="dialog"
              hint="muted"
              ring="seamless" placeholder={catalogText("core:my_copy_0a0cb172")}
            />} messages={{"placeholder":"core:my_copy_0a0cb172"}} />
          </div>
          <div
            className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 p-3"
          >
            {FORK_INFO_LINES.map((line, index) => (
              <p key={index}>
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
            ><Message id="core:cancel_19766ed6" /></button>
            <Button
              type="submit"
              id="fork-submit"
              layout="flex"
              disabled={busy || quotaBlocksCreation}
              disabledStyle="block"
            >
              <LocalizedValue render={() => (busy ? tr("core:remixing_7fdd65e6") : tr("core:remix_f84ed437"))} />
            </Button>
          </div>
        </form>
          </>
        )}
      </DialogCard>
    </DialogRoot>
  );
}
