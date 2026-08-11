import { Field, SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * Agent instructions & skills (issue #460). Per-user global files the coding
 * agent loads on every build/scout run this user dispatches, in any app:
 * instruction files are assembled into the worker's ~/.claude/CLAUDE.md,
 * skills land in ~/.claude/skills/. Rendered by
 * Settings._renderAgentFilesSection() on modal open from
 * GET /api/me/agent-files (?demo=1 passthrough in staging, since
 * user_agent_files is staging:private).
 *
 * The pending-upload form is where the `Field` primitive earns its keep: two
 * labels that WRAP their control rather than pointing at it, one of them
 * carrying an id and a capability-independent `hidden` of its own (it is
 * revealed only for skills, which take a description).
 */
export function AgentFilesSection() {
  return (
    <div data-settings-section="agent-files" className="hidden">
      <div id="agent-files-section">
        <SectionHeading title={<>Agent instructions &amp; skills</>}>
          Personal files the coding agent follows on every build or spec run you start, in any app. Markdown or plain text only, up to 10 of each kind, 48&nbsp;KB per file. Changes apply from your next run.
        </SectionHeading>
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              Instructions
            </h4>
            <button
              data-agent-files-upload="instruction"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Upload
            </button>
          </div>
          <div id="agent-files-instructions-list" className="space-y-1.5">
          </div>
        </div>
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1.5">
            <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              Skills
            </h4>
            <button
              data-agent-files-upload="skill"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Upload
            </button>
          </div>
          <div id="agent-files-skills-list" className="space-y-1.5">
          </div>
        </div>
        {/*
            The hidden file picker, not a field: no box, no ring, nothing the
            Input primitive has to say about it.
        */}
        <input
          id="agent-files-input"
          type="file"
          accept=".md,.txt,text/markdown,text/plain"
          className="hidden"
        />
        {/*
            Pending-upload form: revealed after a file is picked so the
            user can adjust the (slugified) name and, for skills, the
            one-line description before saving.
        */}
        <div
          id="agent-files-form"
          className="hidden rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 mt-2 text-xs"
        >
          <div id="agent-files-form-title" className="font-medium text-zinc-700 dark:text-zinc-300 mb-2">
          </div>
          <Field className="mb-2" label="Name">
            <Input
              id="agent-files-name"
              type="text"
              maxLength={64}
              spacing="mt1"
              box="inset"
              mono
              ring={false}
              text
            />
          </Field>
          <Field id="agent-files-desc-wrap" className="mb-2" startHidden label="Description">
            <Input
              id="agent-files-desc"
              type="text"
              maxLength={200}
              placeholder="One line: what this skill does"
              spacing="mt1"
              box="inset"
              ring={false}
              text
            />
          </Field>
          <div className="flex gap-2">
            <button
              id="agent-files-save"
              className="rounded bg-violet-600 hover:bg-violet-500 px-3 py-1 font-medium text-white transition-colors"
            >
              Save
            </button>
            <button
              id="agent-files-cancel"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
        <StatusLine id="agent-files-status" />
      </div>
    </div>
  );
}
