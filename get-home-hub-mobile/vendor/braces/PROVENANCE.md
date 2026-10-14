# Local security backport: braces 3.0.3

Runtime base from official npm tarball `https://registry.npmjs.org/braces/-/braces-3.0.3.tgz`, SHA-512 integrity `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==` verified before extraction on 9 October 2026. Original name/version and license retained. This is a local patched distribution, not a claimed upstream patched release. The manifest records hashes of the original and current files; the application's security verifier also pins the manifest hash.

Only runtime source, package metadata, original README and license are vendored. Upstream development dependencies/lifecycle scripts and prebuilt distributions are not shipped. Upstream tarball integrity and per-file hashes make the base reproducible. Local source remains subject to normal review. Remove this backport only after a compatible official release fixes the advisory and focused regressions pass.

## Bounded parser and recursive walkers

[Advisory GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) and [upstream issue 70](https://github.com/micromatch/braces/issues/70) recommend limiting nesting before recursive tree walking. This local mitigation uses a hard maximum of 128 levels, independent of caller options.

Modified runtime files: `lib/parse.js`, `lib/compile.js`, `lib/expand.js`, `lib/stringify.js`; added `lib/security-depth.js`. Parser guards cover both brace and parenthesis pushes. Every recursive walker increments/checks its own depth, also protecting direct AST entry points and child-node cycles. Existing stringify parent semantics are retained. The limit includes AST nodes, so a pattern at the parser boundary can still be rejected by a downstream walker if it has another nested leaf. Ordinary patterns remain compatible; excessive nesting now throws controlled SyntaxError. This addresses the reported stack-exhaustion vector, not arbitrary combinatorial expansion or all malicious caller-supplied object graphs.

Focused regressions cover 4000-level balanced/unbalanced/parenthesis patterns, bypass options, direct deep/cyclic ASTs, escaped literals, ordinary range/nested patterns and Metro's micromatch integration. Original MIT license retained.
