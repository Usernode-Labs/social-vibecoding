'use strict';

import { memo, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { mountFlows } from './onboarding-flows/engine.js';

// Onboarding flows (#admin/onboarding-flows): where people come from, and
// where they get lost or go deeper.
//
// One chart over one reading (GET /api/admin/onboarding-flows,
// src/services/onboarding-flows.js). Every person is one thread, drawn from
// where they arrived from to where they are now. Five views redraw the same
// threads around one question each: the whole funnel, who is in a private
// app with someone, who takes part in public apps, how sharing brings the
// next person in, and who drops off. The chart fills the section and is
// moved like a map (drag, two-finger scroll, pinch or wheel to zoom); a box
// or a thread opens a pop-up with the people behind it, and Notes holds the
// counted findings, the tables and how each number is defined.
//
// The chart is a drawn surface with its own layout, morph and pan and zoom,
// so it is one imperative module (onboarding-flows/engine.js) rather than a
// tree of components. This file renders the hosts it draws into, once, each
// marked with data-of, and hands them over: nothing here renders into them
// again, and the engine writes nowhere else. The frame is memoised so a
// re-render of the section cannot reconcile over what the engine drew.
//
// Journey (admin-journey.tsx) reads the same people week by week; this page
// is all time and per person. It prints shares beside its counts, which
// Journey does not, because here they are read against the whole population;
// the notes say to treat a difference of a few people as noise.
//
// Its inks and layout are its own stylesheet block in public/css/app.css
// (#admin-onboarding-flows): they are data colours, not the console's
// accent, and the engine measures against them.
//
// PERMISSIONS: any admin reads. Nothing here writes.

// Under staging with ?demo=1 the route answers a whole, labelled demo payload
// (src/services/onboarding-flows-demo.js). Guarded: the SSG prerender pass
// evaluates this module in Node.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const consoleApi = () => (window as any).AdminConsole;

const PATH = '/api/admin/onboarding-flows';

type Reading = { demo?: boolean; cut?: boolean; people: unknown[] };

// The hosts the engine draws into. Static on purpose: every node that carries
// data-of is the engine's from the moment it mounts.
const Frame = memo(function Frame({ demo, cut }: { demo: boolean; cut: boolean }) {
  return (
    <div className="app">
      <div className="scroller" data-of="scroller">
        <div className="stage" data-of="stage">
          <svg data-of="flow" role="img" aria-labelledby="admin-of-flow-title admin-of-flow-desc">
            <title id="admin-of-flow-title">Onboarding flows</title>
            <desc id="admin-of-flow-desc" data-of="flowDesc" />
            <defs data-of="defs" />
            <g data-of="gZones" />
            <g data-of="gThreads" />
            <g data-of="gLoop" className="loop" />
            <g data-of="gNodes" />
            <g data-of="gLeak" />
          </svg>
        </div>
      </div>
      <div className="tip" data-of="tip" hidden />

      <div className="ui">
        <div className="topbar">
          <div className="ctl" data-of="ctl">
            <div className="tabs" role="tablist" aria-label="View" data-of="tabs" />
            <div className="ctlrow">
              <ul className="legend" data-of="legend" aria-label="Legend" />
              <button className="tgl" data-of="s1Toggle" type="button" aria-pressed="false">
                <span className="knob" aria-hidden="true" />
                Exclude earlier members
              </button>
            </div>
          </div>
          <button className="fab" id="admin-of-notes-open" data-of="notesBtn" type="button" aria-expanded="false" aria-controls="admin-of-notes">Notes</button>
        </div>
        <p className="relnote" data-of="relnote" aria-live="polite" hidden />
        <div className="fill" />
        <section className="sheet detail" aria-label="Selection" data-of="detail" hidden>
          <button className="x" data-of="sheetClose" type="button" aria-label="Clear the selection">&times;</button>
          <div data-of="detailBody" />
        </section>
      </div>

      <aside className="notes" id="admin-of-notes" data-of="notes" aria-label="Notes" hidden>
        <button className="x" data-of="notesClose" type="button" aria-label="Close notes">&times;</button>
        <div className="wrap">
          <header>
            <p className="eyebrow">{demo ? 'Demo people, made up for staging' : 'All time, one thread per person'}</p>
            <h1>Onboarding flows</h1>
            <p className="lede">
              Every person is one thread, drawn from where they arrived from to where they are now. The other
              views keep the same threads and redraw them around one question: who is in a private app with
              someone, who takes part in public apps, how sharing brings the next person in, and who drops off.
            </p>
            <p className="facts" data-of="facts" />
            {cut ? <p className="note">Only the first 5,000 people are drawn.</p> : null}
          </header>
          <section className="card" aria-label="This view">
            <p className="viewline" data-of="viewline" aria-live="polite" />
            <p className="hint">
              Drag or two-finger scroll to move the chart, pinch or use a mouse wheel to zoom, double-click to
              zoom in. Point at a thread to see one person. Select a box to follow everyone who passed through
              it. Selections carry across views.
            </p>
          </section>
          <section className="card" aria-labelledby="admin-of-says-title">
            <h2 id="admin-of-says-title">What this view says</h2>
            <ul className="says" data-of="says" />
          </section>
          <section className="card" aria-labelledby="admin-of-leak-title" data-of="leakCard" hidden>
            <h2 id="admin-of-leak-title">Biggest leaks</h2>
            <ul className="says" data-of="leaks" />
            <p className="note">
              A step is from one card to the next card its people reach, one column to the right. People are
              lost at a step when the card they land in leads no further. Columns that only break the previous
              card down (Time on waitlist, Admit mail) are not steps of their own: the card they break down
              carries the total of its parts, so its people are counted there and again on the parts. Only
              cards with 10 or more people are ranked. Every card on the chart carries a mark for its next
              step: a clay tag with the people lost when more than 10% are, filled when half or more are; a
              green check with the number lost when over 90% go on; and a grey minus when the card is itself an
              end, so everyone in it stops there. A tag counts only the people lost at that one step, so a card
              whose people mostly came through one door can hide a large loss among the rest: the door split
              says when that is so.
            </p>
          </section>
          <section className="card" aria-labelledby="admin-of-table-title">
            <h2 id="admin-of-table-title" data-of="tableTitle" />
            <div className="tablewrap" data-of="tablewrap" />
            <p className="note" data-of="tableNote" />
          </section>
          <section className="card" aria-labelledby="admin-of-grid-title" data-of="gridCard" hidden>
            <h2 id="admin-of-grid-title" data-of="gridTitle">Engaged people: use against contribution</h2>
            <div className="tablewrap" data-of="gridwrap" />
            <p className="note" data-of="gridNote" />
          </section>
          <section className="block" aria-labelledby="admin-of-method-title">
            <h2 id="admin-of-method-title">How to read these numbers</h2>
            <ul className="method" data-of="method" />
          </section>
        </div>
      </aside>
    </div>
  );
});

function OnboardingFlowsSection() {
  const [reading, setReading] = useState<Reading | null>(null);
  const [failed, setFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    consoleApi().fetchJson(DEMO ? `${PATH}?demo=1` : PATH).then((res: { ok: boolean; data: Reading | null }) => {
      if (!live) return;
      if (res.ok && res.data && Array.isArray(res.data.people)) setReading(res.data);
      else setFailed(true);
    });
    return () => { live = false; };
  }, []);

  const drawn = !!reading && reading.people.length > 0;
  useEffect(() => {
    if (!drawn || !root.current) return undefined;
    const chart = mountFlows(root.current, reading);
    return () => chart.destroy();
  }, [drawn, reading]);

  if (drawn) {
    return (
      <div id="admin-onboarding-flows" ref={root}>
        <Frame demo={!!reading.demo} cut={!!reading.cut} />
      </div>
    );
  }
  return (
    <div id="admin-onboarding-flows-wait" className={`${AdminUI.card} p-4 sm:p-5`}>
      {reading ? <p className={AdminUI.muted}>Nobody to draw yet.</p> : null}
      {!reading && failed ? <p className={AdminUI.muted}>Could not load the onboarding flows. Reload to try again.</p> : null}
      {!reading && !failed ? <p className={AdminUI.loading}>Loading the onboarding flows…</p> : null}
    </div>
  );
}

let host: Element | null = null;

const AdminOnboardingFlows = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <OnboardingFlowsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminOnboardingFlows = AdminOnboardingFlows;

// OnboardingFlowsSection for its render test (tests/admin-onboarding-flows-section.test.js).
export { AdminOnboardingFlows, OnboardingFlowsSection };
