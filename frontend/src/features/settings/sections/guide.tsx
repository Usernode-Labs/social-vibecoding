/**
 * Settings → User guide (#5973): the welcome tour's places, and how a change
 * gets voted in, to read at your own pace. The tour's six stops
 * (../../home/tour/tour-steps.ts) point at a place and say a sentence; this
 * says the rest, in the same order, in words a non-developer reads.
 *
 * Every claim here is one the product makes elsewhere. It names no number of
 * votes on purpose: how many yeses a change needs is each project's own rule
 * (dialogs:whoDecides.preset.*), and a guide that states one is wrong for the
 * other three. The tab is called what the bar calls it (core:tabs.ai,
 * "Homeroom bot").
 *
 * Text and nothing else, so it holds no state and settings.js binds nothing
 * inside it. The rows are ListRow's own 15 over 13; a row read rather than
 * scanned lets its subtitle wrap, as ./connectors.tsx's do.
 */

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { SectionHeading } from '@/components/ui/field';

import { useMessages } from '../../../lib/i18n/react';

function Row({ title, body }: { title: string; body: string }) {
  return (
    <ListRow
      inset="text"
      chevron={false}
      title={title}
      subtitle={body}
      subtitleClassName="whitespace-normal"
    />
  );
}

export function GuideSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="guide" className="hidden">
      <div id="settings-guide-section">
        <SectionHeading title={t('settings:guide.title')}>
          {t('settings:guide.intro')}
        </SectionHeading>
        <SectionHeader className="px-0 pt-2">{t('settings:guide.places.heading')}</SectionHeader>
        <GroupedList className="mx-0">
          <Row title={t('settings:guide.place.communities.title')} body={t('settings:guide.place.communities.body')} />
          <Row title={t('settings:guide.place.apps.title')} body={t('settings:guide.place.apps.body')} />
          <Row title={t('settings:guide.place.appMenu.title')} body={t('settings:guide.place.appMenu.body')} />
          <Row title={t('settings:guide.place.suggest.title')} body={t('settings:guide.place.suggest.body')} />
          <Row title={t('settings:guide.place.bot.title')} body={t('settings:guide.place.bot.body')} />
          <Row title={t('settings:guide.place.you.title')} body={t('settings:guide.place.you.body')} />
        </GroupedList>
        <SectionHeader className="px-0">{t('settings:guide.vote.heading')}</SectionHeader>
        <GroupedList id="settings-guide-voting" className="mx-0">
          <Row title={t('settings:guide.vote.build.title')} body={t('settings:guide.vote.build.body')} />
          <Row title={t('settings:guide.vote.up.title')} body={t('settings:guide.vote.up.body')} />
          <Row title={t('settings:guide.vote.checks.title')} body={t('settings:guide.vote.checks.body')} />
          <Row title={t('settings:guide.vote.rule.title')} body={t('settings:guide.vote.rule.body')} />
        </GroupedList>
      </div>
    </div>
  );
}
