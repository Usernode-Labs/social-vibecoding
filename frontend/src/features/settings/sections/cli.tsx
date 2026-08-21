import { SectionHeading, StatusLine } from '@/components/ui/field';

/**
 * Global CLI/coding-agent credentials. The server returns only a short token
 * hint and non-secret metadata; raw bearer values never enter the browser
 * Settings surface. Painted by Settings._renderCliTokens() (?demo=1
 * passthrough in staging — cli tokens are staging:private).
 */
export function CliSection() {
  return (
    <div data-settings-section="cli" className="hidden">
      <div id="cli-tokens-section">
        <SectionHeading title={<>CLI &amp; coding-agent access</>}>
          Credentials approved for the Social Vibecoding CLI, Codex, Claude Code, or OpenCode. Revoking an active credential takes effect immediately.
        </SectionHeading>
        <div id="cli-tokens-list" className="space-y-2">
        </div>
        <button
          id="cli-tokens-more"
          type="button"
          className="hidden mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
        >
          Load more
        </button>
        <StatusLine id="cli-tokens-status" size="xs" />
      </div>
    </div>
  );
}
