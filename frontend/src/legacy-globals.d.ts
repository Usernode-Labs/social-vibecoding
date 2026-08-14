/**
 * The legacy globals React-owned regions still talk to.
 *
 * public/js/** is 50-odd classic scripts that each publish one object on
 * `window`; a converted region needs the same names, and #1079 chunk B moved
 * two of those modules INTO this bundle (features/notifications/
 * notifications.js and features/work-drawer/work-drawer.js) while keeping
 * their `window.X = X` publication so their remaining legacy callers — app.js,
 * app-view.js, dev-chat.js, home.js — keep working untouched.
 *
 * Declared loosely on purpose: these are untyped JS modules, and pretending
 * otherwise here would be a type that lies rather than a type that helps. Only
 * the members React code actually calls are named.
 */

export {};

declare global {
  /** What a kit presentation returns; `el` is the shell it built. */
  interface KitHandle {
    el?: HTMLElement | null;
    dismiss(): void;
  }

  /**
   * What every kit presentation takes. `contentEl` is REPARENTED into the
   * kit's shell — see lib/kit-surface.ts, which is the only thing in this
   * bundle that should be calling these directly.
   */
  interface KitSurfaceOpts {
    contentEl: HTMLElement;
    onDismiss?: () => void;
    [key: string]: unknown;
  }

  interface Window {
    /** features/notifications/notifications.js */
    Notifications?: {
      init(): void;
      refresh(): Promise<void>;
      open: boolean;
      [key: string]: unknown;
    };
    /** features/work-drawer/work-drawer.js */
    WorkDrawer?: {
      init(): void;
      refresh(): Promise<void>;
      open: boolean;
      [key: string]: unknown;
    };
    /** features/settings/settings.js */
    Settings?: {
      init(): void;
      open(section?: string | null, opts?: unknown): void;
      [key: string]: unknown;
    };
    /** public/js/app.js — the shell's router. */
    App?: {
      currentApp?: string | null;
      user?: {
        id?: number;
        username?: string;
        avatarUrl?: string | null;
        [key: string]: unknown;
      } | null;
      eventsWs?: WebSocket | null;
      setBackIcon?(mode: 'home' | 'arrow', href?: string): void;
      setHeaderTitle?(title: string): void;
      [key: string]: unknown;
    };
    /**
     * public/js/platform-ui.js — the native-kit adapter.
     *
     * The three presentation calls are typed because `lib/kit-surface.ts`
     * dispatches on their names: `ui[kind]` has to be something better than
     * `unknown` for that lookup to be checkable at all. Each returns null
     * when the kit declines, which every caller has to handle — that is the
     * fall-through to the web presentation.
     *
     * `hasKit` is optional because the property predates the method: older
     * builds of the adapter shipped without it, and `kit-surface` feature-
     * detects rather than assuming. `isTouch` is not, because everything in
     * this repo has always called it unguarded.
     */
    PlatformUI?: {
      isTouch(): boolean;
      hasKit?(): boolean;
      modal?(opts: KitSurfaceOpts): KitHandle | null;
      sheet?(opts: KitSurfaceOpts): KitHandle | null;
      panel?(opts: KitSurfaceOpts & { side?: 'left' | 'right' }): KitHandle | null;
      pullToRefresh(el: Element, fn: () => Promise<unknown> | void): void;
      toast?(message: string): void;
      [key: string]: unknown;
    };
    /** features/header/node-pill.js */
    NodePill?: {
      init(): Promise<void>;
      [key: string]: unknown;
    };
    /** features/header/wallet-sheet.js */
    WalletSheet?: {
      init(): void;
      [key: string]: unknown;
    };
    /** features/header/native-app-version.js */
    NativeAppVersion?: {
      init(): void;
      refresh(): Promise<string | null>;
      [key: string]: unknown;
    };
    /**
     * features/header/header-menu-controller.js — the hamburger drawer's
     * open/close, and the app-scoped drawer rows' visibility. Both were
     * App.HeaderMenu / App.DrawerStatus in app.js, which now forwards onto
     * these so its own call sites (plus app-view.js, native-chrome.js,
     * node-pill.js, wallet-sheet.js) are untouched.
     */
    HeaderMenu?: {
      init(): void;
      open(): void;
      close(): Promise<void> | void;
      isPresenting(): boolean;
      consumeNavPending(): boolean;
      [key: string]: unknown;
    };
    /** features/header/header-menu-controller.js */
    DrawerStatus?: {
      setAppOpen(open: boolean): void;
      setForkVisible(visible: boolean): void;
      refreshDeployDot(): void;
      [key: string]: unknown;
    };
    /**
     * features/leaderboard/leaderboard.js — the Leaderboard screen's section
     * state. The island's tab strip reports a click back through
     * `_setSection`, which is what the strip's own innerHTML'd listener did.
     */
    Leaderboard?: {
      _setSection?(section: string): void;
      [key: string]: unknown;
    };
    /** public/js/app-view.js — the app screen. The dialogs read its appData. */
    AppView?: {
      appData?: { slug?: string; name?: string; url?: string; [key: string]: unknown } | null;
      [key: string]: unknown;
    };
    /** features/home/home.js — refreshed after app creation. */
    Home?: {
      load?(): void;
      [key: string]: unknown;
    };
    /** public/js/dev-host.js — maps container-local preview URLs for browsers. */
    resolveDevHost?: (url: string) => string;
    /**
     * features/dialogs/app-secrets-controller.js — the retired
     * public/js/app-secrets.js. Still published under this name because five
     * call sites in app-view.js reach it as `window.Secrets`.
     */
    Secrets?: {
      open(slug: string, opts?: { declare?: boolean }): void;
      close(): void;
      [key: string]: unknown;
    };
    /**
     * features/dialogs/screenshot-select.js — the retired
     * public/js/screenshot-select.js. The feedback dialog gates its attach
     * button on `isSupported()`, exactly as it did when this was a tag.
     */
    ScreenshotSelect?: {
      isSupported(): boolean;
      start(opts?: unknown): Promise<{ blob: Blob; contentType: string }>;
      [key: string]: unknown;
    };
    /**
     * The bridge this bundle publishes for `public/js/**` to call back into.
     * `dialogs` is #1078 chunk I's addition: one entry per shell dialog,
     * registered by `useDialog`, so the legacy open/close entry points drive
     * React state instead of writing `hidden` themselves.
     */
    UsernodeReact?: {
      dialogs?: Record<
        string,
        { isOpen(): boolean; open(payload?: unknown): void; close(): void } | undefined
      >;
      messages?: {
        open(conversationId?: number | null): void;
        route(conversationId?: number | null): void;
        close(): void;
        isOpen(): boolean;
        handleBack(): boolean;
        syncChrome(): void;
        handleEvent(event: Record<string, unknown>): void;
        share(reference?: unknown): Promise<void> | void;
        refresh(): Promise<void> | void;
      };
      [key: string]: unknown;
    };
    /** features/dev-chat/dev-chat.js — sanitized Markdown renderer. */
    DevChat?: {
      renderMarkdown(text: string, opts?: { breaks?: boolean; images?: boolean }): string;
      [key: string]: unknown;
    };
    /** The inline head-blocking theme module in src/head.html. */
    Theme?: {
      get(): 'light' | 'dark' | 'system';
      set(mode: string): void;
      apply(): void;
      onChange(fn: (mode: string) => void): void;
    };
  }
}
