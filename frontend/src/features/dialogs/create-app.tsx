/**
 * Create-app dialog (#create-modal).
 *
 * `data-mode` controls "new" vs "import"; `data-import-state` controls the
 * import sub-states (idle / checking / ok / error). CSS in app.css keys off
 * both attributes to show and hide the URL block, the name field and the
 * submit button, so this component only has to flip attributes — it never
 * juggles per-element classes.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. The INITIAL render is still
 * byte-identical to what the shell shipped — same ids, same class strings,
 * same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html in
 * this commit are the proof.
 *
 * ── The second view, and why it costs the baseline nothing ────────────
 *
 * `POST /api/apps` returns 201 with the row still in `'creating'`; the build
 * runs async server-side. This dialog no longer closes on that 201 — it
 * swaps its card to ./create-progress.tsx and reports the four phases
 * `services/app-creator.js` broadcasts, resolving into live /
 * awaiting-secrets / failed.
 *
 * That second view is gated on `created`, which starts null. The prerender
 * pass has no user to submit the form, so it renders the form and nothing
 * else — the progress subtree contributes no ids to public/index.html and
 * therefore nothing to the shell-markup baseline, the id inventory, or the
 * 338 declared dapp.json selectors. A separate tenth shell dialog would have
 * needed an entry in all three; this needs none, which is the whole reason
 * the progress view lives inside this card rather than beside it.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `App.showCreateModal`, `.hideCreateModal`, `._createVis`,
 * `.setCreateVisibility`, `.setCreateMode`, `._setImportState`,
 * `.handleImportCheck` and `.handleCreateApp` were public/js/app.js:3775-3985;
 * the cancel, backdrop, submit, mode-pill, visibility-pill, Check-button and
 * import-url listeners were its `bindEvents`. Seven functions that read each
 * other's state out of the document are four `useState` calls here.
 *
 * `App.showCreateModal()` survives in app.js as a one-line forward: the home
 * screen's empty-state and "+" buttons (frontend/src/features/home/home.js)
 * and the deep-link handler both call it by name.
 *
 * ── What is applied through refs, and why ─────────────────────────────
 *
 * `bindEvents` used to end with `App.setCreateVisibility('collab', 'public')`,
 * which puts the page in a state the SHELL MARKUP DOES NOT DESCRIBE: `.active`
 * on the two "Everyone" pills, `disabled` on both view pills, and the
 * `hidden` class off #create-vis-hint. Rendering those from the initial
 * component state would diverge from the prerendered document and
 * `console.error` a hydration mismatch — which fails proposal checks. So the
 * defaults render exactly as the shell shipped them and the derived state is
 * written by layout effects, the same arrangement `useHiddenClass` exists for.
 *
 * Both inputs stay UNCONTROLLED (refs, not `value`) for the matching reason:
 * a controlled input renders a `value` attribute in the prerender pass.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
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

type Mode = 'new' | 'import';
type ImportState = 'idle' | 'checking' | 'ok' | 'error';
type Vis = 'public' | 'private';

/** The inline row under the repo URL: spinner, green tick, or red error. */
interface ImportStatus {
  tone: 'none' | 'ok' | 'err';
  text: string;
  spinner?: boolean;
}

const IDLE_STATUS: ImportStatus = { tone: 'none', text: '' };

/**
 * How often the progress view re-asks the server while a creation is
 * still pending. The WS broadcasts do the real work; this only has to be
 * often enough that a dropped socket is noticed, and rare enough that a
 * dialog left open costs the API almost nothing.
 */
const POLL_INTERVAL_MS = 4000;

function statusClass(status: ImportStatus): string {
  if (status.tone === 'ok') return 'text-sm mt-2 import-status--ok';
  if (status.tone === 'err') return 'text-sm mt-2 import-status--err';
  return 'text-sm mt-2';
}

