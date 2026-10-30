// The governance machine's I/O: work handlers (durable, reported back as
// events). What browsers hear is a push the transition publishes
// (../pushes.ts); nothing runs after a transition commits.

import type { Json, Pool, WorkHandler } from '../kernel/index.ts';
import { legacy } from '../legacy.ts';
import { backoff, closeAndComment, gone, permanent } from '../github-work.ts';

interface Deps { config: any; pool: Pool }

export function governanceServices({ config, pool }: Deps): Record<string, WorkHandler> {
  const github = () => legacy('services/github');
  return {
    // Close a GitHub issue, then comment on it (github-work.ts). The
    // transition that applies the result tells every web process to stop
    // listing it, and browsers to re-read.
    'github.closeIssue': {
      maxAttempts: 6,
      backoffMs: backoff,
      async run(ctx): Promise<Json> {
        const done = await closeAndComment(ctx, 'issue');
        if ((done as { gone?: boolean }).gone) return done;
        return { closed: true };
      },
    },

    // Reopen a GitHub issue, then comment on it (#6000). The same
    // checkpointed close-then-comment logic, with the reopen call.
    'github.reopenIssue': {
      maxAttempts: 6,
      backoffMs: backoff,
      async run(ctx): Promise<Json> {
        const done = await closeAndComment(ctx, 'reopenIssue');
        if ((done as { gone?: boolean }).gone) return done;
        return { reopened: true };
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

    // #6019: a vote to close passed, so the changes up for a vote that would
    // have closed one of its requests close (services/threads.js
    // closeThreadChanges, strict).
    'threads.closeChanges': {
      maxAttempts: 3,
      backoffMs: backoff,
      async run({ input }): Promise<Json> {
        const closed = await legacy('services/threads').closeThreadChanges(pool, {
          appId: input.appId, threadId: input.threadId, closed: input.closed ?? [], closedBy: input.closedBy ?? null,
        });
        return { closed };
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
