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

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { CameraIcon, ChatIcon, DescriptionIcon, PaperclipIcon, PhotoIcon, VideoCameraIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

import { HostDropOverlay } from '../attachments/file-drag';
import { FEEDBACK_DESCRIPTION_MAX } from '../../lib/issue-body-limit';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useKeyboardSurface } from '../../lib/keyboard-surface';
import { returnKeyHandler } from '../../lib/return-to-next';
import { formOffersComment, openCommentMode } from '../improve/suggest-shortcut';
import { ControllerText } from './controller-text';
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
   * own button named the open app.
   */
  target?: 'app' | 'platform';
  /**
   * The experimental C comment handing itself over (features/comment-pin/):
   * its words, added after anything already typed, and its screenshot,
   * attached as Photos would. 'platform' above comes only from it: the
   * person chose that destination on the comment.
   */
  description?: string;
  screenshotBlob?: Blob;
  /**
   * Comment mode handing a box over (features/comment-pin/post.ts
   * `handOverOptions`): its pictures, the pages' with their pins beside them as
   * data (#4482), the title the box showed, and its Kudos.
   */
  screenshots?: Array<{ blob: Blob; pins?: Array<{ x: number; y: number; n?: number | null; note: string }> }>;
  title?: string;
  bounty?: boolean;
  /** 'form': this form, even where "Suggest an improvement" would open comment mode. */
  mode?: 'form';
  firstFeedback?: { userId: number; appSlug: string | null; issueNumber: number; canFix: boolean };
}

/** The form the drop zone listens on; the controller's node, found by id. */
function feedbackForm(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.getElementById('feedback-form') : null;
}

/** The controller locks the description while a post or an upload runs. */
function feedbackLocked(): boolean {
  const text = typeof document !== 'undefined' ? document.getElementById('feedback-text') as HTMLTextAreaElement | null : null;
  return !!text?.readOnly;
}

