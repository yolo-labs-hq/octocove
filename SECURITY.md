# Security policy

## Supported versions

Before 1.0, security fixes target `main` and the current release branch, if one exists. Older release branches, tags and historical spike revisions are unsupported. Report an issue even if you are unsure whether it affects a supported version; include the exact commit or release.

## Private vulnerability reporting

Use [GitHub private vulnerability reporting](https://github.com/yolo-labs-hq/octocove/security/advisories/new): open the repository's **Security → Advisories → Report a vulnerability** form. Maintainers will coordinate through a private GitHub security advisory. Do not file public issues or PRs containing exploit details or credentials; no personal email disclosure route is used.

If the form is unavailable, do not post vulnerability details publicly: open a public issue that asks the maintainers for a private reporting channel, without any details of the vulnerability, and wait for them to provide one.

Include the affected component/version, impact, prerequisites and a minimal sanitized reproduction using disposable resources. Never include live tokens, customer data or absolute operator paths. Maintainers may ask for further details privately.

We aim to acknowledge reports within **3 business days**, provide initial triage within **7 business days**, and send progress updates at least every **14 days** while a confirmed report is open. These are response targets, not guaranteed fix dates. Severity, reproducibility and affected deployments determine remediation timing. We coordinate disclosure and advisory publication with the reporter after a fix or mitigation is available.

## Scope and known limits

In scope: this repository's CLI, client library, credential helper and shared code, and the hosted Octocove service they talk to (auth, broker, record and API, Git gateway and landing). Include attacks on authorization, exact-candidate approval, landing/receipt integrity, credential custody or cross-attempt/tenant boundaries. The YOLO Studio adapter and its runtime are external and out of scope here; report their vulnerabilities privately to that project's maintainers.

The credential boundary ([helper/broker contract](docs/HELPER_BROKER_CONTRACT.md)) is **accepted as a design**, not blanket implementation or runtime-isolation qualification. Local helper and gateway-proof tests do not qualify every client runtime or live provider. Two threats remain material: a sibling process under the same UID can read an attempt's credentials, and leaked server credentials can write directly upstream without passing the gateway. The overall boundary is unproven for a runtime until that runtime passes its isolation qualification. Do not infer safe shared-agent deployment from passing gateway policy tests.
