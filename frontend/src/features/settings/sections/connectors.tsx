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
/**
 * The three read-only rules, rendered into BOTH copy blocks below: the
 * personal `~/.claude/settings.json` and the per-repo `.claude/settings.json`.
 * One constant, because the two files take identical content and differ only
 * in reach — a repo file covers one repo and travels into a fresh web
 * container; a personal file covers every repo and does not.
 *
 * Written out as a literal rather than built from
 * services/mcp-connect-constants.js: that module is CommonJS on the server
 * side of the repo, and pulling it into the browser bundle to render three
 * short strings would drag the connector's server constants into the shell.
 * tests/connector-permission-rules.test.js asserts this string is exactly
 * `JSON.stringify({ permissions: { allow: READ_ONLY_ALLOW_RULES } }, null, 2)`,
 * so the two cannot drift — a rule added to the constant fails the test here
 * until this block matches.
 */
const PERSONAL_ALLOW_RULES = `{
  "permissions": {
    "allow": [
      "mcp__usernode__get_*",
      "mcp__usernode__list_*",
      "mcp__usernode__whoami"
    ]
  }
}`;

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
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-2 leading-relaxed">
          In Claude.ai: Settings &rarr; Connectors &rarr; Add custom connector. In ChatGPT: Settings &rarr; Connectors. Paste the URL above, then approve the connection in the browser page that opens. You can disconnect here at any time.
        </p>
        {/*
            #1218: the Name field in Claude.ai's "Add custom connector" dialog
            is where the permission-rule server segment comes from — the client
            builds tool names from what the human types, not from the server's
            own serverInfo.name. One account typed `Uesrnode`, and because a
            permission rule's server segment cannot be wildcarded, every rule
            Usernode ships missed it SILENTLY. So the canonical name is stated
            here, at the moment the field is filled in, rather than left to
            chance. `usernode` is exactly what serverInfo.name reports, so a
            client that derives the name and one where it was typed agree.
        */}
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4 leading-relaxed">
          Name it exactly <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode</code>. Claude Code builds its permission rules from that name &mdash; a different spelling still works, but the read-only allowlist Usernode ships in every app repo will not match it, and you will keep being asked to approve each call.
        </p>
        {/*
            #1218 follow-up: the same three rules land in two different files
            depending on where Claude Code is running, and a single block
            headed "add this to ~/.claude/settings.json" was wrong for the
            surface that needs it most. A web session's container is built
            fresh, so a file on the user's own machine is not in it; the only
            thing that travels is the repo, so the per-repo copy is the one
            that applies there. Hence three labelled cases rather than one
            block of prose: a user reads the case they are in.

            Static markup, not a stateful island: both copy buttons and the
            case filtering are wired by Settings._renderConnectors()'s sibling
            handlers, exactly like #connector-url-copy above it. The cases
            render VISIBLE and are hidden by that code, so a client name it
            cannot classify — and a page whose script has not run yet — shows
            everything rather than nothing.
        */}
        <div id="connector-prompt-help" className="mb-4 rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
          <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1">
            Stop the permission prompts
          </h4>
          <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-3 leading-relaxed">
            Claude Code asks you to approve <em>every</em> connector call by default &mdash; including read-only ones like <code className="font-mono text-zinc-600 dark:text-zinc-400">whoami</code> and <code className="font-mono text-zinc-600 dark:text-zinc-400">get_app</code>. Which fix applies depends on where you run it.
          </p>

          <div id="connector-case-cc-local" className="mb-3">
            <h5 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
              Claude Code on your own machine
            </h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-2 leading-relaxed">
              Add this to your own <code className="font-mono text-zinc-600 dark:text-zinc-400">~/.claude/settings.json</code>. It is the only one of the three that covers <strong className="font-semibold text-zinc-600 dark:text-zinc-400">every</strong> repo at once, including repos Usernode never made.
            </p>
            <div className="flex gap-2">
              <pre id="connector-allow-rules" className="flex-1 min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{PERSONAL_ALLOW_RULES}</pre>
              <Button id="connector-allow-rules-copy" type="button" layout="shrink">
                Copy
              </Button>
            </div>
          </div>

          <div id="connector-case-cc-web" className="mb-3">
            <h5 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
              Claude Code on the web
            </h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-2 leading-relaxed">
              A web session gets a fresh container each time, so a settings file on your own machine is not in it and last session&rsquo;s approvals are gone. What the container does carry is the repo it checks out &mdash; so commit the same block as <code className="font-mono text-zinc-600 dark:text-zinc-400">.claude/settings.json</code> in the app repo. Usernode writes that file into every app repo it creates, imports or forks; repos that already existed before it shipped do not have one, and adding it is an ordinary commit.
            </p>
            <div className="flex gap-2 mb-2">
              <pre id="connector-repo-allow-rules" className="flex-1 min-w-0 overflow-x-auto text-xs font-mono text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2">{PERSONAL_ALLOW_RULES}</pre>
              <Button id="connector-repo-allow-rules-copy" type="button" layout="shrink">
                Copy
              </Button>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 leading-relaxed">
              Claude Code may still ask you to trust the workspace once per container before a repo-level file takes effect. Whether that dialog appears in every web session has not been settled &mdash; if you are still prompted after committing the file, that is the reason, and the case above is the fix that does not depend on it.
            </p>
          </div>

          <div id="connector-case-chat" className="mb-3">
            <h5 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-1">
              Claude.ai chat and ChatGPT
            </h5>
            <p className="text-xs text-zinc-500 dark:text-zinc-500 leading-relaxed">
              Nothing to do. You approve the connector once in that product&rsquo;s own settings and it does not ask again per call &mdash; the two blocks above are Claude Code&rsquo;s file format and have no effect there.
            </p>
          </div>

          <p className="text-xs text-zinc-500 dark:text-zinc-500 leading-relaxed">
            Reads only. Anything that acts on your behalf &mdash; filing a request, opening or advancing a proposal &mdash; still asks every time, on purpose. If the prompts continue, the connector is registered under a different name: check a tool name in your session and use that spelling in place of <code className="font-mono text-zinc-600 dark:text-zinc-400">usernode</code>.
          </p>
          {/*
              Read-only, and empty until Settings._renderConnectors() fills it:
              rendering it populated would mismatch hydration, and there is
              deliberately no control next to it that WRITES throttle state. A
              "show it again" button is a button for making the connector nag;
              opening a new chat is what arms the tip.
          */}
          <p id="connector-hint-status" className="hidden text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"></p>
        </div>
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
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
