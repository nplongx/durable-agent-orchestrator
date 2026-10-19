# Local Agent Orchestrator 1.0.9-rc.4 (Testing Pre-release)

> **TESTING ONLY — NOT FOR PRODUCTION.** This candidate is an experimental GitHub pre-release under the [tiered release policy](https://github.com/nplongx/durable-agent-orchestrator/blob/main/docs/RELEASE_POLICY.md). It is not the official frozen artifact and has not passed the formal Phase 2 production/deployment readiness audit.

## Highlights

- Adds the `hybrid-engineering` workflow template with dependency-ordered specialist roles, optional pinned custom-role/Agent-Skill overlays, and deterministic syntax checks orchestrated through durable batch execution.
- Hardens immutable-plan validation for deterministic batch commands and working directories, and improves workflow recovery and diagnosis guidance.
- Adds reusable, versioned workflow policy packs and a read-only dashboard view for policy versions, attachments, and plan-bound violations.
- Expands regressions for workflow recovery, lease fencing, typed artifact provenance, MCP stdio framing/backpressure/shutdown, and package reproducibility.
- Improves generated MCP tool-reference parity checks and Markdown link checking, including reference-style Markdown links and an opt-in external URL check.

## Validation recorded for the candidate

- Two independent validated package builds were byte-identical.
- Bundle MCP initialization and tool discovery passed: 46/46 manifest tools.
- Extracted-package tool-schema validation passed: 46/46.
- Package-path lease-fencing, stdio framing/backpressure/shutdown, hybrid-engineering E2E, CASE-01 recovery, and local plugin E2E checks passed.
- Repository-level documentation and regression checks recorded for the source commit are listed in the [candidate review dossier](https://github.com/nplongx/durable-agent-orchestrator/blob/main/docs/review-candidate-1.0.9-rc.4.md).

## Release artifact

- Filename: `chat-on-steroids-local-orchestrator-1.0.9-rc.4.mcpb`
- Size: `324541` bytes
- SHA-256: `bfb68c11317dc394f6d1ea85368a801dc9f6f473974e34e96d02736747776552`
- Source identity: release tag `v1.0.9-rc.4` (the archive and source inventory were built from the tag target commit).
- Checksum sidecar: `chat-on-steroids-local-orchestrator-1.0.9-rc.4.mcpb.sha256`
- Candidate inventory: `benchmarks/plugin-workflow-benchmark/phase2-candidate-inventory-v1.0.9-rc.4-20261019.json` (supplemental evidence only; marked unapproved and not an independent review or authorization record).

Download the `.mcpb` and `.sha256` sidecar from this release and verify them together before installing. The package is not the official frozen artifact.

## Limitations and release status

- The formal Phase 2 readiness audit remains `BLOCKED_NOT_READY` for production/deployment use. Outstanding blockers include official frozen-artifact custody, independent review, fresh exact-scope authorization, CASE-06 policy disposition, host preflight/static deployment validation, and authorization-audit reconciliation. This pre-release does not claim any of those gates passed.
- No production-readiness claim is made. This candidate passed local package runtime smoke, 46/46 tool discovery/schema checks, package regressions and local plugin E2E, but it has not undergone an independent installation-and-acceptance test against a live OpenClaw Gateway for this exact RC. Real Gateway-backed integration acceptance remains a separate gate.
- The strict Phase 2 `BLOCKED_NOT_READY` result remains in force for formal deployment/production release. Under the tiered [release policy](https://github.com/nplongx/durable-agent-orchestrator/blob/main/docs/RELEASE_POLICY.md), that audit result does not alone veto a testing pre-release once minimum checks pass. Do not describe outstanding formal gates as passed, edit official audit/authorization records, or claim production readiness.
