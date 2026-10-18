# Changelog

Notable changes to this project are recorded here. This file summarizes repository changes and is not a release certification.

# 1.0.9-rc.1 — 2026-10-18 (pre-release)

- Pre-release candidate built from the current `main` source after durable workflow-plan structure validation hardening.
- Includes SQLite durable state, immutable workflow plans, dependency-aware task execution, typed artifact/evidence validation, and recovery/terminalization checks.
- Package checks passed: MCP initialize + `tools/list` (33/33 tools), extracted tool-schema validation, lease-fencing regressions, shutdown/backpressure regressions, CASE-01 crash/restart recovery, and full local plugin E2E.
- This is a pre-release for controlled testing, not a production-readiness certification. Independent candidate review, formal release authorization, CASE-06 policy disposition, and native OpenClaw Gateway E2E remain open.

## Unreleased

- Hardened the versioned workflow-plan structural contract: phase identities must be unique and `required_children` must exactly match the child task identities.
- Expanded strict JSON parsing, dispatch/recovery reconciliation, lease fencing, output-commit binding, typed-artifact provenance, and worker filesystem-boundary regression coverage.
- Added an M12 native-specialist bridge boundary and documentation; a real Gateway-backed execution E2E remains a separate acceptance gate.
- Added repository contribution, security, conduct, known-issue, and CI documentation.
- **Not production-ready:** release identity, exact-scope authorization, independent review, CASE-06 policy disposition, static release validation, and authorization-audit reconciliation remain blocked. See [Known issues](docs/KNOWN_ISSUES.md).