export function FeedbackDialog() {
  // Text only React writes follows the language here. A node the controller
  // writes too starts from <ControllerText>, which React never updates.
  const t = useMessages('dialogs');
  // Experimental (#4289): the form's switch to comment mode, offered where
  // the device's switch is on (not in the side panel). Read on every open,
  // since the setting lives on the device and can change between opens.
  const [offersComment, setOffersComment] = useState(false);
  // The card, as a bottom sheet on a phone (#4554): `useKeyboardSurface`
  // rides the keyboard with it the way the sign-in sheet's does, and the
  // sheet's slide-up is `useStaticModal`'s `phoneSheet` presentation.
  const cardRef = useRef<HTMLDivElement>(null);
  const dialog = useDialog<OpenOptions>('feedback', {
    phoneSheet: true,
    onOpen: (opts) => {
      setOffersComment(formOffersComment());
      Feedback._open(opts || {});
    },
    onClose: () => Feedback._reset(),
  });
  useKeyboardSurface(cardRef, { ride: true });
  // Comment mode instead, taking the form's draft: the words wait for the
  // first click on the page, and the pictures, title, Kudos and destination
  // go into that comment's box.
  const toComment = () => {
    const carry = Feedback._takeDraft();
    dialog.close();
    const any = carry.text.trim() || carry.title || carry.images.length || carry.bounty;
    openCommentMode({ via: 'switch', carry: any ? carry : null });
  };

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
      <DialogCard size="sm" ref={cardRef}>
        {/* The sheet's handle (#4554), shown only in the phone sheet's
            presentation (app.css's `[data-dialog-sheet]` rules). No id: the
            prerendered shell gains nothing it has to name. */}
        <div aria-hidden="true" className="feedback-sheet-grabber" />
        {/* #3907: Return in the title goes on to the description, where it is
            a new line (the iOS keyboard's chevrons are gone). A handler, not
            markup: nothing here is written, so the controller still owns
            every node inside. ⌘/Ctrl+Enter still posts, from the controller. */}
        <div id="feedback-form" onKeyDown={returnKeyHandler()}>
        {/* #4065: the drop zone while a file is held over the form. The
            controller's own `drop` listener attaches the files (images to the
            screenshot row, a clip to the video slot); this draws the outline
            only, and nothing in the controller writes this node. Off while
            the form is locked for a submit or an upload, as its drop is. */}
        <HostDropOverlay host={feedbackForm} label={t('dialogs:feedback.dropLabel')} isDisabled={feedbackLocked} />
        {/* SUGGEST AN IMPROVEMENT, from every way in. It was "Send
            feedback", then "Ask for a change" from the hub's ⋯ (QA
            2026-09-24) and from every way in (UI overhaul); people read
            feedback as a note to nobody in particular, when what it posts is
            a request the members of the place it goes can see, vote on and
            pick up. The line under the heading says exactly that. "Suggest
            an improvement" since the first-session run-through (5 Oct
            2026), in a newcomer's words. */}
        <h2 className="text-lg font-bold">
          {t('dialogs:feedback.heading')}
        </h2>
        <p className="mt-0.5 mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          {t('dialogs:feedback.intro')}
        </p>
        {/* #4680: the way to see what is already asked for, before writing a
            new one. The confirmation's small-link look (#feedback-sent-fix)
            without its hidden/self-center: it shows with the form. Bound to
            openMine by the controller, the same split as #feedback-sent-mine
            — React owns the words, the listener is the controller's. Closing
            keeps the draft (#2796), so half a thought survives the look. */}
        <button id="feedback-form-mine" type="button" className="-mt-3 mb-4 block text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400">
          {t('dialogs:feedback.form.mine')}
        </button>
        {/* Experimental (#4289): this form, or comment mode, where a click on
            the page is the comment. With the switch on, "Suggest an
            improvement" opens comment mode, and this form is reached from its
            Form switch; this is the way back. React's own node, which the
            controller never writes; hidden in the prerendered shell (the
            class, as the rest of this card is), since the switch is off until
            a person turns it on. */}
        <div className={offersComment ? '-mt-1 mb-4 flex items-center gap-2' : 'hidden'}>
          <span className="inline-flex gap-0.5 rounded-full bg-zinc-100 p-[3px] dark:bg-zinc-800" role="radiogroup" aria-label={t('dialogs:feedback.mode.label')}>
            <button
              type="button"
              role="radio"
              aria-checked="true"
              title={t('dialogs:feedback.mode.formTitle')}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-white pl-2 pr-2.5 text-[13px] font-semibold text-zinc-900 shadow-sm ring-1 ring-black/5 dark:bg-zinc-700 dark:text-white"
            >
              <DescriptionIcon className="h-4 w-4" />
              {t('dialogs:feedback.mode.form')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked="false"
              title={t('dialogs:feedback.mode.commentTitle')}
              onClick={toComment}
              className="inline-flex h-7 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[13px] font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
            >
              <ChatIcon className="h-4 w-4" />
              {t('dialogs:feedback.mode.comment')}
            </button>
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('dialogs:feedback.mode.hint')}</span>
        </div>
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
        <p id="feedback-target-label" className="mb-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {t('dialogs:feedback.target.label')}
        </p>
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
              <span id="feedback-target-app-name" className="block truncate text-sm font-semibold"><ControllerText id="dialogs:feedback.target.thisApp" /></span>
              <span id="feedback-target-app-sub" className="block truncate text-xs opacity-75">{t('dialogs:feedback.target.appSub')}</span>
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
            >
              <span className="block truncate text-sm font-semibold">Homeroom</span>
              <span className="block truncate text-xs opacity-75">{t('dialogs:feedback.target.platformSub')}</span>
            </button>
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
          <Label id="feedback-title-label" htmlFor="feedback-title" className="mb-1">
            <RichMessage
              id="dialogs:feedback.title.label"
              components={[<span className="font-normal text-zinc-500 dark:text-zinc-500" />]}
            />
          </Label>
          <Input
            id="feedback-title"
            type="text"
            maxLength={200}
            enterKeyHint="next"
            placeholder={t('dialogs:feedback.title.placeholder')}
          />
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
          <Label id="feedback-text-label" htmlFor="feedback-text" className="mb-1">
            {t('dialogs:feedback.description.label')}
          </Label>
          <Textarea
            id="feedback-text"
            rows={4}
            maxLength={FEEDBACK_DESCRIPTION_MAX}
            aria-required="true"
            placeholder={t('dialogs:feedback.description.placeholder')}
            className="resize-none"
          >
          </Textarea>
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
        {/*
            #4127: one line again. "Choose from Photos" and "Add video" were
            two more buttons beside the capture one, and the row wrapped onto
            a second line. They are now the two rows of a small popover under
            one paperclip button (#feedback-attach-btn), drawn in the vote
            popover's frame. The rows keep their ids, so the controller's
            handlers, limits and disabled states are what they were; it also
            opens and closes the popover (outside click, Escape, a choice).
            Popover, rows and paperclip all render hidden for the same
            hydration reason as the rest of the row: the controller shows
            them on open.
        */}
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              id="feedback-screenshot-btn"
              type="button"
              className="hidden inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-900 dark:text-zinc-100 transition-colors"
            >
              <CameraIcon className="w-3.5 h-3.5" />
              <span data-screenshot-label=""><ControllerText id="dialogs:feedback.screenshot.attach" /></span>
            </button>
            <div className="relative">
              <button
                id="feedback-attach-btn"
                type="button"
                aria-haspopup="menu"
                aria-expanded="false"
                aria-controls="feedback-attach-menu"
                aria-label={t('dialogs:feedback.attach.button')}
                title={t('dialogs:feedback.attach.button')}
                className="hidden inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-900 dark:text-zinc-100 transition-colors"
              >
                <PaperclipIcon className="w-5 h-5" aria-hidden="true" />
              </button>
              <div id="feedback-attach-menu" role="menu" aria-label={t('dialogs:feedback.attach.menu')} className="feedback-attach-pop hidden">
                <button
                  id="feedback-screenshot-picker-btn"
                  type="button"
                  role="menuitem"
                  className="feedback-attach-option hidden"
                >
                  <PhotoIcon aria-hidden="true" />
                  {t('dialogs:feedback.attach.photo')}
                </button>
                <button
                  id="feedback-video-btn"
                  type="button"
                  role="menuitem"
                  className="feedback-attach-option hidden"
                >
                  <VideoCameraIcon aria-hidden="true" />
                  <span data-video-label=""><ControllerText id="dialogs:feedback.video.add" /></span>
                </button>
              </div>
            </div>
            <input
              id="feedback-screenshot-input"
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
            <input
              id="feedback-video-input"
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
            />
          </div>
          <p id="feedback-screenshot-count" className="hidden mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          </p>
          <div id="feedback-screenshot-preview" className="hidden mt-2 flex-wrap items-center gap-2">
          </div>
          {/*
            #3940: video clips. One clip per issue, chosen alongside the
            images above: the popover's Video row (#feedback-video-btn) picks
            an MP4/WebM/MOV file (never `multiple`), #feedback-video-preview
            renders its thumbnail row (first-frame preview, upload state, its
            own 48px remove button), filled by the controller, hidden for the
            same hydration reason as the screenshot controls.
          */}
          <div id="feedback-video-preview" className="hidden mt-2 flex-wrap items-center gap-2">
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
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              <RichMessage
                id="dialogs:feedback.state.label"
                components={[<span className="font-medium text-zinc-700 dark:text-zinc-300" />]}
              />
            </span>
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
              <RichMessage
                id="dialogs:feedback.bounty.label"
                components={[<span className="font-medium text-zinc-700 dark:text-zinc-300" />]}
              />
              <br />
              <span id="feedback-bounty-note" className="text-zinc-500 dark:text-zinc-500">
              </span>
            </span>
          </label>
        </div>
        <div id="feedback-status" className="text-sm mt-2 hidden">
        </div>
        {/* #3994: a message saved on this device that has not sent yet is
            sent again on a press, instead of only when the outbox's own
            triggers fire. The controller shows it while anything is waiting
            and words it while a try is running. */}
        <button
          id="feedback-queue-retry"
          type="button"
          className="hidden mt-1 min-h-[44px] text-sm font-semibold text-violet-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-violet-300"
        >
          <ControllerText id="dialogs:feedback.queue.retry" />
        </button>
        {/* #4033: Cancel and Post stay on screen while the form above them
            scrolls (a long description, the kudos row). `.feedback-actions`
            in app.css pins the row to the bottom of the kit modal, which is
            the scroller. */}
        <div className="feedback-actions flex gap-3 mt-4">
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
          >
            {t('core:common.cancel')}
          </button>
          <Button id="feedback-submit" layout="flex">
            <ControllerText id="dialogs:feedback.submit.post" />
          </Button>
        </div>
        </div>
        <section id="feedback-first-success" className="hidden" aria-labelledby="feedback-first-title" tabIndex={-1}>
          <h2 id="feedback-first-title" className="text-xl font-bold mb-3">
            {t('dialogs:feedback.first.title')}
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            {t('dialogs:feedback.first.intro')}
          </p>
          <p id="feedback-first-notice" className="text-sm text-emerald-700 dark:text-emerald-400 mb-4" role="status"></p>
          <div className="flex flex-col gap-3">
            <Button id="feedback-first-fix" disabledStyle="block" className="min-h-[44px]">{t('dialogs:feedback.first.fix')}</Button>
            <p id="feedback-first-fix-note" className="text-xs text-zinc-500 dark:text-zinc-400">
              <ControllerText id="dialogs:feedback.first.fixNote.default" />
            </p>
            <Button id="feedback-first-board" variant="neutral" ink="neutral" disabledStyle="block" className="min-h-[44px]">{t('dialogs:feedback.first.board')}</Button>
            {/* #3186: the Me screen's list, where this report now is. */}
            <Button id="feedback-first-mine" variant="neutral" ink="neutral" className="min-h-[44px]">{t('dialogs:feedback.first.mine')}</Button>
            <Button id="feedback-first-done" variant="unstyled" ink="muted" className="min-h-[44px]">{t('core:common.done')}</Button>
          </div>
        </section>
        {/*
            #3186: every other filed report's confirmation. It was the status
            line, and the dialog closed itself 1.5 s later; now it is this
            section, drawn like the first-feedback moment above, and it stays
            until Done. The controller names where it went in the heading
            ("Thanks! Posted to Run Club", "Thanks! Posted to Homeroom") and
            fills the notice with any bounty outcome, so the notice renders
            empty and hidden for the reason #feedback-status does.
        */}
        <section id="feedback-sent" className="hidden" aria-labelledby="feedback-sent-title" tabIndex={-1}>
          <h2 id="feedback-sent-title" className="text-lg font-bold mb-3">
            <ControllerText id="dialogs:feedback.sent.title" />
          </h2>
          <p id="feedback-sent-notice" className="hidden text-sm text-emerald-700 dark:text-emerald-400 mb-2" role="status"></p>
          {/* B8: where Homeroom bot builds it, this says so ("Homeroom bot is
              building it now, usually about 8 minutes. ...", #3971), Open
              chat leads, and building it yourself is the small link at the
              foot. The controller words the line and shows the two. */}
          <p id="feedback-sent-line" className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            <ControllerText id="dialogs:feedback.sent.line" />
          </p>
          {/* #3971: a person's first request, where Homeroom bot builds it.
              B8 answered that with the bot's confirmation alone, so nobody it
              built for heard about their first request; this brings the moment
              back beside it rather than in place of it (the moment's own next
              steps would compete with Open chat). The controller shows it and
              names the app in the line. */}
          <div id="feedback-sent-first" className="hidden mb-4 rounded-lg bg-emerald-50 px-3 py-2.5 dark:bg-emerald-500/10">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              {t('dialogs:feedback.sent.firstTitle')}
            </p>
            <p id="feedback-sent-first-line" className="text-sm text-zinc-600 dark:text-zinc-400">
              <ControllerText id="dialogs:feedback.sent.firstLine.unnamed" />
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <Button id="feedback-sent-chat" className="hidden min-h-[44px]">{t('dialogs:feedback.sent.chat')}</Button>
            <Button id="feedback-sent-mine" variant="neutral" ink="neutral" className="min-h-[44px]">{t('dialogs:feedback.sent.mine')}</Button>
            <Button id="feedback-sent-done" variant="unstyled" ink="muted" className="min-h-[44px]">{t('core:common.done')}</Button>
            <button id="feedback-sent-fix" type="button" className="hidden self-center text-xs text-zinc-500 underline underline-offset-2 dark:text-zinc-400">
              {t('dialogs:feedback.sent.fix')}
            </button>
          </div>
        </section>
      </DialogCard>
    </DialogRoot>
  );
}
