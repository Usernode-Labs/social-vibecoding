import { SectionHeading, StatusLine } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';

import { LocalAgentsList } from '../local-agents-list';

/**
 * Experimental: AI progress estimate (default OFF). When enabled, a small
 * Haiku call skims the in-flight Claude Code progress log about once a minute
 * and shows a vague "AI guess" plus a live countdown next to the timer on the
 * running line in dev-chat. #892: the model is now given the MEASURED
 * run-length distribution as prompt input (llm.js RUN_LENGTH_PRIORS) rather
 * than the old "bias toward 2-10 minutes" instruction that flattened its
 * output; nothing scales its answer afterwards. Server-gated per user;
 * settings.js wires the change handler to POST /api/me/ai-progress-estimate.
 *
 * #1281 Session bridge (default OFF) gates the `local` build venue. The spec
 * marks that venue settings-gated and "most users: no" — it is the only one
 * that wants software installed before it can do anything — so it is absent
 * from every venue list until this is on. Deployment support (cliAuthEnabled)
 * is still required on top; see VENUES in public/js/build-venues.js.
 *
 * #2779 Agent sessions used to have a switch here too. They are no longer
 * experimental: new work starts in one for everyone, so the switch is gone.
 *
 * #3624 Homeroom bot used to have a switch here too, while it was tried out
 * one person at a time. It works for everyone now, so the switch is gone.
 *
 * #4289 Press C to comment on the page (default OFF) is the one switch
 * here kept on the DEVICE, not the account: a keyboard shortcut belongs to
 * the keyboard in front of you. C turns on comment mode, where a click leaves
 * a comment (../../comment-pin/), and Suggest an improvement opens it too,
 * with its form one switch away. ../../improve/suggest-settings.ts keeps the
 * switch (localStorage), and
 * ../../improve/suggest-shortcut.ts publishes window.UsernodeReact.suggestShortcut,
 * which settings.js paints and saves the switch through.
 *
 * #907 Local coding agent lives in the same pane (not the CLI section) because
 * it is a preview of the same feature the dev chat's "Run on" selector
 * exposes, and because a lease is NOT a credential: revoking a CLI token is a
 * security action, detaching a machine is a routing one. Painted by
 * settings.js _renderLocalAgentsSection() from GET /api/me/local-agents; the
 * whole block hides itself when no machine has ever attached, so it costs
 * nothing for the overwhelming majority who never run the CLI.
 */
export function ExperimentalSection() {
  return (
    <div data-settings-section="experimental" className="hidden">
      <div id="settings-experimental-section">
        <SectionHeading title="Experimental">
          Early features we're still testing. They may change or disappear.
        </SectionHeading>
        <SwitchRow id="ai-progress-estimate">
          AI progress estimate
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          While the coding agent works, a small AI model skims its progress log about once a minute and guesses how far along it is and roughly how long is left. It's calibrated against how long real runs actually take, but it's still a guess and can be wrong. Adds a tiny per-run cost (billed to your own API key if you've saved one above).
        </p>
        <StatusLine id="ai-progress-estimate-status" size="xs" />
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="session-bridge-enabled">
            Session bridge (run this chat on your computer)
          </SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            Adds <span className="font-mono">Your computer &middot; Homeroom session</span> to the list of places a session can be built. You keep the platform chat exactly as it is, with the same transcript, branch and proposal, but its turns run through the Homeroom CLI on your own machine, on your own Claude plan. It needs the CLI installed and attached, so it stays off until you ask for it.
          </p>
          <StatusLine id="session-bridge-status" size="xs" />
        </div>
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="suggest-shortcut-enabled">
            Press C to comment on the page
          </SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
            Suggest an improvement opens comment mode, and on a computer so does pressing C. Click or tap anything, say what should change and post it: it's a suggestion with a screenshot of the page and your pin on it. Add more comments to the same suggestion, or post each on its own, then press Done. The form is one switch away. C does nothing while you're typing or have text selected, or when the screen or app you're in uses C for something of its own. Saved on this device only.
          </p>
        </div>
      </div>
      <div id="settings-local-agents-section" className="hidden mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <SectionHeading title="Local coding agent">
          Machines running <span className="font-mono">social-vibecoding agent run</span>. While one is attached, that session's plan and coding turns run there on your own Claude subscription instead of on Homeroom. Each turn asks in your terminal before it starts; plan turns are read-only, and after a coding turn Homeroom still opens the pull request, builds the preview and runs the checks. Detaching sends the next turn back to Homeroom.
        </SectionHeading>
        <div id="settings-local-agents-list" className="space-y-2">
          <LocalAgentsList />
        </div>
        <StatusLine id="settings-local-agents-status" size="xs" />
      </div>
    </div>
  );
}
