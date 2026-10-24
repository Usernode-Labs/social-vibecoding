# October 23, 2026 security update

This change starts at canonical `Usernode-Labs/social-vibecoding` main
`b256fc9ee25a905e1df909c977e65a5d1a2429c0`, verified against GitHub on October 23.
It implements the project findings from the supplied October 23 audit. The
original working checkout and its untracked work were left intact. This is a
GitHub PR; no Homeroom proposal or production deployment was created.

## Versions and compatibility

| Input | Reviewed version |
| --- | --- |
| Every Node stage in both platform Dockerfiles, worker, capture, generated starter | **22.23.4**, existing Alpine / Bookworm variants |
| Image and CI npm | **11.21.1** |
| Root / starter Express | **4.22.3** (declared `^4.22.3`) |
| Express 4 body-parser / SDK Express 5 body-parser | **1.20.9 / 2.4.0** |
| Root and worker-global MCP SDK | **1.32.2** |
| Shipped DOMPurify | **3.4.17**, regenerated with `npm run vendor:assets` |
| Frontend Vite | **6.4.5**, dev listener explicitly `127.0.0.1` |
| Tailwind, all three trees | **3.4.17** |
| PostCSS selector parser, all three trees | **7.1.7**, reviewed override |
| tar under bcrypt's node-pre-gyp installer | **7.5.22**, scoped override |
| Root / worker-global Zod | **3.25.76**, remaining finding below |
| Capture Puppeteer / basic-ftp | **23.11.1 / 6.2.1** |
| Standalone Docker / Buildx | **29.9.2 / 0.38.1**, upstream binaries built with Go **1.26.10** |
| SBOM / scanner | Syft **1.55.0**, Trivy **0.76.1** |

`security/validation-2026-10-23.json` records every changed lockfile package,
exact local image IDs, runtime versions, and scan totals. Compatible advisory
fixes include qs, proxy-addr, grpc-js, Hono, fast-uri, ip-address, js-yaml,
brace-expansion, nanoid, protobufjs and source-map-js where present.

The PostCSS override preserves Tailwind's pinned major and utility semantics;
platform/starter CSS compilation and the existing CSS contracts pass. tar 7's
extract API remains compatible with node-pre-gyp; clean installation and a
native Linux bcrypt hash/compare check pass. No npm force-fix, MinIO downgrade,
Firebase Admin major migration, Tailwind 4 migration, or Zod 4 migration was
applied. The frontend's former caret Tailwind declaration is now an exact pin.

Node's patched base still bundled npm 10.9.9 with vulnerable dependencies.
Inspecting published npm tarballs showed that 11.21.1 contains brace-expansion
5.0.12 and undici 6.29.0; npm 11.19.1 did not fix the full image findings. Node
22 supports npm 11.21.1. Both native installation and all image builds pass.

DOMPurify's new filename, head reference, service-worker asset reference,
vendoring script and SHA-384 provenance were updated together. The old asset
was removed. The frozen shell baseline was retained; its deliberate script
replacement is recorded in the script inventory test. Generated shell HTML,
CSS, release files and bundles remain uncommitted.

## Image-only package inventory

The worker additionally installs Claude Code (resolved by CI before a release;
local build **2.1.309**), Codex **0.146.0**, MCP SDK **1.32.2**, Zod **3.25.76**,
and Playwright MCP **0.0.41**, whose browser dependency is
**1.56.0-alpha-2025-10-01**. These are independent of the three project lockfiles.
The existing Playwright pin and screenshot adapter were retained; its image's
browser authentication, font and screenshot smoke tests pass. A browser/MCP pin
migration remains separate compatibility work; npm findings alone do not
establish browser-engine security coverage.

Capture declares its independent Puppeteer tree in `capture/package.json`,
including the basic-ftp override. It uses Debian's Chromium; the built browser
reported **156.0.8078.47**. Puppeteer successfully launched it and verified
DOMPurify's selectedcontent and SVG sanitization with the actual vendored file.
Corepack **0.36.0** is also inherited from the Node bases. Full inventories,
including npm's bundled dependencies and nested global tools, are emitted by
`scripts/image-npm-inventory.js` and by the image SBOMs.

## Remaining findings and applicability

Fresh npm audits, including development dependencies, report:

| Tree | Critical | High | Moderate | Low | Total affected-package findings |
| --- | ---: | ---: | ---: | ---: | ---: |
| Root | 0 | 1 | 12 | 2 | 15 |
| Frontend | 0 | 0 | 0 | 0 | 0 |
| Starter | 0 | 0 | 0 | 0 | 0 |

These include propagated parent-package findings and are not counts of
confirmed attacks or unique CVEs.

