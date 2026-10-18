# Changelog

Notable changes to this project are recorded here. This file summarizes repository changes and is not a release certification.

## Unreleased

- Hardened the versioned workflow-plan structural contract: phase identities must be unique and `required_children` must exactly match the child task identities.
- Expanded strict JSON parsing, dispatch/recovery reconciliation, lease fencing, output-commit binding, typed-artifact provenance, and worker filesystem-boundary regression coverage.
- Added an M12 native-specialist bridge boundary and documentation; a real Gateway-backed execution E2E remains a separate acceptance gate.
- Added repository contribution, security, conduct, known-issue, and CI documentation.
- **Not production-ready:** release identity, exact-scope authorization, independent review, CASE-06 policy disposition, static release validation, and authorization-audit reconciliation remain blocked. See [Known issues](docs/KNOWN_ISSUES.md).
