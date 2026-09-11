import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { DiscoverCard } from '../home/panels/discover';
import type { DiscoverTileView } from '../home/panels-store';
import { prepareIllustration } from '../../lib/prepare-illustration';
import {
  DEFAULT_FRAME, centreOf, clampFrame, panFrame, spreadOf, wheelZoomFactor, zoomFrame,
} from '../../lib/illustration-framing';

type Art = NonNullable<DiscoverTileView['illustration']>;
// Keyboard equivalents for the gestures, so framing is not mouse-only now
// that the sliders are gone.
const KEY_PAN = 3;
const KEY_ZOOM = 1.08;

export function FeaturedIllustrationEditor({ app, onClose }: { app: any; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const close = useRef(onClose);
  useIsomorphicLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const [art, setArt] = useState<Art | null>(null);
  const pendingBlob = useRef<Blob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Live pointers, in insertion order: one is a drag, two or more a pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [dragging, setDragging] = useState(false);
  const endpoint = `/api/apps/${encodeURIComponent(app.slug)}/featured-illustration`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the illustration. Reopen the editor to try again.');
      if (controller.signal.aborted) return;
      setArt(data.illustration ? { ...data.illustration, ...clampFrame(data.illustration) } : null); setLoading(false);
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => { controller.abort(); generation.current++; };
  }, [endpoint]);
  useEffect(() => {
    const url = art?.url;
    return () => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [art?.url]);
  useIsomorphicLayoutEffect(() => {
    if (!root.current || !card.current) return;
    let adoption: KitAdoption | null = adoptKitSurface({ kind: 'modal', contentEl: card.current,
      adoptedOn: root.current, home: 'placeholder', gate: 'kit', onDismiss: () => { adoption = null; close.current(); } });
    return () => { if (adoption) { adoption.restore(); adoption.dismiss(); } };
  }, []);
  const interactive = !!art && !busy && !loading;
  // The art block, not the whole card: the name and blurb below it are not a
  // framing surface, and its box is what every gesture is measured against.
  const artRect = () => {
    const rect = surface.current?.querySelector('.home-discover-art')?.getBoundingClientRect();
    return rect && rect.width && rect.height ? rect : null;
  };
  // A native listener, because React's onWheel is passive at the root and so
  // cannot preventDefault — without which a zoom scrolls the dialog too.
  useEffect(() => {
    const el = surface.current;
    if (!el || !interactive) return undefined;
    const onWheel = (event: WheelEvent) => {
      const rect = artRect();
      if (!rect || event.clientY > rect.bottom) return;
      event.preventDefault();
      setArt(a => a ? { ...a, ...zoomFrame(a, wheelZoomFactor(event.deltaY, event.deltaMode),
        (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height) } : a);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [interactive]);
  useEffect(() => { if (!interactive) { pointers.current.clear(); setDragging(false); } }, [interactive]);
  const endPointer = (id: number) => {
    pointers.current.delete(id);
    if (!pointers.current.size) setDragging(false);
  };
  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || !art) return;
    const pan = { ArrowLeft: [-KEY_PAN, 0], ArrowRight: [KEY_PAN, 0], ArrowUp: [0, -KEY_PAN], ArrowDown: [0, KEY_PAN] }[event.key];
    const zoom = event.key === '+' || event.key === '=' ? KEY_ZOOM : event.key === '-' || event.key === '_' ? 1 / KEY_ZOOM : 0;
    if (!pan && !zoom) return;
    event.preventDefault();
    setArt(a => a ? { ...a, ...(pan ? panFrame(a, pan[0] / 100, pan[1] / 100) : zoomFrame(a, zoom)) } : a);
  };
  const chooseFile = async (chosen?: File) => {
    if (!chosen) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      const prepared = await prepareIllustration(chosen);
      if (current !== generation.current) return;
      pendingBlob.current = prepared;
      setArt({ url: URL.createObjectURL(prepared), ...DEFAULT_FRAME });
    } catch (err) { if (current === generation.current) setError((err as Error).message); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const save = async () => {
    if (busy || loading) return;
    setBusy(true); setError('');
    try {
      const blob = pendingBlob.current;
      const framing = art ? clampFrame(art) : null;
      const query = blob && framing ? `?${new URLSearchParams(Object.entries(framing).map(([k, v]) => [k, String(v)]))}` : '';
      const res = await fetch(endpoint + query, { method: !art ? 'DELETE' : blob ? 'POST' : 'PATCH',
        headers: { 'Content-Type': blob && art ? 'application/octet-stream' : 'application/json' },
        body: !art ? undefined : blob || JSON.stringify(framing) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save. Try again.');
      app.featured_illustration = data.illustration;
      const home = (window as any).Home;
      const cached = home?._apps?.find((a: any) => a.slug === app.slug);
      if (cached) cached.featured_illustration = data.illustration;
      home?.render?.();
      close.current();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const cachedApp = (window as any).Home?._apps?.find((a: any) => a.slug === app.slug);
  const fallback = app.icon_url || (app.icon_image_id ? `/app-icons/${app.icon_image_id}` : null);
  const tile: DiscoverTileView = {
    slug: app.slug, name: app.name, status: app.status, demo: !!app.demo,
    added: !!(window as any).Home?.isYours?.(app),
    icon: fallback ? { kind: 'image', src: fallback } : app.icon_emoji
      ? { kind: 'emoji', emoji: app.icon_emoji } : { kind: 'letter', letter: String(app.name || '?')[0].toUpperCase() },
    blurb: (window as any).HomePanels?.appBlurb?.(app) || null,
    contributors: Number(app.contributor_count ?? cachedApp?.contributor_count) || 0, illustration: art,
  };
  return <div ref={root} className="rounded-2xl bg-white dark:bg-zinc-900 mb-5">
    <div ref={card} className="flex flex-col px-4 pb-5" aria-label="Featured illustration">
      <h2 className="text-lg font-bold pt-3 pb-4">Featured illustration</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">Preview on Discover</p>
      <div className="flex justify-center mb-4">
        <div ref={surface} data-framing-surface={art ? 'true' : 'false'} role="group"
          aria-label="Illustration framing: drag to move, scroll or pinch to zoom, arrow keys to nudge"
          tabIndex={interactive ? 0 : -1}
          className="rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          // touchAction so a pan is a pan and not a page scroll; userSelect
          // because otherwise a drag across the card selects the name and
          // blurb under it, which on touch leaves them highlighted blue.
          style={{ touchAction: interactive ? 'none' : 'auto', userSelect: 'none', WebkitUserSelect: 'none',
            cursor: !interactive ? 'default' : dragging ? 'grabbing' : 'grab' }}
          onKeyDown={nudge}
          onPointerDown={event => {
            if (!interactive) return;
            const rect = artRect();
            if (!rect || event.clientY > rect.bottom) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
            setDragging(true);
          }}
          onPointerMove={event => {
            const live = pointers.current;
            if (!live.has(event.pointerId)) return;
            const rect = artRect();
            if (!rect) return;
            // Incremental: one step per move event, clamped each time, so a
            // pinch that hits the zoom ceiling simply stops instead of
            // banking travel it later replays.
            const before = [...live.values()];
            live.set(event.pointerId, { x: event.clientX, y: event.clientY });
            const after = [...live.values()];
            const from = centreOf(before), to = centreOf(after);
            const was = spreadOf(before), now = spreadOf(after);
            setArt(a => {
              if (!a) return a;
              let next: Art = a;
              if (was > 0 && now > 0) {
                next = { ...next, ...zoomFrame(next, now / was,
                  (to.x - rect.left) / rect.width, (to.y - rect.top) / rect.height) };
              }
              return { ...next, ...panFrame(next, (to.x - from.x) / rect.width, (to.y - from.y) / rect.height) };
            });
          }}
          onPointerUp={event => endPointer(event.pointerId)}
          onPointerCancel={event => endPointer(event.pointerId)}>
          <DiscoverCard tile={tile} preview />
        </div>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        aria-label="Upload featured illustration" onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
      <fieldset disabled={busy || loading} className="flex flex-col gap-3">
        <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => file.current?.click()}>{art ? 'Replace image' : 'Upload image'}</Button>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">PNG, JPEG or WebP, up to 20 MB.</p>
        {art ? <>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Drag the card to move the image. Scroll or pinch to zoom. Zoom <span data-zoom-readout>{Math.round(art.zoom * 100)}%</span>.
          </p>
          <div className="flex gap-3">
            <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => setArt({ ...art, ...DEFAULT_FRAME })}>Reset position</Button>
            <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => { setArt(null); pendingBlob.current = null; }}>Use app icon</Button>
          </div>
        </> : null}
      </fieldset>
      {loading && !error ? <p role="status" className="text-sm mt-3">Loading preview…</p> : null}
      {error ? <p role="alert" className="text-sm text-red-500 mt-3">{error}</p> : null}
      <div className="flex gap-3 mt-5">
        <Button type="button" className="min-h-[44px] flex-1" disabled={loading || busy} onClick={() => { void save(); }}>{busy ? 'Please wait…' : 'Save'}</Button>
        <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" disabled={busy} onClick={onClose}>Cancel</Button>
      </div>
    </div>
  </div>;
}
