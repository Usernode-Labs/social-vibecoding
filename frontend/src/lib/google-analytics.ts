/**
 * Homeroom's Google Analytics tag (#6314), on the live shell only.
 *
 * The tag itself runs in public/analytics-frame.html, never in this page: see
 * that file for why. This module decides what the frame hears:
 *
 *   - page views, as a cleaned path (analyticsPath): the screen, and for an
 *     app its slug. An app opens inside the shell, so this is how every app
 *     is counted. No script goes into an app, whose address holds its sign-in
 *     token. In-app pages are not seen.
 *   - sign_up, once, when /api/auth/me says the account is new.
 *
 * Never an account number: Google counts visits, not people. Whether a
 * visit is counted at all is `analyticsCounted`: false for service accounts,
 * for people who chose Leave me out in Settings > Privacy, and for people who
 * objected to being recorded, who send nothing but a sign_up.
 *
 * Only `app.onhomeroom.com` runs it, so previews, checks, shots and local
 * builds load nothing from Google.
 */

const LIVE_HOST = 'app.onhomeroom.com';
const FRAME_PATH = '/analytics-frame.html';
const SIGN_UP_SENT_KEY = 'hr_ga_sign_up_sent';

// Screens named by their first segment. Anything else (a sign-in link, an
// invite, a screen added later) is reported as /other, not as what it says.
const SCREENS = new Set([
  'home', 'discover', 'messages', 'homeroom-bot', 'communities', 'workshop',
  'settings', 'profile', 'wallet', 'leaderboard', 'notifications', 'admin',
  'login', 'signup', 'waitlist',
]);
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The only description of an address that ever leaves this page. */
export function analyticsPath(pathname: string, hash: string): string {
  const fromHash = String(hash || '').replace(/^#\/?/, '');
  const route = (fromHash || String(pathname || '').replace(/^\/+/, '')).split(/[?&#]/)[0];
  const [first, second] = route.split('/');
  if (!first) return '/';
  if (first === 'app') return SLUG.test(second || '') ? `/app/${second}` : '/other';
  return SCREENS.has(first) ? `/${first}` : '/other';
}

type SessionUser = {
  id?: unknown;
  analyticsCounted?: unknown;
  justSignedUp?: unknown;
};

export function installGoogleAnalytics(host: any = globalThis) {
  const api = { setSession: (_user: SessionUser | null, _verified?: boolean) => {} };
  host.UsernodeReact = host.UsernodeReact || {};
  host.UsernodeReact.googleAnalytics = api;
  // The side panel's document is a second copy of the shell: the top one counts.
  if (host.location?.hostname !== LIVE_HOST || host.top !== host) return api;

  const doc = host.document;
  let frame: any = null;
  let ready = false;
  let queue: unknown[] = [];
  let reporting = false;
  let lastPath: string | null = null;

  const post = (message: unknown) => {
    if (ready) frame.contentWindow?.postMessage(message, host.location.origin);
    else queue.push(message);
  };
  const ensureFrame = () => {
    if (frame) return;
    frame = doc.createElement('iframe');
    frame.hidden = true;
    frame.title = '';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Without this, the frame's document.referrer is the shell's whole address.
    frame.referrerPolicy = 'no-referrer';
    frame.src = FRAME_PATH;
    doc.body.appendChild(frame);
  };
  const reportPage = () => {
    if (!reporting) return;
    const path = analyticsPath(host.location.pathname, host.location.hash);
    if (path === lastPath) return;
    lastPath = path;
    post({ type: 'page', path });
  };
  const startReporting = () => {
    ensureFrame();
    post({ type: 'on' });
    reporting = true;
    reportPage();
  };
  const stopReporting = () => {
    reporting = false;
    lastPath = null;
    if (frame) post({ type: 'off' });
  };
  const sendSignUpOnce = (id: unknown) => {
    const key = `${SIGN_UP_SENT_KEY}:${id}`;
    try {
      if (host.localStorage.getItem(key)) return;
      host.localStorage.setItem(key, '1');
    } catch { return; } // Unrecorded, it could be counted on every load.
    ensureFrame();
    post({ type: 'on' });
    post({ type: 'sign_up' });
  };

  host.addEventListener('message', (event: any) => {
    if (event.origin !== host.location.origin || !frame || event.source !== frame.contentWindow) return;
    if (event.data?.type !== 'homeroom-analytics-ready') return;
    ready = true;
    const waiting = queue;
    queue = [];
    waiting.forEach(post);
  });
  host.addEventListener('hashchange', reportPage);
  host.addEventListener('popstate', reportPage);

  api.setSession = (user, verified = true) => {
    if (!user) {
      startReporting();
      return;
    }
    // A remembered session has no answer from the server yet: wait for it.
    if (!verified) return;
    if (user.justSignedUp === true) sendSignUpOnce(user.id);
    if (user.analyticsCounted === true) startReporting();
    else stopReporting();
  };
  return api;
}
