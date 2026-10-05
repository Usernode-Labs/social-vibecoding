import { RichMessage } from "../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Send-feedback dialog (#feedback-modal).
 *
 * Extracted verbatim from Shell.tsx by #1078 chunk A. The render output is
 * byte-identical to what the shell shipped before — same ids, same class
 * strings, same `hidden` semantics, same data-* attributes — and
 * tests/baselines/shell-markup.json plus the prerendered public/index.html
 * in this commit are the proof.
 *
 * ── What this island owns, and what it does not ───────────────────────
 *
 * OWNS: the open/close lifecycle. `useDialog` holds the `open` state,
 * `useStaticModal` performs the kit lift that `PlatformUI.adoptStaticModal`
 * used to do from outside React, and Cancel and the backdrop click are
 * rendered handlers rather than listeners `App.bindEvents` attached.
 *
 * DOES NOT OWN: anything inside the card, including the two confirmations
 * (the first-feedback moment and #3186's sent one). The target pills, the
 * title and description fields, the screenshot row, the two opt-in rows and the status
 * line are written by `./feedback-controller` — the retired ~810-line block
 * from `App.bindEvents`, whose header explains why it is still imperative.
 * React renders this tree once and never reconciles inside it, which is what
 * keeps the two owners from colliding.
 *
 * That controller is also why the fields below stay UNCONTROLLED: a rendered
 * `value` would both fight the controller and put a `value` attribute into
 * the prerendered public/index.html that the hand-written shell never had.
 */

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { CameraIcon, PhotoIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { returnKeyHandler } from '../../lib/return-to-next';
import { Feedback, init as initFeedback } from './feedback-controller';
import { useDialog } from './use-dialog';

/** Reserved for callers that still pass `{ fromDev: true }` — see #226/#312. */
interface OpenOptions {
  fromDev?: boolean;
  /**
   * QA 2026-09-24: what the person asked for. The Workshop "+" menu's "File
   * an issue" row passes 'issue'; everything else is feedback.
   */
  intent?: 'issue' | 'feedback';
  /**
   * 'app': open with "This app" chosen, when it can be. For a caller whose
   * own button named the open app (Getting started's Suggest).
   */
  target?: 'app';
  firstFeedback?: { userId: number; appSlug: string | null; issueNumber: number; canFix: boolean };
}

export function FeedbackDialog() {
  const dialog = useDialog<OpenOptions>('feedback', {
    onOpen: (opts) => Feedback._open(opts || {}),
    onClose: () => Feedback._reset(),
  });

  // Was the middle of `App.bindEvents`. Layout effect, so the header's
  // speech-bubble button and the ?shot=feedback deep link are both live
  // before the first paint that could act on them.
  useIsomorphicLayoutEffect(() => {
    initFeedback();
  }, []);

  return (
    <DialogRoot
      id="feedback-modal"
      ref={dialog.rootRef}
      {...dialog.backdropProps}
    >
      <DialogCard size="sm">
        {/* #3907: Return in the title goes on to the description, where it is
            a new line (the iOS keyboard's chevrons are gone). A handler, not
            markup: nothing here is written, so the controller still owns
            every node inside. ⌘/Ctrl+Enter still posts, from the controller. */}
        <div id="feedback-form" onKeyDown={returnKeyHandler()}>
        {/* SUGGEST AN IMPROVEMENT, from every way in. It was "Send
            feedback", then "Ask for a change" (QA 2026-09-24); people read
            feedback as a note to nobody in particular, when what it posts is
            a request the members of the place it goes can see, vote on and
            pick up. The line under the heading says exactly that. "Suggest
            an improvement" since the first-session run-through (5 Oct
            2026), in a newcomer's words. */}
        <h2 className="text-lg font-bold"><Message id="core:suggest_an_improvement" /></h2>
        <p className="mt-0.5 mb-4 text-sm text-zinc-600 dark:text-zinc-400"><Message id="core:members_can_see_it_vote_on_it_and_pick_it_up_4592a6ed" /></p>
        {/*
            Target toggle: file this feedback against the app being viewed
            or against the Homeroom platform. The "This app" button
            is always visible but rendered disabled/grayed-out when no app
            with a repo is open (see ./feedback-controller).

            #2707: BOTH options render `aria-checked="false"`, because when
            both are selectable nothing is selected until the person taps
            one. The old markup pre-checked Platform, and the controller
            then pre-selected "This app" on open wherever it was available —
            so the dialog always arrived with a destination already made up,
            and a report about the app could be filed against the platform
            (or the reverse) by nobody's decision. The controller still
            selects the single available destination when there is only one:
            an extra tap that cannot disambiguate anything is just a tax.
        */}
        {/* WHERE SHOULD THIS GO? (UI overhaul): the question the row asks,
            as its label, where the grey hint under it used to ask it. Each
            option leads with the NAME of the place (the app's, or
            Homeroom), with what it is under it, so the choice is between
            two places a person knows rather than two categories. */}
        <p id="feedback-target-label" className="mb-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100"><Message id="core:where_should_this_go_172707af" /></p>
        <div id="feedback-target" className="flex gap-2 mb-3" role="radiogroup" aria-labelledby="feedback-target-label">
          <div className="flex-1 flex flex-col items-center">
            <button
              type="button"
              role="radio"
              aria-checked="false"
              data-feedback-target="app"
              id="feedback-target-app"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-left transition-colors"
            >
              {/* The controller writes the app's name into the first line,
                  and "No app open" when there is none; the second line says
                  what it is, and goes when the first already says it. */}
              <span id="feedback-target-app-name" className="block truncate text-sm font-semibold"><Message id="core:this_app_0982cb17" /></span>
              <span id="feedback-target-app-sub" className="block truncate text-xs opacity-75"><Message id="core:this_app_0982cb17" /></span>
            </button>
            {/* Caret indicating the selected option; shown/hidden by the controller. */}
            <div
              id="feedback-caret-app"
              className="hidden mt-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-violet-600"
            >
            </div>
          </div>
          <div className="flex-1 flex flex-col items-center">
            <button
              type="button"
              role="radio"
              aria-checked="false"
              data-feedback-target="platform"
              id="feedback-target-platform"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-left transition-colors"
            ><RichMessage id="core:sentence_65c51315a582" components={[<span className="block truncate text-sm font-semibold" />, <span className="block truncate text-xs opacity-75" />]} /></button>
            <div
              id="feedback-caret-platform"
              className="hidden mt-1 w-0 h-0 border-l-4 border-r-4 border-b-4 border-l-transparent border-r-transparent border-b-violet-600"
            >
            </div>
          </div>
        </div>
        {/*
            #2888: the red "Choose where this goes." the controller shows when
            Post request is pressed with no destination (the button stays
            live; it refuses and says why rather than sitting disabled). It
            was also a grey prompt while the choice was open (#2707); the
            label above asks the question now, so the line is only the
            refusal. Renders EMPTY and hidden for the same two reasons
            #feedback-text-error does: the controller owns the text, and a
            line on the initial render would both lie and mismatch on
            hydration. The controller also points the radiogroup's
            `aria-describedby` at it while it is up.

            #1603 is the precedent this follows: a control that refuses and
            says nothing reads as a broken control, so the reason is on
            screen beside the thing to fix.
        */}
        <p id="feedback-target-hint" className="hidden -mt-1 mb-3 text-xs text-zinc-600 dark:text-zinc-400">
        </p>
        {/*
            #556: editable title, auto-filled live from the description
            (the controller debounces POST /api/feedback/title as you type).
            Left blank at submit, the server names the issue as before.
        */}
        <div className="mb-2">
          <Label id="feedback-title-label" htmlFor="feedback-title" className="mb-1"><RichMessage id="core:sentence_26f6ea772843" components={[<span className="font-normal text-zinc-500 dark:text-zinc-500" />]} /></Label>
          <Localized element={<Input
            id="feedback-title"
            type="text"
            maxLength={200}
            enterKeyHint="next" placeholder={catalogText("core:suggested_as_you_type_d3c5cf47")}
          />} messages={{"placeholder":"core:suggested_as_you_type_d3c5cf47"}} />
        </div>
        {/*
            #1603: the description was always mandatory — the controller's
            submit returned early on an empty one and said nothing, so the
            button looked dead. The requirement is on screen now (this label
            and its asterisk) and the refusal is too (#feedback-text-error,
            filled and revealed by ./feedback-controller on an empty submit).

            `aria-required`, not the HTML `required` attribute: these fields
            are not inside a <form>, so `required` buys no native behaviour
            here while switching :invalid on for a field nobody has touched.

            The error node renders EMPTY and hidden, exactly like
            #feedback-status above it — the controller owns its text, and an
            initial render that already carried the message would both lie on
            open and mismatch on hydration.
        */}
        <div>
          {/* "What should change?", which was "Description*" (UI overhaul):
              a question that says what to write, and plainly the one thing
              the request needs, so it carries no asterisk. */}
          <Label id="feedback-text-label" htmlFor="feedback-text" className="mb-1"><Message id="core:what_should_change_e6cbf7fa" /></Label>
          <Localized element={<Textarea
            id="feedback-text"
            rows={4}
            maxLength={2000}
            aria-required="true" placeholder={catalogText("core:describe_the_change_or_the_problem_you_hit_1a8ea3fb")}
            className="resize-none"
          >
          </Textarea>} messages={{"placeholder":"core:describe_the_change_or_the_problem_you_hit_1a8ea3fb"}} />
          <p id="feedback-text-error" role="alert" className="hidden mt-1 text-xs text-red-700 dark:text-red-400">
          </p>
        </div>
        {/*
            #683/#824: desktop drag-to-select, native mobile capture, and a
            Photos fallback all converge on one preview/upload list.

            #3027: up to three images. #feedback-screenshot-preview is the
            thumbnail LIST, rendered empty: the controller appends one item
            per image (preview, status, its own 48px remove button) and takes
            them away again, so it is that module's host like the rest of the
            card. #feedback-screenshot-count says how many fit; it renders
            empty and hidden for the same hydration reason as
            #feedback-status, and the controller fills it on open. The picker
            takes several files at once (`multiple`); the controller keeps
            only as many as there is room for.
        */}
        <div className="mt-2">
          <div className="flex flex-wrap gap-2">
            <button
              id="feedback-screenshot-btn"
              type="button"
              className="hidden inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            >
              <CameraIcon className="w-3.5 h-3.5" />
              <span data-screenshot-label=""><Message id="core:attach_screenshot_97ea8f3f" /></span>
            </button>
            <button
              id="feedback-screenshot-picker-btn"
              type="button"
              className="hidden inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            >
              <PhotoIcon className="w-3.5 h-3.5" /><Message id="core:choose_from_photos_29f14b4f" /></button>
            <input
              id="feedback-screenshot-input"
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
          <p id="feedback-screenshot-count" className="hidden mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          </p>
          <div id="feedback-screenshot-preview" className="hidden mt-2 flex-wrap items-center gap-2">
          </div>
        </div>
        {/*
            #685: opt-in app state snapshot. Hidden unless the open app has
            registered a state provider via usernode.issueState.register()
            AND the feedback target is "This app" (wired in the controller).
        */}
        <div id="feedback-state-row" className="hidden mt-2">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              id="feedback-state-checkbox"
              type="checkbox"
              defaultChecked={true}
              className="accent-violet-500 w-4 h-4 mt-0.5"
            />
            <span className="text-xs text-zinc-600 dark:text-zinc-400"><RichMessage id="core:sentence_6954da0dc50d" components={[<span className="font-medium text-zinc-700 dark:text-zinc-300" />]} /></span>
          </label>
        </div>
        {/*
            #964: opt-in kudos bounty on the issue this dialog is about to
            file. Starts UNCHECKED on every open (the controller's _open) —
            filing feedback must never quietly spend someone's weekly
            allowance. The note under it carries the viewer's live remaining
            figure, and the checkbox is disabled at zero; the server is the
            real gate either way, and a bounty that can't be placed never
            costs the user their filed issue. Same utility classes as
            #feedback-state-row above, so no new Tailwind names appear.

            #1582 shortened this line to what a bounty DOES. What it used to
            also carry — that ticking the box spends 1 of the viewer's weekly
            kudos — moved into the note below rather than going away: this
            control spends a real allowance, so the cost has to stay on
            screen. The note already had the live remaining figure and is the
            right place for it.

            #2586 made that line one sentence about the person it thanks:
            "Put a kudos on this to thank whoever solves it". The emphasised
            run no longer ends in a colon, so the separating space rides
            inside the plain run's string — a bare whitespace expression
            between the two would be two adjacent text children, which
            cannot survive hydration (React #418) and the shell build
            refuses it.
        */}
        <div id="feedback-bounty-row" className="hidden mt-2">
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input id="feedback-bounty-checkbox" type="checkbox" className="accent-violet-500 w-4 h-4 mt-0.5" />
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium text-zinc-700 dark:text-zinc-300"><Message id="core:put_a_kudos_on_this_fc4bcd3c" /></span>
              <Message id="core:to_thank_whoever_solves_it_1b252eed" />
              <br />
              <span id="feedback-bounty-note" className="text-zinc-500 dark:text-zinc-500">
              </span>
            </span>
          </label>
        </div>
        <div id="feedback-status" className="text-sm mt-2 hidden">
        </div>
        <div className="flex gap-3 mt-4">
          {/*
              The controller's success and save-for-later paths still close
              the dialog by clicking this button after their 1500 ms grace
              window (`setTimeout(() => …('feedback-cancel').click(), 1500)`).
              That keeps working through a rendered handler: a programmatic
              click dispatches a real event, and React 19 delegates its
              listeners at document.body.
          */}
          <button
            id="feedback-cancel"
            className="flex-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            onClick={() => dialog.close()}
          ><Message id="core:cancel_19766ed6" /></button>
          <Button id="feedback-submit" layout="flex"><Message id="core:post_request_f070a1ea" /></Button>
        </div>
        </div>
        <section id="feedback-first-success" className="hidden" aria-labelledby="feedback-first-title" tabIndex={-1}>
          <h2 id="feedback-first-title" className="text-xl font-bold mb-3"><Message id="core:congratulations_on_your_first_request_1b7c19bd" /></h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4"><Message id="core:you_ve_helped_make_this_app_better_want_to_take__6b08ca94" /></p>
          <p id="feedback-first-notice" className="text-sm text-emerald-700 dark:text-emerald-400 mb-4" role="status"></p>
          <div className="flex flex-col gap-3">
            <Button id="feedback-first-fix" disabledStyle="block" className="min-h-[44px]"><Message id="core:try_a_fix_yourself_8f4261e4" /></Button>
            <p id="feedback-first-fix-note" className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="core:start_with_a_draft_you_can_edit_before_sending_i_c0b2869c" /></p>
            <Button id="feedback-first-board" variant="neutral" ink="neutral" disabledStyle="block" className="min-h-[44px]"><Message id="core:see_this_app_s_board_22885aca" /></Button>
            {/* #3186: the Me screen's list, where this report now is. */}
            <Button id="feedback-first-mine" variant="neutral" ink="neutral" className="min-h-[44px]"><Message id="core:see_your_requests_893fe5b4" /></Button>
            <Button id="feedback-first-done" variant="unstyled" ink="muted" className="min-h-[44px]"><Message id="core:done_11a6767d" /></Button>
          </div>
        </section>
        {/*
            #3186: every other filed report's confirmation. It was the status
            line, and the dialog closed itself 1.5 s later; now it is this
            section, drawn like the first-feedback moment above, and it stays
            until Done. The controller names where it went in the heading
            ("Posted to Run Club", "Posted to Homeroom") and fills the notice
            with any bounty outcome, so the notice renders empty and hidden
            for the reason #feedback-status does.
        */}
        <section id="feedback-sent" className="hidden" aria-labelledby="feedback-sent-title" tabIndex={-1}>
          <h2 id="feedback-sent-title" className="text-lg font-bold mb-3"><Message id="core:request_posted_fa85958e" /></h2>
          <p id="feedback-sent-notice" className="hidden text-sm text-emerald-700 dark:text-emerald-400 mb-2" role="status"></p>
          {/* B8: where Homeroom bot builds it, this says so ("Homeroom bot is
              on it, usually about 8 minutes."), Open chat leads, and building
              it yourself is the small link at the foot. The controller words
              the line and shows the two. */}
          <p id="feedback-sent-line" className="text-sm text-zinc-600 dark:text-zinc-400 mb-4"><Message id="core:find_it_on_your_profile_under_your_requests_ca1132f3" /></p>
          <div className="flex flex-col gap-3">
            <Button id="feedback-sent-chat" className="hidden min-h-[44px]"><Message id="core:open_chat_0600175a" /></Button>
            <Button id="feedback-sent-mine" variant="neutral" ink="neutral" className="min-h-[44px]"><Message id="core:see_your_requests_893fe5b4" /></Button>
            <Button id="feedback-sent-done" variant="unstyled" ink="muted" className="min-h-[44px]"><Message id="core:done_11a6767d" /></Button>
            <button id="feedback-sent-fix" type="button" className="hidden self-center text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400"><Message id="core:build_it_yourself_with_a_coding_agent_1cf36aa3" /></button>
          </div>
        </section>
      </DialogCard>
    </DialogRoot>
  );
}
