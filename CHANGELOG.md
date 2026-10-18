# Changelog

Notable changes to this project are recorded here. This file summarizes repository changes and is not a release certification.

# 1.0.9-rc.2 — 2026-10-18 (pre-release)

- Added the immutable built-in `system-workflow-coordinator` role, outside custom-role persistence and CRUD; the custom-role API now reserves the `system-` namespace.
- Added `workflow_coordinator_role` and `workflow_coordinator_step`: approved runs can be dispatched/prepared from one high-level call, approved deterministic local steps are advanced with a bounded per-call budget, and specialist results/synthesis can be submitted while preserving approval, provenance, and strict JSON success gates.
- Added durable `execute_batch` to the shipped MCP runtime. Batch items are derived and validated against the approved immutable plan, then persisted with execution/session/exit evidence; prior individual executions are not retroactively grouped.
- Added the read-only ORBIT / OPS dashboard with workflow attention/status views, custom role and Agent Skills inspection, distinct batch versus individual-execution ledgers, event/artifact inspection, and a bounded local text/log browser. The dashboard uses a read-only SQLite connection, loopback-only binding, same-origin checks and local bundled assets; see [the operator guide](docs/local-dashboard.md).
- Added goal/constraint/success-criterion JSON predicates pinned to immutable plans and independently checked at synthesis; added bounded, versioned Agent Skills snapshots for custom roles. See the README for supported predicates, import limits, and permission boundaries.
- Added E2E coverage for pre-approval stop behavior, custom-role impersonation rejection, coordinator-managed dispatch/task transitions, and successful synthesis through the new API.
- Validation for this source snapshot: full `npm test` PASS; `npm run test:batch` PASS; packaged MCP initialize/tool discovery and extracted tool-schema validation PASS (37/37). Candidate SHA-256: `bf6ca642cfbf670a19353f79029d38b46311cf91df0c7742ad8ee49aec8f75e2`. This pre-release note is not a production-readiness certification.

# 1.0.9-rc.1 — 2026-10-18 (pre-release)

- Pre-release candidate built from the current `main` source after durable workflow-plan structure validation hardening.
- Includes SQLite durable state, immutable workflow plans, dependency-aware task execution, typed artifact/evidence validation, and recovery/terminalization checks.
- Package checks passed: MCP initialize + `tools/list` (33/33 tools), extracted tool-schema validation, lease-fencing regressions, shutdown/backpressure regressions, CASE-01 crash/restart recovery, and full local plugin E2E.
- This is a pre-release for controlled testing, not a production-readiness certification. Independent candidate review, formal release authorization, CASE-06 policy disposition, and native OpenClaw Gateway E2E remain open.

## Unreleased

- Added a per-run goal plus closed JSON predicate contract for built-in and custom workflow runs; supported predicate types cover immutable-plan checks, task completion/exit status, roles, and provenance-validated typed artifact fields. The normalized contract is pinned into the immutable execution plan hash.
- Added runtime PASS/FAIL evaluation at synthesis; claimed CTO statuses cannot override a failed predicate. Artifact predicates require matching active artifact IDs bound to successful durable results, while plan/task predicates are evaluated directly from the immutable plan and durable task rows.
- Added regression coverage for unknown predicate types, invalid fields/operators, plan-hash pinning, false claimed PASS results, mismatch/invalid evidence references, and malformed MCP input schemas; documented supported predicates and limits.
- Added optional multi-skill bundles for custom roles, imported from local directories or public GitHub skill folders/`SKILL.md` URLs; role versions pin bounded text snapshots and SHA-256 fingerprints, while role updates and clones preserve snapshots by default.
- Added Agent Skills frontmatter validation, import size/file caps, binary-file skipping, symlink rejection for local skill contents, read-only skill context injection, migration for existing SQLite role tables, and local/remote regression coverage.
- Documented role skill usage and the distinction between a role's contracts/permissions and supplementary skill instructions; imported scripts are never executed and skills do not expand runtime permissions.
- Hardened the versioned workflow-plan structural contract: phase identities must be unique and `required_children` must exactly match the child task identities.
- Expanded strict JSON parsing, dispatch/recovery reconciliation, lease fencing, output-commit binding, typed-artifact provenance, and worker filesystem-boundary regression coverage.
- Added an M12 native-specialist bridge boundary and documentation; a real Gateway-backed execution E2E remains a separate acceptance gate.
- Added repository contribution, security, conduct, known-issue, and CI documentation.
- **Not production-ready:** release identity, exact-scope authorization, independent review, CASE-06 policy disposition, static release validation, and authorization-audit reconciliation remain blocked. See [Known issues](docs/KNOWN_ISSUES.md).
