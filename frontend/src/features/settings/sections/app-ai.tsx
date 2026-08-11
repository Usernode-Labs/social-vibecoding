import { SectionHeading, StatusLine } from '@/components/ui/field';

/**
 * App AI permissions (issue #34). Lists every app the user has granted access
 * to their daily AI budget: today's spend vs the per-app cap, a cap editor,
 * the BYOK spillover toggle, and Revoke. Rendered by
 * Settings._renderLlmGrants() on modal open from GET /api/me/llm-grants
 * (?demo=1 passthrough in staging).
 */
export function AppAiSection() {
  return (
    <div data-settings-section="app-ai" className="hidden">
      <div id="llm-grants-section">
        <SectionHeading title="App AI permissions">
          Apps you've allowed to use AI on your behalf. Their spend counts against your normal daily budget, plus the per-app cap you set. Revoking takes effect immediately.
        </SectionHeading>
        <div id="llm-grants-list" className="space-y-2">
        </div>
        <StatusLine id="llm-grants-status" />
      </div>
    </div>
  );
}
