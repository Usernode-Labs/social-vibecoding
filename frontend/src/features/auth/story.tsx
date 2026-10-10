/**
 * The signed-out story: what Homeroom is, for somebody who arrived on their
 * own, in place of the waitlist pitch (./landing.tsx shows it unless the
 * first session's switch is off, `story_landing` in the waitlist options).
 *
 * One centred group under the landing's logo bar: the picture, the small
 * caps "Welcome to Homeroom", one headline, the small caps "For example"
 * over the make screen's three examples (to show, not to press). The "Get
 * started" button and "Already have an account? Sign in" stay at the foot.
 * The whole story fits its screen: on a short one it shrinks, a step at a
 * time, until the foot is on screen (`fitStyle`, below). Nothing under the
 * button says what a new account waits for: the waiting screen does
 * (C1-story on the onboarding canvas, the owner's review of 8 October).
 *
 * "Get started" and "Sign in" both open the sign-in sheet over this
 * screen; an account made from it is asked what to make next
 * (../first-session/make.tsx).
 */

// The three examples are the make screen's own starting points (Evan, 8 Oct
// 2026, #4354): the same three here and there, the tier list drawn as one.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Message } from '../../lib/i18n/react';
import { TEMPLATES } from '../first-session/examples';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { TierChart } from '../first-session/tier-chart';

const SMALL_CAPS = 'text-[12px] leading-4 font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

// THE STORY SHRINKS TO FIT ITS SCREEN (Evan, 10 Oct 2026, iPhone Safari): on
// a phone shorter than the story, Get started fell below the fold, under
// Safari's toolbar, and a foot pinned over the examples looked wrong. So the
// story takes these steps, in the owner's order and each on top of the last,
// only as far as its screen needs: 1 the picture, 2 the spacing, 3 the
// headline, 4 two examples instead of three. A screen it already fits (a
// large phone, a desktop) sees step 0, the story as it was.
export const FIT_STEPS = 4;

export function fitStyle(fit: number) {
  return {
    picture: fit >= 1 ? 'w-[136px]' : 'w-[200px]',
    group: fit >= 2 ? 'py-2' : 'py-6',
    label: fit >= 2 ? 'mt-3' : 'mt-4',
    examples: fit >= 2 ? 'mt-[18px]' : 'mt-7',
    row: fit >= 2 ? 'py-2' : 'py-2.5',
    foot: fit >= 2 ? 'pt-4' : 'pt-6',
    headline: fit >= 3 ? 'text-[23px] leading-[28px]' : 'text-[28px] leading-[33px]',
    count: fit >= 4 ? 2 : TEMPLATES.length,
  };
}

// Safari's toolbar comes and goes as a page scrolls (about 98px). A screen
// that changes height by less than this keeps its step; anything more, or a
// new width, starts again.
const TOOLBAR_SLACK = 120;

// The space under the foot is the story's to use, all but this much. Under
// "Sign in" the page keeps its own bottom air and, in iPhone Safari, room
// for the toolbar (the story's padding, css/app.css). Counting all of it as
// out of bounds dropped the third example on an iPhone 13 mini with about
// 100px left empty above the toolbar (Evan, 10 Oct 2026). So the story may
// run into that space, scrolling a little if it must, as long as "Sign in"
// keeps its own 12px and this much more above the bottom of the screen.
const FOOT_AIR = 18;

// The step a fit settles on, once step `fit` is the first that fits with
// `room` to spare above and below its group: the earliest step whose story
// (`heights`, one per step taken) is no taller than that room plus the space
// under the foot it may use (`under`, less FOOT_AIR).
export function settledStep(heights: number[], fit: number, room: number, under: number) {
  const tallest = heights[fit] + 2 * room + Math.max(0, under - FOOT_AIR);
  const best = heights.findIndex((h) => h <= tallest);
  return best >= 0 && best < fit ? best : fit;
}

