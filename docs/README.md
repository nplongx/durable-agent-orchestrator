# Documentation

This index is the starting point for users, operators, and contributors. Visit the [Runalith project website](https://nplongx.github.io/runalith/) for an overview, then use the guides below for implementation details. Pages are grouped by the question they answer rather than by the order in which the implementation was built.

## Getting started

- [Quickstart](quickstart.md) — build or connect the local MCP runtime and understand the first workflow steps.
- [Root README](../README.md) — project purpose, capabilities, security boundaries, commands, and navigation.
- [Testing pre-release notes for 1.0.9-rc.5](release-notes-1.0.9-rc.5.md) — Runalith package identity, compatibility and testing boundaries.

## Using the runtime

- [Workflow lifecycle and recovery](workflow-lifecycle.md) — proposal, explicit approval, task execution, diagnosing blockers, rework, and synthesis.
- [Hybrid engineering workflow](hybrid-engineering-workflow.md) — combine specialist reasoning with plan-bound deterministic execution.
- [Durable batch execution](batch-execution.md) — the `execute_batch` input contract, preconditions, result evidence, and limitations.
- [Agent Skills](agent-skills.md) — skill format, import sources, immutable snapshots, role bindings, and security limits.
- [Workflow policies](workflow-policies.md) — supported predicates, policy versions, attachment timing, evaluation, and audit behavior.
- [Local dashboard](local-dashboard.md) — start and configure the read-only UI, endpoints, and security boundaries.
- [MCP tool reference](MCP_REFERENCE.md) — generated tool index and full input schemas from the current `tools/list` response.
- [Terminology and naming compatibility](TERMINOLOGY.md) — product terminology and identifiers retained for compatibility.

## Understanding the implementation

- [Architecture](architecture.md) — runtime components, durable state, execution, and recovery boundaries.
- [Architecture illustrations](diagrams/README.md) — GitHub-rendered static PNGs that supplement the written explanation.
- [Release policy](RELEASE_POLICY.md) — minimum checks for experimental GitHub pre-releases versus formal frozen/production releases.
- [Known issues and release blockers](KNOWN_ISSUES.md) — current limits and outstanding gates; this is not a general feature roadmap.

## Contributing and maintaining documentation

- [Contributing guide](../CONTRIBUTING.md) — development environment, tests, safety, and pull request expectations.
- [Documentation rewrite workflow](DOCUMENTATION_WORKFLOW.md) — how to inventory, classify, write, verify, review, and maintain docs.
- [Security policy](../SECURITY.md) — reporting process and security boundaries.
- [Changelog](../CHANGELOG.md) — user-visible changes by release/candidate.

## Engineering plans and historical records

The remaining milestone (`m*`), phase (`p*`), proposal, implementation-plan, benchmark, and evidence files document development history or a scoped engineering effort. They are not current usage instructions by default and must not be treated as a single current specification. Before relying on one, check its scope and stated status, then verify behavior against the shipped code and tests. A plan or evidence packet is not proof that a feature is currently shipped or release-authorized. Do not modify historical evidence to make current status look cleaner.

### Architecture and design proposals

| Record | Intended use | Reading caution |
|---|---|---|
| [Agent architecture proposal](agent-architecture-proposal.md) | Historical design rationale and role/orchestration proposal | A proposal is not a contract for every current runtime path. |
| [M0 architecture freeze](m0-architecture-freeze.md) | Baseline architecture and compatibility decisions | Freeze/milestone language describes its original scope; verify current invariants in code. |
| [M1 agent contract layer](m1-agent-contract-layer.md) | Earlier agent contract design | Later milestones may change enforcement; inspect the current contract modules and tests. |
| [M3 requirements/research/architecture](m3-requirements-research-architecture.md), [M4 engineer](m4-engineer.md), [M4 progress](m4-progress.md), [M5 specialist verification](m5-specialist-verification.md), [M6 reviewer](m6-reviewer.md), [M7 CTO](m7-cto.md), [M8 recovery/idempotency](m8-rework-recovery-idempotency.md), [M9 governance/permissions](m9-governance-permissions.md), [M10 observability](m10-observability.md) | Historical milestone contracts and progress notes | Use as milestone-specific design context, not as a substitute for current runtime tests. |
| [M11 native E2E plan](m11-native-e2e.md), [M11 QA evidence](m11-qa-worker-6-evidence.md) | Runner-boundary design and a dated QA record | The QA record describes its own test context; do not generalize it to current live integration. |
| [M12 broker architecture](m12-broker-architecture.md), [M12 native specialist bridge](m12-native-specialist-bridge.md), [M12 phase 1 patch notes](m12-phase1-openclaw-2026.9.5-patch.md), [M12 gateway admission](m12-phase1b-gateway-admission.md), [M12 core hook](m12-phase1b-openclaw-core-hook.md), [M12 phase 3 plan](m12-phase3-implementation-plan.md), [M12 production runner rollout](m12-production-runner-rollout.md) | Distributed-worker/native Gateway integration plans and contracts | These are separate from the local plugin mode unless a shipped integration and live acceptance evidence prove otherwise. |

### Distributed execution phases and benchmark records

| Record group | Files | Reading caution |
|---|---|---|
| P0–P4 contracts and runner setup | [P0 execution contract](p0-execution-contract.md), [P1 runner smoke](p1-runner-smoke.md), [P2 GitHub Actions provider](p2-github-actions-provider.md), [P3 worker protocol](p3-worker-protocol.md), [P4 evidence verifier](p4-evidence-verifier.md) | These describe phase-specific interfaces and evidence. They do not by themselves enable remote execution in the shipped local plugin. |
| P5–P9 distributed scheduling and delivery | [P5 task leases](p5-task-leases.md), [P6 distributed scheduler](p6-distributed-scheduler.md), [P7 LangGraph control loop](p7-langgraph-control-loop.md), [P8 autonomous delivery](p8-autonomous-delivery.md), [P9 resumable execution](p9-resumable-execution.md) | Check present code, deployment configuration, and live evidence before claiming these paths are operational. |
| P10–P14 performance and hardening | [P10 capacity benchmark](p10-capacity-benchmark.md), [P11 security hardening](p11-security-hardening.md), [P12 observability](p12-observability.md), [P13 failure injection](p13-failure-injection.md), [P14 idempotency audit](p14-idempotency-audit.md) | A plan, simulation, or audit packet is scoped evidence, not a blanket production certification. |
| Distributed provider integration | [GitHub Actions distributed-worker plan](github-actions-distributed-worker-implementation-plan.md), [GitHub Actions/OpenClaw contract matrix](github-actions-openclaw-contract-matrix.md) | The contract matrix explicitly records missing/unproven native Gateway requirements; do not infer a native provider from the presence of an adapter. |
| Workflow benchmark | [Benchmark plan](plugin-workflow-benchmark-plan.md), [tracked benchmark repository README](../benchmarks/plugin-workflow-benchmark/README.md), [paired-host harness contract](../benchmarks/plugin-workflow-benchmark/paired-host-harness-contract.md) | Keep benchmark identity and authorization separate from general test results. Local, ignored phase-freeze/preflight copies are not links for GitHub readers. Consult [known issues](KNOWN_ISSUES.md) for current release blockers. |

Use the [release policy](RELEASE_POLICY.md) to distinguish testing pre-releases from the production/frozen-release lane, [known issues](KNOWN_ISSUES.md) for current limitations, and the [`1.0.9-rc.4` candidate record](review-candidate-1.0.9-rc.4.md) for exact artifact evidence. A testing pre-release does not satisfy or override formal production release gates.

## Where facts come from

Runtime behavior is defined by the shipped MCP entrypoint, workflow contracts, storage and execution implementation, schemas, and tests. Documentation describes that behavior; it does not override it. If a page conflicts with the implementation, record the discrepancy and resolve it before presenting the claim as current.
