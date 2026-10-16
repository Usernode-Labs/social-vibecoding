/**
 * The two fixed section hosts, and the state that decides what is in them.
 *
 * There were three. Create app was the third, below Challenges; it is the
 * launcher grid's trailing tile now (../create-tile.tsx, the prototype's
 * scrHome), so its host, its view model and its block went together.
 *
 * ── Why the hosts are the components ──────────────────────────────────
 *
 * `HomePanels.render()` used to do three things to each host: assign its
 * `innerHTML`, toggle `hidden` on it, and MIRROR the block's own state
 * attributes up onto it (`_stampState`). That third one existed because a
 * selector written the way the spec, the dapp.json checks and the screenshot
 * assertions write it —
 * `[data-panel-slot="create"][data-create-enabled="true"]` — asks for both
 * attributes on ONE element, and the block that knows the value is a child of
 * the host that carries the slot name.
 *
 * Rendering the host from React collapses all three into props, and the mirror
 * stops being a second pass over markup somebody else wrote: the same view
 * model feeds the host's attribute and the block's.
 *
 * ── `hidden` and the prerender ────────────────────────────────────────
 *
 * The hand-written shell shipped these sections WITHOUT `hidden`, empty. That
 * is what the prerendered document still contains and what the first client
 * render has to agree with, so `hidden` waits for `painted` — the flag that
 * separates "no render has happened yet" from "this render decided there is
 * nothing to show". Inferring it from a null block would put `hidden` on the
 * very first paint and mismatch hydration, which is a console error on #home
 * and a failed proposal check.
 */

import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { panelsStore, type HomePanelsState, type PanelStamps } from '../panels-store';
import { ChallengesPanel } from './challenges';
import { DiscoverPanel } from './discover';
import { BrowseLink, SectionHeading, SeeAllLink, stampProps } from './ui';

/**
 * One host. `slot` names WHICH block it is for — it rides along from the grid
 * cell each section replaces, and it is the hook everything outside the
 * feature already selects on.
 *
 * `label` is the area's name, drawn ABOVE the block (see `SectionHeading`).
 * This host is prerendered with its view null, and the first client render
 * has to agree with that document or hydration mismatches, which is a
 * console error on `#home` and a failed proposal check. So whatever the
 * heading draws BEFORE a view exists is a constant: Discover's label always
 * is, and Challenges' is "Challenges" with no link until its view arrives
 * (ChallengesSectionView below).
 *
 * The heading lives INSIDE the section, so a block with nothing to show takes
 * its label down with it rather than leaving a label over a gap.
 */
function Section({
  id, slot, label, action, painted, stamps, children,
}: {
  id: string;
  slot: string;
  label: string;
  action?: ReactNode;
  painted: boolean;
  stamps?: PanelStamps;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      data-panel-slot={slot}
      className={painted && !children ? 'hidden px-3 pb-3' : 'px-3 pb-3'}
      {...stampProps(stamps)}
    >
      <SectionHeading action={action}>
        {label}
      </SectionHeading>
      {children}
    </section>
  );
}

/**
 * The sections as pure functions of the whole state, and the store-connected
 * components that are all `<Shell/>` mounts.
 *
 * The split exists for the same reason `WidgetStripBody` is split from
 * `WidgetStrip`: tests/home-panels-render.test.js runs `HomePanels.render()`
 * in a vm and then renders what it pushed, and a component that reads the
 * bundle's own store through a hook cannot be handed a sandbox's state.
 */
export function DiscoverSectionView({ painted, discover }: HomePanelsState) {
  const t = useMessages('home');
  return (
    <Section
      id="home-discover-section"
      slot="discover"
      // #4184: the section names what its cards are. Only this heading: the
      // tab bar's "Discover", "Browse all apps" and the panel registry's
      // title keep their words. At 320px it ellipsises beside the link.
      label={t('home:discover.heading')}
      // CONSTANT, like the label: both are rendered in the prerender and by
      // the first client render, so neither can disagree with the document
      // the shell ships. Nothing here reads the view model — the ⋮ names its
      // block by key and the link goes to a fixed hash.
      action={<BrowseLink />}
      painted={painted}
      stamps={discover
        ? { featured: discover.featured.length, popular: discover.popular.length }
        : undefined}
    >
      {discover ? <DiscoverPanel view={discover} /> : null}
    </Section>
  );
}

// No mirrored attributes: `data-rows` describes the block's COMPOSITION and
// is selected on the article itself, which is where the string renderer put
// it too.
//
// THE HEADING NAMES WHAT THE BLOCK HOLDS: "First challenges", "Next
// challenges", or "Challenges" over its one line (HomePanels.challengesView),
// with "See all" beside it in every mode but "No challenges right now".
//
// WHY THIS CANNOT MISMATCH HYDRATION. The heading element is the same static
// `h2.home-area-label` in every state; only its text and its link follow the
// view, and both fall back to the prerender's own values while there is no
// view: "Challenges" and no link. The view is null in the prerender and stays
// null until HomePanels.render() pushes one after `/api/home-panels`
// answers, which is long after hydration, the same moment the cards under the
// heading appear. So the first client render draws exactly the document the
// shell ships, and the content-named heading is an ordinary update after it.
// It is also what the loading state looks like: "Challenges" with no link
// until the data lands. (The counter that once rode here was dropped with the
// season progress; see ./challenges.tsx.)
export function ChallengesSectionView({ painted, challenges }: HomePanelsState) {
  const t = useMessages('home');
  return (
    <Section
      id="home-challenges-section"
      slot="challenges"
      label={challenges ? challenges.heading : t('home:challenges.heading')}
      action={challenges?.seeAll ? <SeeAllLink /> : null}
      painted={painted}
    >
      {challenges ? <ChallengesPanel view={challenges} /> : null}
    </Section>
  );
}

export function DiscoverSection() {
  return <DiscoverSectionView {...useStoreState(panelsStore)} />;
}

export function ChallengesSection() {
  return <ChallengesSectionView {...useStoreState(panelsStore)} />;
}
