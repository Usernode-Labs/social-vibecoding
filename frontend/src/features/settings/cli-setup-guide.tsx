import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
/**
 * Shared local coding-agent setup for Settings and the own-tools launchpad.
 *
 * This guide is static section content, not a credential-list state. Keeping
 * it outside `#cli-tokens-list` means it remains visible while capability
 * detection is pending, when staging deliberately disables the real token
 * API, and when the account already has credentials.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

const REPOSITORY_SETUP = `git clone https://github.com/Usernode-Labs/social-vibecoding.git
cd social-vibecoding`;
const CODEX_COMMAND = 'codex';
const CLAUDE_COMMAND = 'claude';
const PROPOSAL_PROMPT = 'Create a proposal for <app name> that <describe the change you want>.';

function ui(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

function CopyableCode({ label, value }: { label: string; value: string }) {
  useUiLanguage();
  const [buttonLabel, setButtonLabel] = useState(tr("settings:copy_e21f935f"));
  return (
    <div className="mt-2 flex min-w-0 items-stretch overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900">
      {/* Focusable, and named (QA 2026-09-24 Q20): a long line scrolls
          sideways, and a region that scrolls must be reachable by keyboard. */}
      <pre
        tabIndex={0}
        role="region"
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto whitespace-pre px-3 py-2 text-xs font-mono text-zinc-700 dark:text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
      ><code>{value}</code></pre>
      <LocalizedDynamic element={<Button
        type="button"
        layout="shrink"
        variant="unstyled"
        size="none"
        ink="none"
        className="inline-flex min-h-[44px] min-w-[88px] items-center justify-center border-l border-zinc-200 dark:border-zinc-700 px-3 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        aria-label={tr("settings:copy_value1_9776bafb", { value1: label })}
        onClick={async () => {
          const ok = await ui()?.copyText?.(value);
          setButtonLabel(ok ? tr("settings:copied_8d525e5f") : tr("settings:copy_failed_5b50e7a6"));
          if (!ok) ui()?.toast?.(tr("settings:couldn_t_copy_select_the_text_and_copy_it_manual_9181be57"), { error: true });
          setTimeout(() => setButtonLabel(tr("settings:copy_e21f935f")), 1500);
        }}
      >
        {buttonLabel}
      </Button>} resolve={() => ({ get "aria-label"() { return tr("settings:copy_value1_9776bafb", { value1: label }); } })} />
    </div>
  );
}

function SetupStep({ n, title, children }: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-950 text-xs font-semibold text-violet-700 dark:text-violet-300" aria-hidden="true">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h4 className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{title}</h4>
        {children}
      </div>
    </li>
  );
}

export function CliSetupGuide({
  id = 'cli-setup-guide',
  proposalPrompt = PROPOSAL_PROMPT,
  promptHelp = tr("settings:replace_the_placeholders_with_the_app_and_change_2e751b16"),
}: { id?: string; proposalPrompt?: string; promptHelp?: string } = {}) {
  return (
    <div id={id} className="mb-4 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200"><Message id="settings:set_up_a_local_coding_agent_524891f6" /></h3>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed"><Message id="settings:start_codex_or_claude_code_from_a_local_checkout_6f0b72af" /></p>
      <ol className="mt-4 space-y-4">
        <Localized element={<SetupStep n={1} title={catalogText("settings:clone_the_repository_0fce6e04")}>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed"><Message id="settings:clone_homeroom_and_enter_the_checkout_830d38a3" /></p>
          <Localized element={<CopyableCode label={catalogText("settings:repository_setup_commands_3f2f7e3c")} value={REPOSITORY_SETUP} />} messages={{"label":"settings:repository_setup_commands_3f2f7e3c"}} />
        </SetupStep>} messages={{"title":"settings:clone_the_repository_0fce6e04"}} />
        <Localized element={<SetupStep n={2} title={catalogText("settings:start_your_coding_agent_c21d5754")}>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed"><Message id="settings:run_either_codex_or_claude_code_from_the_reposit_7310f470" /></p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400"><Message id="settings:codex_616efbe9" /></div>
              <Localized element={<CopyableCode label={catalogText("settings:codex_command_1bab5da7")} value={CODEX_COMMAND} />} messages={{"label":"settings:codex_command_1bab5da7"}} />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-zinc-600 dark:text-zinc-400"><Message id="settings:claude_code_246ef8c1" /></div>
              <Localized element={<CopyableCode label={catalogText("settings:claude_code_command_5af7af69")} value={CLAUDE_COMMAND} />} messages={{"label":"settings:claude_code_command_5af7af69"}} />
            </div>
          </div>
        </SetupStep>} messages={{"title":"settings:start_your_coding_agent_c21d5754"}} />
        <Localized element={<SetupStep n={3} title={catalogText("settings:ask_it_to_create_a_proposal_1f6f6432")}>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {promptHelp}
          </p>
          <Localized element={<CopyableCode label={catalogText("settings:example_proposal_prompt_a09ecbf5")} value={proposalPrompt} />} messages={{"label":"settings:example_proposal_prompt_a09ecbf5"}} />
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed"><Message id="settings:follow_the_agent_s_instructions_it_will_ask_you__f8013ce9" /></p>
        </SetupStep>} messages={{"title":"settings:ask_it_to_create_a_proposal_1f6f6432"}} />
      </ol>
    </div>
  );
}
