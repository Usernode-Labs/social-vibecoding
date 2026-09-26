/**
 * Settings → Welcome tour: the way back to the four-step tour that Home's
 * Getting started card offers a new account (../../home/tour, #3240).
 *
 * The tour's own Skip says "You can reopen this from Settings", and the card
 * can be closed for good, so this section is the other half of that sentence
 * rather than a nicety. It is one
 * button: clear this browser's "finished" flag for this account, ask for the
 * tour again, and go to Home, which is where every step points. The request
 * opens the tour whatever the account's own "done" says
 * (../../home/tour/tour-done.ts), and finishing it records "done" on both
 * again.
 *
 * ── Why this pane may hold a handler at all ───────────────────────────
 *
 * ./index.tsx's header explains that the panes are STATIC because settings.js
 * binds every control inside them by id, once, and a React re-render of a
 * pane would silently stop those listeners firing. This one holds no state
 * and therefore never re-renders, and settings.js binds nothing inside it:
 * #settings-tour-replay is React's, the same way ./theme.tsx's segments are.
 */

import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';

import { requestTour } from '../../home/tour/tour-request';
import { clearDone, currentUserId } from '../../home/tour/tour-storage';

function replay(): void {
  clearDone(currentUserId());
  // Ask first, navigate second: the overlay waits for Home to be on screen
  // before it opens, so the order only decides whether it waits at all.
  requestTour();
  (window as unknown as { App?: { navigateHome?: () => void } }).App?.navigateHome?.();
}

export function TourSection() {
  return (
    <div data-settings-section="tour" className="hidden">
      <div id="settings-tour-section">
        <SectionHeading title="Welcome tour">
          A one-minute walk through your apps and the Homeroom menu.
        </SectionHeading>
        <Button
          id="settings-tour-replay"
          type="button"
          layout="shrink"
          size="narrow"
          onClick={replay}
        >
          Replay the tour
        </Button>
        <p id="settings-tour-hint" className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
          It starts again on your home screen.
        </p>
      </div>

      <div id="settings-tour-guide" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <SectionHeading title="Guide to Homeroom">
          The tour shows you where things are. This is what to do once you're there, from your first day to your fiftieth.
        </SectionHeading>

        <div className="space-y-5 text-xs text-zinc-500 dark:text-zinc-500 leading-relaxed">
          <div>
            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Home</h4>
            <p className="mt-1">
              Home is a feed of activity across the projects you belong to: new posts, proposals up for a vote, and changes that just merged. It's the launcher, not a project itself, so the fastest way back to something you're building is to open it from here rather than hunting for it elsewhere.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Creating and finding projects</h4>
            <p className="mt-1">
              Discover lists every public project on Homeroom. Open one to use it, or to see what people are building and proposing there.
            </p>
            <p className="mt-1">
              To start your own, tap the create button and describe what you want. You'll pick who it's for first: Just me (only you can see it), A group (private to people you invite), or A community (anyone can find it, join, and build). Whichever you choose, Homeroom gives it its own app and its own database, and you can open it up or narrow it later from its page.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Group chat and dev sessions</h4>
            <p className="mt-1">
              Every project has a group chat: the place people discuss it, ask questions, and share what they're trying next. Anyone in the project can post there.
            </p>
            <p className="mt-1">
              When you're ready to build, you start a dev session: a private, one-on-one conversation with the Mayor (Homeroom's coding assistant) focused on the exact change you want. You describe the feature or fix in plain language, and the Mayor asks anything it needs before it starts. A dev session keeps its own transcript, its own branch, and its own proposal, so several people can each be building something different on the same project at once without stepping on each other.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">The spec and build flow</h4>
            <p className="mt-1">
              A dev session works in two stages. First comes the spec: a plain-language description of what will be built, which the Mayor writes and you review and adjust until it says what you actually want. Nothing is coded yet at this stage, so it's the cheap place to change your mind.
            </p>
            <p className="mt-1">
              Once you approve the spec, the build turn writes the actual code, opens a preview you can try, and runs Homeroom's automated checks against it. If a check fails, the Mayor fixes it and runs the checks again. When you're happy with the preview, the change is ready to propose.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Proposing changes and voting</h4>
            <p className="mt-1">
              A finished build becomes a proposal: a specific, reviewable change to a project, sitting on Workshop next to a preview of it and its checks. Anyone who belongs to the project can open the proposal, try the preview, and vote for or against it. A proposal whose checks haven't passed can't merge, whatever the vote says.
            </p>
            <p className="mt-1">
              Once enough people vote yes, the change merges and goes live for everyone using the project. Workshop is where you'll find anything waiting on your vote, marked as needing you.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">Settings</h4>
            <p className="mt-1">
              This screen, along with the rest of Settings, is where you manage your account: your profile, notifications, appearance, and the experimental features above. It's also where you can come back to replay this tour any time, using the button above.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
