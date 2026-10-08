import { Button } from '@/components/ui/button';
import { useMessages } from '../../lib/i18n/react';
import { CliSetupGuide } from '../settings/cli-setup-guide';

export interface OwnToolsGuideView {
  prompt: string;
  resumeHtml: string;
  canImport: boolean;
}

/** The same setup card as Settings, with this session's brief and context. */
export function OwnToolsGuide({ view }: { view: OwnToolsGuideView }) {
  const t = useMessages('devchat');
  return (
    <div className="dc-launchpad" data-launchpad="own-tools-pr">
      {view.resumeHtml ? <div dangerouslySetInnerHTML={{ __html: view.resumeHtml }} /> : null}
      <CliSetupGuide
        id="dc-cli-setup-guide"
        proposalPrompt={view.prompt}
        promptHelp={t('devchat:ownTools.promptHelp')}
      />
      {view.canImport ? (
        <div className="px-4 pb-4 text-xs text-zinc-500 dark:text-zinc-400">
          <p>{t('devchat:ownTools.alreadyBuilt')}</p>
          <Button
            type="button" size="sm" variant="neutral" className="mt-2"
            data-launchpad-action="import"
            onClick={() => window.DevChat?._importOwnToolsPr()}
          >{t('devchat:ownTools.import')}</Button>
        </div>
      ) : null}
    </div>
  );
}
