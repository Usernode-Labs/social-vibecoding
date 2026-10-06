/**
 * The signed-out story: what Homeroom is, for somebody who arrived on their
 * own, in place of the waitlist pitch (./landing.tsx shows it unless the
 * first session's switch is off, `story_landing` in the waitlist options).
 *
 * One headline and three examples of what communities make, each a row
 * with its icon, its name and what it is for (to show, not to press: the
 * make screen offers them as starting points), then one button and what it
 * leads to. A stranger's new account waits for access, so the line under
 * "Make an account" says so before they make one (#4037, decisions A and B
 * on the onboarding canvas). The kicker, the line under the headline and the
 * label over the examples are gone: the headline already says it. The
 * landing's logo bar stays above the story: it is a stranger's first screen.
 *
 * "Make an account" and "Sign in" both open the sign-in sheet over this
 * screen; an account made from it is asked what to make next
 * (../first-session/make.tsx).
 */

import { EXAMPLES } from '../first-session/examples';

export function Story({ primaryClass, onStart, onSignIn }: {
  primaryClass: string;
  onStart: () => void;
  onSignIn: () => void;
}) {
  return (
    <div data-landing-story="" className="px-4 flex grow flex-col text-center">
      <img
        src="/brand/people.png"
        alt=""
        width={816}
        height={612}
        draggable={false}
        className="mx-auto mt-4 block h-auto w-[112px] max-w-full"
      />
      {/* Centred in the room between the picture and the button. */}
      <div className="my-auto flex flex-col items-center gap-6 py-8">
        <h1 className="text-[34px] leading-[38px] font-extrabold text-balance">
          Communities make apps together.
        </h1>
        <ul className="w-full max-w-sm md:max-w-md overflow-hidden rounded-2xl bg-white text-left dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
          {EXAMPLES.map((e) => (
            <li key={e.key} className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:shadow-[inset_0_1px_0_var(--app-sheet-line)]">
              <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{e.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">{e.title}</span>
                <span className="block text-[13px] text-zinc-500 dark:text-zinc-400">{e.line}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="w-full max-w-sm md:max-w-md mx-auto flex flex-col gap-2.5">
        <a href="#signup" data-landing-story-start="" className={primaryClass} onClick={(e) => { e.preventDefault(); onStart(); }}>
          Make an account
        </a>
        <p className="text-[14px] leading-5 text-zinc-500 dark:text-zinc-400">
          You'll get a spot on the waitlist.
        </p>
        <a href="#login" data-landing-story-signin="" className="mx-auto mt-1.5 py-1 text-[15px] font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={(e) => { e.preventDefault(); onSignIn(); }}>
          Sign in
        </a>
      </div>
    </div>
  );
}
