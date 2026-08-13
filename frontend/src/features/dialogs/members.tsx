/**
 * Members, approvers & governance dialog (#members-modal).
 *
 * Sections are shown and hidden per viewer: visibility controls for the
 * creator/admin, member list + invite typeahead for collab-private apps,
 * proposal-approval governance, the app-admins roster and the approvers
 * roster.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * gave it a lifecycle. The render output is still byte-identical to what the
 * shell shipped — same ids, same class strings, same `hidden` semantics, same
 * data-* attributes — and tests/baselines/shell-markup.json plus the
 * image-prerendered public/index.html are the proof.
 *
 * ── What this island owns, and what it does not ───────────────────────
 *
 * It owns the dialog's LIFECYCLE: `open`/`close`, the reveal, the kit lift
 * (`useStaticModal`), the backdrop-dismiss rule and the ghost-click guard —
 * everything `useDialog` provides. It does NOT own anything inside the card.
 *
 * That split is deliberate and it is why the returned tree is CONSTANT: no
 * interpolated state anywhere below the root, so React renders these nodes
 * once at hydration and never reconciles them again. The interior belongs to
 * members-controller.js, which was moved here from public/js/app-view.js in
 * this same chunk and still paints its rosters with `innerHTML` and rebinds
 * its pills with the cloneNode-swap idiom. Converting those ~1,200 lines is a
 * chunk of its own; the header comment on members-controller.js explains why
 * in full. One owner per node is the invariant, and this arrangement keeps it
 * — the same way #admin-section-content and the app-secrets island do.
 */

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { init as initMembers, MembersDialog as Members } from './members-controller';
import { useDialog } from './use-dialog';

