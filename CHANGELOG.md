# Changelog

Notable changes to this project are recorded here. This file summarizes repository changes and is not a release certification.

# 1.0.9-rc.4 — 2026-10-19 (review candidate; not published)

- Added the `hybrid-engineering` workflow template: nine dependency-ordered specialist tasks, optional pinned custom role/Agent Skill overlays, and two deterministic code-authored syntax checks executed together through durable ExecutionManager Batch Execution.
- Hardened immutable-plan checks for deterministic batch command and working-directory metadata, and retained pinned role-profile snapshots during workflow plan revalidation.
- Added regression coverage for the hybrid workflow, real batch evidence, tamper/mismatch rejection, package tool-schema parity, and deterministic package reproducibility.
- Includes the reusable workflow-policy pack and read-only ORBIT / OPS Policies view from the preceding candidate work.
- Added repository-wide Archify documentation: interactive system architecture, hybrid workflow, versioned policy lifecycle and repository-map diagrams, with static PNG previews and a regeneration helper. These are explanatory docs, not release-gate evidence.
- Local validation: `npm run test:protocol`, `npm run test:workflow-m4`, `npm test`, extracted MCP package smoke/schema validation, and package reproducibility. A post-install local workflow also completed 11/11 child tasks, both deterministic checks (exit code 0), and 11/11 durable recovery checks.
- Review-candidate SHA-256: `6910f1902b18b1c0a504a7c68a0c8f62b9d1243b2380e9da4b25ec54d24dd19c` (`325270` bytes; [candidate record](docs/review-candidate-1.0.9-rc.4.md)). This identifies the exact review candidate only; it is not a frozen artifact, authorized release, or production-readiness certification. Independent candidate review, formal exact-scope authorization, CASE-06 policy disposition, and authorization-audit reconciliation remain blocked; see [Known issues](docs/KNOWN_ISSUES.md).


# 1.0.9-rc.3 — 2026-10-19 (pre-release)

- Added reusable workflow policy packs with seven MCP tools for catalog/validation/create/list/get/version update and pre-approval attachment.
- Policy definitions use the existing closed JSON success predicate vocabulary; unknown or executable rule content and conflicting policy predicates fail closed. Immutable SQLite policy versions, policy attachments and append-only policy audit rows are recorded locally.
- Attached policy snapshots, exact versions, content hashes and merged predicate contract are pinned to the immutable execution plan. Plan validation re-computes the merged contract, while execution-plan loading verifies attachment-ledger and base-proposal binding. Policy changes never silently rewrite already-approved plans; attachment after approval/plan compilation is blocked.
- Added the ORBIT / OPS read-only Policies view and `GET /api/policies` endpoint for immutable versions, exact workflow pins, stored-snapshot integrity status and plan-bound violation history; expanded policy unit, MCP E2E, dashboard and extracted-tool-schema regression coverage.
- See [workflow policy pack documentation](docs/workflow-policies.md). Rules such as retry budgets and qualitative style checks are intentionally not advertised as machine-enforced without dedicated enforcement points.
- Validation: `TMPDIR="$HOME/.cache/cos-batch-test-tmp" npm test` PASS; `npm run test:protocol` PASS; `npm run test:batch` PASS; policy-contract and MCP policy E2E tests PASS; Dashboard read-only/API security tests PASS; packaged MCP smoke test and extracted tool-schema parity PASS (44/44); package regression suite including lease fencing, CASE-01 crash/restart, stdio framing/backpressure and extracted-plugin E2E PASS. Final reviewed candidate SHA-256: `b5f6fbbb06a1eeaec6bea6ecaef8d8036b2f96cf0c52f206bf6395798d8f1bde`. This is not a production-readiness certification.

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
