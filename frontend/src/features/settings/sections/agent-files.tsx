import { Button } from '@/components/ui/button';

import { AgentFilesList } from '../agent-files-list';
import { Field, SectionHeading, StatusLine } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

import { useMessages } from '../../../lib/i18n/react';
import { pressButton, returnKeyHandler } from '../../../lib/return-to-next';

/** Return in the pending-upload form's last field: Save, as a tap would press it. */
function saveAgentFile(): void {
  pressButton(document.getElementById('agent-files-save'));
}

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
 *
 * Return walks that form (#3907: the iOS keyboard's chevrons are gone): the
 * name goes on to the description when it is showing, and the last field
 * presses Save, the button settings.js wires. settings.js also sets the
 * name's `enterKeyHint` when it opens the form, since which one is last
 * depends on the kind.
 */
export function AgentFilesSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="agent-files" className="hidden">
      <div id="agent-files-section">
        <SectionHeading title={t('settings:agentFiles.title')}>
          {t('settings:agentFiles.intro')}
        </SectionHeading>
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {t('settings:agentFiles.instructions.heading')}
            </h4>
            <button
              data-agent-files-upload="instruction"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              {t('settings:agentFiles.instructions.upload')}
            </button>
          </div>
          <div id="agent-files-instructions-list" className="space-y-1.5">
            <AgentFilesList
              kind="instruction"
              empty={t('settings:agentFiles.instructions.empty')}
            />
          </div>
        </div>
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1.5">
            <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {t('settings:agentFiles.skills.heading')}
            </h4>
            <button
              data-agent-files-upload="skill"
              className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              {t('settings:agentFiles.skills.upload')}
            </button>
          </div>
          <div id="agent-files-skills-list" className="space-y-1.5">
            <AgentFilesList
              kind="skill"
              empty={t('settings:agentFiles.skills.empty')}
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
          onKeyDown={returnKeyHandler({ submit: saveAgentFile })}
        >
          <div id="agent-files-form-title" className="font-medium text-zinc-700 dark:text-zinc-300 mb-2">
          </div>
          <Field className="mb-2" label={t('settings:agentFiles.form.nameLabel')}>
            <Input
              id="agent-files-name"
              type="text"
              maxLength={64}
              enterKeyHint="next"
              spacing="mt1"
              box="inset"
              mono
              ring={false}
              text
            />
          </Field>
          <Field id="agent-files-desc-wrap" className="mb-2" startHidden label={t('settings:agentFiles.form.descriptionLabel')}>
            <Input
              id="agent-files-desc"
              type="text"
              maxLength={200}
              enterKeyHint="done"
              placeholder={t('settings:agentFiles.form.descriptionPlaceholder')}
              spacing="mt1"
              box="inset"
              ring={false}
              text
            />
          </Field>
          <div className="flex gap-2">
            <Button id="agent-files-save" variant="compact" size="xs">
              {t('core:common.save')}
            </Button>
            <Button id="agent-files-cancel" variant="outline" size="xs" ink="muted">
              {t('core:common.cancel')}
            </Button>
          </div>
        </div>
        <StatusLine id="agent-files-status" />
      </div>
    </div>
  );
}
