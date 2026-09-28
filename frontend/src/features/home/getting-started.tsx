/**
 * `#home-getting-started` — the Getting started card on top of Home
 * (communities, stage 5).
 *
 * A new account answers "What communities do you want to join?"
 * (../auth/communities-first-run.js) and lands on a Home whose first thing
 * is four steps, the last three in the community it joined first:
 *
 *   1. Take the 1-minute tour         the welcome tour (./tour), finished or
 *                                     skipped on any device (#3240)
 *   2. Say hi in <community>          a message of theirs in its chat
 *   3. Vote on what needs you, or Look around the Workshop when nothing
 *      there is waiting on a vote
 *   4. Open <community> and try it, or for Homeroom (which has no app of its
 *      own to open) Find another community
 *
 * Each ticks off from what the person DID, which the server reads
 * (GET /api/me/getting-started, src/services/onboarding.js); nothing here is
 * a checkbox. The two visits that leave no row of their own (the Workshop,
 * Discover) are recorded when their row is pressed. The close button ends
 * the card for good, on every device.
 *
 * ── The tour is a row, with its own button ─────────────────────────────
 *
 * The tour used to start by itself right after the join screen, which said
 * the same things a moment before (#3240). It is the card's first row now,
 * and the only way a newcomer meets it, so until it is done the row carries
 * a filled Start button rather than the chevron every other row has: the
 * one filled control on Home, because nothing else will offer the tour
 * again. The row itself is not a button (a button cannot hold one). Once
 * the tour is done the row is an ordinary ticked row, and pressing it
 * replays the tour. Either press asks for the tour the way Settings' Replay
 * does (./tour/tour-request.ts), and the tour's own "done" landing on the
 * account (`sv:tour-done`) reloads the card, which ticks the row.
 *
 * ── The island rules ───────────────────────────────────────────────────
 *
 *   * THE FIRST RENDER IS THE PRERENDERED MARKUP: an empty section, hidden.
 *     Whether to show anything is `App.user.showGettingStarted`, a
 *     classic-script global that only exists after the session is read, so
 *     it is read in an effect and the card arrives one fetch later.
 *   * VISIBILITY RIDES A REF (`useHiddenClass`); the section's className is
 *     a constant.
 *   * Nothing in `public/js/**` writes into this subtree, so it may hold
 *     state (AGENTS.md).
 *
 * `?shot=getting-started` draws a fixture card with no fetch, the way
 * ../auth/username-first-run.js's `?shot=choose-username` does, so the
 * declared check can see it; every other `?shot=`, `?demo=` and `?token=`
 * route draws nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { CheckIcon, PlayIcon, XIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { TOUR_DONE_EVENT } from './tour/tour-done';
import { requestTour } from './tour/tour-request';

export interface GettingStartedStep {
  id: 'tour' | 'say-hi' | 'vote' | 'explore';
  title: string;
  detail: string;
  done: boolean;
  /** A hash route to go to, or null when `slug` names an app to open (or it is the tour). */
  href: string | null;
  slug?: string;
}

export interface GettingStartedModel {
  show: boolean;
  steps: GettingStartedStep[];
  done: number;
  total: number;
}

const SHOT = 'getting-started';

export const SHOT_MODEL: GettingStartedModel = {
  show: true,
  done: 1,
  total: 4,
  steps: [
    { id: 'tour', title: 'Take the 1-minute tour', detail: 'See how Homeroom works.', done: false, href: null },
    { id: 'say-hi', title: 'Say hi in City garden', detail: 'Post in its chat.', done: true, href: '#messages' },
    { id: 'vote', title: 'Vote on what needs you', detail: '2 waiting in City garden', done: false, href: '#workshop' },
    { id: 'explore', title: 'Open City garden and try it', detail: 'Changes voted in ship here.', done: false, href: null, slug: 'city-garden' },
  ],
};

/** Which visit a step's press records, for the two that leave no row. */
export function seenKeyFor(step: GettingStartedStep): 'workshop' | 'discover' | null {
  if (step.href === '#workshop') return 'workshop';
  if (step.href === '#apps') return 'discover';
  return null;
}

/** "1 of 3", or "All done" once every step is. */
export function counterText(model: Pick<GettingStartedModel, 'done' | 'total'>): string {
  return model.done >= model.total ? 'All done' : `${model.done} of ${model.total}`;
}

function shot(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('shot') === SHOT) return SHOT;
    if (params.get('shot') || params.get('demo') || params.get('token')) return 'skip';
  } catch { /* ignore */ }
  return null;
}

function viewerWantsCard(): boolean {
  const app = (window as unknown as { App?: { user?: { showGettingStarted?: boolean } | null } }).App;
  return app?.user?.showGettingStarted === true;
}

async function post(path: string, body?: unknown): Promise<void> {
  try {
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    console.warn('[getting-started] post failed', err);
  }
}

