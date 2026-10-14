# CommonJS adapter for upstream decode-uri-component 0.5.0

Downloaded from the official npm registry on 5 October 2026. `index.js`, `index.d.ts` and `license` are unmodified upstream files. `index.cjs` changes only the exported function declaration to `module.exports`; decoding logic is identical. Dual exports retain ESM support and allow the installed query-string 7 CommonJS consumer/Metro to use the patched linear scanner. Package metadata has been reduced to the runtime package and dual entry points. This is a local compatibility adapter, not an upstream CommonJS distribution.

Upstream advisory: https://github.com/advisories/GHSA-vcc3-ghjq-m6fr
Tarball: https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.5.0.tgz
Tarball SHA-256: f42d289f996e6c9f0e33d8f31de1fe9a7a077c612dca489cafdb2df4cbb6122f
