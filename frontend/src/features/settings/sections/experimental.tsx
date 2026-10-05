import { RichMessage } from "../../../lib/i18n/react";
import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
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
 * #3624 Homeroom bot (default OFF) puts this person on the bot's DM list, or
 * takes them off it: the same list an admin keeps on the bot's dashboard
 * (homeroom_bot_dm_users), so its cap and the weekly allowance per person
 * hold either way. settings.js wires the change handler to
 * POST /api/me/homeroom-bot-dm and paints the switch from /api/auth/me's
 * `homeroomBotDm`; a full list answers 409 and the switch goes back off.
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
        <Localized element={<SectionHeading title={catalogText("settings:experimental_3dc9f569")}><Message id="settings:early_features_we_re_still_testing_they_may_chan_18b10e0c" /></SectionHeading>} messages={{"title":"settings:experimental_3dc9f569"}} />
        <SwitchRow id="ai-progress-estimate"><Message id="settings:ai_progress_estimate_84af6dff" /></SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"><Message id="settings:while_the_coding_agent_works_a_small_ai_model_sk_c1f62fff" /></p>
        <StatusLine id="ai-progress-estimate-status" size="xs" />
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="session-bridge-enabled"><Message id="settings:session_bridge_run_this_chat_on_your_computer_a7de0058" /></SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"><RichMessage id="settings:sentence_8e3af0c1eee6" components={[<span className="font-mono" />]} /></p>
          <StatusLine id="session-bridge-status" size="xs" />
        </div>
        <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
          <SwitchRow id="homeroom-bot-dm-enabled"><Message id="settings:homeroom_bot_build_with_it_in_messages_09675ab3" /></SwitchRow>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"><Message id="settings:create_a_project_and_describe_what_it_should_do__c7e403c1" /></p>
          <StatusLine id="homeroom-bot-dm-status" size="xs" />
        </div>
      </div>
      <div id="settings-local-agents-section" className="hidden mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <Localized element={<SectionHeading title={catalogText("settings:local_coding_agent_c95fa225")}><RichMessage id="settings:sentence_f3e68128c7f5" components={[<span className="font-mono" />]} /></SectionHeading>} messages={{"title":"settings:local_coding_agent_c95fa225"}} />
        <div id="settings-local-agents-list" className="space-y-2">
          <LocalAgentsList />
        </div>
        <StatusLine id="settings-local-agents-status" size="xs" />
      </div>
    </div>
  );
}
