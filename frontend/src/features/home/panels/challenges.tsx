/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
 *
 * ── A PLATE OF CARDS, not a card of rows ──────────────────────────────
 *
 * It was one white card of 56px divided rows. The homescreen design draws it
 * as the reference does: one tinted card per challenge — art, title, and a
 * white pill holding its state — on a plate that holds them and the season
 * summary together.
 *
 * THE PLATE IS TRANSLUCENT, and that is the whole reason it exists rather
 * than being nothing. Cards alone on the wallpaper read as four unrelated
 * things; the white card the block used to be reads as one thing but covers
 * the wallpaper exactly where the page is tallest. At 55% the grouping reads
 * and the washes carry on through (`.home-challenges-plate` in app.css).
 *
 * ── The pill, and what is on it ───────────────────────────────────────
 *
 * Every card carries the same pill: state, how long the SEASON has left, and
 * the reward. The deadline is on all of them rather than stated once beside
 * the ring, because a pill that changes shape between challenges reads as two
 * kinds of thing; it is the same sentence on each because it is one fact
 * about the season, which is also how the design draws it.
 *
 * THE METER HUGS THE PILL'S BOTTOM EDGE, inset to the pill's own padding.
 * Run to the edge instead, the pill's radius eats the low end — and the low
 * end is the case that most needs to be visible. Which is also why the fill
 * is `max(10px, pct%)`: a challenge at 0 of 5 shows a stub of the track's
 * colour, so "not started" reads as a track not yet run rather than as no
 * track at all.
 *
 * A YES-OR-NO CHALLENGE DRAWS NO METER, and this reverses #911 on purpose.
 * That change gave every row a two-state track so the list would not be
 * mixed — some rows with progress, some with a hole where progress would be.
 * The hole was a property of the ROW: a reserved lane with nothing in it. A
 * card's pill has no reserved lane, so a binary challenge simply has a pill
 * without a bar under it, and its ✓ says the whole of what there is to say.
 *
 * ── The standings preview is GONE ─────────────────────────────────────
 *
 * A block of leaderboard rows used to sit under the challenges. It is
 * removed: this area is called Challenges, and a second list with its own
 * label inside one card made the reader work out which list they were looking
 * at before they could read either. The way to the standings is one tap from
 * here — "Open leaderboard", in this section's own heading, which renders in
 * every branch including the between-seasons one.
 */

import { ProgressRing } from '@/components/ui/progress-ring';
import type { ChallengeRowView, ChallengesView, SeasonView } from '../panels-store';
import { PanelFooter, PanelShell, panels, tintOf } from './ui';

/**
 * The ring and the season's two numbers, at the top of the plate.
 *
 * It replaces the "· 1 of 6 · 3,900 pts left" that rode the section heading,
 * where at 12px after the area's name and its link it pushed the label into
 * an ellipsis on a phone. As a ring it is content: the first thing on the
 * plate, stating the one fact the block exists to state.
 *
 * The ring itself is `@/components/ui/progress-ring` — the geometry, the
 * twelve-o'clock start and the zero case all live there, because it is a
 * shape of the language rather than of this block, and because a raw SVG
 * element under `features/**` is a glyph that escaped icons.tsx as far as
 * tests/shell-icon-set.test.js is concerned; that scanner is a plain search
 * for the opening tag, comments included, so this sentence spells the tag out
 * in words rather than tripping the rule it is describing.
 *
 * NO PLATE OF ITS OWN. It sits directly on the block's plate rather than in a
 * card, so the four tinted cards below are the only card-shaped things here
 * and the summary reads as their caption.
 */
