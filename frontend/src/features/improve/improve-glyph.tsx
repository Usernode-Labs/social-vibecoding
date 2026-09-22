/**
 * #improve-btn-glyph — what is happening to the build, as one 16px mark.
 *
 * It was the leading glyph of `#improve-btn`, the header pill that opened the
 * Improve panel. #2718 retired that pill — the header's right group is the
 * bell and the Homeroom mark now, and the panel opens from a row of the mark's
 * menu (`#app-menu-row-improve`) — so the glyph moved to that row's leading
 * edge, which is where a menu row's icon goes anyway.
 *
 * The id, the three states and the `data-state` attribute are unchanged,
 * because they are what a declared check selects on to prove a landed build
 * offers its reload.
 *
 * ── What the three states say ──────────────────────────────────────────
 *
 *   lightbulb — nothing in flight; the row is an invitation
 *   spinner   — this app or the platform is building or downloading a build
 *   refresh   — a new build is here, the platform's or this app's own, and
 *               the panel offers the reload
 *
 * ── The cost of the move, stated ───────────────────────────────────────
 *
 * On the header pill this glyph was visible at rest, on every route. In a menu
 * row it is visible only once the menu is open, so the build state loses its
 * at-rest cue and `../header/platform-mark.tsx` does NOT put it back as a
 * third dot on the mark — see the note there on why two corners is the whole
 * budget.
 *
 * That is an acceptable loss and the reason is what the two states actually
 * are: "building" and "ready to reload" are both OFFERS THE PANEL MAKES, and
 * neither is time-critical the way an unsent draft or a running turn is.
 * Where it is closest to time-critical — this app's own build landing while
 * you are looking at the app — the dev board already says so on screen.
 *
 * It is worth knowing this glyph has eaten a dot before: `#improve-version-dot`
 * was retired (#1610) for saying in 8px of colour what this says in shape.
 * That argument ran the other way round — one cue, the better one, wins — and
 * it is the same argument here.
 */

import { ArrowPathIcon, LightBulbIcon, SpinnerArcIcon } from '@/components/ui/icons';

const BUSY_STATES = ['deploying', 'downloading'];
const READY_STATES = ['ready', 'failed'];

export function ImproveGlyph({ versionState, appDeploying, appUpdateReady }: {
  versionState: string;
  appDeploying: boolean;
  appUpdateReady: boolean;
}) {
  // `w-5 h-5` because this is a menu row's icon now, and the rows around it
  // are 20px. The wrapper cannot supply it: the row's icon span sizes its
  // DIRECT svg child (`[&>svg]:h-5 [&>svg]:w-5`) and `#improve-btn-glyph` sits
  // between the two, so the glyph states its own size exactly as it did at
  // 16px inside the header pill. `animate-spin` stays the caller's, per the
  // note on SpinnerArcIcon.
  const cls = 'w-5 h-5 shrink-0';
  if (appDeploying || BUSY_STATES.includes(versionState)) {
    return <span id="improve-btn-glyph" data-state="busy" className="contents">
      <SpinnerArcIcon className={`${cls} animate-spin`} aria-hidden="true" />
    </span>;
  }
  // A build of this app that landed is the same offer as a platform build
  // that is cached: the arrow, and the reload in the panel.
  if (appUpdateReady || READY_STATES.includes(versionState)) {
    return <span id="improve-btn-glyph" data-state="ready" className="contents">
      <ArrowPathIcon className={cls} aria-hidden="true" />
    </span>;
  }
  return <span id="improve-btn-glyph" data-state="idle" className="contents">
    <LightBulbIcon className={cls} aria-hidden="true" />
  </span>;
}
