# Private project repositories

Homeroom-managed Forgejo source follows project view visibility. The rollout
uses two settings. Keep the cohort in `GIT_HOST_PRIVATE_PROJECTS`
(`config.gitHost.privateProjects` in Helm) and enable visibility writes with
`GIT_HOST_PRIVATE_PROJECTS_WRITE=true` (`config.gitHost.privateProjectsWrite`).
The read cohort is a comma-separated list of Forgejo repository names. Set it
to `*` after the pilot. Keeping the cohort configured while pausing writes
preserves authenticated source for repositories already made private.

Before enabling writes, confirm the web read account can read a private
repository in the apps organization. Its Forgejo token needs read access to
new repositories as well as the pilot repository. The read account and the
conductor's write account stay on the platform. Ensure workers, unit suites,
BuildKit, and kpack can reach the platform's internal Service on port 3000.
The chart permits ingress from the configured source caller namespaces during
the rollout. Check egress in the build namespaces' own policies.

1. Enable source delivery for one disposable project. With its Forgejo
   repository private, confirm a signed-out Git read fails. Exercise a
   member's Code download, an external work order, a bot turn that pushes a
   branch, a staging build with checks and shots, and a production rebuild.
2. Enable visibility writes for one existing private project. The workflow
   clock looks for drift every five minutes and makes its repository private.
   Confirm the same anonymous and authorized access checks. Test both an
   approved publication and a return to private on a disposable project.
3. Add repository names in batches. Look for
   `project-repo-visibility` errors and verify the converted repositories
   before extending the cohort.

New private projects in the cohort start with a private repository. During
a transition to private, Forgejo is updated before Homeroom records the app
as private. During a transition to public, the approved app change records
publication to retry if Forgejo is unavailable. The backfill only closes
previously public access on private apps. Existing downloaded copies can
outlive a visibility change.

For a locally authored proposal, resolve the exact base SHA in Homeroom
and use `social-vibecoding source clone <slug> <directory> --base-sha <sha>`
with the signed-in CLI profile. The source endpoint refuses a stale base.
