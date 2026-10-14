# Local security backport: node-forge 1.4.0

Runtime base from official npm tarball `https://registry.npmjs.org/node-forge/-/node-forge-1.4.0.tgz`, SHA-512 integrity `sha512-LarFH0+6VfriEhqMMcLX2F7SwSXeWwnEAJEsYm5QKWchiVYVvJyV9v7UDvUv+w5HO23ZpQTXDv/GxdDdMyOuoQ==` verified before extraction on 9 October 2026. Original name/version and license retained. This is a local patched distribution, not a claimed upstream patched release. The manifest records hashes of the original and current files; the application's security verifier also pins the manifest hash.

Only runtime source, package metadata, original README and license are vendored. Upstream development dependencies/lifecycle scripts and prebuilt distributions are not shipped. Upstream tarball integrity and per-file hashes make the base reproducible. Local source remains subject to normal review. Remove this backport only after a compatible official release fixes the advisory and focused regressions pass.

## Strict signature-data parsing

Only `lib/rsa.js` has changed runtime logic. It is byte-identical to the pinned postimage proposed in [digitalbazaar/forge PR 1157](https://github.com/digitalbazaar/forge/pull/1157), commit `683ab3344899cc08a581e4d5675a33e87aff7b04`, incorporating [PR 1152](https://github.com/digitalbazaar/forge/pull/1152), commit `ceba34402e329f0365134f23fe19898756527d65`. Both PRs were still **open/unmerged** when read; this project assumes maintenance responsibility for this reviewed local backport. It is not represented as maintainer-approved.

The validation change rejects extra nested DigestAlgorithm elements and nonempty NULL parameters. RSA primitives, padding algorithms, hash implementations and the rest of the runtime source are unchanged. No local rewrite of cryptographic algorithms. The upstream BSD-3-Clause OR GPL-2.0 license is preserved in LICENSE.

Focused local tests cover malformed nested data, nonempty NULL data, SHA-256/SHA-1/MD5 valid parameters, omitted SHA-256 parameters, required MD5 NULL parameters, mismatched digest and Expo certificate/manifest signing. Synthetic keys are generated in memory and never stored or used for distribution.

[Advisory GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) remains unreleased upstream; current local status is **backported mitigation verified**, not a blanket cryptographic audit.
