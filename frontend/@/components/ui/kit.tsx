/**
 * The frame's kit: the components every page of the one frame is drawn with.
 *
 * These are the 2026-11-06 screen tour's own components (its kit.mjs:
 * page(), s(), list(), r(), tiles(), pill(), btn() …) as React, emitting
 * the same markup under the same class names with an `fr-` prefix. Their
 * styles are the tour's own stylesheets, compiled into app.css between the
 * `looks:begin` and `looks:end` marks (scripts/build-looks-css.js, from
 * frontend/looks/): the kit's rules for any look, then one block per look.
 * So a screen drawn here is the screen the tour drew, under each of the
 * nine looks, and a look is changed in its file there, never here.
 *
 * NO TAILWIND AND NO VALUES HERE. A kit element carries kit classes only;
 * a utility class would sit beside a look's rule and one of the nine would
 * stop matching the tour. The one inline style is a size or a colour the
 * data gives (a tile's size, a community's own colour), passed as the
 * custom property the kit reads.
 *
 * Kit markup exists only under a look (lib/skin.ts isFrameSkin) and only
 * inside an element with class `fr`, the frame root, where the kit's reset
 * and type apply (`Frame` below). Rules of the frame the components keep
 * for their callers (docs/superpowers/specs/2026-11-08-one-frame-glass-
 * spec.md): one row for everything listed (picture, name, one line, one
 * status), at most one pill on it, a zero says nothing.
 */
import * as React from 'react';
import { createPortal } from 'react-dom';

import { KIT_ICONS } from './kit-icons';

/** `k('row sm on')` → `fr-row fr-sm fr-on`. Falsy parts are dropped. */
export function k(...names: Array<string | false | null | undefined>): string {
  return names
    .flatMap((n) => (n ? n.split(/\s+/) : []))
    .filter(Boolean)
    .map((n) => `fr-${n}`)
    .join(' ');
}

type Custom = React.CSSProperties & Record<`--fr-${string}`, string | number>;