- **Zod 3 / GHSA-mrhx-c7xc-m3w5:** no patched Zod 3 exists. The remote MCP
  server now sets `maxToolInputElements: 10_000` before schema validation and
  already limits JSON to 512 KB before dispatch. An integration test proves
  oversized collections never enter Zod validation. Worker MCP servers use
  stdio. Zod 4 is a separate migration; the exact version/advisory exception
  expires **November 22, 2026**. The affected version remains recorded.
- **MinIO 8:** decode-uri-component and stream-json remain affected. Their
  suggested replacements change module/API contracts; automatically selecting
  MinIO 7 is a downgrade. MinIO consumes object-store responses, so
  attacker-controlled object names, metadata or responses require further
  reachability review. No general non-applicability claim is made.
- **Firebase Admin 13:** its older Firestore/Storage request stack retains uuid
  findings, propagated through retry-request, teeny-request and google-gax.
  The advisory concerns buffer-writing UUID APIs; v4 request-ID generation is
  a different usage. Keep Admin 13 pending a tested migration rather than
  overriding every old UUID major across its consumers.
- **Anthropic SDK 0.89:** the remaining advisory concerns the SDK's filesystem
  memory tool; this platform's messages API use does not invoke that tool.
- **Mermaid 11 / KaTeX:** the remaining low finding requires existing prototype
  pollution to bypass KaTeX trust restrictions. The application uses strict
  Mermaid settings and sanitizes the resulting SVG. Mermaid 12 was not taken
  as an automatic security patch. The precondition is not evidence of an
  existing prototype-pollution path in this application.
- **proxy-addr:** all locked copies are patched to 2.0.8. The previous advisory
  required a specific IPv4-mapped trusted subnet. `server.js` explicitly uses
  `trust proxy: false`; a regression verifies forged X-Forwarded-For does not
  replace the connection address. This setting did not meet that advisory's
  precondition even before the dependency update.
- **MCP:** the platform exposes HTTP, so the SDK memory advisory is relevant.
  Upgrading alone leaves its new element limit disabled; this change enables
  it. The separate worker stdio servers do not meet that HTTP precondition.
- **Standalone Buildx:** latest upstream 0.38.1 still embeds go-archive v0.2.0
  (CVE-2026-17106) and x/net v0.59.0 (CVE-2026-78669). Govulncheck 1.9.0 found
  no affected archive-extraction symbols in the upstream linux/arm64 binary,
  but did find linked HTTP/2 symbols. **The HTTP/2 finding remains affected;
  reachability is not dismissed.** Both matches are explicitly retained with
  standalone-only exceptions expiring **October 30, 2026**. A vendor update
  and amd64 assessment remain necessary. Kubernetes platform images contain
  neither Docker CLI nor Buildx. Copying the same-version upstream binaries
  removes Alpine's Go 1.26.9 certificate finding without changing Docker's API
  version or disabling BuildKit.
- **OS packages:** lower-severity and vendor-unfixed/deferred findings remain,
  especially in Debian's browser/compiler/PostgreSQL package trees. Exact
  counts and hashes are recorded in the validation JSON; complete reports
  are CI artifacts. These repeated package matches need distro updates and
  package-specific applicability review. Bookworm was retained rather than
  introducing an untested OS migration in this patch.

The gates reject unreviewed **fixable HIGH/CRITICAL** matches. Passing that
policy includes the exact expiring exceptions above. Full reports retain
lower-severity and unfixed findings. Missing scan/audit data fails the check.

## Cleanup and validation

`worker/process-ownership.js` reads Linux /proc or bounded macOS ps/lsof output.
It requires the same user, process start time and exact command before each
signal, spares the hook and its ancestors, and considers only workspace
listeners for the stop hook. In-loop launches retain process identities,
snapshot owned descendants, and use a dedicated app process group to find
servers orphaned by npm/shell wrappers. Each process is checked individually;
no process group is signalled wholesale. Direct ChildProcess handles cover
failed inspection and process-title changes. TERM has a bounded grace period,
then KILL; failed spawns and failed fixture startup also clean up.

Fixture servers bind loopback. The previous /proc-only assertion was replaced
with a real cross-platform state check. Regression coverage includes foreign
users/workspaces, unreadable metadata, PID reuse during escalation, failed
spawns, a changed process title, wrapper exit and a TERM-resistant grandchild.

Local verification used fresh root, frontend and starter installations, not the
original checkout's node_modules. The isolated starter installation was then
moved outside src/ so repository SQL/source inventory checks did not inspect
its third-party fixture code.

- Changed-file selection: **249 suites; 4,761 passed, 38 skipped, 0 failed**
  under Node **22.23.4**. The full 2,129-suite repository run was not duplicated.
- Dedicated cleanup/security run with **no forced test exit**: **57 passed**
  on macOS and **57 passed** on Linux/Node 22.23.4.
- Disposable PostgreSQL 17 fixture run: **17 passed**; its container was removed.
- SQL validation: **4,771 unique statements** passed; dynamic baseline unchanged.
- Shell and CSS builds, vendored asset regeneration/provenance, native bcrypt,
  and all five native linux/arm64 image builds passed.
