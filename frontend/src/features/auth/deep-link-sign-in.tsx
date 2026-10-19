/**
 * A shared link opened while signed out (#5264): the landing's sign-in sheet
 * (./sign-in-sheet.tsx), titled for the place the link was for, over a
 * blurred stand-in for that page.
 *
 * The router (App.restoreFromHash) remembers the address for after the
 * sign-in (AuthScreens.rememberDeepLink, the same `_pendingHash` that
 * AuthScreens.finishLogin restores) and hands it to the landing
 * (AuthScreens.showSignInFor), which opens this sheet as it shows. It used to
 * answer every such link with the full-page "Sign in" form, which said
 * nothing of where the link led.
 *
 * Why the page behind is a stand-in rather than the page itself: everything
 * a signed-in screen draws comes from an API that answers 401 to a visitor
 * with no session, so the real page has nothing to show. A quiet, blurred
 * outline of a page (a header and a few cards) on the home wallpaper takes
 * its place, so the sheet still reads as standing over something.
 */

/** The places a link can name that the sheet names back. */
export type DeepLinkScreen = 'discover' | 'messages' | 'communities' | 'notifications' | 'settings';

export type DeepLinkPlace =
  | { kind: 'screen'; screen: DeepLinkScreen }
  | { kind: 'project'; slug: string }
  | { kind: 'page' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

const SCREEN_FOR_HEAD: Readonly<Record<string, DeepLinkScreen>> = Object.freeze({
  apps: 'discover',
  discover: 'discover',
  messages: 'messages',
  chat: 'messages',
  communities: 'communities',
  workshop: 'communities',
  notifications: 'notifications',
  settings: 'settings',
});

/**
 * The route a remembered address names: a fragment (`#apps`,
 * `#app/<slug>/board`) or a clean app path (`/app/<slug>/board?x=1`), the two
 * shapes App._deepLinkTarget gives. Any query is dropped.
 */
function routeOf(target: string): string {
  const raw = String(target || '');
  let route = '';
  if (raw.startsWith('#')) route = raw.slice(1);
  else if (raw.startsWith('/app/')) route = raw.slice(1);
  return route.split('?')[0];
}

/** Which place a remembered address is for, read off its first segments. */
export function deepLinkPlace(target: string): DeepLinkPlace {
  const parts = routeOf(target).split('/');
  const head = parts[0] || '';
  if (head === 'app' && parts[1]) {
    let slug = '';
    try { slug = decodeURIComponent(parts[1]); } catch { slug = ''; }
    return SLUG_RE.test(slug) ? { kind: 'project', slug } : { kind: 'page' };
  }
  const screen = Object.prototype.hasOwnProperty.call(SCREEN_FOR_HEAD, head) ? SCREEN_FOR_HEAD[head] : null;
  return screen ? { kind: 'screen', screen } : { kind: 'page' };
}

/**
 * Where Apple's or Google's trip comes back to: the same page, so a sign-in
 * there lands on it too. A fragment comes back on `/`, an app path as
 * itself; the server takes only those shapes and answers anything else with
 * Home (services/sign-in-providers.js safeReturnTo).
 */
export function deepLinkReturnTo(target: string): string {
  const raw = String(target || '');
  if (raw.startsWith('#') && raw.length > 1) return '/' + raw;
  if (raw.startsWith('/app/')) return raw.split('?')[0];
  return '/';
}

/** The sheet's title for that place. Each one is a whole message. */
export function deepLinkTitle(
  place: DeepLinkPlace,
  projectName: string | null,
  t: (id: string, params?: Record<string, unknown>) => string,
): string {
  if (place.kind === 'project') {
    return projectName
      ? t('auth:deepLinkSignIn.project', { project: projectName })
      : t('auth:deepLinkSignIn.someProject');
  }
  if (place.kind === 'screen') {
    switch (place.screen) {
      case 'discover': return t('auth:deepLinkSignIn.discover');
      case 'messages': return t('auth:deepLinkSignIn.messages');
      case 'communities': return t('auth:deepLinkSignIn.communities');
      case 'notifications': return t('auth:deepLinkSignIn.notifications');
      case 'settings': return t('auth:deepLinkSignIn.settings');
      default: break;
    }
  }
  return t('auth:deepLinkSignIn.page');
}

/**
 * The page behind the sheet: an outline of a screen, blurred, on the home
 * wallpaper. Under the sheet's own dim (z-50) and over the landing's story,
 * so the story does not show through while the sheet is up.
 */
export function DeepLinkBackdrop() {
  const card = 'rounded-[20px] bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900';
  return (
    <div
      aria-hidden="true"
      data-deep-link-backdrop=""
      className="fixed inset-0 z-[45] touch-none overflow-hidden"
      style={{ background: 'var(--home-wallpaper)' }}
    >
      <div className="mx-auto flex h-full max-w-2xl flex-col gap-4 px-4 pt-[max(1rem,env(safe-area-inset-top))] opacity-80 blur-md">
        <div className="flex items-center gap-3 py-2">
          <div className="h-9 w-9 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <div className="h-5 w-40 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        <div className={`${card} h-40`} />
        <div className="h-3 w-24 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        <div className={`${card} h-56`} />
        <div className={`${card} h-32`} />
      </div>
    </div>
  );
}