/** The frame root: where the kit's reset, ink and type begin. */
export function Frame({ as: Tag = 'div', className, children, ...props }: {
  as?: 'div' | 'section' | 'main';
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  return <Tag className={`fr${className ? ` ${className}` : ''}`} {...props}>{children}</Tag>;
}

/** One of the kit's 24px stroked glyphs (./kit-icons.ts), decorative. */
export function Icon({ name, size = 20, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={k('ic', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Our own static path strings, never a person's text.
      dangerouslySetInnerHTML={{ __html: KIT_ICONS[name] || KIT_ICONS.info }}
    />
  );
}

/**
 * A project's picture: the one tile on the product. Its own image when it
 * has one, else its emoji or first letter on its colour.
 */
export function Tile({ size = 40, src, emoji, color, name = '' }: {
  size?: number;
  src?: string | null;
  emoji?: string | null;
  color?: string | null;
  name?: string;
}) {
  // A picture that has not arrived yet, or never does: `seen` is the address
  // that loaded, `lost` the one that failed (then the emoji or letter stands in).
  const [seen, setSeen] = React.useState<string | null>(null);
  const [lost, setLost] = React.useState<string | null>(null);
  const picture = src && lost !== src ? src : null;
  const style: Custom = { '--fr-ts': `${size}px` };
  // A picture or an emoji with no colour of its own sits on white, as the
  // launcher's tiles do: many icons are drawn on transparency. Until the
  // picture is there the tile is the look's sunk tone, not a blank white
  // square (the brightest thing in a dark look's row).
  style['--fr-tc'] = color || (picture && seen !== picture ? 'var(--fr-sunk)' : '#fff');
  return (
    <span className={k('tile')} style={style} aria-hidden="true">
      {picture
        ? (
          <img
            src={picture}
            alt=""
            loading="lazy"
            decoding="async"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            // A picture already in the cache is complete before React listens for its load.
            ref={(img) => { if (img && img.complete && img.naturalWidth > 0 && seen !== picture) setSeen(picture); }}
            onLoad={() => setSeen(picture)}
            onError={() => setLost(picture)}
          />
        )
        : (emoji || name.slice(0, 1).toUpperCase())}
    </span>
  );
}

/**
 * A person: their picture, else their first letter on their colour. A list
 * whose standard face says two letters ("DU" for a deleted user, Messages)
 * hands them in as `initials`.
 */
export function Av({ size = 32, name, src, color, initials }: { size?: number; name: string; src?: string | null; color?: string | null; initials?: string }) {
  const style: Custom = { '--fr-as': `${size}px` };
  if (color) style['--fr-ac'] = color;
  return (
    <span className={k('av')} style={style} aria-hidden="true">
      {src
        ? <img src={src} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
        : (initials || name.replace('@', '').slice(0, 1))}
    </span>
  );
}

/** A glyph or a number in the picture's place. */
export function Lead({ icon, tone, size, dash, children }: {
  icon?: string;
  tone?: 'acc' | 'ok' | 'wait' | 'bad';
  size?: number;
  /** An outline only: something to add (New community). */
  dash?: boolean;
  children?: React.ReactNode;
}) {
  // A lead in a grid of tiles is the tiles' size, with their corner.
  const style = size ? { width: size, height: size, borderRadius: Math.round(size * 0.29) } : undefined;
  return <span className={k('lead', tone, dash && 'dash')} style={style} aria-hidden={icon ? 'true' : undefined}>{icon ? <Icon name={icon} size={size ? Math.round(size * 0.42) : 20} /> : children}</span>;
}

export type PillKind = 'act' | 'wait' | 'ok' | 'bad' | '';

function saysNothing(children: React.ReactNode): boolean {
  return children === null || children === undefined || children === false
    || children === 0 || children === '' || (typeof children === 'string' && children.trim() === '');
}

/**
 * One word of status, coloured by what it means: `act` blue (this waits
 * for you), `wait` amber (on others), `ok` green (done), `bad` red, none
 * grey. Zero or empty renders nothing.
 */
export function Pill({ kind = '', mini, href, target, onClick, children }: {
  kind?: PillKind;
  /** The small one that sits in a row's title, after its words. */
  mini?: boolean;
  /** A pill that is a door (a verified account's page). */
  href?: string;
  /** Another site: a real link in a new tab. */
  target?: '_blank';
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  children?: React.ReactNode;
}) {
  if (saysNothing(children)) return null;
  const cls = k('pill', kind, mini && 'mini');
  if (href) return <a className={cls} data-kind={kind || 'none'} href={href} {...(target ? { target, rel: 'noopener noreferrer' } : undefined)} onClick={onClick}>{children}</a>;
  return <span className={cls} data-kind={kind || 'none'}>{children}</span>;
}

/** A count that asks for you. Zero renders nothing. */
export function Count({ children, label }: { children?: React.ReactNode; label?: string }) {
  if (saysNothing(children)) return null;
  return <span className={k('n')} aria-label={label}>{children}</span>;
}

type BtnOwn = {
  /** '' the page's one primary · quiet · line · ok · bad */
  kind?: '' | 'quiet' | 'line' | 'ok' | 'bad';
  icon?: string;
  small?: boolean;
  block?: boolean;
};

export function Btn({ kind = '', icon, small, block, className, type = 'button', children, ...props }:
  BtnOwn & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={k('btn', kind, small && 'sm', block && 'block', props.disabled && 'off', className)} {...props}>
      {icon ? <Icon name={icon} size={17} /> : null}
      {children}
    </button>
  );
}

/** Grey words at the end of a row: a time, an amount. */
export function Meta({ tone, children }: { tone?: 'ok'; children?: React.ReactNode }) {
  if (saysNothing(children)) return null;
  return <span className={k('meta', tone)}>{children}</span>;
}

export interface RowProps {
  /** The picture: a <Tile/>, an <Av/> or a <Lead/>. */
  lead?: React.ReactNode;
  title: React.ReactNode;
  /** The one line under the name. Without it the row is the single-line kind unless `sm` says otherwise. */
  line?: React.ReactNode;
  /** The one status: a <Pill/>, a <Meta/>, a small <Btn/>. */
  right?: React.ReactNode;
  /** A chevron: the row opens something. */
  go?: boolean;
  /** You are here. */
  on?: boolean;
  /** 48px, for a single line. Defaults to "no line". */
  sm?: boolean;
  /** The name and line may wrap to two lines; `'all'` shows every line of both (a switch's sentence is never cut). */
  wrap?: boolean | 'all';
  /**
   * A row with a job of its own (version 2): `showall` the centred link that ends a card, `headrow` a card's
   * first row with its link, `week` a week's bold name, `item` a lighter name, `act` an action in the accent,
   * `proj` a project's name over its items, `month` a month's, `more` a compact list's "more" row.
   */
  kind?: 'showall' | 'headrow' | 'week' | 'item' | 'act' | 'proj' | 'month' | 'more';
  /** A number in a fixed column before the name (#6412); `'mono'` sets it in the mono face. */
  num?: React.ReactNode;
  numMono?: boolean;
  /** A small glyph before the name, where a 40px picture would be too much (a compact list). */
  glyph?: string;
  glyphTone?: 'acc';
  href?: string;
  /** A row that opens another site: a real link in a new tab (`rel` is `noopener noreferrer` unless given). */
  target?: '_blank';
  rel?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Said to a screen reader where the visible row would be ambiguous. */
  label?: string;
  /** A row that is a choice: picked or not, said as a toggle. The lit row (`on`) shows it. */
  pressed?: boolean;
}

/** The `data-*` attributes a caller hands a kit component, and nothing else it was given. */
function dataOf(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(props)) {
    if (key.startsWith('data-') && props[key] != null) out[key] = String(props[key]);
  }
  return out;
}

/**
 * THE row. Anything listed is this: picture, name, one line, one status,
 * in that order. A row with an `href` is a link (a door: cmd-click keeps
 * the address); with only `onClick` a button; else plain.
 */
export function Row({ lead, title, line, right, go, on, sm, wrap, kind, num, numMono, glyph, glyphTone, href, target, rel, onClick, label, pressed, ...rest }: RowProps & Record<`data-${string}`, string | undefined>) {
  const data = dataOf(rest);
  const cls = k('row', (sm ?? !line) && 'sm', on && 'on', wrap && 'wrap', wrap === 'all' && 'all', kind);
  const body = (
    <>
      {lead}
      {glyph ? <span className={k('ei', glyphTone)} aria-hidden="true"><Icon name={glyph} size={16} /></span> : null}
      {saysNothing(num) ? null : <span className={k('num', numMono && 'mono')}>{num}</span>}
      <span className={k('tx')}>
        <span className={k('t')}>{title}</span>
        {line ? <span className={k('s')}>{line}</span> : null}
      </span>
      {right}
      {go ? <Icon name="cr" size={18} className="go" /> : null}
    </>
  );
  if (href) {
    const away = target ? { target, rel: rel || 'noopener noreferrer' } : undefined;
    return <a className={cls} href={href} {...away} onClick={onClick} aria-label={label} aria-current={on ? 'page' : undefined} {...data}>{body}</a>;
  }
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label} aria-pressed={pressed} {...data}>{body}</button>;
  return <div className={cls} {...data}>{body}</div>;
}

/** A group's surface: rows, or any one block. */
export function Card({ pad, className, text, on, onClick, label, children }: {
  pad?: boolean;
  className?: string;
  /** A padded card of sentences (`.txt` inside it is the small grey one). */
  text?: boolean;
  /** Picked: the accent's ring. With `onClick` the card is a button and says so. */
  on?: boolean;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  label?: string;
  children?: React.ReactNode;
}) {
  const cls = k('card', pad && 'pad', text && 'text', on && 'on', onClick && 'press', className);
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-pressed={on === undefined ? undefined : on} aria-label={label}>{children}</button>;
  return <div className={cls}>{children}</div>;
}