export function CreateAppDialog() {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);
  const collabPublicRef = useRef<HTMLButtonElement>(null);
  const collabPrivateRef = useRef<HTMLButtonElement>(null);
  const viewPublicRef = useRef<HTMLButtonElement>(null);
  const viewPrivateRef = useRef<HTMLButtonElement>(null);

  const [mode, setMode] = useState<Mode>('new');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [status, setStatus] = useState<ImportStatus>(IDLE_STATUS);
  const [collabVis, setCollabVis] = useState<Vis>('public');
  const [viewVis, setViewVis] = useState<Vis>('public');
  const [error, setError] = useState('');
  // The app this dialog is now reporting on. Null until a POST succeeds,
  // which is what keeps the FIRST render byte-identical to the
  // prerendered shell — the progress subtree exists only after a user
  // action, so it never reaches public/index.html.
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);
  const progress = useStoreState(creationProgressStore);

  const dialog = useDialog('create', {
    onOpen: () => {
      applyMode('new');
      setTimeout(() => nameRef.current?.focus(), 0);
    },
    // Verbatim from App.hideCreateModal: reset the form, clear the error, and
    // put mode, import state and visibility back to their defaults so the
    // next open never inherits the last one's half-finished import.
    onClose: () => {
      formRef.current?.reset();
      setError('');
      applyMode('new');
      setCollabVis('public');
      setViewVis('public');
      // Drop the progress view too, so the next open lands on the form.
      // The build carries on server-side either way — closing this is
      // dismissing a report, not cancelling anything.
      setCreated(null);
      stopWatchingCreation();
    },
  });

  useHiddenClass(errorRef, !error);
  // collab=public forces view=public and disables the view pills — the one
  // invalid combination (publicly buildable but privately viewable) can never
  // be selected, and the hint says why.
  const collabPublic = collabVis === 'public';
  useHiddenClass(hintRef, !collabPublic);
  useClassToggle(collabPublicRef, 'active', collabVis === 'public');
  useClassToggle(collabPrivateRef, 'active', collabVis === 'private');
  useClassToggle(viewPublicRef, 'active', viewVis === 'public');
  useClassToggle(viewPrivateRef, 'active', viewVis === 'private');
  useIsomorphicLayoutEffect(() => {
    if (viewPublicRef.current) viewPublicRef.current.disabled = collabPublic;
    if (viewPrivateRef.current) viewPrivateRef.current.disabled = collabPublic;
  }, [collabPublic]);
  // The name field is required only in "new" mode. In "import" the
  // server-side pre-flight gates submission — the field is not even visible
  // until the check passes.
  useIsomorphicLayoutEffect(() => {
    if (nameRef.current) nameRef.current.required = mode === 'new';
  }, [mode]);

  // Progress arrives on the WS `app_status` channel, which public/js/app.js
  // forwards into the store. That is the fast path and it is not the only
  // one it can be: a socket that drops right before the terminal event
  // would leave a step spinning forever. So while the outcome is still
  // pending, also ASK — GET /api/apps/:slug serves the same phase from the
  // server-side store, plus the status, so one poll recovers everything a
  // missed broadcast would have carried.
  const creatingSlug = created && outcomeOf(progress.status) === 'pending' ? created.slug : null;
  useEffect(() => {
    if (!creatingSlug) return undefined;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      void fetchCreationProgress(creatingSlug, (url) => fetch(url));
    };
    // Immediately, not only on the interval: the first phase broadcast
    // may already have been sent before this dialog started listening,
    // and four seconds of four idle steps reads as nothing happening.
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [creatingSlug]);

  /** Verbatim from App.setCreateMode: one entry point keeps every mirror in sync. */
  function applyMode(next: Mode) {
    setMode(next);
    setError('');
    // Switching back to "new" shouldn't leave a stale check banner around;
    // switching into "import" lands on idle either way.
    setImportState('idle');
    setStatus(IDLE_STATUS);
  }

  /** Verbatim from App.setCreateVisibility. */
  function applyVisibility(kind: 'collab' | 'view', value: Vis) {
    if (kind === 'collab') {
      setCollabVis(value);
      if (value === 'public') setViewVis('public');
    } else if (collabVis === 'private') {
      setViewVis(value);
    } else {
      setViewVis('public');
    }
  }

  // Verbatim from App.handleImportCheck.
  //
  //   idle ─┬─ Check click ─→ checking ─┬─ ok    (name field reveals,
  //         │                           │        prefilled, Import enables)
  //         │                           └─ error (inline message, retry)
  //         └─ user edits URL after a successful check → back to idle
  //
  // Why explicit Check and not a debounced auto-check? Two reasons: (1) "I
  // just invited the bot, click here" is a clear action that pairs with the
  // inline error text from the server, vs. a debounced surprise; (2)
  // verifyBotAccess can mutate state by accepting a pending invitation, and we
  // don't want that firing on every keystroke.
  async function check() {
    const url = (urlRef.current?.value || '').trim();
    const fail = (text: string) => {
      setImportState('error');
      setStatus({ tone: 'err', text });
    };
    if (!url) return fail('Paste a GitHub repo URL first.');

    setImportState('checking');
    setStatus({ tone: 'none', text: 'Checking bot access…', spinner: true });

    let res: Response;
    try {
      res = await fetch(`/api/github/verify-access?url=${encodeURIComponent(url)}`);
    } catch {
      return fail('Network error — try again.');
    }

    let data: Record<string, string> = {};
    try {
      data = await res.json();
    } catch {
      /* a non-JSON body is reported through the HTTP status below */
    }
    if (!res.ok) return fail(data.error || `Check failed (HTTP ${res.status}).`);

    setImportState('ok');
    const fullName = data.fullName || `${data.owner}/${data.repo}`;
    setStatus({ tone: 'ok', text: `✓ usernode-bot has Write access to ${fullName}.` });

    // Prefill the name field — repo name + optional description, capped so we
    // don't blow past the input's visible width. Only fill if the user hasn't
    // already typed something, so re-checks don't clobber a manual edit.
    const nameEl = nameRef.current;
    if (nameEl && !nameEl.value.trim() && data.name) {
      nameEl.value = data.description
        ? `${data.name} — ${data.description}`.slice(0, 80)
        : data.name;
    }
    nameEl?.focus();
  }

  // Verbatim from App.handleCreateApp.
  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = (nameRef.current?.value || '').trim();
    const repoUrl = (urlRef.current?.value || '').trim();
    setError('');
    if (!name) return;

    // Guard: in import mode, submit is gated behind a successful check. CSS
    // hides the submit button when the state isn't 'ok', but a determined user
    // could still submit by hitting Enter, so belt-and-braces here. The server
    // runs the pre-flight again on POST anyway.
    if (mode === 'import') {
      if (!repoUrl) return;
      if (importState !== 'ok') return setError('Click "Check" to verify bot access first.');
    }

    const body: Record<string, string> = mode === 'import' ? { name, repoUrl } : { name };
    body.collabVisibility = collabVis;
    body.viewVisibility = viewVis;

    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) return setError(data.error || 'Failed to create app');
      // The POST returns 201 with the row still in 'creating' — the build
      // runs async server-side. #1418 covered that with a one-line toast
      // over a closed dialog, because the tile's small "Spinning up…" was
      // easy to miss; the dialog now STAYS OPEN and reports the phases
      // app-creator broadcasts, so the toast would only say the same
      // thing twice, less well.
      const slug = data.app?.slug;
      if (!slug) {
        // A 201 we cannot follow. Nothing to report progress on, so fall
        // back to exactly the old behaviour rather than opening an empty
        // progress view.
        dialog.close();
        window.PlatformUI?.toast?.(
          mode === 'import'
            ? 'Your app is being imported. It will appear in your list of apps when it’s ready.'
            : 'Your app is being created. It will appear in your list of apps when it’s ready.',
        );
        (window.Home?.load as (() => void) | undefined)?.();
        return;
      }
      watchCreation(slug);
      setCreated({ slug, name: data.app?.name || name });
      // Refresh the grid behind the dialog so the new tile is already
      // there when the user closes it.
      (window.Home?.load as (() => void) | undefined)?.();
    } catch {
      setError('Network error');
    }
  }

  return (
    <DialogRoot
      id="create-modal"
      ref={dialog.rootRef}
      data-mode={mode}
      data-import-state={importState}
      {...dialog.backdropProps}
    >
      {/*
          The mode/import-state attributes are mirrored onto this card
          because the native-kit modal adoption lifts it out of
          #create-modal while presented — CSS keyed off the root would stop
          matching (the bug that left the modal stuck in import mode).
      */}
      <DialogCard
        size="sm"
        id="create-card"
        data-mode={mode}
        data-import-state={importState}
      >
        {created ? (
          <CreateProgress
            appName={created.name}
            mode={mode}
            progress={progress}
            onOpenApp={() => {
              const slug = created.slug;
              dialog.close();
              (window.App?.openAppTab as ((s: string, t: string) => void) | undefined)?.(slug, 'app');
            }}
            onSetSecrets={() => {
              const slug = created.slug;
              dialog.close();
              // Published by features/app-secrets — a bare global read is
              // what broke the last cross-surface jump, so guard it and
              // leave the tile's own "fix secrets" path as the fallback.
              (window.Secrets?.open as ((s: string) => void) | undefined)?.(slug);
            }}
            onRetry={() => {
              const slug = created.slug;
              // Put the view back into its pending state immediately —
              // the retry re-enters createApp server-side and will start
              // broadcasting phases again.
              watchCreation(slug);
              void fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' })
                .then(() => (window.Home?.load as (() => void) | undefined)?.())
                .catch(() => {
                  publishAppStatus({
                    slug,
                    status: 'error',
                    errorReason: 'Couldn’t reach the server to retry. Try again from the app’s tile.',
                  });
                });
            }}
            onClose={() => dialog.close()}
          />
        ) : (
        <>
        <h2 id="create-title" className="text-lg font-bold mb-4">
          {mode === 'import' ? 'Import existing app' : 'Create a new app'}
        </h2>
        <div className="flex p-1 mb-4 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
          <button
            type="button"
            data-mode-pill="new"
            className="create-mode-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
            onClick={() => applyMode('new')}
          >
            Create new
          </button>
          <button
            type="button"
            data-mode-pill="import"
            className="create-mode-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
            onClick={() => applyMode('import')}
          >
            Import existing
          </button>
        </div>
        <form id="create-form" ref={formRef} className="space-y-4" onSubmit={submit}>
          {/*
              Import-only: GitHub repo URL + Check button. The Check
              button runs the bot-access pre-flight; on success the
              #app-name field below appears, prefilled with the repo
              name. CSS hides this whole block in "new" mode.
          */}
          <div id="create-import-block" className="create-import-block">
            <label
              htmlFor="import-url"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              GitHub repo URL
            </label>
            <div className="flex gap-2">
              <Input
                id="import-url"
                ref={urlRef}
                name="repoUrl"
                type="url"
                autoComplete="off"
                spellCheck="false"
                width="flex"
                box="dialog"
                hint="muted"
                ring="seamless"
                className="font-mono text-sm"
                placeholder="https://github.com/owner/repo"
                onInput={() => {
                  // Any edit invalidates the previous check; the user must
                  // click again. Without this they could verify repo A, edit
                  // the URL to point at repo B, then submit — the route's own
                  // pre-flight catches it, but the UI shouldn't claim
                  // "verified" for a URL that hasn't been verified.
                  setImportState('idle');
                  setStatus(IDLE_STATUS);
                }}
              />
              <Button
                type="button"
                id="import-check"
                disabledStyle="block"
                className="whitespace-nowrap"
                disabled={importState === 'checking'}
                onClick={check}
              >
                {importState === 'ok' ? 'Re-check' : 'Check'}
              </Button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Invite
              <code className="font-mono text-xs">
                usernode-bot
              </code>
              as a collaborator with Write access.
            </p>
            {/*
                Inline status row: spinner while checking, green check on
                ok, red error text on failure. Hidden in idle.
            */}
            <div id="import-status" className={statusClass(status)}>
              {status.spinner ? <span className="import-spinner"></span> : null}
              {status.text}
            </div>
          </div>
          {/*
              Name field. Always visible in "new" mode; gated behind a
              successful access check in "import" mode (CSS hides it
              until #create-card[data-import-state="ok"]).
          */}
          <div id="create-name-block">
            <label htmlFor="app-name" className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              App name
            </label>
            <Input
              id="app-name"
              ref={nameRef}
              name="name"
              type="text"
              autoComplete="off"
              box="dialog"
              hint="muted"
              ring="seamless"
              placeholder="my cool app"
            />
          </div>
          {/*
              Visibility: two segmented controls. Collab=Everyone forces
              View=Everyone (a publicly-buildable app can't be privately
              viewed) — applyVisibility enforces it.
          */}
          <div id="create-visibility-block" className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Who can build it
              </label>
              <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                <button
                  type="button"
                  ref={collabPublicRef}
                  data-collab-vis="public"
                  className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  onClick={() => applyVisibility('collab', 'public')}
                >
                  Everyone
                </button>
                <button
                  type="button"
                  ref={collabPrivateRef}
                  data-collab-vis="private"
                  className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  onClick={() => applyVisibility('collab', 'private')}
                >
                  Invite-only
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Who can see &amp; use it
              </label>
              <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                <button
                  type="button"
                  ref={viewPublicRef}
                  data-view-vis="public"
                  className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  onClick={() => applyVisibility('view', 'public')}
                >
                  Everyone
                </button>
                <button
                  type="button"
                  ref={viewPrivateRef}
                  data-view-vis="private"
                  className="create-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  onClick={() => applyVisibility('view', 'private')}
                >
                  Collaborators only
                </button>
              </div>
              <p
                id="create-vis-hint"
                ref={hintRef}
                className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 hidden"
              >
                Apps everyone can build are always public to view.
              </p>
            </div>
          </div>
          <div id="create-error" ref={errorRef} className="text-red-400 text-sm hidden">
            {error}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="create-cancel"
              className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button type="submit" id="create-submit" layout="flex">
              {mode === 'import' ? 'Import' : 'Create'}
            </Button>
          </div>
        </form>
        </>
        )}
      </DialogCard>
    </DialogRoot>
  );
}
