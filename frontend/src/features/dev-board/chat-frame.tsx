/**
 * The Dev general-chat sub-view's frame — the ACTIVITY screen's chassis
 * (Streamlined Concept).
 *
 * It used to carry a "← General chat" back bar above the pane; Activity is a
 * first-class destination now (#app/<slug>/activity, an app-context sheet
 * row), the header's title tab names it, and the eye button is the way back
 * to the app — so the bar is gone and the frame is just the legacy-owned
 * host. `AppView.renderGroupChatTab()` still mounts into `#dev-chat-body`
 * exactly as it always did — spec side-panel, autocomplete, drafts and
 * scroll restore all unchanged — so React renders it as an empty leaf and
 * never looks inside it again.
 */

export function DevChatSubView() {
  return (
    <div className="flex flex-col h-full min-h-0 dc-lift dc-lift-strip">
      {/* app.css gives this host the 12px of strip shoulder that shows above
          the Discussion sheet ../group-chat/general-chat.tsx mounts here — the
          same band a Messages thread shows above its sheet. Its class string
          stays the empty-host one tests/dev-board-island.test.js pins. */}
      <div id="dev-chat-body" className="flex-1 min-h-0"></div>
    </div>
  );
}
