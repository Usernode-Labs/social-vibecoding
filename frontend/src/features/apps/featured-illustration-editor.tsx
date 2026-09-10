import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { DiscoverCard } from '../home/panels/discover';
import type { DiscoverTileView } from '../home/panels-store';
import { prepareIllustration } from '../../lib/prepare-illustration';

type Art = NonNullable<DiscoverTileView['illustration']>;
const DEFAULT_FRAME = { zoom: 1, x: 0, y: 0 };
const clamp = (n: number) => Math.max(-100, Math.min(100, n));

export function FeaturedIllustrationEditor({ app, onClose }: { app: any; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const close = useRef(onClose);
  useIsomorphicLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const [art, setArt] = useState<Art | null>(null);
  const pendingBlob = useRef<Blob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<{ px: number; py: number; x: number; y: number; width: number; height: number } | null>(null);
  const endpoint = `/api/apps/${encodeURIComponent(app.slug)}/featured-illustration`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the illustration. Reopen the editor to try again.');
      if (controller.signal.aborted) return;
      setArt(data.illustration); setLoading(false);
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
      const framing = art ? { zoom: art.zoom, x: art.x, y: art.y } : null;
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
        <div style={{ touchAction: art && !busy ? 'none' : 'auto', cursor: art ? 'grab' : 'default' }}
          onPointerDown={event => {
            if (!art || busy || loading) return;
            const rect = event.currentTarget.querySelector('.home-discover-art')!.getBoundingClientRect();
            if (event.clientY > rect.bottom) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { px: event.clientX, py: event.clientY, x: art.x, y: art.y, width: rect.width, height: rect.height };
          }}
          onPointerMove={event => {
            const d = drag.current;
            if (d) setArt(a => a ? { ...a, x: clamp(d.x + (event.clientX - d.px) / d.width * 100), y: clamp(d.y + (event.clientY - d.py) / d.height * 100) } : a);
          }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <DiscoverCard tile={tile} preview />
        </div>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
        aria-label="Upload featured illustration" onChange={e => { void chooseFile(e.target.files?.[0]); e.target.value = ''; }} />
      <fieldset disabled={busy || loading} className="flex flex-col gap-3">
        <Button type="button" variant="neutral" ink="muted" className="min-h-[44px]" onClick={() => file.current?.click()}>{art ? 'Replace image' : 'Upload image'}</Button>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">PNG, JPEG or WebP, up to 20 MB. {art ? 'Drag the image to position it.' : ''}</p>
        {art ? <>
          {([{ key: 'zoom', label: 'Size', min: 0.5, max: 3, step: 0.01 },
            { key: 'x', label: 'Horizontal position', min: -100, max: 100, step: 1 },
            { key: 'y', label: 'Vertical position', min: -100, max: 100, step: 1 }] as const).map(control =>
            <label key={control.key} className="flex flex-col gap-1 text-sm">
              <span>{control.label} <span className="text-zinc-500">{Math.round(art[control.key] * (control.key === 'zoom' ? 100 : 1))}%</span></span>
              <input type="range" min={control.min} max={control.max} step={control.step} value={art[control.key]}
                className="w-full min-h-[44px] accent-violet-600" onChange={e => setArt({ ...art, [control.key]: Number(e.target.value) })} />
            </label>)}
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