export function MembersDialog() {
  const dialog = useDialog('members', {
    onOpen: () => { void Members._load(); },
    onClose: () => Members._reset(),
  });

  // Publishes the block onto window.AppView and takes over
  // AppView.openMembersModal. A layout effect, not DOMContentLoaded: the
  // bundle is a deferred module, so that event may already have fired.
  useIsomorphicLayoutEffect(() => { initMembers(); }, []);

  return (
    <div
      id="members-modal"
      ref={dialog.rootRef}
      className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60"
      {...dialog.backdropProps}
    >
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-6 w-full max-w-sm shadow-xl">
          {/*
              Heading is set per app in openMembersModal: "Proposal approvals"
              on the self-app (whose only sections are the approval ones),
              "Members & visibility" everywhere else.
          */}
          <h2 id="members-modal-title" className="text-lg font-bold mb-4">
            Members &amp; visibility
          </h2>
          <div id="members-visibility-section" className="hidden space-y-3 mb-4">
            <div>
              <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Who can build it
              </label>
              <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                <button
                  type="button"
                  data-m-collab-vis="public"
                  className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                >
                  Everyone
                </button>
                <button
                  type="button"
                  data-m-collab-vis="private"
                  className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                >
                  Invite-only
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Who can see &amp; use it
              </label>
              <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                <button
                  type="button"
                  data-m-view-vis="public"
                  className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                >
                  Everyone
                </button>
                <button
                  type="button"
                  data-m-view-vis="private"
                  className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                >
                  Collaborators only
                </button>
              </div>
              <p id="members-vis-hint" className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 hidden">
                Apps everyone can build are always public to view.
              </p>
            </div>
            <div id="members-vis-error" className="text-red-400 text-sm hidden">
            </div>
          </div>
          <div id="members-invite-section" className="hidden mb-4">
            <label
              htmlFor="members-invite-input"
              className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1"
            >
              Invite a user
            </label>
            <div className="relative">
              <input
                id="members-invite-input"
                type="text"
                autoComplete="off"
                spellCheck="false"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="username"
              />
              {/* Typeahead dropdown (GET /api/users/search) */}
              <div
                id="members-invite-suggestions"
                className="hidden absolute left-0 right-0 top-full mt-1 z-10 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden"
              >
              </div>
            </div>
            <div id="members-invite-status" className="text-sm mt-2">
            </div>
          </div>
          <div id="members-list-section" className="hidden mb-4">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Collaborators
            </p>
            <div
              id="members-list"
              className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
            </div>
          </div>
          {/*
              Proposal approvals (issue #646): who can approve proposals +
              how many approvals are needed. Shown to creator/admin; changes
              open a dapp.json governance PR (POST .../governance-pr).
          */}
          <div
            id="members-governance-section"
            className="hidden space-y-3 mb-4 pt-3 border-t border-zinc-200 dark:border-zinc-800"
          >
            <p className="text-sm font-semibold">
              Proposal approvals
            </p>
            <div>
              <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                Who can approve proposals
              </label>
              <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium">
                <button
                  type="button"
                  data-m-approver-policy="anyone"
                  className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                >
                  Everyone
                </button>
                <button
                  type="button"
                  data-m-approver-policy="invited"
                  className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                >
                  Invited approvers
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                How many approvals are needed
              </label>
              <div className="flex items-center gap-2">
                <div className="flex p-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-sm font-medium flex-1">
                  <button
                    type="button"
                    data-m-approvals-mode="default"
                    className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  >
                    Time &amp; majority
                  </button>
                  <button
                    type="button"
                    data-m-approvals-mode="at_least"
                    className="members-vis-pill flex-1 rounded-md px-3 py-1.5 transition-colors"
                  >
                    At least
                  </button>
                </div>
                <input
                  id="members-approvals-n"
                  type="number"
                  min="1"
                  max="50"
                  defaultValue="1"
                  className="hidden w-16 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                />
                <button
                  type="button"
                  id="members-approvals-propose"
                  className="hidden rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition-colors"
                >
                  Propose
                </button>
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                Changes open a proposal that is voted on under the current rules.
              </p>
            </div>
            {/*
                Initial-approvers draft step: revealed when "Invited approvers"
                is tapped on an app currently set to Everyone. Display-only
                until Propose (which replaces the confirm dialog for this
                path) — see _showInitialApproversDraft in app-view.js.
            */}
            <div
              id="members-initial-approvers"
              className="hidden space-y-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3"
            >
              <p className="text-sm font-medium">
                Initial approvers
              </p>
              <p id="members-initial-approvers-status" className="text-xs text-zinc-500 dark:text-zinc-400">
              </p>
              <div id="members-initial-approvers-list" className="space-y-1">
              </div>
              <div className="relative">
                <input
                  id="members-initial-approver-input"
                  type="text"
                  autoComplete="off"
                  spellCheck="false"
                  className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  placeholder="add approvers to invite (optional)"
                />
                <div
                  id="members-initial-approver-suggestions"
                  className="hidden absolute left-0 right-0 top-full mt-1 z-10 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden"
                >
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  id="members-initial-approvers-propose"
                  className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition-colors"
                >
                  Propose
                </button>
                <button
                  type="button"
                  id="members-initial-approvers-cancel"
                  className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
            <div id="members-governance-error" className="text-red-400 text-sm hidden">
            </div>
          </div>
          {/*
              Approver roster + invite (issue #646). Final visibility is
              decided after the roster fetch (_renderApprovers): shown when
              the policy is 'invited' (creator/admin + collaborators) or —
              for anyone who can see it — when leftover rows exist under
              'anyone', with the dormant-roster note below. An empty roster
              on an 'anyone' app keeps the whole section hidden: approvers
              don't apply there, so "No approvers yet" only misled.
          */}
          <div id="members-approvers-section" className="hidden mb-4">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              Approvers
            </p>
            <div
              id="members-approvers-list"
              className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
            </div>
            <p id="members-approvers-dormant-note" className="hidden text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Approvers only take effect when &ldquo;Who can approve proposals&rdquo; is set to Invited approvers.
            </p>
            <div id="members-approver-invite" className="hidden relative mt-2">
              <input
                id="members-approver-invite-input"
                type="text"
                autoComplete="off"
                spellCheck="false"
                className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                placeholder="invite an approver by username"
              />
              <div
                id="members-approver-suggestions"
                className="hidden absolute left-0 right-0 top-full mt-1 z-10 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden"
              >
              </div>
            </div>
            <div id="members-approver-status" className="text-sm mt-2">
            </div>
          </div>
          {/*
              #788: per-app admins. The roster's only writer is the
              deploy-time reconcile of dapp.json's `admins` block; managers
              (creator / app admin / platform admin) get an editor whose
              Propose opens a PR editing that block (POST .../admins-pr) —
              everyone else keeps the read-only roster, hidden when empty.
              The self-app stays read-only: reconcileAppAdmins skips
              self_hosted apps.
          */}
          <div id="members-appadmins-section" className="hidden mb-4">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
              App admins
            </p>
            <div
              id="members-appadmins-list"
              className="max-h-56 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
            </div>
            <div id="members-appadmins-edit" className="hidden mt-2">
              <div className="relative">
                <input
                  id="members-appadmins-input"
                  type="text"
                  autoComplete="off"
                  spellCheck="false"
                  className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent"
                  placeholder="add an admin by username"
                />
                <div
                  id="members-appadmins-suggestions"
                  className="hidden absolute left-0 right-0 top-full mt-1 z-10 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl overflow-hidden"
                >
                </div>
              </div>
              <div id="members-appadmins-actions" className="hidden mt-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    id="members-appadmins-propose"
                    className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Propose
                  </button>
                  <button
                    type="button"
                    id="members-appadmins-cancel"
                    className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
            <p id="members-appadmins-status" className="text-sm mt-2 hidden">
            </p>
            <p id="members-appadmins-note" className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
              Set in
              <code>
                dapp.json
              </code>
              . To change them, open a pull request that edits the
              <code>
                admins
              </code>
              list &mdash; that proposal needs real Yes votes and won&rsquo;t merge on a timer.
            </p>
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              id="members-close"
              className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              onClick={() => dialog.close()}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
