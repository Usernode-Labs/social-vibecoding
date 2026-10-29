/**
 * A GUEST DISCOVER CARD OPENS INTO ITS PROJECT'S PAGE (#landing cards).
 *
 * The picture a visitor taps grows into the colour band at the top of the
 * project's page (./guest-project.tsx), and the page's back button shrinks
 * the band into its card again, so the page plainly came from the card. It
 * is a same-document view transition: one element named `guest-hero` in the
 * old view, the matching one in the new, and the browser morphs between them
 * (app.css, "The guest card opens into its page").
 *
 * The page changes through the address (`location.hash`), which the landing
 * reads in a hashchange listener, so the new view is not there when the
 * transition's update callback returns. The callback waits for it, polling
 * with timers: while the callback runs the browser holds rendering, and
 * animation frames do not fire then.
 *
 * Skipped, and the page simply swaps, where there is no view-transition
 * support, where the device asks for reduced motion, and when there is no
 * card to grow from. A target that comes to rest off screen (Discover opens
 * at its top) is left unnamed, so the band fades out instead of flying away.
 */

export const HERO_NAME = 'guest-hero';

/** How long the update callback waits for the new view before giving up on the morph. */
export const WAIT_MS = 600;

type Transition = { ready: Promise<void>; finished: Promise<void> };
type TransitionDoc = Document & { startViewTransition?: (update: () => Promise<void>) => Transition };

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

function waitFor(find: () => HTMLElement | null, ms: number): Promise<HTMLElement | null> {
  const until = Date.now() + ms;
  return new Promise((resolve) => {
    const look = () => {
      const el = find();
      if (el || Date.now() > until) resolve(el);
      else setTimeout(look, 16);
    };
    look();
  });
}

/**
 * Run `navigate`, morphing `from` into whatever `findTarget` finds once the
 * new view is drawn. Every promise the transition hands back is caught: a
 * transition another one interrupts rejects `ready`, and an unhandled
 * rejection is a console error.
 */
export function morph(from: HTMLElement | null, navigate: () => void, findTarget: () => HTMLElement | null): void {
  const doc = document as TransitionDoc;
  if (!from || typeof doc.startViewTransition !== 'function' || reducedMotion()) {
    navigate();
    return;
  }
  let target: HTMLElement | null = null;
  from.style.viewTransitionName = HERO_NAME;
  let t: Transition;
  try {
    t = doc.startViewTransition(async () => {
      from.style.viewTransitionName = '';
      navigate();
      const found = await waitFor(findTarget, WAIT_MS);
      if (found && onScreen(found)) {
        target = found;
        found.style.viewTransitionName = HERO_NAME;
      }
    });
  } catch {
    from.style.viewTransitionName = '';
    navigate();
    return;
  }
  t.ready.catch(() => {});
  t.finished.catch(() => {}).finally(() => {
    if (target) target.style.viewTransitionName = '';
  });
}

const escape = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'));

/** A card's picture on Discover (featured or not). */
export function cardCover(slug: string): HTMLElement | null {
  const s = escape(slug);
  return document.querySelector<HTMLElement>(`[data-guest-featured="${s}"] [data-guest-card-cover], [data-guest-card="${s}"] [data-guest-card-cover]`);
}

/** The project page's picture in its band, else the band itself. */
export function projectHero(slug: string): HTMLElement | null {
  const page = document.querySelector<HTMLElement>(`[data-guest-project="${escape(slug)}"]`);
  return page?.querySelector<HTMLElement>('[data-guest-hero]') || page?.querySelector<HTMLElement>('[data-guest-project-band]') || null;
}
