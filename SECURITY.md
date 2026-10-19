# Security policy

## Supported development line

Security fixes are developed against the current default branch. Published plugin bundles and the working-tree source may differ; do not assume a candidate bundle has been reviewed or is a supported production release.

## Reporting a vulnerability

Please do **not** publish exploitable details, credentials, or a working attack sequence in a public issue. Use GitHub's private vulnerability-reporting option on this repository's **Security** tab when available. If private reporting is not enabled, contact the repository owner through a private GitHub channel before disclosing details publicly.

Include the affected commit/version, impact, prerequisites, a minimal safe reproduction, and any suggested mitigation. Redact tokens, personal data, database contents, and host-specific paths. Please allow maintainers a reasonable opportunity to investigate and prepare a fix before public disclosure.

## Security design notes

The [system architecture diagram](docs/diagrams/rendered/system-architecture.html) and [workflow policy lifecycle](docs/diagrams/rendered/workflow-policy-lifecycle.html) provide visual context for the runtime and policy boundaries. The [visual documentation index](docs/diagrams/README.md) links to all diagrams; code and enforcement tests remain authoritative.

- Workflow plan approval and execution approval are separate gates.
- Durable SQLite state and validated evidence, not model prose alone, determine terminal workflow status.
- Local execution contracts are structured and bounded; do not assume the plugin is an operating-system sandbox.
- Distributed-worker and native OpenClaw integration components are experimental until the explicit readiness gates documented in the repository have passed.
- A passing automated test suite is not a production security certification.
