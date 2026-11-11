import { useEffect, useState, type RefObject } from 'react';
import { ChevronDownIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { isNearBottom, type ScrollBox } from './stick-to-bottom';

export function showsToEnd(box: ScrollBox): boolean {
  return box.clientHeight > 0 && box.scrollHeight > box.clientHeight && !isNearBottom(box);
}

/** The inbox's own foot, independent of the conversation's newest line. */
export function InboxToEnd({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const t = useMessages('messages');
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const read = () => setShown(showsToEnd(el));
    const resize = new ResizeObserver(read);
    const changes = new MutationObserver(read);
    el.addEventListener('scroll', read, { passive: true });
    resize.observe(el);
    changes.observe(el, { childList: true, subtree: true });
    read();
    return () => { el.removeEventListener('scroll', read); resize.disconnect(); changes.disconnect(); };
  }, [scroller]);
  const name = t('messages:inbox.toEnd.name');
  return (
    <div className="relative z-10 shrink-0" data-inbox-to-end="">
      <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ bottom: 'calc(var(--platform-tabs-h, 0px) + 12px)' }}>
        <button
          type="button" inert={!shown} aria-label={name} title={name}
          className={`pointer-events-auto relative flex h-9 items-center justify-center gap-1.5 rounded-full bg-white ps-3 pe-3.5 text-[0.8125rem] font-semibold text-zinc-700 shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_14px_rgba(0,0,0,0.14)] dark:bg-zinc-800 dark:text-zinc-200 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${shown ? 'translate-y-0 scale-100 opacity-100' : 'pointer-events-none translate-y-2 scale-90 opacity-0'}`}
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
        >
          <ChevronDownIcon aria-hidden="true" className="h-[18px] w-[18px]" />
          {t('messages:inbox.toEnd.label')}
        </button>
      </div>
    </div>
  );
}
