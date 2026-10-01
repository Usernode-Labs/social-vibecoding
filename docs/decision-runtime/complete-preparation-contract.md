# C7: complete preparation in the disposable fixture

This checkpoint exercises the native Kubernetes preparation contract through
`staging.prepareCandidateUnderBuildLock`, the shared decision/execution runtime,
and the actual clone, kpack and runtime services. It admits no additional caller
and does not activate a candidate.

Staging fetches and checks out the reserved full source revision, reads the
manifest and secrets, then invokes named `prepareClone`, `prepareImage` and
`prepareRuntime` operations. The worker owns their validated actions and reported
facts. Staging must not recheck a recoverable clone through a different service,
overwrite it, or use legacy failed-preparation database removal. Older preparation
work kinds keep their existing dispatch contract. Already admitted Kubernetes work
keeps its payload, operation identities and decision version; the clone service
adopts its verified completion instead of copying again.

Each retry may refetch the immutable source. Clone completion requires the same
owned database OID and completion marker. Build adoption requires the persisted
recipe, source revision, Build UID and output digest. Runtime adoption requires
the persisted desired specification, resource UIDs, ownership, image and actual
health. A lost reply after a committed phase fact, resource creation, runtime
receipt or accepted completion must preserve these identities. A claim expiry
permits inspection, not a conclusion that earlier external creation stopped.

Supersession revokes further domain permission. Retirement fences and removes
only the old attempt's database and UID-verified runtime. Serving state and the
successor remain untouched. Retained retirement obligations continue to reconcile
late resources; absence and elapsed time do not close them. Build artifacts and
retired role markers retain the C4/C6 retention rules. Activation remains a
separate authorized action and is excluded from this proof.

The harness requires parent and child isolation preflight before mutations. It
uses a newly provisioned kind cluster, dedicated kubeconfig, disposable PostgreSQL
and dedicated registry. Fixture inputs/substitutions are explicit:

- A public, pinned MIT sample app with its own `/health` and `PORT` support
  replaces a platform-managed proposal repository/PR. Source checkout and kpack
  fetch/build are real; no source files or launch command are rewritten.
  The fixture pins `nickovivar/simple-health-endpoint` at
  `59de32fd44f50ba06926a43d90b567e33aa39236`. Its empty manifest and supplied PORT
  are intentional inputs; it does not exercise a generated Homeroom app.
- A seeded local source template replaces template refresh/production data. The
  actual clone service performs copying, redaction, completion and retirement.
- Staging secrets use actual empty fixture tables. Database connection URL host
  and port are translated to the preflight-verified Docker PostgreSQL address so
  local-cluster Pods can reach it; role/password/database come from the real
  connection URL implementation.
- Health HTTP uses the verified Kubernetes Service proxy from the host. It reads
  the real app response; resource/Pod/Endpoint observations remain actual API
  reads. No successful clone, Build or runtime observation is injected.
- An independent serving sentinel uses the fixture's dedicated non-root Node
  image and HTTP command. It is not the candidate: the candidate uses the actual
  kpack digest and its native launcher. Its UIDs, specification, health, all
  seven serving projection fields and absent activation binding are checked.
- Interruption and lost-reply hooks run after actual operations. These are fault
  injections, not evidence that a real network failure occurred.

The sample does not use PostgreSQL itself: SQL access to each clone is verified
separately, and the persisted runtime Secret is checked against its credentials.
This does not prove app-specific migrations, private GitHub access, production
networking, activation or compatibility with production kpack. Preparation
admission and operation authorization precede external work, but staging's source
fetch and the Build's source fetch are separate;
this proves matching revisions, not a shared content cache. Polling may refetch
the same source and report retry-local timing. Existing session/retention locks,
timers and compatibility dispatch remain; this checkpoint does not retire them.

Actual fixture evidence is recorded in the implementation ledger. Reproduce with
`node scripts/kpack-local-fixture.js init <explicit-local-socket>`, then `setup`
and `test-preparation <returned-directory>`. Parent and each SIGKILL child rerun
full physical-identity preflight. The test pauses after actual phase operations,
kills/reclaims the same work, then checks identities before any resumed creation.
Clone inspection occurs after worker exit so its own advisory lock is released.
Lost acknowledgments are injected after actual clone completion, Build creation,
Service creation, runtime-receipt commit and accepted work settlement. One database
copy, one Build POST and one POST per runtime kind are asserted. A separately
interrupted Build attempt is superseded; it cannot prepare a runtime, and cleanup
waits for the actual Build to settle before releasing its clone.

Next bounded cutover: the Kubernetes/kpack native CLI handoff submission entering
`handoff-pipeline.runStaging`. Replace its synchronous native preparation dispatch
with durable admission/completion, and keep activation as a separate authorized
step before its staging-ready/checks continuation. Remove that caller's competing
synchronous preparation/inline cleanup and recovery dispatch in the same slice;
do not keep a second fallback builder for it. See the retirement inventory for
the retained-work, timer and lock removal gates. This cutover is not implemented
or authorized for production by C7.
