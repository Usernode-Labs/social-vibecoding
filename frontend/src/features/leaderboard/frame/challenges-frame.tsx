/**
 * Challenges in the one frame, as the 2026-11-06 screen tour draws it (its
 * steps s53 and s54): the frame with Challenges and Standings as its tabs,
 * your standing as the one sentence, what you can still earn and what is
 * done as groups of the standard row, and your season in the context column.
 *
 * Presentational: the pane's own view (../challenges-pane.tsx) with another
 * face. A challenge's own page and Standings are still the pane's.
 */
import { Btn, Card, Facts, Lead, Meta, Note, PageBody, Row, Sec, Tabs } from '@/components/ui/kit';
import { useMessages } from '../../../lib/i18n/react';
import { useFrameFlag } from '../../frame/frame-flag';

/** A challenge as the pane's card has it: `goal` is its name ("Use apps for 10 minutes"), `label` its kind ("Weekly"). */
interface CardLike {
  key: string; idx: number; done: boolean; label: string; goal: string; reward: string | null;
  stateLabel: string; earned: string | null;
}

export type FrameToken =
  | { gated: true; onReview: () => void }
  | { gated: false; amount: string; revealed: boolean; onReveal: () => void };

export function ChallengesFrame({ tabs, onTab, purpose, groups, notice, onOpen, season, note, token }: {
  tabs: Array<{ key: string; label: string }>;
  onTab: (key: string) => void;
  /** Your standing in one line; undefined before it is known. */
  purpose?: string | null;
  groups: Array<{ key: string; heading: string | null; cards: CardLike[] }>;
  notice?: string | null;
  onOpen: (idx: number) => void;
  season: { rank: string; of: string | null; points: string | null; pointsLabel: string } | null;
  note?: string | null;
  token: FrameToken | null;
}) {
  useFrameFlag('challenges-frame');
  const t = useMessages('leaderboard');
  return (
    <PageBody
      data-challenges-frame=""
      title={t('leaderboard:tabs.challenges')}
      purpose={purpose || undefined}
      tabs={<Tabs tabs={tabs} current="challenges" onPick={(key) => onTab(key)} />}
      side={season || token ? (
        <>
          {season ? (
            <Sec label={t('leaderboard:standing.label')}>
              <Facts items={[{ value: season.rank, label: season.of || '' }, ...(season.points ? [{ value: season.points, label: season.pointsLabel }] : [])]} />
            </Sec>
          ) : null}
          {note ? <Note>{note}</Note> : null}
          {token ? (
            <Sec>
              <Card>
                {token.gated ? (
                  <Row
                    wrap
                    lead={<Lead icon="lock" />}
                    title={t('leaderboard:standing.token.withheld')}
                    line={t('leaderboard:standing.token.review')}
                    right={<Btn kind="quiet" small onClick={token.onReview}>{t('leaderboard:standing.token.reviewTerms')}</Btn>}
                  />
                ) : (
                  <Row
                    wrap
                    lead={<Lead icon="star" />}
                    title={t('leaderboard:standing.token.label')}
                    line={t('leaderboard:standing.token.note')}
                    right={token.revealed ? <Meta>{token.amount}</Meta> : <Btn kind="quiet" small onClick={token.onReveal}>{t('leaderboard:standing.token.reveal')}</Btn>}
                  />
                )}
              </Card>
            </Sec>
          ) : null}
        </>
      ) : undefined}
    >
      {groups.filter((group) => group.cards.length).map((group) => (
        <Sec key={group.key} label={group.heading || undefined}>
          <Card>
            {group.cards.map((card) => (card.done ? (
              <Row key={card.key} sm lead={<Lead icon="check" tone="ok" />} title={card.goal || card.label} right={<Meta>{card.earned || card.reward}</Meta>} onClick={() => onOpen(card.idx)} />
            ) : (
              <Row key={card.key} lead={<Lead icon="trophy" tone="acc" />} title={card.goal || card.label} line={card.stateLabel || undefined} right={<Meta>{card.reward}</Meta>} go onClick={() => onOpen(card.idx)} sm={false} />
            )))}
          </Card>
        </Sec>
      ))}
      {notice ? <Note>{notice}</Note> : null}
    </PageBody>
  );
}
