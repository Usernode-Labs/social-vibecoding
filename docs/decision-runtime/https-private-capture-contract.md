# Disposable HTTPS and private capture

This proof stays within the default-off Kubernetes/kpack CLI cohort and fresh,
ownership-verified local stores. No production credentials, DNS, trust store,
registry, deployment or default kubeconfig may be used or changed.

## Contract before implementation

- Capture Jobs retain their public `https://…fixture.invalid` URLs. A disposable
  TLS edge terminates actual TLS on that hostname. Its generated certificate and
  browser trust are scoped to the fixture; trust is not disabled globally. Job
  DNS maps only the recorded fixture host to the owned edge container.
- The edge invokes the packaged platform's real `/__caddy/access` policy before
  serving documents or assets. App-scoped capture JWTs exchange for the real
  scoped edge cookie. A fixture self-staging surface uses the shipped auth and
  admin middleware against the actual prepared database clone, exchanging JWTs
  for real session rows and Secure/HttpOnly cookies.
- The non-admin screenshot identity may see the ordinary document but cannot
  read admin data. The assertion identity may read admin data but cannot perform
  admin writes. Missing, malformed, expired, wrong-app and unknown-user tokens
  must not gain private access; membership remains authoritative. Assets require
  the private edge permission even where the platform serves their bytes publicly.
- Capture and companion checks remain owned by their original lifecycle/run and
  Jobs. Kill the actual worker while those Jobs run, then restart with admission
  disabled. Recovery adopts the original Job UIDs, settles once and durably
  delivers required gating work. It must not create a competing execution.
- TLS/edge setup and process teardown verify the fixture destinations, cluster,
  database, container identities and certificate fingerprint. Missing or mismatched
  configuration fails closed before test mutations. All generated material stays
  in the disposable fixture and cleanup preserves successor identities.

## Explicit substitutions and limits

The tiny source, GitHub metadata/policy, fixture DNS/TLS installation and test loss
points remain substitutions. The self-staging permission surface is a small test
server composed from the shipped middleware, not a complete self-app build. Its
health path probes the actual candidate Service; auth/session storage uses that
candidate's actual clone. The edge is a test TLS router invoking real forward-auth,
not proof of an installed production ingress controller. Production certificates,
least-privilege RBAC, network policy, mixed-version capture protocol and arbitrary
app-specific authorization remain separate installation/compatibility gates.
No lifecycle, successful build/runtime observation or settlement is substituted.

## Reproduce locally

Create a **new** fixture with `scripts/kpack-local-fixture.js init` and an explicit
local Docker socket. Use the returned dedicated directory for these commands, in
order: `setup`, `setup-https`, `setup-unit-checks`, `test-https`, `teardown`.
`setup-https` refuses adding trust after a capture image has been built. Teardown
verifies immutable ownership and keeps private evidence. Never reuse a retired
fixture or a populated packaged store to bypass fresh-store admission.

The capture image contains the generated certificate in its own Debian/NSS trust
stores. The browser uses normal certificate verification; there is no
`ignoreHTTPSErrors`, global certificate bypass or host trust installation. Its
public URL is unchanged. The local router uses ordinary upstream HTTP **after**
TLS termination, invokes the real platform gate, and reads the actual conditional
Ingress binding to select the prepared candidate's Service for health. This is
an explicit fixture installation substitution, not a capture URL rewrite.

### Private membership prerequisite

The fixture explicitly grants the non-admin capture account membership in its
private project. That grant is a **fixture input**, not a product observation or
proof that ordinary private projects grant it automatically. The real
`app-access.isViewMember` requires membership or admin status; `seedCaptureUser`
provides platform access, not blanket private-project membership. Staging demo
fixtures grant selected memberships separately. The read-only assertion admin
passes the existing admin visibility policy; it still cannot perform admin writes.

Consequently this proof covers **authorized private capture**. Before supporting
ordinary private projects, verify their capture admission policy and decide how a
run obtains narrowly scoped view permission without publishing admin screenshots
or bypassing the private gate. Missing users/keys/membership must remain visible
failure or blocked work, not be described as successful private capture. No new
permission bypass is introduced by this fixture.

## Demonstrated evidence

