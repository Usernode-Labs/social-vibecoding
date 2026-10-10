/**
 * The signed-out story: what Homeroom is, for somebody who arrived on their
 * own, in place of the waitlist pitch (./landing.tsx shows it unless the
 * first session's switch is off, `story_landing` in the waitlist options).
 *
 * One centred group under the landing's logo bar: the picture, the small
 * caps "Welcome to Homeroom", one headline, the small caps "For example"
 * over the make screen's three examples (to show, not to press). The "Get
 * started" button and "Already have an account? Sign in" stay at the foot,
 * pinned there while the story scrolls under them. Nothing under the button says what a new
 * account waits for: the waiting screen does (C1-story on the onboarding
 * canvas, the owner's review of 8 October).
 *
 * "Get started" and "Sign in" both open the sign-in sheet over this
 * screen; an account made from it is asked what to make next
 * (../first-session/make.tsx).
 */

// The three examples are the make screen's own starting points (Evan, 8 Oct
// 2026, #4354): the same three here and there, the tier list drawn as one.
import { useEffect, useRef, useState } from 'react';

import { Message } from '../../lib/i18n/react';
import { TEMPLATES } from '../first-session/examples';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { TierChart } from '../first-session/tier-chart';

const SMALL_CAPS = 'text-[12px] leading-4 font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

export function Story({ primaryClass, onStart, onSignIn }: {
  primaryClass: string;
  onStart: () => void;
  onSignIn: () => void;
}) {
  const t = useMessages('auth');
  // Is the story passing under the pinned foot? Its ground is drawn only
  // then (`data-landing-story-foot="over"`), so a page that fits, or one
  // scrolled to its end, looks as it did before the foot was pinned. Read in
  // an effect: the first render is the prerender's, with no ground.
  const endRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const end = endRef.current;
    const foot = footRef.current;
    if (!end || !foot || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setOver(!entry.isIntersecting),
      { rootMargin: `0px 0px -${foot.offsetHeight}px 0px` },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, []);
  return (
    <div data-landing-story="" className="px-4 flex grow flex-col text-center">
      {/* One group, centred in the room above the button: the picture, the
          label 16px under it, the headline 8px under that, and the examples
          28px lower. On a short phone the auto margins fall to zero and the
          page scrolls, with the foot pinned over it. */}
      <div className="my-auto flex flex-col items-center py-6">
        <img
          src="/brand/people.png"
          alt=""
          width={816}
          height={612}
          draggable={false}
          className="mx-auto block h-auto w-[200px] max-w-full"
        />
        <div className={`mt-4 ${SMALL_CAPS}`}>{t('auth:story.welcome')}</div>
        <h1 className="mt-2 text-[28px] leading-[33px] font-extrabold text-balance">
          {t('auth:story.headline')}
        </h1>
        <div className="mt-7 flex w-full max-w-sm md:max-w-md flex-col gap-2 text-left">
          <div className={`px-1 ${SMALL_CAPS}`}>{t('auth:story.examples')}</div>
          <ul className="w-full overflow-hidden rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
            {TEMPLATES.map((e) => (
              <li key={e.key} className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:shadow-[inset_0_1px_0_var(--app-sheet-line)]">
                <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{e.chart ? <TierChart /> : e.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-[650] text-zinc-900 dark:text-zinc-100"><Message id={e.title} /></span>
                  <span className="block text-[13px] text-zinc-500 dark:text-zinc-400"><Message id={e.line} /></span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      {/* The foot stays on screen while the story above it scrolls (Evan,
          10 Oct 2026: on iPhone Safari Get started sat under the toolbar,
          below the fold). Sticky to the foot of whatever scrolls the page,
          the landing's scroller or, in a phone browser, the document; its
          ground (css/app.css, [data-landing-story-foot="over"]), drawn only
          while the story's end is below it, keeps the story legible as it
          passes under. */}
      <div ref={endRef} aria-hidden="true" className="h-px" />
      <div ref={footRef} data-landing-story-foot={over ? 'over' : ''} className="sticky bottom-0 z-10 -mx-4 px-4 pt-6 pb-3">
        <div className="w-full max-w-sm md:max-w-md mx-auto flex flex-col gap-3">
          <a href="#signup" data-landing-story-start="" className={primaryClass} onClick={(e) => { e.preventDefault(); onStart(); }}>
            {t('auth:story.start')}
          </a>
          <p className="mt-1 text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
            <RichMessage id="auth:story.haveAccount" components={[
            <a href="#login" data-landing-story-signin="" className="font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={(e) => { e.preventDefault(); onSignIn(); }} />,
            ]} />
          </p>
        </div>
      </div>
    </div>
  );
}
