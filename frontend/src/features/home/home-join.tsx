/**
 * Communities to join on the signed-in Home (One Home, #6361): the shared
 * section (./communities-to-join.tsx) over the public directory, less the
 * communities already on this Home, joined or pinned. Join is
 * Home.setMembership, which joins and pins the community; the store reads
 * the pins back, and the card leaves the list.
 */
import { useEffect, useMemo, useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import type { GuestApp } from '../guest/guest-data';
import { CommunitiesToJoin, readDirectory } from './communities-to-join';
import { homePinsStore } from './home-pins-store';
import { useHomeQuery } from './use-home-query';

export function HomeJoin() {
  const pins = useStoreState(homePinsStore);
  const query = useHomeQuery();
  const [apps, setApps] = useState<GuestApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!pins.ready) return;
    let live = true;
    setFailed(false);
    void readDirectory(attempt > 0).then((list) => {
      if (!live) return;
      // #6354 review: null is a directory that could not be read, which is
      // not the same as one with nothing in it: say so, and let them retry.
      if (list) setApps(list);
      else { setApps(null); setFailed(true); }
    });
    return () => { live = false; };
  }, [pins.ready, attempt]);

  const exclude = useMemo(() => new Set([
    ...pins.joined.map((c) => c.slug),
    ...pins.pins.map((p) => p.slug),
  ]), [pins.joined, pins.pins]);

  if (!pins.ready) return <section id="home-join-section" className="px-3 pb-6" hidden />;
  return (
    <CommunitiesToJoin
      apps={apps}
      failed={failed}
      exclude={exclude}
      signedIn
      query={query}
      onJoin={(app) => { void (window as any).Home?.setMembership?.(app.slug, true); }}
      onRetry={() => { setApps(null); setAttempt((n) => n + 1); }}
    />
  );
}
