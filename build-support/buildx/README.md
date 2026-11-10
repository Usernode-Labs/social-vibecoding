# Standalone Buildx security rebuild

The official v0.39.0-rc1 binary still embeds two advisory-bearing modules:
`github.com/docker/docker v28.5.2+incompatible` and
`github.com/moby/go-archive v0.2.0`. All three findings (#6556, #6557 and
#6558) are in this one binary, not the Kubernetes platform image.

The standalone Dockerfile builds the same upstream Buildx revision with the
small dependency patch in this directory. It retains BuildKit support, its
other upstream vendored dependencies, and the Go dependency build metadata.
No security exception or scanner suppression is added.

## Source and changes

- Buildx tag: `v0.39.0-rc1`; commit:
  `b708617c05822b226f952c4e223cf750cbbd4798`.
- Source archive:
  https://codeload.github.com/docker/buildx/tar.gz/b708617c05822b226f952c4e223cf750cbbd4798
- Archive SHA-256:
  `d2b5d92ff45929f83aad2f44ca045c887e61c2a851c72ee185ce68a13f118dd8`.
- The old Docker module supplies only the frozen random-name helper. Its
  source is moved unchanged into `internal/namesgenerator`, together with
  its Apache license and notices. The import, module requirement, sums and
  obsolete vendor entry are removed. No Docker daemon implementation is
  brought into Buildx.
- The two vendored compression source files are from go-archive `v0.3.3`.
  The module requirement, Go checksum entries and vendor manifest identify
  that patched release. Its other dependencies are already satisfied by the
  upstream tree; the build uses `-mod=vendor`, with no dependency resolution
  during compilation.
- go-archive module archive:
  https://proxy.golang.org/github.com/moby/go-archive/@v/v0.3.3.zip
- Module archive SHA-256:
  `15e0fbb71e965895562ac14c94a4f10d2900850cdecb63ebdbfa5575d2d90f9f`.
- Go checksum database entries:
  `h1:OxxR9paxsluYi+zDUEXTTaIxtkK3viymW+Ka7vRhhME=` and
  `go.mod h1:Npdv43fFqlhZW7Xo8fbm3ZMYFvAGNviUPqX21VERbcE=`.

The runtime binary identifies itself as `v0.39.0-rc1-homeroom.1` and retains
the upstream revision. The compiler is pinned to Go 1.26.10, the supported
1.26 patch returned by Go's release feed on November 10, 2026. The build
uses the target OS and architecture even when its compiler runs natively.

## Verification

Build `Dockerfile`'s `buildx-tools` target for linux/amd64 and linux/arm64.
`go version -m` must contain go-archive v0.3.3 and no old Docker module.
Scan the binary and finished standalone image with the existing image
security scripts; all three CVE matches must be absent. Preserve the full
scan reports, including any unrelated findings.

Run upstream `go test -mod=vendor ./store`, the patched compression package's
upstream tests, and a real Docker Buildx build through the replacement CLI
plugin. A future official release can replace this rebuild once it removes
the old module, includes the fixed archive library, and passes those checks.
