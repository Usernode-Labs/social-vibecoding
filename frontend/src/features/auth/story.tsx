/**
 * The signed-out story: what Homeroom is, for somebody who arrived on their
 * own, in place of the waitlist pitch (./landing.tsx shows it when the
 * first session's switch is on, `story_landing` in the waitlist options).
 *
 * A small illustration so the brand carries over, one line of what this is
 * and one of the loop, three examples of what groups make (to show, not to
 * press: the make screen offers them as starting points), then one button.
 * "Get started" and "Sign in" both open the sign-in sheet over this screen;
 * an account made from it is asked what to make next
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
      <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
        Welcome to Homeroom
      </p>
      <h1 className="mt-2.5 text-[30px] leading-[34px] md:text-[34px] md:leading-[38px] font-extrabold text-balance">
        On Homeroom, communities make apps together.
      </h1>
      <p className="mt-2.5 text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400 text-pretty">
        Anyone using an app can change it. Your group decides what goes in.
      </p>
      <div className="mt-6 text-left">
        <p className="text-center text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
          What groups make
        </p>
        <ul className="mt-2.5 overflow-hidden rounded-2xl bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
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
      <div className="grow" />
      <div className="mt-6 w-full max-w-sm md:max-w-md mx-auto flex flex-col gap-2.5">
        <a href="#signup" data-landing-story-start="" className={primaryClass} onClick={(e) => { e.preventDefault(); onStart(); }}>
          Get started
        </a>
        <p className="mt-1.5 text-center text-[15px] text-zinc-500 dark:text-zinc-400">
          {'Already have an account? '}
          <a href="#login" data-landing-story-signin="" className="font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={(e) => { e.preventDefault(); onSignIn(); }}>
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