export function Story({ primaryClass, onStart, onSignIn }: {
  primaryClass: string;
  onStart: () => void;
  onSignIn: () => void;
}) {
  const t = useMessages('auth');
  const storyRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  // One fit: the screen it was made for, the story's height at each step
  // taken so far, and whether it has settled.
  const fitting = useRef<{ width: number; height: number; heights: number[]; settled: boolean } | null>(null);
  const [fit, setFit] = useState(0);
  const [measure, setMeasure] = useState(0);
  // Measured before the browser paints, so the steps are never seen. The
  // group is centred by auto margins in the room the story fills; while the
  // story is taller than that room the margins are zero, and that is the cue
  // for the next step. At the first step that fits, `settledStep` may go
  // back to one it passed on the way, using the space under the foot. The
  // first render (the prerender's) is step 0.
  useLayoutEffect(() => {
    const story = storyRef.current;
    const group = groupRef.current;
    const foot = footRef.current;
    if (!story || !group || !foot || !story.offsetHeight) return;
    if (!fitting.current) fitting.current = { width: window.innerWidth, height: window.innerHeight, heights: [], settled: false };
    const f = fitting.current;
    if (f.settled) return;
    f.heights[fit] = group.offsetHeight + foot.offsetHeight;
    const room = group.getBoundingClientRect().top - story.getBoundingClientRect().top;
    if (room < 1) {
      if (fit < FIT_STEPS) setFit(fit + 1);
      else f.settled = true;
      return;
    }
    const under = parseFloat(getComputedStyle(story).paddingBottom)
      + (story.parentElement ? parseFloat(getComputedStyle(story.parentElement).paddingBottom) : 0);
    f.settled = true;
    const best = settledStep(f.heights, fit, room, under);
    if (best !== fit) setFit(best);
  }, [fit, measure]);
  // A new screen (a turned phone, a resized window) starts again from full
  // size. A story first laid out while its screen was hidden is measured
  // once it shows.
  useEffect(() => {
    const story = storyRef.current;
    if (!story) return undefined;
    const onResize = () => {
      const f = fitting.current;
      if (!f) return;
      if (window.innerWidth === f.width && Math.abs(window.innerHeight - f.height) < TOOLBAR_SLACK) return;
      fitting.current = null;
      setFit(0);
      setMeasure((n) => n + 1);
    };
    window.addEventListener('resize', onResize);
    const shown = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { if (!fitting.current && story.offsetHeight) setMeasure((n) => n + 1); })
      : null;
    shown?.observe(story);
    return () => {
      window.removeEventListener('resize', onResize);
      shown?.disconnect();
    };
  }, []);
  const s = fitStyle(fit);
  return (
    <div ref={storyRef} data-landing-story="" className="px-4 flex grow flex-col text-center">
      {/* One group, centred in the room above the button: the picture, the
          label 16px under it, the headline 8px under that, and the examples
          28px lower (closer from step 2). Where even step 4 does not fit,
          the auto margins fall to zero and the page scrolls. */}
      <div ref={groupRef} className={`my-auto flex flex-col items-center ${s.group}`}>
        <img
          src="/brand/people.png"
          alt=""
          width={816}
          height={612}
          draggable={false}
          className={`mx-auto block h-auto ${s.picture} max-w-full`}
        />
        <div className={`${s.label} ${SMALL_CAPS}`}>{t('auth:story.welcome')}</div>
        <h1 className={`mt-2 ${s.headline} font-extrabold text-balance`}>
          {t('auth:story.headline')}
        </h1>
        <div className={`${s.examples} flex w-full max-w-sm md:max-w-md flex-col gap-2 text-left`}>
          <div className={`px-1 ${SMALL_CAPS}`}>{t('auth:story.examples')}</div>
          <ul className="w-full overflow-hidden rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
            {TEMPLATES.slice(0, s.count).map((e) => (
              <li key={e.key} className={`flex items-center gap-3 px-3.5 ${s.row} [&+&]:shadow-[inset_0_1px_0_var(--app-sheet-line)]`}>
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
      <div ref={footRef} className={`w-full max-w-sm md:max-w-md mx-auto flex flex-col gap-3 ${s.foot} pb-3`}>
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
  );
}
