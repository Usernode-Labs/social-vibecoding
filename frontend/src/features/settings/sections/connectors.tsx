import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Hosted MCP connector: connect Claude.ai / ChatGPT so their built-in coding
 * agent (Claude Code on the web, Codex) can do the work on the user's own
 * subscription. Also holds the verified GitHub account link, because that link
 * exists only to serve this flow: it is IDENTITY ONLY (no OAuth scope, no
 * stored token) and its whole job is attributing a submitted pull request to
 * the account that verified it. The fork the agent pushes to is made by that
 * agent, not by the platform.
 *
 * Rendered by Settings._renderConnectors() / _renderGithubLink() from
 * GET /api/me/connectors and GET /api/me/github (?demo=1 passthrough in
 * staging — mcp_tokens is staging:private and the link needs a real OAuth
 * round-trip, so a staging clone has neither).
 */
export function ConnectorsSection() {
  return (
    <div data-settings-section="connectors" className="hidden">
      <div id="connectors-section">
        <SectionHeading title={<>Claude &amp; ChatGPT connectors</>}>
          Connect Usernode to Claude.ai or ChatGPT and you can browse apps, file requests and turn finished work into proposals from the chat you already have open &mdash; with the coding done by Claude Code or Codex on your own plan, not your Usernode daily allowance.
        </SectionHeading>
        <Label className="mb-1" htmlFor="connector-url">
          Connector URL
        </Label>
        <div className="flex gap-2 mb-2">
          {/*
              `mono` as a PROP, not className: this field writes `font-mono`
              before the focus ring, where #settings-api-key writes it after.
              Input's variant table exists to reproduce both spellings.
          */}
          <Input
            id="connector-url"
            type="text"
            readOnly={true}
            spellCheck="false"
            width="flex"
            mono
          />
          <Button id="connector-url-copy" type="button" layout="shrink">
            Copy
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4 leading-relaxed">
          In Claude.ai: Settings &rarr; Connectors &rarr; Add custom connector. In ChatGPT: Settings &rarr; Connectors. Paste the URL above, then approve the connection in the browser page that opens. You can disconnect here at any time.
        </p>
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
          Connected
        </h4>
        <div id="connectors-list" className="space-y-2">
        </div>
        <StatusLine id="connectors-status" size="xs" />
      </div>
      <div id="github-link-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <SectionHeading title="GitHub account">
          Linking GitHub proves which GitHub account is yours, so work built by your own coding agent can be submitted under your name. Usernode asks for
          <strong className="font-semibold text-zinc-600 dark:text-zinc-400">
            no access to your repositories
          </strong>
          &mdash; read-only public profile information only &mdash; and stores no GitHub token. Your coding agent (Claude Code or Codex) makes your fork of an app using its own GitHub connection.
        </SectionHeading>
        <div id="github-link-body" className="space-y-2">
        </div>
        <StatusLine id="github-link-status" size="xs" />
      </div>
    </div>
  );
}
