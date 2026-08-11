/**
 * The shell's dialogs, one component per modal root.
 *
 * `Dialogs` renders all nine in the order Shell.tsx used to spell them out
 * inline. Order is load-bearing twice over: the prerendered public/index.html
 * is compared byte-for-byte against what the hand-written shell shipped, and
 * `tests/baselines/shell-markup.json` pins the id inventory that dapp.json's
 * declared checks select against.
 *
 * Every one of these is deliberately static — see any component's header for
 * why (PlatformUI.adoptStaticModal moves their cards out of the DOM at open
 * time, so a React re-render of the subtree would reconcile against the wrong
 * parent). #1078 chunk A converts the markup; the behaviour move needs the
 * adoption seam brought inside React first.
 */

import { CreateAppDialog } from './create-app';
import { RenameAppDialog } from './rename-app';
import { CloseIssueDialog } from './close-issue';
import { ForkAppDialog } from './fork-app';
import { ImportPrDialog } from './import-pr';
import { MembersDialog } from './members';
import { FeedbackDialog } from './feedback';
import { ShareDialog } from './share';
import { AppSecretsDialog } from './app-secrets';

export function Dialogs() {
  return (
    <>
      <CreateAppDialog />
      <RenameAppDialog />
      <CloseIssueDialog />
      <ForkAppDialog />
      <ImportPrDialog />
      <MembersDialog />
      <FeedbackDialog />
      <ShareDialog />
      <AppSecretsDialog />
    </>
  );
}

export {
  CreateAppDialog,
  RenameAppDialog,
  CloseIssueDialog,
  ForkAppDialog,
  ImportPrDialog,
  MembersDialog,
  FeedbackDialog,
  ShareDialog,
  AppSecretsDialog,
};
