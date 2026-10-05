import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { Button } from '@/components/ui/button';

import { AgentFilesList } from '../agent-files-list';
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
        <SectionHeading title={<><Message id="settings:agent_instructions_skills_7c5c7975" /></>}><Message id="settings:personal_files_the_coding_agent_follows_on_every_0ac8544a" /></SectionHeading>
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"><Message id="settings:instructions_934652dc" /></h4>
            <button
              data-agent-files-upload="instruction"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            ><Message id="settings:upload_865e89de" /></button>
          </div>
          <div id="agent-files-instructions-list" className="space-y-1.5">
            <AgentFilesList
              kind="instruction"
              empty="No instruction files yet. Upload a markdown file to guide the coding agent on every build you start."
            />
          </div>
        </div>
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1.5">
            <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300"><Message id="settings:skills_66d0f523" /></h4>
            <button
              data-agent-files-upload="skill"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            ><Message id="settings:upload_865e89de" /></button>
          </div>
          <div id="agent-files-skills-list" className="space-y-1.5">
            <AgentFilesList
              kind="skill"
              empty="No skills yet. Upload a skill file the agent can use while building for you."
            />
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
          <Localized element={<Field className="mb-2" label={catalogText("settings:name_dcd1d522")}>
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
          </Field>} messages={{"label":"settings:name_dcd1d522"}} />
          <Localized element={<Field id="agent-files-desc-wrap" className="mb-2" startHidden label={catalogText("settings:description_526e0087")}>
            <Localized element={<Input
              id="agent-files-desc"
              type="text"
              maxLength={200} placeholder={catalogText("settings:one_line_what_this_skill_does_5e8fbb47")}
              spacing="mt1"
              box="inset"
              ring={false}
              text
            />} messages={{"placeholder":"settings:one_line_what_this_skill_does_5e8fbb47"}} />
          </Field>} messages={{"label":"settings:description_526e0087"}} />
          <div className="flex gap-2">
            <Button id="agent-files-save" variant="compact" size="xs"><Message id="settings:save_1509f561" /></Button>
            <Button id="agent-files-cancel" variant="outline" size="xs" ink="muted"><Message id="settings:cancel_19766ed6" /></Button>
          </div>
        </div>
        <StatusLine id="agent-files-status" />
      </div>
    </div>
  );
}