The actual packaged matrix passed (one case, no failures/skips) in fresh fixture
`a6af94af-4a30-47ae-8f45-8babd3c79f87`. Product base is accepted `f04887e47`;
this checkpoint adds test harness/contract code. Latest inspected canonical
`93c1e915b6262fc0cbab0e883767664b70740766` has no changes to the relevant
capture, identity, edge, membership or runtime owners relative to the integrated
pin. Newer template theme changes are unrelated and were not silently merged.

- Real Chromium trusts only the fixture's installed certificate. Both browser
  contexts visit the unchanged public HTTPS hostname. The original capture Job
  emits a valid HTTP-200 PNG showing **Ordinary screenshot**; its separate
  assertions render **Read-only assertions**. Real admin read succeeds, ordinary
  read fails, and read-only admin writes fail. Reusing a screenshot cookie with
  the assertion JWT exercises the shipped staging identity-switch path.
- Real edge/session cookie exchange succeeds with Secure/HttpOnly cookies;
  cookie-only follow-up requests work. Missing, malformed, expired, wrong-app and
  unknown-user credentials are denied. A valid token with a mismatching cloned
  username passes no local authentication. All three bridge/native/Tailwind assets
  are denied without edge authority and loaded with it. Loopback TLS regression
  additionally rejects an untrusted certificate; preflight rejects fixture,
  certificate and key mismatches.
- Worker loss occurs after companion creation while the original capture is held
  at the fixture document. Restart with admission disabled harvests the same run
  `6d7c9ba5-7d69-4834-ab70-3001b7f7ff64`, capture Job UID
  `899d4d87-6262-431b-b92f-aef12779c315` and unit Job UID
  `33f7cb62-3394-434c-a2e1-97b9b81163c1`. Exactly two Jobs are created overall.
  Both succeed. After a second loss following the actual verdict commit, history
  and settlement receipt remain identical, original Job/input retirement closes
  the manifest obligation, continuation succeeds and required merge delivery
  invokes its **substituted** policy exactly once. No real GitHub merge is proved.
- Database OID **27710**, Build UID `a7cd5218-f059-4dda-a792-9c68ebd16fa8`,
  candidate image digest
  `sha256:256a6348130be2321730ba68dd7ce9d06c9153865f2b8a6c470123f2ebb41c17`
  and Secret/Service/Deployment UIDs stay unchanged across the preparation,
  activation, checks and verdict restarts. The real serving sentinel remains
  healthy and preparation preserves its binding until separately authorized
  activation. Successful clone/build/runtime observations are never substituted.

Private `packaged/result.json`, `source-sha256.json`, `https-permissions.json`,
`https-original-jobs.json`, `https-screenshot.png` and request/entry-point logs
retain the image/source tuple and detailed identities. The digest-pinned browser
contains the shipped capture code plus fixture-only certificate trust; unit source,
GitHub metadata, loss barriers, TLS router and explicitly granted membership are
fixture inputs. The tiny identity document is not a production self-app build.
All three attempted clusters/databases/registries and the PostgreSQL-only regression
container have been ownership-verified and retired; private evidence remains.

Focused verified PostgreSQL: **1,002 passed, zero failures/skips**. TLS/isolation/
fixture/CI checks: **21 passed**. Mapped checks: **159 passed, 20 opt-in integration
skips**; the actual matrix above ran separately. SQL validation: **3,251 unique /
4,154 static variants** against disposable PostgreSQL. Writer inventory remains
**16 explicit legacy statements**. Sandbox loopback rejection was rerun through
the verified disposable runner; no ambient database was connected.

Earlier attempts failed on two harness errors: Node's address-list DNS callback,
and an undeclared screenshot path targeting `/` instead of the fixture `/proof`.
Both are corrected in reproducible setup. Neither failing run is counted as a
complete proof. An attempted input correction after checks were admitted was
refused; no admitted capture inputs were rewritten. No product guards were weakened.

## What remains / what was removed

This closes the disposable authorized-private HTTPS/assets/capture recovery gate.
It removes the **internal HTTP substitution from this proof path**; the older
HTTP fixture remains available for its earlier test matrix. No production handler,
lock, timer, reducer or lifecycle owner is removed by this verification slice.
Installation supervision, least-privilege RBAC, production ingress/certificate and
builder compatibility, mixed-version protocol, arbitrary application permissions
and ordinary private-project capture admission remain explicit boundaries.

Repeated revisions on the same session, overlapping checks/supersession and safe
retirement of **published predecessors** are the next essential correctness gate.
It must report actual resource release and competing ownership removed, while
retaining unresolved creators. No additional workflow or rollout precedes it.
