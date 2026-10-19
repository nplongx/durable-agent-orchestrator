# 1.0.9-rc.4 — Release notes draft

> **Publication status:** draft for a testing-only GitHub pre-release; no GitHub Release or version tag has been created. The pre-release tier uses the minimum checks in [Release policy](RELEASE_POLICY.md); this build is not production-approved and is not the project's official frozen artifact. Before publishing, rebuild or reconfirm the package against the exact intended tag commit and update the hash below if it changes.

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
- Repository-level documentation and regression checks recorded for the source commit are listed in the [candidate review dossier](review-candidate-1.0.9-rc.4.md).

## Artifact prepared for a potential release attachment

- Filename: `chat-on-steroids-local-orchestrator-1.0.9-rc.4-candidate-20261019T064500Z.mcpb`
- Size: `324398` bytes
- SHA-256: `dc40671ff74f9238bb8cbd89658e0dc72972fa4940951108f5469fd829c7b2a8`
- Source commit: `ade73e69626e3ce6d10386d97599765e47df8079`
- Candidate inventory: `benchmarks/plugin-workflow-benchmark/phase2-candidate-inventory-ade73e6-20261019T064655Z.json` (local ignored evidence file; SHA-256 `77f54e62e1c87fd6c63d37aeac605e08e12fed79d00351d007d44d58e83ced74`).

The `.mcpb` is a local ignored build output and is not committed to the repository. The exact file must be transferred and its SHA-256 independently verified before any review or attachment.

## Limitations and release status

- The formal Phase 2 readiness audit is still blocked. The official frozen artifact is absent, independent candidate review and CASE-06 policy disposition are missing, fresh exact-scope authorization is not established, and authorization-audit reconciliation remains outstanding.
- No production-readiness claim is made. Real Gateway-backed integration acceptance remains separate from local package tests.
- The strict Phase 2 `BLOCKED_NOT_READY` result remains in force for formal deployment/production release. Under the tiered [release policy](RELEASE_POLICY.md), that audit result alone does not prohibit a clearly labeled testing pre-release when all minimum checks pass. Do not describe the outstanding formal gates as passed, do not edit official audit/authorization records, and do not claim production readiness.