- Browser sanitization passed in the actual built capture Chromium.
- Frontend typecheck still reports **60 pre-existing diagnostics**. A clean
  canonical snapshot with its own original lockfile produces identical output
  after normalizing the checkout path and generating its language catalog.
- PR CI builds/scans all five images on linux/amd64, audits all lockfiles,
  and runs cleanup/security tests on Ubuntu and macOS. No PR job publishes
  images or releases. Remote CI results remain attached to the PR.

Image checks run the actual Node binary without the app or network, record
Node/Brotli/OpenSSL and installed npm versions, scan the complete SPDX SBOM,
and independently scan an exported image for distro packages. Syft and Trivy
receive archives/SBOMs with networking disabled and no Docker socket. A
separate container downloads only the public vulnerability database. Existing
BuildKit `pull: true` and `sbom: true` are retained; release checks consume that
attached SBOM by immutable digest. Daily audits also cover reused images when
no release is needed. Reports are retained for 30 days.

## Rebuild and rollout (operator work after review)

**No production action was performed.** Merging main uses the existing atomic
Helm/Argo release workflow. A manual main workflow dispatch also publishes a
stable release and can trigger production rollout; it is not merely a local
build command. Use the existing candidate/staging review procedure first.

1. Review the dependency overrides, remaining findings and exception expiry.
   Build the approved revision with `--pull`; retain its exact source revision,
   image digests, runtime probes, complete vulnerability reports and SBOMs.
   Confirm linux/amd64 PR checks before using local arm64 evidence for a release.
2. Release the platform, worker and capture digests through the existing atomic
   chart, first in the normal candidate/canary environment. Check health,
   authentication, normal and refused MCP calls, shell/cache upgrade, a build
   turn and capture. Drain old worker containers/pods after their active turns
   finish; old processes do not gain the new runtime when an image is rebuilt.
3. **Refresh prebuilt starters separately.** Generated Dockerfiles and lockfile
   bytes change `starter-images.contextKey`, so new ready-made projects select
   new keys. The starter-images clock builds missing current keys after a
   release; Admin → Templates shows status and offers Rebuild. Verify every
   ready-made starter image, including its actual Node version and scan, before
   calling that part of the rollout complete.
4. **Existing projects keep their existing image.** Inventory their running
   immutable digests and actual runtimes, including older Node 18/20/22 images.
   Update each repository's Dockerfile/lockfile through its own normal review,
   rebuild at its approved revision, scan/probe the finished image, then roll
   its deployment. Rebuilding the platform or warming new starter keys alone
   does not replace these deployments. Keep the registry's retention policy;
   do not delete images still referenced by a project.
5. If using **kpack/CNB**, Dockerfile pins do not select the buildpack runtime.
   Refresh builder/run images, ensure the buildpack supports the patched Node
   branch, set the existing `BP_NODE_VERSION` to **22.23.4** or a later patched
   Node 22, and rebuild and probe each resulting application image. The current
   config defaults to `22.*`; do not infer the result from that declaration.
6. Verify actual running binaries after rollout, reconcile all old digests,
   and monitor health/errors. Keep a known-good **patched** rollback image;
   rebuild a prior healthy source revision with the security fixes if needed.

Local review commands, from an empty throwaway checkout/output directory:

```sh
node scripts/security-audit.js
npm run vendor:assets
npm run ensure:shell
npm run test:changed -- --base b256fc9ee25a905e1df909c977e65a5d1a2429c0
node --require ./tests/lib/test-net.js --test --test-timeout=180000 \
  tests/build-stop-hook.test.js tests/inloop-launch.test.js tests/security-update.test.js

# For each built image; component is platform, standalone, worker, capture or starter.
sh scripts/create-image-sbom.sh "$IMAGE" "$REPORT/sbom.spdx.json"
sh scripts/check-image-security.sh "$IMAGE" "$REPORT" "$REPORT/sbom.spdx.json" "$COMPONENT"
# For a published image with its existing BuildKit attestation:
sh scripts/check-published-image.sh "$IMAGE_AT_DIGEST" "$REPORT" "$COMPONENT"
```

Sources rechecked on October 23:
[Node security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases),
[body-parser](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828),
[DOMPurify](https://github.com/cure53/DOMPurify/security/advisories/GHSA-87xg-pxx2-7hvx),
[MCP HTTP validation](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-46jr-4wx8-v453),
[proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h),
[Buildx 0.38.1 security rebuild](https://github.com/docker/buildx/releases/tag/v0.38.1),
[go-archive](https://github.com/moby/go-archive/security/advisories/GHSA-hfg8-hc9c-6c3h),
[Go HTTP/2](https://pkg.go.dev/vuln/GO-2026-6611).
