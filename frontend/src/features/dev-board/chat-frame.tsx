/**
 * The Dev general-chat sub-view's frame — the ACTIVITY screen's chassis
 * (Streamlined Concept).
 *
 * It carried a "← General chat" back bar once; Activity is a first-class
 * destination now (`#app/<slug>/activity`, a row of the Improve panel), so
 * there is nothing to go back FROM — only a screen to name.
 *
 * That name used to be a 10px subtitle inside the header chip. It is the
 * screen bar's now (features/shell/screen-bar.tsx), which is the whole of
 * this frame's chrome: Activity has no actions of its own, so the bar is the
 * heading and nothing else, exactly as the board draws it.
 *
 * `AppView.renderGroupChatTab()` still mounts into `#dev-chat-body` exactly as
 * it always did — spec side-panel, autocomplete, drafts and scroll restore all
 * unchanged — so React renders it as an empty leaf and never looks inside it
 * again.
 */

import { ScreenBar } from '../shell/screen-bar';

export function DevChatSubView() {
  return (
    <div className="flex flex-col h-full min-h-0">
      <ScreenBar title="Activity" />
      <div id="dev-chat-body" className="flex-1 min-h-0"></div>
    </div>
  );
}
