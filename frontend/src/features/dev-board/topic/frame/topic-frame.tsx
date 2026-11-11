/**
 * The kit's parts of an item's page (a request, a change) in the one frame:
 * the first screen tour's layout (its steps s32 to s35) holding what the
 * standard page says today (version 2). The page's head is a small line
 * saying what it is ("Request #5998") over its full title, with the page's
 * own menu.
 *
 * Presentational. The page (../request-head.tsx, ../change-head.tsx) is
 * still the product's: it draws these under a look beside its own parts,
 * and hands in the words.
 */
import { Card, Frame, Head, Icon, Pill, Sec, Track, k, type PillKind } from '@/components/ui/kit';

/**
 * The head, in the bar's place. The ⋯ keeps the class and the key the
 * shell's own menu wiring finds it by (AppView reads `.dev-card-menu-btn`
 * and `data-card-menu`), drawn as the kit's disc.
 */
export function TopicFrameHead({ title, over, menu }: {
  title: string;
  /** What this is, over the title: "Request #5998", with its topic when it has one. */
  over?: string | null;
  menu?: { key: string; label: string } | null;
}) {
  return (
    <Frame data-topic-frame-head="">
      <Head
        title={title}
        over={over || undefined}
        acts={menu ? (
          <button type="button" className={`${k('ib')} dev-card-menu-btn`} data-card-menu={menu.key} aria-haspopup="true" aria-label={menu.label} title={menu.label}>
            <Icon name="more" size={18} />
          </button>
        ) : undefined}
      />
    </Frame>
  );
}

/**
 * Where the request stands (the tour's status block): the stage as a pill,
 * the five-stop line, one sentence, the claim's small words, and the one
 * action for this viewer, drawn as the kit's button with the class the
 * standard look's action has, for whatever reads it.
 */
export function TopicFrameStatus({ label, pill, at, state = 'now', words, say, fine, action }: {
  /** None on a request's page: the card is stacked at the words' top, where a label has no room; the pill says the stage. */
  label?: string | null;
  pill?: { word: string; kind: PillKind } | null;
  /** The stop the request is at; null draws no line (a closed request). */
  at: number | null;
  state?: 'now' | 'wait';
  words: readonly [string, string, string, string, string];
  say?: string | null;
  fine?: string | null;
  action?: { label: string; title?: string; disabled?: boolean; href?: string; onClick?: () => void } | null;
}) {
  return (
    <Sec label={label || undefined} data-topic-status="">
      <Card>
        <div className={k('status')}>
          {pill ? <div className={k('btnrow')}><Pill kind={pill.kind}>{pill.word}</Pill></div> : null}
          {at != null ? <Track at={at} state={state} words={words} /> : null}
          {say ? <p className={k('txt')}>{say}</p> : null}
          {fine ? <p className={k('fine')}>{fine}</p> : null}
          {action ? (
            <div className={k('btnrow')}>
              {action.href
                ? <a className={`${k('btn')} dev-request-primary`} href={action.href} title={action.title}>{action.label}</a>
                : <button type="button" className={`${k('btn', action.disabled && 'off')} dev-request-primary`} title={action.title} disabled={!!action.disabled} onClick={action.onClick}>{action.label}</button>}
            </div>
          ) : null}
        </div>
      </Card>
    </Sec>
  );
}
