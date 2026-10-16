// The governance machine's I/O: work handlers (durable, reported back as
// events) and notifiers (post-commit kicks, allowed to be lost). What
// browsers hear is a push the transition publishes (../pushes.ts).

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';

// requestDeploy: platform.ts's, for the rebuild work left from before;
// adoptCampaigns: platform.ts's, for the campaign work left from before.
interface Deps {
  config: any; pool: Pool;
  requestDeploy?: (appId: number, reason: string, o?: Record<string, unknown>) => Promise<number>;
  adoptCampaigns?: () => Promise<number>;
}

export function governanceServices({ config, pool, requestDeploy, adoptCampaigns }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  return {
    // Close a GitHub issue, then comment on it (github-work.ts). The
    // transition that applies the result tells every web process to stop
    // listing it, and browsers to re-read.
    'github.closeIssue': {
      maxAttempts: 6,
      backoffMs: backoff,
      async run(ctx): Promise<Json> {
        const done = await closeAndComment(ctx, (gh, owner, repo, number) => gh.closeIssue(owner, repo, number));
        if ((done as { gone?: boolean }).gone) return done;
        return { closed: true };
      },
    },

    // A secret change's own rebuild, as the machine recorded it before
    // every deploy was app-delivery's. An item of it left from then deploys
    // nothing: it asks app-delivery for the redeploy here, so it is asked
    // whichever release applies its result (an older Pod's code would only
    // mark it done), and answers `handOff`, which the machine reads as its
    // follow-up now being app-delivery's (machine.ts). The request key is
    // the item's, so a retry asks once.
    'app.rebuildProduction': {
      maxAttempts: 5,
      backoffMs: backoff,
      async run({ input, workId }): Promise<Json> {
        await requestDeploy!(Number(input.appId), 'secret_change', { requestKey: `handoff:${workId}` });
        return { handOff: true };
      },
    },

    // A campaign an older release applied queued this item (it ran
    // fleet-maintenance's old driver): the campaign machine takes the
    // campaign instead (platform.adoptCampaigns), and the item is done.
    // Transitional: deleted once no older release can run.
    'campaign.run': {
      maxAttempts: 5,
      backoffMs: backoff,
      async run(): Promise<Json> {
        await adoptCampaigns!();
        return { handOff: 'campaign' };
      },
    },

    // A close vote closed a request: the Homeroom bot's proposals for it that
    // are up for a vote are withdrawn once every request they are linked to
    // is closed, and the bot is woken for the app. `strict`: a failure to
    // read is thrown, and the item runs again.
    'bot.requestsClosed': {
      maxAttempts: 3,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const out = await legacy('services/homeroom-bot-closed-requests')
          .noteRequestsClosed(pool, { appId: input.appId, closed: input.closed, strict: true });
        return { withdrawn: out?.withdrawn ?? [] };
      },
    },

    // Whether a close proposal's target is still open on GitHub. A target
    // closed by hand there is announced by nothing else.
    'governance.checkTarget': {
      maxAttempts: 3,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const gh = github();
        if (!gh.isEnabled()) throw permanent('GitHub is not configured');
        try {
          const issue = await gh.getIssue(input.owner, input.repo, input.number);
          return { open: issue?.state === 'open' };
        } catch (err) {
          if (gone(err)) return { open: false };
          throw err;
        }
      },
    },
  };
}

// Post-commit kicks that only speed something up: losing one costs a wait.
export function governanceNotifiers({ config, pool }: Deps): Record<string, (n: any) => Promise<void> | void> {
  return {
    // A request board changed: the Workshop re-places its cards (an hourly
    // sweep re-themes what it misses).
    boardChange: (n) => legacy('services/ws').noteBoardChange({ appId: n.appId, appSlug: n.appSlug }),
    // "Vote on a change", graded now rather than on the scorer's next pass,
    // which grades the same vote if this is lost.
    scoreVote: () => legacy('services/topochain/challenge-scorer').scoreOnVote(pool, config),
  };
}
