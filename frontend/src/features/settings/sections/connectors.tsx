import { Button } from '@/components/ui/button';
import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Hosted MCP connector: connect Claude.ai / ChatGPT so their built-in coding
 * agent (Claude Code on the web, Codex) can do the work on the user's own
 * subscription. Also holds GitHub/X ownership proofs for the Layer-1 daily
 * credit tier. These are IDENTITY ONLY: immutable provider id + display handle
 * and verification timestamps, with no provider token retained.
 *
 * Rendered by Settings._renderConnectors() / _renderGithubLink() from
 * GET /api/me/connectors and GET /api/me/social-identities (deterministic
 * staging fixtures make every credit state reviewable without OAuth).
 */
export function ConnectorsSection() {
  return (
    <div data-settings-section="connectors" className="hidden">
      <div id="connectors-section">
        <SectionHeading title={<>Claude &amp; ChatGPT connectors</>}>
          Connect Usernode to Claude.ai or ChatGPT and you can browse apps, file requests and turn finished work into proposals from the chat you already have open &mdash; with the coding done by Claude Code or Codex on your own plan, not your Usernode daily allowance.
        </SectionHeading>
        {/*
            The NAME field comes before the URL because that is the order
            "Add custom connector" asks for them, and because a wrong name
            is the failure that hides (#1206): the connector works, but
            every permission rule the platform publishes names this exact
            string, the server segment of such a rule cannot be
            wildcarded, and a rule that names `Uesrnode` matches nothing
            without erroring. The value is filled from the API's `setup`
            block, never typed here, so there is one spelling in the
            product.
        */}
        <Label className="mb-1" htmlFor="connector-name">
          Connector name
        </Label>
        <div className="flex gap-2 mb-2">
          <Input
            id="connector-name"
            type="text"
            readOnly={true}
            spellCheck="false"
            width="flex"
            mono
          />
          <Button id="connector-name-copy" type="button" layout="shrink">
            Copy
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4 leading-relaxed">
          Type this name exactly. It becomes part of every permission rule for these tools, so a different spelling leaves those rules matching nothing &mdash; with no error, just a prompt on every call.
        </p>
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
        {/*
            Fewer permission prompts. Deliberately framed as something the
            USER installs in their own client: a connector cannot reduce
            its own prompting and should not be able to, so this is a
            snippet to copy, not a switch to flip. The acting tools are
            absent from it on purpose, and the copy says so — a
            confirmation before a change goes to a group vote is the one
            prompt worth keeping, and it only means anything once the
            read-only noise around it is gone.
        */}
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
          Fewer permission prompts
        </h4>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-2 leading-relaxed">
          Claude Code asks before every connector call, including read-only ones. Save this as <code className="font-mono text-[11px]">.claude/settings.json</code> in the project you work in and the tools that only read &mdash; <span id="connector-perms-reads" /> &mdash; stop asking. Tools that act on your behalf are left out on purpose: <span id="connector-perms-acts" /> keep asking, because <span className="font-semibold">submit_work</span> puts a change to a group vote. Apps scaffolded by Usernode already ship this file.
        </p>
        <div className="flex gap-2 mb-2">
          <pre
            id="connector-perms-json"
            className="flex-1 min-w-0 overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-2 text-[11px] font-mono text-zinc-700 dark:text-zinc-300"
          />
          <Button id="connector-perms-copy" type="button" layout="shrink">
            Copy
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4 leading-relaxed">
          <a
            href="/connector-setup.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Full connector setup notes
          </a>
        </p>
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2 mt-4">
          Connected
        </h4>
        <div id="connectors-list" className="space-y-2">
        </div>
        <StatusLine id="connectors-status" size="xs" />
      </div>
      <div id="github-link-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <SectionHeading title="Social accounts &amp; daily credits">
          Connect GitHub or X to prove that you control that provider account. Either one unlocks the same $10/day Layer-1 credit tier when identity credits are active; connecting both does not stack credits. This is an account-control proof, not proof of unique humanity. For GitHub, Usernode asks for
          <strong className="font-semibold text-zinc-600 dark:text-zinc-400">
            no access to your repositories
          </strong>
          &mdash; identity-only profile information &mdash; and stores no provider token. GitHub can also attribute proposals built by your own coding agent to the account you verified.
        </SectionHeading>
        <div id="github-link-body" className="space-y-2">
        </div>
        <StatusLine id="github-link-status" size="xs" />
      </div>
    </div>
  );
}
