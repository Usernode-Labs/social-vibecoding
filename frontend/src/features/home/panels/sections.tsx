/**
 * The three fixed section hosts, and the state that decides what is in them.
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

import { useStoreState } from '../../../lib/use-store-state';
import { panelsStore, type HomePanelsState, type PanelStamps } from '../panels-store';
import { ChallengesPanel } from './challenges';
import { CreatePanel } from './create';
import { DiscoverPanel } from './discover';
import { BrowseLink, LeaderboardLink, PanelMenuButton, SectionHeading, stampProps } from './ui';

/**
 * One host. `slot` names WHICH block it is for — it rides along from the grid
 * cell each section replaces, and it is the hook everything outside the
 * feature already selects on.
 *
 * `label` is the area's name, drawn ABOVE the block (see `SectionHeading`).
 * It is a CONSTANT per section, never read off the view model: this host is
 * prerendered with `children` null, so anything data-derived in the heading
 * would differ between the built document and the first client render, which
 * is a hydration mismatch and a console error on `#home`. Data may still
 * appear beside it — `trailing` does exactly that for the challenges summary —
 * because its null state matches the prerender's by construction.
 *
 * The heading lives INSIDE the section, so a block with nothing to show takes
 * its label down with it rather than leaving a label over a gap.
 */
function Section({
  id, slot, label, trailing, action, painted, stamps, children,
}: {
  id: string;
  slot: string;
  label: string;
  trailing?: ReactNode;
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
        {trailing}
      </SectionHeading>
      {children}
    </section>
  );
}

/**
 * The three sections as pure functions of the whole state, and the three
 * store-connected components that are all `<Shell/>` mounts.
 *
 * The split exists for the same reason `WidgetStripBody` is split from
 * `WidgetStrip`: tests/home-panels-render.test.js runs `HomePanels.render()`
 * in a vm and then renders what it pushed, and a component that reads the
 * bundle's own store through a hook cannot be handed a sandbox's state.
 */
export function DiscoverSectionView({ painted, discover }: HomePanelsState) {
  return (
    <Section
      id="home-discover-section"
      slot="discover"
      label="Discover"
      // CONSTANT, like the label: both are rendered in the prerender and by
      // the first client render, so neither can disagree with the document
      // the shell ships. Nothing here reads the view model — the ⋮ names its
      // block by key and the link goes to a fixed hash.
      action={<><BrowseLink /><PanelMenuButton panelKey="discover" /></>}
      painted={painted}
      stamps={discover
        ? { featured: discover.featured.length, popular: discover.popular.length }
        : undefined}
    >
      {discover ? <DiscoverPanel view={discover} /> : null}
    </Section>
  );
}

// No mirrored attributes: `data-rows` / `data-fill` describe the block's
// COMPOSITION and are selected on the article itself, which is where the
// string renderer put them too.
export function ChallengesSectionView({ painted, challenges }: HomePanelsState) {
  return (
    <Section
      id="home-challenges-section"
      slot="challenges"
      label="Challenges"
      // "1 of 6 · 3,900 pts left" — the counter that used to ride the block's
      // own title, following the title out of the card. Null between seasons,
      // which is also its prerendered state.
      // SMALLER THAN THE NAME. The counter rode the block's own title at the
      // title's size, which was fine when the title had a bar to itself; in a
      // heading that also carries the block's controls, 15px of "· 1 of 6 ·
      // 3,900 pts left" pushed the whole label into an ellipsis on a phone.
      // 12px is the shell's caption size, it fits, and the hierarchy it makes
      // — the area's NAME, then how far through it you are — is the right one.
      trailing={challenges?.summary
        ? <span className="whitespace-nowrap text-[12px]">{` \u00b7 ${challenges.summary}`}</span>
        : null}
      action={<><LeaderboardLink /><PanelMenuButton panelKey="challenges" /></>}
      painted={painted}
    >
      {challenges ? <ChallengesPanel view={challenges} /> : null}
    </Section>
  );
}

export function CreateSectionView({ painted, create }: HomePanelsState) {
  return (
    <Section
      id="home-create-section"
      slot="create"
      label="Create app"
      painted={painted}
      stamps={create ? { createEnabled: create.canCreate } : undefined}
    >
      {create ? <CreatePanel view={create} /> : null}
    </Section>
  );
}

export function DiscoverSection() {
  return <DiscoverSectionView {...useStoreState(panelsStore)} />;
}

export function ChallengesSection() {
  return <ChallengesSectionView {...useStoreState(panelsStore)} />;
}

export function CreateSection() {
  return <CreateSectionView {...useStoreState(panelsStore)} />;
}
