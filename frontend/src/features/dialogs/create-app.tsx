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
 * moved the behaviour in and made it stateful. #1910 restyled it in the
 * pane language (the recipe is spelled out above the class constants
 * below). The INITIAL render still carries every id, every `hidden` and
 * every data-* attribute the shell shipped — `public/js/**` looks those up
 * and the declared dapp.json checks select on them — and
 * tests/baselines/shell-markup.json is the proof; only the class strings
 * are new.
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
import { ChevronRightIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
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
import { normalizeRepositoryUrl } from './repository-url';
import { useDialog } from './use-dialog';

type Mode = 'new' | 'import';
type ImportState = 'idle' | 'checking' | 'ok' | 'error';
type Vis = 'public' | 'private';
/**
 * #1911: the dialog is three steps that UNFOLD in one card, rather than
 * one page of every choice.
 *
 *   start    how to begin: from scratch, or from a GitHub repo. The two
 *            choices ARE the old mode pills (same `create-mode-pill` class,
 *            same `data-mode-pill`, same #create-card[data-mode] styling),
 *            drawn as two rows. Picking one collapses this step to the
 *            chosen row (with a "Change" affordance) and unfolds the next.
 *   details  the name — and, for an import, the repo URL and its access
 *            check first (the name card reveals on a passed check, as
 *            before). Stays on screen, editable, once the last step opens.
 *   access   who can build it and who can see it, then Create / Import.
 *
 * `step` is the FURTHEST step reached; everything up to it is showing.
 * Every section stays in the document on every step (the declared checks
 * and public/js select on the same ids as before); app.css folds and
 * unfolds them off `#create-card[data-step]`, the same attribute-driven
 * mechanism `data-mode` and `data-import-state` already use.
 */
type Step = 'start' | 'details' | 'access';
const STEPS: readonly Step[] = ['start', 'details', 'access'];

/** The inline row under the repo URL: spinner, green tick, or red error. */
interface ImportStatus {
  tone: 'none' | 'ok' | 'err';
  text: string;
  spinner?: boolean;
}

const IDLE_STATUS: ImportStatus = { tone: 'none', text: '' };

/**
 * `?shot=create-import` lands the dialog on the import view, so a URL can
 * reach that state for the declared check and for screenshots. Same
 * arrangement as app-allowance.tsx's `?shot=create-quota`: display only,
 * read once on open, and never on the prerender pass (no `location`).
 */
function shotMode(): Mode {
  try {
    return new URLSearchParams(location.search).get('shot') === 'create-import' ? 'import' : 'new';
  } catch {
    return 'new';
  }
}

/**
 * #1911: which step a `?shot=` lands on. `create-import` and
 * `create-details` open on the details step (import and new respectively);
 * `create-access` opens on the last step. Everything else, including a
 * real open, starts at the start.
 */
function shotStep(): Step {
  try {
    const shot = new URLSearchParams(location.search).get('shot');
    if (shot === 'create-import' || shot === 'create-details') return 'details';
    if (shot === 'create-access') return 'access';
    return 'start';
  } catch {
    return 'start';
  }
}

/**
 * How often the progress view re-asks the server while a creation is
 * still pending. The WS broadcasts do the real work; this only has to be
 * often enough that a dropped socket is noticed, and rare enough that a
 * dialog left open costs the API almost nothing.
 */
const POLL_INTERVAL_MS = 4000;

function statusClass(status: ImportStatus): string {
  if (status.tone === 'ok') return 'px-1 text-sm mt-2 import-status--ok';
  if (status.tone === 'err') return 'px-1 text-sm mt-2 import-status--err';
  return 'px-1 text-sm mt-2';
}

/*
 * ── The pane recipe (#1910) ───────────────────────────────────────────
 *
 * The dialog is drawn in the widget language the shell's panes wear — the
 * notifications sheet, the Improve rail, the app chip's menu and the auth
 * screens — rather than the bordered-inset look the other dialogs still
 * have. The language separates by FIGURE/GROUND, not by rules: a grey pane
 * ground, white cards floating on it with no border, and one high-contrast
 * state, the solid inversion, for "selected".
 *
 *   PANE     the card's own ground, for the web presentation. Inside the
 *            kit's modal shell the card is neutralised (`.un-modal
 *            .platform-modal-card` in app.css) and the same ground comes
 *            from the shell instead, through the `--un-sheet-bg` override
 *            keyed on `.un-modal:has(> #create-card)`. Tailwind arbitrary
 *            values, so the classes stay complete literals for the
 *            extractor; the token is `--dc-strip`, the dev session's strip
 *            and the ground every `.dc-lift` sheet sits on.
 *   CARD/ROW the auth screens' field card: rounded-2xl, white, hairline
 *            rows. `dark:bg-zinc-800` rather than the language's zinc-900
 *            because the pane ground is darker than the page ground in
 *            dark mode, and zinc-900 on `--dc-strip` (#131316) did not
 *            separate.
 *   FIELD    the borderless 17px input that sits in such a row.
 *   RAIL/SEGMENT  the segmented control: a raised white track (the
 *            language's controls float on the ground; a recessed grey
 *            track vanishes into a grey pane) and full-width segments.
 *            Their colours stay in app.css, keyed off #create-card's
 *            data-mode and the `.active` class, so the mechanism the
 *            legacy controller and the dapp.json checks rely on is
 *            untouched — only the look changed.
 *   PILL_SECONDARY  the white pill the auth screens use for a secondary
 *            action; the primary is <Button variant="pillAccent">.
 */
const PANE = 'bg-[color:var(--dc-strip)] dark:bg-[color:var(--dc-strip)] rounded-3xl';
const CARD = 'rounded-2xl bg-white dark:bg-zinc-800 overflow-hidden';
const ROW = 'px-4 pt-3 pb-2';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const CAPTION = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';
const FIELD = { box: 'card', hint: 'dim', ring: 'bare' } as const;
const RAIL = 'flex items-center gap-0.5 rounded-full bg-white dark:bg-zinc-800 p-0.5 text-sm font-semibold';
const SEGMENT = 'flex-1 min-h-8 rounded-full px-3 py-1 leading-tight transition-colors';
const PILL_SECONDARY = 'flex-1 h-11 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm '
  + 'hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors';
/*
 * #1911: the start step's two choices, one white card each, full width,
 * with a title and a one-line caption and a chevron at the trailing edge.
 * The selection colours (the solid inversion when this is the mode the
 * dialog is in) stay in app.css on `.create-mode-pill`, keyed off
 * #create-card[data-mode] exactly as the old segmented pills were.
 */
const CHOICE = 'create-mode-pill w-full text-left ' + CARD + ' px-4 py-3 flex items-center gap-3 transition-colors';
const CHOICE_TITLE = 'block text-[15px] font-semibold';
const CHOICE_CAPTION = 'create-choice-caption block text-xs mt-0.5';
// Shown in place of the chevron once the step has collapsed to the chosen
// row: pressing the row then reopens the choice.
const CHOICE_CHANGE = 'create-choice-change text-xs font-medium shrink-0';
/* The small numbered heading each unfolded step opens with. */
const STEP_HEADING = 'text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 mb-2';

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
  const accessRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>('new');
  const [step, setStep] = useState<Step>('start');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [status, setStatus] = useState<ImportStatus>(IDLE_STATUS);
  const [collabVis, setCollabVis] = useState<Vis>('public');
  const [viewVis, setViewVis] = useState<Vis>('public');
  const [error, setError] = useState('');
  const { blocked: quotaBlocksCreation } = useAppAllowance();
  // The app this dialog is now reporting on. Null until a POST succeeds,
  // which is what keeps the FIRST render byte-identical to the
  // prerendered shell — the progress subtree exists only after a user
  // action, so it never reaches public/index.html.
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);
  const progress = useStoreState(creationProgressStore);

  const dialog = useDialog('create', {
    onOpen: () => {
      applyMode(shotMode());
      // #1911: a real open starts on the first step; the shot links land
      // on the one they name. Focus follows: nothing on the start step
      // wants the keyboard, the details step's first field does.
      const initial = shotStep();
      setStep(initial);
      void invalidateAppAllowance();
      if (initial === 'details') setTimeout(() => focusDetails(shotMode()), 0);
    },
    // Verbatim from App.hideCreateModal: reset the form, clear the error, and
    // put mode, import state and visibility back to their defaults so the
    // next open never inherits the last one's half-finished import.
    onClose: () => {
      formRef.current?.reset();
      setError('');
      applyMode('new');
      setStep('start');
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

  /** #1911: the field the details step opens on, for the mode it is in. */
  function focusDetails(forMode: Mode) {
    (forMode === 'import' ? urlRef.current : nameRef.current)?.focus();
  }

  /**
   * #1911: the start step's choice — set the mode and unfold the details.
   * Once the step has collapsed to the chosen row, pressing that row folds
   * the later steps back up so the choice can be changed; what was typed
   * below stays in the document for when they unfold again.
   */
  function choose(next: Mode) {
    if (step !== 'start') {
      setError('');
      setStep('start');
      return;
    }
    applyMode(next);
    setStep('details');
    setTimeout(() => focusDetails(next), 0);
  }

  /**
   * Continue with the selected start option, or leave the details step.
   * The same two guards the old single page
   * applied at submit, applied one step earlier so the access step is never
   * reached with nothing to create; the error line names what is missing.
   */
  function next() {
    if (step === 'start') {
      choose(mode);
      return;
    }
    const name = (nameRef.current?.value || '').trim();
    if (mode === 'import') {
      if (!normalizeRepositoryUrlInput()) return setError('Paste a GitHub repo URL first.');
      if (importState !== 'ok') return setError('Click "Check" to verify bot access first.');
    }
    if (!name) {
      setError('Give your app a name.');
      nameRef.current?.focus();
      return;
    }
    setError('');
    setStep('access');
    // The card can be taller than a phone's dialog: bring the step that
    // just unfolded into view, and its footer with it.
    setTimeout(() => accessRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
  }

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
  function normalizeRepositoryUrlInput(): string {
    const input = urlRef.current;
    const normalized = normalizeRepositoryUrl(input?.value || '');
    if (input) input.value = normalized;
    return normalized;
  }

  async function check() {
    const url = normalizeRepositoryUrlInput();
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
      return fail('Network error. Try again.');
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
        ? `${data.name}: ${data.description}`.slice(0, 80)
        : data.name;
    }
    nameEl?.focus();
  }

  // Verbatim from App.handleCreateApp.
  async function submit(event: FormEvent) {
    event.preventDefault();
    // #1911: Enter on the details step advances; only the last step creates.
    if (step !== 'access') {
      if (step === 'details') next();
      return;
    }
    const name = (nameRef.current?.value || '').trim();
    const repoUrl = mode === 'import' ? normalizeRepositoryUrlInput() : '';
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
      void invalidateAppAllowance();
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
      data-step={step}
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
        data-step={step}
        className={PANE}
      >
        {created ? (
          <CreateProgress
            appName={created.name}
            mode={mode}
            surface="pane"
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
        <h2 id="create-title" className="text-[17px] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
          {mode === 'import' && step !== 'start' ? 'Import existing app' : 'Create a new app'}
        </h2>
        {/*
            #1911: how far the flow has unfolded. Text, not dots, because
            the dialog is narrow and three words say it; the index is also
            on the attribute for the declared checks.
        */}
        <p
          id="create-step-indicator"
          data-step-index={String(STEPS.indexOf(step) + 1)}
          className="text-xs text-zinc-500 dark:text-zinc-400 mb-3"
        >
          {`Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`}
        </p>
        <AppAllowance id="create-app-quota" surface="pane" />
        <form id="create-form" ref={formRef} className="space-y-4" onSubmit={submit}>
          {/*
              STEP 1 (#1911): how to begin. The two rows are the old mode
              pills — same class, same data-mode-pill, same
              #create-card[data-mode] selection colours in app.css — so
              coming back to this step shows which way the dialog is set.
              A choice advances; the footer's Next uses the selected choice.
          */}
          <div data-create-step="start" className="space-y-2">
            <p className={STEP_HEADING}>1. How do you want to start?</p>
            <button
              type="button"
              data-mode-pill="new"
              className={CHOICE}
              onClick={() => choose('new')}
            >
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Start from scratch</span>
                <span className={CHOICE_CAPTION}>Name it, then describe what you want and build it with the group.</span>
              </span>
              <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
              <span className={CHOICE_CHANGE}>Change</span>
            </button>
            <button
              type="button"
              data-mode-pill="import"
              className={CHOICE}
              onClick={() => choose('import')}
            >
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Import a GitHub repo</span>
                <span className={CHOICE_CAPTION}>Bring an app that already exists. You will invite the bot to it first.</span>
              </span>
              <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
              <span className={CHOICE_CHANGE}>Change</span>
            </button>
          </div>
          {/*
              STEP 2 (#1911): the details. Import-only: GitHub repo URL +
              Check button. The Check button runs the bot-access pre-flight;
              on success the #app-name field below appears, prefilled with
              the repo name. CSS hides the URL block in "new" mode.
          */}
          <div data-create-step="details" className="space-y-4">
          <p className={STEP_HEADING}>{mode === 'import' ? '2. Which repo, and what to call it' : '2. What to call it'}</p>
          <div id="create-import-block" className="create-import-block">
            <div className={CARD}>
              <div className={ROW}>
                <label htmlFor="import-url" className={LABEL}>
                  GitHub repo URL
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="import-url"
                    ref={urlRef}
                    name="repoUrl"
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck="false"
                    width="flex"
                    {...FIELD}
                    className="font-mono text-[15px]"
                    placeholder="github.com/owner/repo"
                    onBlur={() => {
                      normalizeRepositoryUrlInput();
                    }}
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
                    variant="pillNeutral"
                    size="sm"
                    ink="neutral"
                    layout="shrink"
                    disabledStyle="block"
                    // The pill sits INSIDE a white card, so its neutral fill
                    // has to be one step off the card in both themes: zinc-100
                    // on white, and zinc-700 on the card's zinc-800 (the
                    // variant's zinc-800 vanished into it).
                    className="whitespace-nowrap dark:bg-zinc-700 dark:hover:bg-zinc-600"
                    disabled={importState === 'checking'}
                    onClick={check}
                  >
                    {importState === 'ok' ? 'Re-check' : 'Check'}
                  </Button>
                </div>
              </div>
            </div>
            {/*
                ONE text node on each side of the <code>. `Invite{' '}` is two
                adjacent text children, and renderToStaticMarkup emits no
                separator comment between them, so the browser sees one node
                where hydration expects two and React reports #418 — a
                console error, which fails proposal checks.
            */}
            <p className={CAPTION + ' mt-1.5'}>
              {'Invite '}
              <code className="font-mono text-xs">
                usernode-bot
              </code>
              {' as a collaborator with Write access.'}
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
          <div id="create-name-block" className={CARD}>
            <div className={ROW}>
              <label htmlFor="app-name" className={LABEL}>
                App name
              </label>
              <Input
                id="app-name"
                ref={nameRef}
                name="name"
                type="text"
                autoComplete="off"
                {...FIELD}
                placeholder="my cool app"
              />
            </div>
          </div>
          </div>
          {/*
              STEP 3 (#1911): visibility, two segmented controls.
              Collab=Everyone forces View=Everyone (a publicly-buildable app
              can't be privately viewed) — applyVisibility enforces it.
          */}
          <div data-create-step="access" ref={accessRef}>
          <p className={STEP_HEADING}>3. Who can use it</p>
          <div id="create-visibility-block" className="space-y-3">
            <div>
              <p className={LABEL + ' mb-1.5'}>
                Who can build it
              </p>
              <div className={RAIL}>
                <button
                  type="button"
                  ref={collabPublicRef}
                  data-collab-vis="public"
                  className={'create-vis-pill ' + SEGMENT}
                  onClick={() => applyVisibility('collab', 'public')}
                >
                  Everyone
                </button>
                <button
                  type="button"
                  ref={collabPrivateRef}
                  data-collab-vis="private"
                  className={'create-vis-pill ' + SEGMENT}
                  onClick={() => applyVisibility('collab', 'private')}
                >
                  Invite-only
                </button>
              </div>
            </div>
            <div>
              <p className={LABEL + ' mb-1.5'}>
                Who can see &amp; use it
              </p>
              <div className={RAIL}>
                <button
                  type="button"
                  ref={viewPublicRef}
                  data-view-vis="public"
                  className={'create-vis-pill ' + SEGMENT}
                  onClick={() => applyVisibility('view', 'public')}
                >
                  Everyone
                </button>
                <button
                  type="button"
                  ref={viewPrivateRef}
                  data-view-vis="private"
                  className={'create-vis-pill ' + SEGMENT}
                  onClick={() => applyVisibility('view', 'private')}
                >
                  Collaborators only
                </button>
              </div>
              <p
                id="create-vis-hint"
                ref={hintRef}
                className={CAPTION + ' mt-1.5 hidden'}
              >
                Apps everyone can build are always public to view.
              </p>
            </div>
          </div>
          </div>
          <div id="create-error" ref={errorRef} className="px-1 text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          {/*
              #1911: the footer follows how far the card has unfolded,
              through CSS on #create-card[data-step] rather than by
              mounting and unmounting (every id ships on every step).
              Cancel is always there; Next until the last step has
              unfolded, then Create / Import. No Back: the earlier steps
              are still on screen and editable, and the start row's
              "Change" reopens the first choice.
          */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              id="create-cancel"
              className={PILL_SECONDARY}
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button
              type="button"
              id="create-next"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation}
              onClick={next}
            >
              Next
            </Button>
            <Button
              type="submit"
              id="create-submit"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation}
            >
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