function SeasonRing({ view }: { view: SeasonView }) {
  return (
    <div className="home-panel-season flex items-center gap-2.5 px-1 pb-2.5 pt-0.5">
      <ProgressRing pct={view.pct} label={view.fraction} title={view.label} />
      <div className="min-w-0">
        <div className="truncate whitespace-nowrap text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
          {view.lead}
        </div>
        {view.sub ? (
          <div className="truncate whitespace-nowrap text-[12.5px] leading-tight text-zinc-500 dark:text-zinc-400">
            {view.sub}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One challenge card:
 *
 *   ┌──────┐  Suggest 3 changes
 *   │ art  │  ( ○  7 days left        500 pts )
 *   └──────┘    ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░
 *
 * The well holds the challenge's ICON, set on its KIND (`challenge_kinds.icon`
 * — the controlled vocabulary a template already points at, so one setting
 * gives every challenge of that kind the same face, which is what makes a
 * column of cards scannable rather than a column of different drawings).
 *
 * With no icon it falls back to the CATEGORY word, which is the only other
 * per-challenge mark there is — never to a decorative emoji hashed out of the
 * row, which would be a picture that means nothing sitting where the design
 * puts a picture that means something. The word gets its own class because it
 * needs what a glyph does not: a single long category ("ONBOARDING") is one
 * unbreakable word wider than a 62px well, so `.home-challenge-art-word` lets
 * it break and clamps it to two lines.
 *
 * The state well is the ✓/○ INSIDE the pill rather than beside the title,
 * which is what lets the title start at the same x on every card whether or
 * not the challenge is done.
 */
function ChallengeCard({ row, deadline }: { row: ChallengeRowView; deadline: string | null }) {
  const { meter } = row;
  return (
    <div
      className={`home-challenge-card ${tintOf(String(row.id))} flex items-center gap-3 p-2.5 cursor-pointer`}
      data-challenge-id={row.id}
      title={row.tip}
      onClick={() => panels()?.goToChallenges?.()}
    >
      {row.icon ? (
        <span
          className="home-challenge-art shrink-0 w-[3.875rem] h-[3.875rem] rounded-xl flex items-center justify-center text-[2rem] leading-none"
          aria-hidden="true"
        >
          {row.icon}
        </span>
      ) : (
        <span className="home-challenge-art home-challenge-art-word shrink-0 w-[3.875rem] h-[3.875rem] rounded-xl flex items-center justify-center px-1 text-center text-[9px] font-semibold uppercase leading-tight text-zinc-500 dark:text-zinc-400">
          {row.label}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="home-panel-goal truncate whitespace-nowrap text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
          {row.goal}
        </div>
        {/*
            SYMMETRIC PADDING. It was `pt-1.5 pb-2.5` — 4px of extra room
            along the bottom, left over from when the meter was a 3px rail
            flush with the pill's bottom edge and the text had to clear it.
            The meter is the capsule at the left now, so that clearance has
            nothing to clear: it just pushed the state, the deadline and the
            reward above the pill's centre. `py-2` keeps the pill exactly as
            tall as it was — 16px of vertical padding either way — and puts
            its contents in the middle of it.
        */}
        <div className="home-challenge-pill relative overflow-hidden mt-1.5 flex items-center gap-2 px-2.5 py-2">
          {meter.binary ? (
            /*
                A YES-OR-NO CHALLENGE IS A CIRCLE, and only that. It has no
                progress to draw, so the ○/✓ is the whole of its state — and
                the shape difference is what tells it apart at a glance from
                the capsule beside it in the list.
            */
            row.done ? (
              <span
                className="home-panel-glyph shrink-0 w-4 h-4 rounded-full flex items-center justify-center bg-emerald-500 text-white text-[10px] leading-none"
                aria-hidden="true"
              >
                ✓
              </span>
            ) : (
              <span
                className="home-panel-glyph shrink-0 w-4 h-4 rounded-full border-[1.5px] border-zinc-400 dark:border-zinc-500"
                aria-hidden="true"
              />
            )
          ) : (
            /*
                A COUNTED ONE IS A CAPSULE THAT FILLS, and it carries all three
                things the state used to need three elements for: how far
                along, the exact count, and whether it is done. The bar that
                used to ride the pill's bottom edge is gone with it — one
                element in the pill, not one in the pill and a rule under it.
                Same height as the circle, so the two line up down the list.

                THE FILL IS A TINT of the accent blue, not the solid colour
                and not brand ink. The count sits ON the capsule, so a solid
                fill would hide it the moment progress passed the text; and
                brand ink — a deep navy — at a tint strength composites to a
                blue-grey that read as "track, slightly darker" rather than as
                progress. app.css states the opacity and the contrast it has
                to keep.
            */
            <span
              className="home-panel-bar-track home-challenge-meter relative shrink-0 inline-flex h-4 items-center justify-center overflow-hidden rounded-full bg-black/10 dark:bg-white/15"
              role="progressbar"
              aria-valuenow={meter.current}
              aria-valuemin={0}
              aria-valuemax={meter.target}
              aria-label={`${row.goal || 'Challenge'}: ${meter.current} of ${meter.target}${meter.label}`}
            >
              <span
                className={row.done
                  ? 'home-panel-bar-fill home-challenge-meter-fill absolute inset-y-0 left-0 bg-emerald-500'
                  : 'home-panel-bar-fill home-challenge-meter-fill absolute inset-y-0 left-0 bg-violet-500'}
                // A FLOOR, not a bare percentage: a challenge at 0 of 5 shows
                // a short nub rather than an empty capsule, because "not
                // started" still has to read as a track with something to
                // fill. It is a design minimum and a deliberately small one —
                // app.css says why, including the clipping argument that used
                // to be given for it and is wrong for this shape.
                style={{ width: `max(var(--home-meter-floor), ${meter.pct}%)` }}
              />
              <span
                className={row.done
                  ? 'relative px-1.5 text-[10.5px] font-semibold leading-none text-emerald-800 dark:text-emerald-200'
                  // violet-900 / -100 (read the hex — that scale is the
                  // shell's blue), not brand ink. The count has to clear 4.5:1
                  // on the FILLED half as well as the empty one, and brand ink
                  // on the tint measured 4.47 — close enough to be arguable,
                  // which is not a place to leave small bold type. These clear
                  // 5.5:1 filled and 8.8:1 unfilled, and they let the fill keep
                  // its full strength rather than dimming the blue to make the
                  // numeral fit.
                  : 'relative px-1.5 text-[10.5px] font-semibold leading-none text-violet-900 dark:text-violet-100'}
              >
                {`${meter.current}/${meter.target}`}
              </span>
            </span>
          )}
          {/*
              The SEASON's deadline, on every card. Null only when the payload
              carries no end date, and then the pill simply has a gap where the
              sentence goes rather than inventing one.
          */}
          <span className="flex-1 min-w-0 truncate whitespace-nowrap text-[12.5px] text-zinc-600 dark:text-zinc-400">
            {deadline || ''}
          </span>
          {/*
              whitespace-nowrap on the reward is load-bearing: it is organiser
              prose and multi-word ("Up to 6,500 pts"), so without it a tight
              pill wraps it to a second line.
          */}
          {row.reward ? (
            <span className="shrink-0 whitespace-nowrap text-[12.5px] font-semibold text-zinc-700 dark:text-zinc-200">
              {row.reward}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (!view.rows.length) {
    return (
      <PanelShell panelKey={view.key} expanded={false} plate="soft" stamps={{ rows: 0 }}>
        <div className="home-panel-body">
          <p
            className="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
            title="Go to the Challenges tab on the Leaderboard screen"
            onClick={() => panels()?.goToChallenges?.()}
          >
            No challenges are running right now
          </p>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      plate="soft"
      stamps={{ rows: view.rows.length }}
      footer={<PanelFooter panelKey={view.key} total={view.total} expanded={view.expanded} />}
    >
      {view.season ? <SeasonRing view={view.season} /> : null}
      <div className="home-panel-body">
        <div className="home-panel-rows flex flex-col gap-2">
          {view.rows.map((row) => (
            <ChallengeCard
              key={row.id}
              row={row}
              deadline={view.season ? view.season.deadline : null}
            />
          ))}
        </div>
      </div>
    </PanelShell>
  );
}
