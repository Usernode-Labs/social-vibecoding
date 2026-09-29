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
        <div id="settings-tour-guide" className="mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800">
          <SectionHeading title="A guide to Homeroom">
            What each part of the platform is for, beyond the one-minute tour.
          </SectionHeading>
          <SectionHeading title="Home">
            Your apps are shortcuts to the projects you use. A small mark shows where each one
            lives: people for a private community, a lock for one that is just yours. The last
            tile starts a new project, and the Getting started card keeps your first steps handy.
          </SectionHeading>
          <SectionHeading title="Communities" className="mt-4">
            This tab lists every project you belong to. A project opens on its hub, with the
            workshop beside it where changes happen. Needs you is one list of decisions waiting
            on you across all your projects.
          </SectionHeading>
          <SectionHeading title="Messages" className="mt-4">
            Conversations with people and agents. A project's channel lives on its project page,
            not here.
          </SectionHeading>
          <SectionHeading title="Discover" className="mt-4">
            Find public projects to join, or start a new project of your own.
          </SectionHeading>
          <SectionHeading title="Feedback and votes" className="mt-4">
            Inside any app, Give feedback sends the community a note about what should change.
            New change starts one yourself: describe it, try the preview, then put it to a vote.
          </SectionHeading>
          <SectionHeading title="Me" className="mt-4">
            Your profile, and Settings, where account, appearance and connection options live.
            You can replay the welcome tour from Settings any time.
          </SectionHeading>
        </div>
      </div>
    </div>
  );
}
