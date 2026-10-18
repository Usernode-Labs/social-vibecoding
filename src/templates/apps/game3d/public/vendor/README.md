# Vendored: three.js r170

`three.module.min.js` is the upstream `build/three.module.min.js` from
https://github.com/mrdoob/three.js, pinned at tag r170, taken from
https://unpkg.com/three@0.170.0/build/three.module.min.js on the day this
template was made. MIT licensed; the license header sits at the top of the
file.

It is vendored rather than loaded from a CDN because apps on Homeroom load
no cross-origin assets (see the platform conventions: fetch
`<platform domain>/claude.md`). `public/game.js` imports it by the
same-origin path `/vendor/three.module.min.js`.

To upgrade, replace the file with the new pinned build and update this
note.
