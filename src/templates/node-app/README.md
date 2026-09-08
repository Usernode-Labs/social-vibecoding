# Locked app build inputs

These are source inputs for `getTemplateFiles`, not this repository's runtime
dependencies. The generator copies the package and lockfile into each new
app, replacing only the root package name and description. Existing apps and
forks are not migrated or rewritten.

Docker and Paketo use the same `npm run build` entrypoint; Tailwind 3.4.17 is
a locked development dependency. Docker installs it only in the CSS build
stage. The runtime stage installs production dependencies with `npm ci`.
Generated CSS remains ignored and is rebuilt for every image.
The project descriptor excludes `node_modules` without a trailing slash:
pack otherwise leaves an empty directory, causing Paketo to select
`npm rebuild` instead of the lockfile-backed clean install.

To deliberately refresh dependencies, edit this package manifest and run
`npm install --package-lock-only --ignore-scripts` in this directory, then
review the manifest/lock diff and run the template tests. Do not refresh this
lockfile incidentally when changing unrelated platform dependencies.

At introduction, `npm audit` reports three moderate advisories in the
existing Express/body-parser/qs dependency chain (none high or critical).
The existing runtime dependency ranges were retained for this build fix;
review those advisories separately before publishing the new template.

SV's Kubernetes adapter selects `ensure:shell` before `build` to preserve the
platform self-app's prerender/CSS ordering. The infra-owned compatibility
buildpack covers legacy apps whose compilation only exists in a Dockerfile.
It does not make arbitrary Dockerfiles executable by kpack.
