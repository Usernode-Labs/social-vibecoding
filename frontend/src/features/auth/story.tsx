/**
 * The signed-out story: what Homeroom is, for somebody who arrived on their
 * own, in place of the waitlist pitch (./landing.tsx shows it unless the
 * first session's switch is off, `story_landing` in the waitlist options).
 *
 * From the top, under the landing's logo bar: the small caps "Welcome to
 * Homeroom", the picture, one headline, the small caps "For example" over
 * three communities (an emoji, the community's name and what it made; to
 * show, not to press), the "Get started" button and "Already have an
 * account? Sign in" under it. Nothing under the button says what a new
 * account waits for: the waiting screen does (C1-story on the onboarding
 * canvas, the owner's review of 8 October).
 *
 * "Get started" and "Sign in" both open the sign-in sheet over this
 * screen; an account made from it is asked what to make next
 * (../first-session/make.tsx).
 */

/**
 * The three communities the story shows. Its own list, not the make screen's
 * starting points (../first-session/examples.ts): those are being reworked
 * on their own, and what a community made is said here as a noun.
 */
const COMMUNITIES = [
  { key: 'run', emoji: '🏃', name: 'Sunday Run Club', made: 'Weekly miles' },
  { key: 'film', emoji: '🎬', name: 'Friday Film Night', made: 'Movie poll' },
  { key: 'trip', emoji: '🏕️', name: 'Lake Trip Crew', made: 'Trip plan' },
] as const;

const SMALL_CAPS = 'text-[12px] leading-4 font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400';

export function Story({ primaryClass, onStart, onSignIn }: {
  primaryClass: string;
  onStart: () => void;
  onSignIn: () => void;
}) {
  return (
    <div data-landing-story="" className="px-4 flex grow flex-col text-center">
      <div className={`mt-1 ${SMALL_CAPS}`}>Welcome to Homeroom</div>
      <img
        src="/brand/people.png"
        alt=""
        width={816}
        height={612}
        draggable={false}
        className="mx-auto mt-5 block h-auto w-[112px] max-w-full"
      />
      {/* Centred in the room between the picture and the button, with air
          around it and between the headline and the examples. */}
      <div className="my-auto flex flex-col items-center gap-7 py-6">
        <h1 className="text-[28px] leading-[33px] font-extrabold text-balance">
          On Homeroom, communities make apps together.
        </h1>
        <div className="flex w-full max-w-sm md:max-w-md flex-col gap-2 text-left">
          <div className={`px-1 ${SMALL_CAPS}`}>For example</div>
          <ul className="w-full overflow-hidden rounded-[20px] bg-white dark:bg-zinc-900 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]">
            {COMMUNITIES.map((c) => (
              <li key={c.key} className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:shadow-[inset_0_1px_0_var(--app-sheet-line)]">
                <span className="app-icon-tile flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-2xl" aria-hidden="true">{c.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-[650] text-zinc-900 dark:text-zinc-100">{c.name}</span>
                  <span className="block text-[13px] text-zinc-500 dark:text-zinc-400">{c.made}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="w-full max-w-sm md:max-w-md mx-auto flex flex-col gap-3">
        <a href="#signup" data-landing-story-start="" className={primaryClass} onClick={(e) => { e.preventDefault(); onStart(); }}>
          Get started
        </a>
        <p className="mt-1 text-[15px] leading-5 text-zinc-500 dark:text-zinc-400">
          Already have an account?{' '}
          <a href="#login" data-landing-story-signin="" className="font-medium text-violet-700 dark:text-violet-400 hover:underline" onClick={(e) => { e.preventDefault(); onSignIn(); }}>
            Sign in
          </a>
        </p>
      </div>
    </div>
  );
}
