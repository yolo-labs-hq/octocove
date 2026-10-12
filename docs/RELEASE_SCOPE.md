# Release scope

The publication scope is **source-only**: Octocove source, documentation,
lockfiles, and dependency declarations/notices. It excludes `node_modules`, built
worker bundles, generated application JavaScript, native libraries, WASM binaries,
CLI executables, container images and OS package payloads. Installing dependencies
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
