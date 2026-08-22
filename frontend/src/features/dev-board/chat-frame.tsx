/**
 * The Dev general-chat sub-view's frame, converted from
 * `AppView._renderChatSubView()`'s `innerHTML` template (#1084 chunk G).
 *
 * A slim back-button header above the existing chat pane.
 * `AppView.renderGroupChatTab()` still mounts into `#dev-chat-body` exactly as
 * it used to mount into the pinned pane — spec side-panel, autocomplete, drafts
 * and scroll restore all unchanged — so `#dev-chat-body` is a legacy-owned host
 * and React renders it as an empty leaf and never looks inside it again.
 *
 * `#dev-chat-back` stays a real `<a href>` (#1036), so a modified click is left
 * to the browser and only a plain click is intercepted. The `href` is computed
 * by `AppView._devPageHref()` and passed in rather than derived here: it depends
 * on `App.currentApp` and the self-app's hash-routing rules, which are the
 * router's business, not this component's.
 */

export interface DevChatSubViewProps {
  /** `AppView._devPageHref()`. */
  backHref: string;
  /**
   * Plain-click handler. The caller keeps the `NavLink.isNativeClick(e)` guard
   * and the `App.switchTab('dev')` call, so the behaviour is the template's.
   */
  onBackClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}

export function DevChatSubView({ backHref, onBackClick }: DevChatSubViewProps) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <a
          id="dev-chat-back"
          className="inline-flex items-center un-touch-target text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-sm"
          title="Back to the dev page"
          href={backHref}
          onClick={onBackClick}
        >
          &larr;
        </a>
        <span className="text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">
          General chat
        </span>
      </div>
      <div id="dev-chat-body" className="flex-1 min-h-0"></div>
    </div>
  );
}
