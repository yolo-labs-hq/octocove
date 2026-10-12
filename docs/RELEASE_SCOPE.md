# Release scope

The publication scope is **source-only**: Octocove source, documentation,
lockfiles, and dependency declarations/notices, plus the two npm tarballs
described under [npm tarballs](#npm-tarballs). Apart from those tarballs it
excludes `node_modules`, built worker bundles, generated application JavaScript,
native libraries, WASM binaries, CLI executables, container images and OS
package payloads. Installing dependencies
from their upstream registries is separate from redistributing them in our release.
This document addresses dependency redistribution only.

**Container and binary redistribution is not qualified.** A locked npm license
inventory is not clearance for an image, executable or worker bundle. There is
no claim that an installed dependency or every optional platform variant ships.
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) and `third-party-licenses.json`
record the declared licences of the locked packages.

Before redistributing an image, executable or bundle, a distributor must:

- Pin base image **digests**, platform/architecture and build inputs. A mutable
  tag such as `node:20-bookworm-slim` is not a pin; inherited OS/Node packages are
  outside the npm inventory.
- Inventory exact apt package versions, transitive dependencies and license /
  copyright files, including `git` and `ca-certificates`. Record
  the apt repository snapshot used to build. Git is **GPLv2**; review its actual
  packaged components and satisfy corresponding-source and notice requirements
  when redistributing it. Include the inherited image's packages as well.
- Inspect the actual final files of each image, worker/client bundle, CLI or
  WASM release for the chosen platform. Record excluded build-only dependencies
  and bundled native sublibraries, not just npm wrapper declarations.
- Preserve upstream copyrights, license texts and applicable NOTICE files;
  qualify LGPL source/replacement/relinking requirements and MPL file-level
  source availability with exact upstream revisions, patches and instructions.
  Publish the corresponding-source location with the artifact, not merely a
  link to an unversioned project homepage.
- Publish an artifact-specific SBOM, checksums, build provenance, supported
  platforms, and a record linking the artifact digest to the source/notice
  bundle. Ensure web fonts and any copied compatibility data retain attribution.

`THIRD_PARTY_NOTICES.md` and `third-party-licenses.json` cover the committed
JavaScript lockfiles only (the package/version count is stated in the notices file).
Container bases, apt packages and libraries embedded within npm binaries are
outside that count. They require separate artifact inventories if redistributed. No AGPL declaration occurs in
the locked npm inventory; that says nothing about excluded components.

## npm tarballs

Two npm packages are the only distributed artifacts besides the source
repository. Both are Apache-2.0, built from this repository's own sources, and
contain no third-party code. Each tarball carries the repository `LICENSE` and
`NOTICE`, which `prepack` copies from the repository root. Neither package
declares runtime `dependencies`; the built JavaScript imports only Node.js
built-in modules (`node:*`). Both packages are still `"private": true`;
publishing follows [RELEASING.md](RELEASING.md).

**`@yolo-labs/octocove`** (`packages/cli`) contains exactly:

- `dist/octocove.mjs`: one ESM file that esbuild bundles from `packages/cli/src`,
  `packages/client/src` and `packages/shared/src`. These are all first-party
  sources from this repository. The bundle contains no source map and no code
  from `node_modules`. Its only imports are Node.js built-ins.
- `package.json`, `README.md`, `LICENSE`, `NOTICE`.

The CLI tarball needs no `THIRD_PARTY_NOTICES` file because nothing third-party
is inlined. The CLI build writes an esbuild metafile to
`packages/cli/build-meta/`, which is never packed. `tools/release-scan/pack_scan.py`
(the `npm-pack` CI job and the publish workflow) fails if any metafile input
falls outside those three source directories, including any `node_modules`
path. It also fails if the bundle imports anything other than a `node:` module
at runtime, or if the metafile does not match the packed bundle. A change that
starts bundling third-party code must ship that code's licence and copyright
notices in the tarball and update the gate and this section.

**`@yolo-labs/octocove-client`** (`packages/client`) contains exactly:

- `dist/**/*.js` and `dist/**/*.d.ts`: `tsc` output of `packages/client/src`,
  one file per source module, with no bundling and no source maps. This includes
  `dist/generated/openapi.d.ts` and `dist/generated/routing.{js,d.ts}`, which are
  generated from this repository's OpenAPI spec.
- `retry-policy.json`, `package.json`, `README.md`, `LICENSE`, `NOTICE`.

`pack_scan.py` enforces each file set (no other file may appear). It also runs
the release-scan detectors over every packed file and rejects source maps and
non-public manifests. The npm license inventory (`THIRD_PARTY_NOTICES.md`) covers
build and test tooling in the lockfile. None of that tooling ships in either
tarball.