function Tick({ done }: { done: boolean }) {
  return done ? (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white" aria-hidden="true">
      <CheckIcon className="h-4 w-4" />
    </span>
  ) : (
    <span className="h-7 w-7 shrink-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600" aria-hidden="true" />
  );
}

export function GettingStarted() {
  const rootRef = useRef<HTMLElement | null>(null);
  const [model, setModel] = useState<GettingStartedModel | null>(null);
  const homeVisible = useVisibility('home-screen', true);

  const load = useCallback(async () => {
    const mode = shot();
    if (mode === SHOT) { setModel(SHOT_MODEL); return; }
    if (mode === 'skip' || !viewerWantsCard()) { setModel(null); return; }
    try {
      const res = await fetch('/api/me/getting-started', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = (await res.json()) as GettingStartedModel;
      setModel(body && body.show ? body : null);
    } catch (err) {
      console.warn('[getting-started] load skipped', err);
    }
  }, []);

  // After the session is read, after the join screen is answered, and each
  // time Home comes back on screen: a person who went to say hi comes back to
  // a card with that step ticked.
  useEffect(() => {
    void load();
    const onChange = () => { void load(); };
    document.addEventListener('sv:authed', onChange);
    // A boot from the session snapshot confirms the session later
    // (app.js _reconcileSession), with the server's showGettingStarted.
    document.addEventListener('sv:session', onChange);
    document.addEventListener('sv:communities-joined', onChange);
    // The tour's "done" has reached the account: its row ticks.
    document.addEventListener(TOUR_DONE_EVENT, onChange);
    return () => {
      document.removeEventListener('sv:authed', onChange);
      document.removeEventListener('sv:session', onChange);
      document.removeEventListener('sv:communities-joined', onChange);
      document.removeEventListener(TOUR_DONE_EVENT, onChange);
    };
  }, [load]);
  const wasVisible = useRef(homeVisible);
  useEffect(() => {
    if (homeVisible && !wasVisible.current) void load();
    wasVisible.current = homeVisible;
  }, [homeVisible, load]);

  useHiddenClass(rootRef, !model);

  const close = () => {
    setModel(null);
    const app = (window as unknown as { App?: { user?: { showGettingStarted?: boolean } | null } }).App;
    if (app?.user) app.user.showGettingStarted = false;
    if (shot() !== SHOT) void post('/api/me/getting-started/close');
  };

  const open = (step: GettingStartedStep) => {
    if (step.id === 'tour') {
      requestTour();
      return;
    }
    const seen = seenKeyFor(step);
    if (seen && !step.done && shot() !== SHOT) void post('/api/me/getting-started/seen', { step: seen });
    const App = (window as unknown as { App?: { navigateToApp?: (slug: string) => void } }).App;
    if (step.slug) App?.navigateToApp?.(step.slug);
    else if (step.href) location.hash = step.href;
  };

  const pct = model && model.total ? Math.round((100 * model.done) / model.total) : 0;

  return (
    <section ref={rootRef} id="home-getting-started" className="hidden px-3 pb-2 pt-3" aria-label="Getting started">
      {model ? (
        <GroupedList tone="plane" className="mx-0" data-getting-started={`${model.done}/${model.total}`}>
          <div className="flex items-start gap-3 px-4 pb-3 pt-4">
            <div className="min-w-0 flex-1">
              <div className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">Getting started</div>
              <div className="mt-0.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-getting-started-count="">
                {counterText(model)}
              </div>
            </div>
            <button
              type="button"
              className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-500/10 dark:text-zinc-400"
              aria-label="Close Getting started"
              title="Close"
              data-getting-started-close=""
              onClick={close}
            >
              <XIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mx-4 mb-1 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
            <div className="h-full rounded-full bg-violet-600" style={{ width: `${pct}%` }} />
          </div>
          {model.steps.map((step) => (step.id === 'tour' && !step.done ? (
            <ListRow
              key={step.id}
              inset="none"
              leading={<Tick done={false} />}
              title={step.title}
              subtitle={step.detail}
              chevron={false}
              trailing={(
                <Button
                  type="button"
                  variant="pillAccent"
                  size="sm"
                  layout="iconRow"
                  className="shrink-0"
                  aria-label="Start the tour"
                  data-getting-started-tour-start=""
                  onClick={() => open(step)}
                >
                  <PlayIcon className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                  Start
                </Button>
              )}
              data-getting-started-step={step.id}
              data-done="false"
            />
          ) : (
            <ListRow
              key={step.id}
              as="button"
              inset="none"
              leading={<Tick done={step.done} />}
              title={step.title}
              subtitle={step.detail}
              titleClassName={step.done ? 'text-zinc-500 line-through decoration-zinc-400 dark:text-zinc-400' : undefined}
              data-getting-started-step={step.id}
              data-done={String(step.done)}
              onClick={() => open(step)}
            />
          )))}
        </GroupedList>
      ) : null}
    </section>
  );
}
