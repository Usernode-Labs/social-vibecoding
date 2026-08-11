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
    /** public/js/app.js — the shell's router. */
    App?: {
      currentApp?: string | null;
      [key: string]: unknown;
    };
    /** public/js/platform-ui.js — the native-kit adapter. */
    PlatformUI?: {
      isTouch(): boolean;
      pullToRefresh(el: Element, fn: () => Promise<unknown> | void): void;
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
    /** The inline head-blocking theme module in src/head.html. */
    Theme?: {
      get(): 'light' | 'dark' | 'system';
      set(mode: string): void;
      apply(): void;
      onChange(fn: (mode: string) => void): void;
    };
  }
}
