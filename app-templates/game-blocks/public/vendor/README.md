# Vendored: three.js r186

`three.module.min.js` is [three.js](https://threejs.org) 0.186.1 (MIT
licence, notice at the top of the file), the whole library as one minified
ES module: `three/build/three.module.js` bundled with esbuild
(`--bundle --format=esm --minify --legal-comments=inline`), so it loads
with no import map and from this app's own address, never a CDN.

Do not edit it. To move to a newer three.js, rebuild it the same way and
replace the file; `public/app.js` imports it as
`import * as THREE from './vendor/three.module.min.js'`. Add-ons from
`three/examples/jsm` import `'three'` by name, so copy one in only after
changing that import to this file's path.