/** A group's link, at the end of its label: "All 18", "Edit". */
export function GroupLink({ href, onClick, disabled, bad, children }: {
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Nothing to do yet ("Mark all seen" with nothing new): a button that is off. */
  disabled?: boolean;
  /** In red: Report, Delete. */
  bad?: boolean;
  children: React.ReactNode;
}) {
  const cls = k('link', bad && 'bad', disabled && 'off');
  if (href && !disabled) return <a className={cls} href={href} onClick={onClick}>{children}</a>;
  return <button type="button" className={cls} onClick={onClick} disabled={disabled || undefined}>{children}</button>;
}

/** A labelled group: the label, at most one link, then one block. */
export function Sec({ label, action, id, children, ...props }: { label?: React.ReactNode; action?: React.ReactNode; id?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={k('sec')} id={id} {...props}>
      {label ? (
        <div className={k('sechead')}>
          <h2 className={k('cap')}>{label}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Things you open, as a grid of tiles: apps, and only apps. */
export function Tiles({ cols, after, children }: {
  /** Eight across on a desktop (six in a narrow page), four on a phone; the kit's own is six and four. */
  cols?: 8;
  /** Rows under the grid, in the same card: a <ShowAll/>. */
  after?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return <Card><div className={k('tiles', cols === 8 && 't8')}>{children}</div>{after}</Card>;
}

/** One tile of the grid, with its name under it and a count if it asks for you. */
export function TileItem({ tile, name, count, href, onClick, dim, lit, pressed, corner }: {
  tile: React.ReactNode;
  name: React.ReactNode;
  count?: number;
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** Faded: there, but not yours yet (a community you have not pinned). */
  dim?: boolean;
  /** Its <Lead/> is lit: the tile that is open (All communities). */
  lit?: boolean;
  pressed?: boolean;
  /**
   * A control of its own on the tile's corner (pin, unpin): a button with the kit class `corner`. The tile is
   * then a group holding its door and that button side by side, since a button may not sit inside a link.
   */
  corner?: React.ReactNode;
}) {
  const body = (<>{tile}<Count>{count}</Count><span className={k('nm')}>{name}</span></>);
  const cls = k('at', dim && 'dim', lit && 'lit');
  if (corner) {
    return (
      <div className={cls}>
        {href
          ? <a className={k('atl')} href={href} onClick={onClick}>{body}</a>
          : <button type="button" className={k('atl')} onClick={onClick} aria-pressed={pressed}>{body}</button>}
        {corner}
      </div>
    );
  }
  if (href) return <a className={cls} href={href} onClick={onClick}>{body}</a>;
  return <button type="button" className={cls} onClick={onClick} aria-pressed={pressed}>{body}</button>;
}

/** Up to five numbers said in words. */
export interface FactItem {
  value: React.ReactNode;
  label: React.ReactNode;
  tone?: 'acc' | 'ok' | 'wait';
  /** A second, fainter line under the label ("7 on you"). */
  sub?: React.ReactNode;
  /** A figure that opens something: a link with `href`, else a button. */
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * Up to five numbers said in words. `bare` leaves out the card, for figures that share one with rows, a second
 * strip or the week's bars (the kit draws the hairline between them); `inset` is the smaller strip inside such
 * a card.
 */
export function Facts({ items, bare, inset }: { items: FactItem[]; bare?: boolean; inset?: boolean }) {
  const strip = (
    <div className={k('facts', `f${items.length}`, inset && 'inset')}>
      {items.map((f, i) => {
        const body = (
          <>
            <span className={k('v', f.tone)}>{f.value}</span>
            <span className={k('l')}>{f.label}</span>
            {f.sub ? <span className={k('l', 'sub')}>{f.sub}</span> : null}
          </>
        );
        if (f.href) return <a className={k('fact')} key={i} href={f.href} onClick={f.onClick}>{body}</a>;
        if (f.onClick) return <button type="button" className={k('fact')} key={i} onClick={f.onClick}>{body}</button>;
        return (
          <div className={k('fact')} key={i}>
            <div className={k('v', f.tone)}>{f.value}</div>
            <div className={k('l')}>{f.label}</div>
            {f.sub ? <div className={k('l', 'sub')}>{f.sub}</div> : null}
          </div>
        );
      })}
    </div>
  );
  return bare || inset ? strip : <Card>{strip}</Card>;
}

/**
 * A vote, as the tour's ballot: what is asked, the tally as one bar with
 * the line it must reach, the count in words, then how to cast it. The
 * caller says the words (it knows the language and the rule).
 */
export function Ballot({ pill, id, title, line, yes, no, of, need, words, voters, actions, note }: {
  /** The one status over the title, such as a "Your vote" pill. */
  pill?: React.ReactNode;
  id?: string | null;
  title?: React.ReactNode;
  line?: React.ReactNode;
  yes: number;
  no: number;
  /** How many may vote, and how many yeses pass it. */
  of: number;
  need: number;
  words: { yes: string; rest: string; needed: string };
  voters?: React.ReactNode;
  actions?: React.ReactNode;
  note?: React.ReactNode;
}) {
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / Math.max(of, 1)) * 100))}%`;
  return (
    <Card>
      <div className={k('ballot')}>
        {title ? (
          <div>
            <div className={k('btnrow')}>{pill}{id ? <span className={k('mono')}>{id}</span> : null}</div>
            <div className={k('sub17')} style={{ marginTop: 8 }}>{title}</div>
            {line ? <div className={k('s')} style={{ fontSize: 13, color: 'var(--fr-mut)', marginTop: 4 }}>{line}</div> : null}
          </div>
        ) : null}
        <div className={k('bar2')} role="img" aria-label={`${words.yes} · ${words.rest}`}>
          <i className={k('y')} style={{ width: pct(yes) }} />
          <i className={k('no')} style={{ width: pct(no) }} />
          <span className={k('need')} data-l={words.needed} style={{ insetInlineStart: pct(need) }} />
        </div>
        <div className={k('line1')}><b>{words.yes}</b><span>{words.rest}</span><span style={{ flex: 1 }} />{voters}</div>
        {actions || note ? (
          <div className={k('btnrow')}>
            {actions}
            {note ? <span className={k('meta')} style={{ fontSize: 13, color: 'var(--fr-mut)' }}>{note}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** One sentence the page wants read: plain (navy), or toned. */
export function Note({ tone = '', icon = 'info', children }: { tone?: '' | 'wait' | 'ok' | 'bad'; icon?: string; children: React.ReactNode }) {
  return <div className={k('note', tone)}><Icon name={icon} size={17} /><div>{children}</div></div>;
}

/** The page's head: its title, one sentence saying what it is for, at most one primary action. */
export function Head({ title, purpose, acts, over, lead, under }: {
  title: React.ReactNode;
  purpose?: React.ReactNode;
  acts?: React.ReactNode;
  /** A small-caps line over the title: what kind of thing this is ("Request #5998"). */
  over?: React.ReactNode;
  /** The picture before the title: a project's <Tile/>, a person's <Av/>. */
  lead?: React.ReactNode;
  /** A 13px grey line right under the title: who and how many. */
  under?: React.ReactNode;
}) {
  return (
    <div className={k('head')}>
      {lead}
      <div className={k('tx')}>
        {over ? <div className={k('cap', 'over')}>{over}</div> : null}
        <h1 className={k('title')}>{title}</h1>
        {under ? <div className={k('sub13')}>{under}</div> : null}
        {purpose ? <p className={k('purpose')}>{purpose}</p> : null}
      </div>
      {acts ? <div className={k('acts')}>{acts}</div> : null}
    </div>
  );
}

/** The page's views, as tabs. */
export function Tabs({ tabs, current, onPick, end, flush, seg, label }: {
  tabs: Array<{ key: string; label: React.ReactNode; count?: number; href?: string }>;
  current: string;
  onPick?: (key: string, event: React.MouseEvent<HTMLElement>) => void;
  /** At the row's end, on a desktop only: a <Search/>. A phone has no room there; give it the field under the tabs (<Search only="p"/>). */
  end?: React.ReactNode;
  /** No margin of its own: tabs inside a group or a sheet. */
  flush?: boolean;
  /** A switch: the tabs share the whole width, each centred (a sheet's Sign in · Create account). */
  seg?: boolean;
  label?: string;
}) {
  return (
    <nav className={k('tabs', flush && 'flush', seg && 'seg')} aria-label={label}>
      {tabs.map((tab) => {
        const cls = k('tab', tab.key === current && 'on');
        const body = (<>{tab.label}<Count>{tab.count}</Count></>);
        return tab.href
          ? <a key={tab.key} className={cls} href={tab.href} aria-current={tab.key === current ? 'page' : undefined} onClick={(e) => onPick?.(tab.key, e)}>{body}</a>
          : <button key={tab.key} type="button" className={cls} aria-pressed={tab.key === current} onClick={(e) => onPick?.(tab.key, e)}>{body}</button>;
      })}
      {end ? <div className={k('end')}>{end}</div> : null}
    </nav>
  );
}

/**
 * The page's body: work in the 720px column, context in the 320px column
 * beside it, which goes below on a phone (above with `sideFirst`).
 */
export function Cols({ side, sideFirst, wide, flip, tail, children }: {
  side?: React.ReactNode;
  sideFirst?: boolean;
  wide?: boolean;
  /**
   * The work column's last groups, which a phone puts AFTER the side column:
   * a list with no end (Home's directory) would otherwise keep the side
   * column's groups under every row of it.
   */
  tail?: React.ReactNode;
  /** Flipped: the side column leads, 360px, and the work is the 680px column after it (a list of panes, then the pane). */
  flip?: boolean;
  children?: React.ReactNode;
}) {
  if (flip && side) {
    return (
      <div className={k('cols', 'flip')}>
        <div className={k('stack')}>{side}</div>
        <div className={k('stack')}>{children}</div>
      </div>
    );
  }
  return (
    <div className={k('cols', !side && 'one', wide && 'wide', tail != null && 'mix')}>
      <div className={k('stack')}>
        {children}
        {tail != null ? <div className={k('stack', 'tail')}>{tail}</div> : null}
      </div>
      {side ? <div className={k('stack', sideFirst && 'first')}>{side}</div> : null}
    </div>
  );
}

/**
 * A page of the frame, inside the page area: the head, its tabs, then the
 * columns. The sidebar, bar and tab bar around it are the shell's
 * (features/frame/frame-app.tsx).
 */
export function PageBody({ title, purpose, acts, over, lead, under, tabs, side, sideFirst, wide, flip, narrow, below, tail, children, ...props }: {
  /** The work column's last groups, after the side column on a phone (see <Cols/>). */
  tail?: React.ReactNode;
  title: React.ReactNode;
  purpose?: React.ReactNode;
  acts?: React.ReactNode;
  /** The head's own slots (see <Head/>): a line over the title, a picture before it, a line under it. */
  over?: React.ReactNode;
  lead?: React.ReactNode;
  under?: React.ReactNode;
  /** The side column leads (see <Cols/>). */
  flip?: boolean;
  /** One narrow page (784px): a form. */
  narrow?: boolean;
  tabs?: React.ReactNode;
  side?: React.ReactNode;
  sideFirst?: boolean;
  /** The main column takes the width and the side column is 400px (Home), instead of the tour's 720 and 320. */
  wide?: boolean;
  /** Groups under both columns, the whole width: a sideways row of cards. */
  below?: React.ReactNode;
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Frame {...props}>
      <div className={k('inner', narrow && 'narrow')}>
        <Head title={title} purpose={purpose} acts={acts} over={over} lead={lead} under={under} />
        {tabs}
        <Cols side={side} sideFirst={sideFirst} wide={wide} flip={flip} tail={tail}>{children}</Cols>
        {below ? <div className={k('stack', 'wide')}>{below}</div> : null}
      </div>
    </Frame>
  );
}

/** Cards side by side in one row that scrolls sideways: challenges, featured communities. */
export function HRow({ even, children }: {
  /** Equal columns that fill the row (text cards: challenges, communities to join); on a phone 240px each, scrolling sideways. */
  even?: boolean;
  children?: React.ReactNode;
}) {
  return <div className={k('hrow', even && 'even')}>{children}</div>;
}

/**
 * A challenge, as the Challenges tab's card: its art on its tone (or its
 * icon), the goal, the rail with its words and how far along, the reward.
 */
export function ChallengeCard({ href, onClick, art, icon, title, line, state, label, fill, reward }: {
  href: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  /** The illustration and the fill it sits on; `icon` is drawn when there is none. */
  art?: { src: string; fill: string } | null;
  icon?: string | null;
  title: React.ReactNode;
  line?: React.ReactNode;
  state: 'new' | 'progress' | 'done';
  /** The rail's words: "2 of 5", "Started", "Done". */
  label: React.ReactNode;
  /** 0..1, how much of the rail is filled; null draws no bar. */
  fill?: number | null;
  reward?: React.ReactNode;
}) {
  const pct = state === 'done' ? 100 : fill == null ? null : Math.max(0, Math.min(100, Math.round(fill * 100)));
  return (
    <a className={k('card', 'ccard')} href={href} onClick={onClick}>
      {art
        ? <span className={k('cart')} style={{ background: art.fill }} aria-hidden="true"><img src={art.src} alt="" loading="lazy" /></span>
        : <span className={k('cart')} aria-hidden="true">{icon}</span>}
      <span className={k('cbody')}>
        <span className={k('t')}>{title}</span>
        {line ? <span className={k('s')}>{line}</span> : null}
        <span className={k('rail', state)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          {state !== 'done' && pct != null ? <i style={{ width: `${Math.max(pct, 6)}%` }} /> : null}
          <span>{label}</span>
        </span>
        {reward ? <span className={k('bp')}>{reward}</span> : null}
      </span>
    </a>
  );
}

/**
 * A challenge's picture in a row's lead: its illustration on its tone, as
 * the standard challenge card draws it, else its emoji, else the trophy.
 * Shared by Home's Next challenges and the Challenges page's open rows.
 * `tone` is the product's own tone class (lib/challenge-illustrations
 * resolveIllustration().toneClass), which sets --tint-art in both themes;
 * the caller resolves the picture, since the kit reads no data.
 */
export function ChallengeArt({ src, tone, icon, size = 44 }: {
  src?: string | null;
  tone?: string | null;
  /** The challenge's emoji, drawn when it has no illustration (or the picture fails). */
  icon?: string | null;
  size?: number;
}) {
  const [lost, setLost] = React.useState<string | null>(null);
  const style: Custom = { '--fr-cs': `${size}px` };
  if (src && lost !== src) {
    return (
      <span className={`${k('cart', 'sm')}${tone ? ` ${tone}` : ''}`} style={{ ...style, background: 'var(--tint-art)' }} aria-hidden="true">
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setLost(src)} />
      </span>
    );
  }
  return <span className={k('cart', 'sm')} style={style} aria-hidden="true">{icon || <Icon name="trophy" size={Math.round(size * 0.45)} />}</span>;
}

/** The arrow that ends a row which opens a page of its own (a challenge), as the standard card's. */
export function RowArrow() {
  return <span className={k('arr')} aria-hidden="true"><Icon name="right" size={16} /></span>;
}

/**
 * A community as a picture card (Featured on Home): its illustration, or
 * its tile large on the cover; its name, one sentence, who is there, and
 * the row's one word.
 */
export function PicCard({ href, onClick, cover, darkCover, tile, color, title, line, two, meta, word, end, badge, flag, label, ...data }: {
  /** With no picture: the colour the tile stands on (the community's own). */
  color?: string | null;
  /** The sentence may take two lines (a directory's card). */
  two?: boolean;
  /** Said to a screen reader in place of the card's text. */
  label?: string;
  /** On the cover's lower corner: who is there (a people glyph and a number, with its words for a screen reader). */
  badge?: React.ReactNode;
  /** On the cover's upper corner: "New". */
  flag?: React.ReactNode;
  href: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  cover?: string | null;
  darkCover?: string | null;
  tile?: React.ReactNode;
  title: React.ReactNode;
  line?: React.ReactNode;
  meta?: React.ReactNode;
  word?: React.ReactNode;
  /**
   * A control of the card's own at its foot, beside `meta` (Join on a
   * member's Home). A button may not sit inside a link, so the card is then
   * a group: its picture and words are the door, the foot stands under it.
   */
  end?: React.ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  const face = (
    <>
      <span className={k('fcover', !cover && color ? 'tc' : '')} style={!cover && color ? { '--fr-tc': color } as Custom : undefined}>
        {cover ? <img src={cover} alt="" loading="lazy" className={k('sun')} /> : tile}
        {cover && darkCover ? <img src={darkCover} alt="" loading="lazy" className={k('moon')} /> : null}
        {flag ? <span className={k('pill', 'new')}>{flag}</span> : null}
        {badge ? <span className={k('pill')}>{badge}</span> : null}
      </span>
      <span className={k('fbody')}>
        <span className={k('t')}>{title}</span>
        {line ? <span className={k('s', two && 'two')}>{line}</span> : null}
        {!end && (meta || word) ? <span className={k('fm')}>{meta}{word ? <span className={k('btn', 'quiet', 'sm')}>{word}</span> : null}</span> : null}
      </span>
    </>
  );
  if (end) {
    return (
      <div className={k('card', 'fcard')} {...data}>
        <a className={k('fdoor')} href={href} onClick={onClick} aria-label={label}>{face}</a>
        <div className={k('fm')}><span className={k('fmt')}>{meta}</span>{end}</div>
      </div>
    );
  }
  return <a className={k('card', 'fcard')} href={href} onClick={onClick} aria-label={label} {...data}>{face}</a>;
}

/**
 * The one line for progress: Plan, Build, Checks, Vote, Live, drawn the
 * same wherever a request or a change appears. `at` is the stop reached (5:
 * live, every stop green); `state` is how the current one stands: under
 * way, or waiting on others. `mini` is the wordless strip on a row.
 */
export function Track({ at, state = 'now', mini, words, stops }: {
  at: number;
  state?: 'now' | 'wait';
  mini?: boolean;
  words: readonly [string, string, string, string, string];
  /** Each stop's own state, where the caller already knows them (the bot's track); it replaces what `at` and `state` would draw. */
  stops?: ReadonlyArray<'done' | 'now' | 'wait' | 'live' | ''>;
}) {
  return (
    <span className={k('track', mini && 'mini')} role="img" aria-label={words[Math.min(Math.max(at, 0), 4)]}>
      {words.map((word, i) => (
        <span key={word} className={k('st', stops ? stops[i] : at >= 5 ? 'live' : i < at ? 'done' : i === at ? state : '')} aria-hidden="true">{word}</span>
      ))}
    </span>
  );
}

/** The page's search field, under its tabs: one real input in the kit's field. */
export function Search({ value, onChange, placeholder, label, flush, only }: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  label?: string;
  /** No margin under it (in a sheet, or right over a list). */
  flush?: boolean;
  /** Drawn on a desktop only (`d`) or a phone only (`p`): the pair of a field at the tabs' end. */
  only?: 'd' | 'p';
}) {
  return (
    <div className={k('search', flush && 'flush', only)}>
      <label className={k('inp', value && 'val')}>
        <Icon name="search" size={18} />
        <input
          type="search"
          className={k('v')}
          value={value}
          placeholder={placeholder}
          aria-label={label || placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}

/** Fields in a card, each a label over its box (the tour's fields()). */
export function Fields({ children }: { children?: React.ReactNode }) {
  return <div className={k('card')}><div className={k('fields')}>{children}</div></div>;
}

/**
 * One field: its label, its box, at most one line under it. `before` is
 * drawn inside the box ahead of what is typed (the people already picked).
 * The box is lit while its input has the focus (app.css), red with `bad`.
 */
export function Field({ label, icon, before, hint, tone, bad, area, count, end, after, afterWraps, ...input }: {
  label?: React.ReactNode;
  icon?: string;
  before?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'bad' | 'ok';
  bad?: boolean;
  /** Several lines: the box is a <textarea> (it takes the same props an input would). */
  area?: boolean;
  /** At the label's end: how much is used ("52/280"). */
  count?: React.ReactNode;
  /** Inside the box, after what is typed: show the password, the microphone. */
  end?: React.ReactNode;
  /** Beside the box, on its line: a button that acts on the field (Check, Save). `afterWraps` lets it drop under on a narrow page. */
  after?: React.ReactNode;
  afterWraps?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = React.useId();
  const box = (
    <div className={k('inp', Boolean(input.value || before) && 'val', bad && 'err', area && 'area')}>
      {icon ? <Icon name={icon} size={18} /> : null}
      {before}
      {area
        ? <textarea id={id} className={k('v')} rows={3} {...(input as unknown as React.TextareaHTMLAttributes<HTMLTextAreaElement>)} />
        : <input id={id} className={k('v')} {...input} />}
      {end}
    </div>
  );
  return (
    <div className={k('field')}>
      {label && saysNothing(count) ? <label htmlFor={id}>{label}</label> : null}
      {label && !saysNothing(count) ? <label htmlFor={id} className={k('lab')}><span>{label}</span><span className={k('count')}>{count}</span></label> : null}
      {after ? <div className={k('fieldrow', afterWraps && 'wrap')}>{box}{after}</div> : box}
      {hint ? <span className={k('hint', tone)}>{hint}</span> : null}
    </div>
  );
}

/** An on or off setting on a row: the kit's switch, as a real one. */
export function Tog({ on, onChange, label, disabled, ...props }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean } & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={k('tog', on && 'on')}
      disabled={disabled}
      onClick={(event) => { event.stopPropagation(); onChange(!on); }}
      {...props}
    />
  );
}

/**
 * THE sheet. Every short task is one: the same title, sentence and button
 * order as a page (frame rule 7). `kind` '' is centred (from the bottom on
 * a phone), 'right' the side sheet on a desktop, 'pop' the small one
 * anchored to the corner.
 *
 * It is a dialog: it takes the focus, Escape or a press on the dimmed page
 * closes it, and the focus goes back to where it was. Drawn in <body>, over
 * the chrome and the screens (app.css gives its host the layer); where
 * there is no document (the render tests) it renders in place.
 */
export function Sheet({ kind = '', title, purpose, onClose, closeLabel, primary, secondary, foot, top, children }: {
  /** Between the head and the groups: a switch (<Tabs seg/>), a <Search flush/>. */
  top?: React.ReactNode;
  kind?: '' | 'right' | 'pop';
  title: React.ReactNode;
  purpose?: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  foot?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      try { before?.focus?.({ preventScroll: true }); } catch { /* it has gone */ }
    };
  }, [onClose]);
  const sheet = (
    <div className="fr fr-ovhost">
      <div className={k('ov', kind)} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div className={k('sheet')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
          <button type="button" className={k('ib x')} aria-label={closeLabel} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
          <div className={k('head')}>
            <div className={k('tx')}>
              <h2 className={k('title')} id={titleId}>{title}</h2>
              {purpose ? <p className={k('purpose')}>{purpose}</p> : null}
            </div>
          </div>
          {top}
          {children ? <div className={k('stack')}>{children}</div> : null}
          {primary || secondary ? (
            <div className={k('btnrow')} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              {primary}
              {secondary}
            </div>
          ) : null}
          {foot ? <div className={k('foot')}>{foot}</div> : null}
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}


/* ── Version 2 (11 Nov 2026): what today's content needs of the kit ──────
   The looks draw the product's own content in the first tour's layout
   (docs/superpowers/plans/2026-11-11-looks-v2-todays-content.md). These are
   the pieces that content needed and the kit lacked; their rules are the
   "version 2" block at the end of frontend/looks/kit.css. Additions go
   below, at the end of the file. */

/** A heading inside a page or a card: 22px a name, 17px a card's title, 15px a sentence with a bold lead, 13px a grey line. */
export function Sub({ size, as: Tag = 'div', children }: { size: 13 | 15 | 17 | 22; as?: 'div' | 'h2' | 'h3' | 'p' | 'span'; children?: React.ReactNode }) {
  return <Tag className={k(`sub${size}`)}>{children}</Tag>;
}

/** Grey words beside darker ones, in a title or a sentence ("· 10 of 11 done"). */
export function Mut({ children }: { children?: React.ReactNode }) {
  return <span className={k('mut')}>{children}</span>;
}

/** One grey sentence under a group's card: what the group does not say itself. */
export function SecNote({ end, children, ...data }: { /** The line that ends a list, centred under it. */ end?: boolean; children?: React.ReactNode } & Record<`data-${string}`, string | undefined>) {
  if (saysNothing(children)) return null;
  return <p className={k('secnote', end && 'end')} {...data}>{children}</p>;
}

/** A label inside a group, over one part of it ("Featured" over its cards). */
export function CapSub({ children }: { children?: React.ReactNode }) {
  return <h3 className={k('cap', 'sub')}>{children}</h3>;
}

/**
 * The centred link that ends a card: "Show all 96 apps", "Earlier weeks".
 * `go` adds the chevron when it opens a page rather than more of the card.
 */
export function ShowAll({ href, onClick, go, children }: { href?: string; onClick?: (event: React.MouseEvent<HTMLElement>) => void; go?: boolean; children: React.ReactNode }) {
  return <Row kind="showall" sm title={children} go={go} href={href} onClick={onClick} />;
}

/** A card's first row: its name, and the link that opens all of it ("All items · See all"). */
export function HeadRow({ title, link, href, onClick }: { title: React.ReactNode; link?: React.ReactNode; href?: string; onClick?: (event: React.MouseEvent<HTMLElement>) => void }) {
  return <Row kind="headrow" sm title={title} right={link ? <span className={k('link')}>{link}</span> : null} go href={href} onClick={onClick} />;
}

/** A week in a list of weeks: its name in bold, what happened in it, and its one status. */
export function WeekRow({ title, line, right, go, on, href, onClick }: Pick<RowProps, 'title' | 'line' | 'right' | 'go' | 'on' | 'href' | 'onClick'>) {
  return <Row kind="week" title={title} line={line} right={right} go={go} on={on} href={href} onClick={onClick} />;
}

/** People as overlapping faces: the first few, then how many more. */
export function Avs({ people, size = 28, max = 5, more, label }: {
  people: Array<{ name: string; src?: string | null; color?: string | null }>;
  size?: number;
  /** How many faces are drawn before the rest become a number. */
  max?: number;
  /** How many more there are than `people` holds (the caller knows the whole count). */
  more?: number;
  /** Said to a screen reader in place of the faces ("26 active this week"). */
  label?: string;
}) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length + (more || 0);
  if (!shown.length && rest <= 0) return null;
  const style: Custom = { '--fr-as': `${size}px` };
  return (
    <span className={k('avs')} role={label ? 'img' : undefined} aria-label={label}>
      {shown.map((person, i) => <Av key={i} size={size} name={person.name} src={person.src} color={person.color} />)}
      {rest > 0 ? <span className={k('av', 'more')} style={style} aria-hidden="true">+{rest}</span> : null}
    </span>
  );
}

/**
 * One picture of a change: the shot, named in its corner. A picture that
 * cannot be read (the file gone, a copy with no media) is dropped, leaving
 * the figure's own ground and its name rather than the browser's broken
 * picture.
 */
export function Shot({ src, label }: { src: string; label: React.ReactNode }) {
  const [bad, setBad] = React.useState(false);
  return <figure>{bad ? null : <img src={src} alt="" loading="lazy" onError={() => setBad(true)} />}<figcaption>{label}</figcaption></figure>;
}

/** A change's pictures side by side (before and after); three across with `cols={3}`, a sideways strip on a phone. */
export function Shots({ cols, cards, children }: { cols?: 3; /** Holds <ShotCard/>s, each a card of its own, not a before and after pair. */ cards?: boolean; children?: React.ReactNode }) {
  return <div className={k('shots', cols === 3 && 's3', cards && 'cards')}>{children}</div>;
}

/** Cards in a grid: three across (two on a phone) for picture cards, `cols={2}` for two equal columns of small cards. */
export function Grid({ cols, children }: { cols?: 2; children?: React.ReactNode }) {
  return <div className={k('grid', cols === 2 && 'g2')}>{children}</div>;
}

/** A project's large cover where it has no picture: its emoji on its colour, or its picture. */
export function Cover({ src, color, children }: { src?: string | null; color?: string | null; children?: React.ReactNode }) {
  const style: Custom | undefined = color ? { '--fr-tc': color } : undefined;
  return <div className={k('cover')} style={style} aria-hidden="true">{src ? <img src={src} alt="" loading="lazy" /> : children}</div>;
}

/**
 * A card of words in a sideways row (<HRow even/>) or a grid: its picture
 * and its one status or button on the first line, its name, then one line
 * and, if it has more to say, two clamped lines.
 */
export function HCard({ top, end, title, line, more, foot, href, onClick, label }: {
  /** The picture: a <Tile/>, a <Lead/>. */
  top?: React.ReactNode;
  /** The one status or button, at the first line's end. */
  end?: React.ReactNode;
  title: React.ReactNode;
  line?: React.ReactNode;
  /** A longer sentence, clamped to two lines. */
  more?: React.ReactNode;
  /** A last line of its own: faces and a link. */
  foot?: React.ReactNode;
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  label?: string;
}) {
  const body = (
    <>
      {top || end ? <span className={k('hc-top')}>{top}{end}</span> : null}
      <span className={k('t2')}>{title}</span>
      {line ? <span className={k('s2')}>{line}</span> : null}
      {more ? <span className={k('s2', 'two')}>{more}</span> : null}
      {foot}
    </>
  );
  const cls = k('card', 'pad', 'hcard', !href && onClick && 'press');
  if (href) return <a className={cls} href={href} onClick={onClick} aria-label={label}>{body}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

/**
 * The week as bars, one a day: how tall each is (`value`, 0 to 1 of the
 * tallest), the words over the one worth naming, the day under it. The
 * chart is a picture to a screen reader; `label` says what it shows. Where
 * the days say themselves (`spoken`: "Monday: 37m"), it is a list of them
 * instead, as the standard chart is, and a pointer resting on a day reads
 * the same words.
 */
export function Bars({ days, label }: {
  days: Array<{ label: React.ReactNode; value: number; text?: React.ReactNode; now?: boolean; spoken?: string; id?: string }>;
  label: string;
}) {
  const style: Custom | undefined = days.length === 7 ? undefined : { '--fr-bn': days.length };
  const bar = (day: { value: number }) => (day.value > 0 ? { height: `${Math.max(3, Math.min(100, Math.round(day.value * 100)))}%` } : undefined);
  if (days.some((day) => day.spoken)) {
    return (
      <div className={k('bars')} style={style} role="list" aria-label={label}>
        {days.map((day, i) => (
          <div className={k('bcol', day.now && 'now', !(day.value > 0) && 'none')} key={i} role="listitem" title={day.spoken} data-activity-day={day.id}>
            <span className="sr-only">{day.spoken}</span>
            <span className={k('bv')} aria-hidden="true">{day.text}</span>
            <i aria-hidden="true" style={bar(day)} />
            <span className={k('bl')} aria-hidden="true">{day.label}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={k('bars')} style={style} role="img" aria-label={label}>
      {days.map((day, i) => (
        // A day with nothing in it is a baseline in the quiet ink (.none), not a stub of the accent.
        <div className={k('bcol', day.now && 'now', !(day.value > 0) && 'none')} key={i} aria-hidden="true">
          <span className={k('bv')}>{day.text}</span>
          <i style={bar(day)} />
          <span className={k('bl')}>{day.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A thin bar of how far along something is (`value`, 0 to 1). `meter` is
 * the same bar with room over and under it, between a figure and its
 * sentence (storage used). `done` turns a finished one green.
 */
export function Prog({ value, meter, done, label }: { value: number; meter?: boolean; done?: boolean; label?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round((value || 0) * 100)));
  return (
    <div className={k('prog', meter && 'meter', done && 'done')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A choice from a short list, in the kit's field: a real <select> with the kit's chevron. */
export function Select({ label, hint, tone, bad, options, ...select }: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'bad' | 'ok';
  bad?: boolean;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = React.useId();
  return (
    <div className={k('field')}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className={k('inp', 'val', 'sel', bad && 'err')}>
        <select id={id} className={k('v')} {...select}>
          {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </select>
        <Icon name="cd" size={18} />
      </div>
      {hint ? <span className={k('hint', tone)}>{hint}</span> : null}
    </div>
  );
}

/** One line of what happened in a thread: a small glyph, then the words (a <b> in them is the name). */
export function Evt({ icon, children }: { icon: string; children?: React.ReactNode }) {
  return <div className={k('evt')}><span className={k('ei')} aria-hidden="true"><Icon name={icon} size={16} /></span><span>{children}</span></div>;
}

/* ── Version 2, a project's pages (lane P) ── */

/** One quiet sentence in a card, over its rows: what a row would say if it had anything to open ("Nothing more to vote on."). */
export function CardNote({ children }: { children?: React.ReactNode }) {
  if (saysNothing(children)) return null;
  return <p className={k('cardnote')}>{children}</p>;
}

/**
 * A change as a picture card, inside <Shots/>: its picture (or `fallback`,
 * the project's tile, where it has none or the file is gone), its name in
 * bold, then who and when. A link with `href`, a button with `onClick`.
 */
export function ShotCard({ href, onClick, src, fallback, title, line }: {
  href?: string;
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  src?: string | null;
  fallback?: React.ReactNode;
  title: React.ReactNode;
  line?: React.ReactNode;
}) {
  const [bad, setBad] = React.useState(false);
  const body = (
    <>
      <span className={k('pic', 'img')} aria-hidden="true">
        {src && !bad ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setBad(true)} /> : fallback}
      </span>
      <span className={k('cap2')}><b>{title}</b></span>
      {line ? <span className={k('cap2')}>{line}</span> : null}
    </>
  );
  if (href) return <a className={k('shot', 'shotc')} href={href} onClick={onClick}>{body}</a>;
  if (onClick) return <button type="button" className={k('shot', 'shotc')} onClick={onClick}>{body}</button>;
  return <div className={k('shot', 'shotc')}>{body}</div>;
}
