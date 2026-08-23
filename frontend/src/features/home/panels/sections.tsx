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
import { stampProps } from './ui';

/**
 * One host. `slot` names WHICH block it is for — it rides along from the grid
 * cell each section replaces, and it is the hook everything outside the
 * feature already selects on.
 */
function Section({
  id, slot, painted, stamps, children,
}: {
  id: string;
  slot: string;
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
    <Section id="home-challenges-section" slot="challenges" painted={painted}>
      {challenges ? <ChallengesPanel view={challenges} /> : null}
    </Section>
  );
}

export function CreateSectionView({ painted, create }: HomePanelsState) {
  return (
    <Section
      id="home-create-section"
      slot="create"
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
