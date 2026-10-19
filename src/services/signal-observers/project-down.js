'use strict';

// project_down: one project whose production deploy keeps failing.
//
// Goalio could not deploy from 17 Sep to 15 Oct 2026: about 1,200 retries a
// day, its creator told once by an `app_health` notification, and nobody
// else until a person read the logs four weeks later. A failed rebuild
// leaves `apps.last_failure` set (services/deploy-failure.js) until a
// deploy succeeds, so a project still carrying one is a project still not
// live with its latest version.
//
// This returns each such project, and the kind waits a day before it files
// (fileAfterMs below; the row's first sighting is the clock, since
// last_failure keeps only the latest attempt's time). The request goes on
// the PROJECT'S OWN board (appId), not Homeroom's, held for a person: the
// Homeroom bot builds there only when somebody in the project mentions it
// on the request (platform-signals.js heldIssues, homeroom-bot-holds.js),
// and nobody but the creator, told already, is notified. Three or more
// projects failing at one step is the platform's problem instead, and is
// wave 1's `project_deploys`.
//
// The failure's reason is the project's own build output. It is shown here
// because the request lives on that project's board, held from the bot,
// for the project's own people; it is scrubbed and cut like any excerpt.

const DAY = 24 * 60 * 60 * 1000;

const FAILING_SQL = `
  SELECT id, slug, last_failure
    FROM apps
   WHERE last_failure IS NOT NULL AND self_hosted IS NOT TRUE AND repo_url IS NOT NULL
   ORDER BY id`;

async function run(pool) {
  const { rows } = await pool.query(FAILING_SQL);
  return rows.map((r) => {
    const f = r.last_failure || {};
    const stage = String(f.stage || 'deploy').slice(0, 40);
    return {
      kind: 'project_down',
      key: r.slug,
      appId: Number(r.id),
      subject: { slug: r.slug, stage },
      fileAfterMs: DAY,
      title: `This project can't go live: its deploy fails at the ${stage} step`,
      summary: 'Homeroom has been trying to deploy this project\'s latest version for a day, and it fails every time, '
        + 'so people still see the version before it, or nothing.',
      evidence: {
        lines: [
          `The latest attempt failed at the ${stage} step${f.sha ? ` on ${String(f.sha).slice(0, 7)}` : ''}${f.at ? `, at ${f.at}` : ''}.`,
        ],
        excerpts: f.reason ? [{ label: 'Why it failed', text: String(f.reason) }] : [],
        where: ['Dockerfile', 'package.json'],
      },
      evidencePrivate: { log: typeof f.log === 'string' ? f.log.slice(-4000) : null },
    };
  });
}

module.exports = { run, FAILING_SQL };
