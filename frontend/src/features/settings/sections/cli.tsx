import { Message } from "../../../lib/i18n/react";
import { SectionHeading, StatusLine } from '@/components/ui/field';

import { CliSetupGuide } from '../cli-setup-guide';
import { CliTokensList } from '../cli-tokens-list';

/**
 * Global CLI/coding-agent credentials. The server returns only a short token
 * hint and non-secret metadata; raw bearer values never enter the browser
 * Settings surface. Settings._renderCliTokens() owns the keyset fetch and the
 * DELETE; the ROWS are ../cli-tokens-list.tsx's since #1191 — the section
 * stays static markup around one stateful child, which is the same shape the
 * App-AI and agent-files panes already have.
 */
export function CliSection() {
  return (
    <div data-settings-section="cli" className="hidden">
      <div id="cli-tokens-section">
        <SectionHeading title={<><Message id="settings:cli_coding_agent_access_f5b96ef5" /></>}><Message id="settings:credentials_approved_for_the_homeroom_cli_codex__d72becb6" /></SectionHeading>
        <CliSetupGuide />
        <div id="cli-tokens-list" className="space-y-2">
          <CliTokensList />
        </div>
        <button
          id="cli-tokens-more"
          type="button"
          className="hidden mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        ><Message id="settings:load_more_ac8991ef" /></button>
        <StatusLine id="cli-tokens-status" size="xs" />
      </div>
    </div>
  );
}
