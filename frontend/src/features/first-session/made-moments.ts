/**
 * The made screen's moments (newcomer run five, 13 Oct 2026): what the
 * screen after Make it (./made.tsx) first showed, what was tapped on it, and
 * the maker's tour after it (./index.tsx Tour), each told to the server as it
 * happens (POST /api/apps/:slug/first-version/moments,
 * src/services/first-session-moments.js, which names every kind). Run five
 * could only piece these together from screenshots.
 *
 * With the browser's own time (`clientAt`); the server keeps its receipt
 * time beside it. Sent and forgotten: never waited on and never retried, so
 * a moment that is lost is only a missing row, never a slower tap. Nothing
 * anybody typed goes: a kind, small counts and short codes.
 */

export type MadeMoment =
  | 'made_shown' | 'planning_shown' | 'questions_shown' | 'submit_tapped' | 'invite_shown'
  | 'share_invite_tapped' | 'invite_sent' | 'invite_later_tapped' | 'continue_tapped'
  | 'tour_started' | 'tour_step_shown' | 'tour_ended';

export type MomentDetail = {
  count?: number;
  step?: number;
  steps?: number;
  how?: 'after_questions' | 'again' | 'shared' | 'copied' | 'done' | 'skipped';
  entry?: 'first_session' | 'create';
};

/** Where a moment is sent. */
export function momentsUrl(slug: string): string {
  return `/api/apps/${encodeURIComponent(slug)}/first-version/moments`;
}

// The "shown" moments already sent from this page, so a screen drawn again
// (each poll redraws it) says each once.
const sentOnce = new Set<string>();

/** The body a moment is sent with. Pure. */
export function momentBody(kind: MadeMoment, detail: MomentDetail = {}, now: Date = new Date()): string {
  return JSON.stringify({ kind, clientAt: now.toISOString(), ...detail });
}

/**
 * Send one moment for the project `slug`. `once`: only the first time this
 * page sends it (with the same detail). Answers whether it was sent. Never
 * throws.
 */
export function noteMoment(slug: string | null | undefined, kind: MadeMoment, detail: MomentDetail = {}, { once = false }: { once?: boolean } = {}): boolean {
  if (!slug) return false;
  if (once) {
    const key = `${slug}\u0000${kind}\u0000${JSON.stringify(detail)}`;
    if (sentOnce.has(key)) return false;
    sentOnce.add(key);
  }
  try {
    void fetch(momentsUrl(slug), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: momentBody(kind, detail),
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** For the tests: forget what this page has sent once. */
export function resetMomentsForTests(): void {
  sentOnce.clear();
}
