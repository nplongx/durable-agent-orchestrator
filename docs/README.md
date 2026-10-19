# Documentation

This index is the starting point for users, operators, and contributors. Pages are grouped by the question they answer rather than by the order in which the implementation was built.

## Getting started

- [Quickstart](quickstart.md) — install a local candidate, verify the MCP connection, and understand the first workflow steps.
- [Root README](../README.md) — project purpose, capabilities, security boundaries, commands, and navigation.

## Using the plugin

- [Hybrid engineering workflow](hybrid-engineering-workflow.md) — combine specialist reasoning with plan-bound deterministic execution.
- [Durable batch execution](batch-execution.md) — the `execute_batch` input contract, preconditions, result evidence, and limitations.
- [Agent Skills](agent-skills.md) — skill format, import sources, immutable snapshots, role bindings, and security limits.
- [Workflow policies](workflow-policies.md) — supported predicates, policy versions, attachment timing, evaluation, and audit behavior.
- [Local dashboard](local-dashboard.md) — start and configure the read-only UI, endpoints, and security boundaries.

## Understanding the implementation

- [Architecture](architecture.md) — runtime components, durable state, execution, and recovery boundaries.
- [Architecture illustrations](diagrams/README.md) — GitHub-rendered static PNGs that supplement the written explanation.
- [Known issues and release blockers](KNOWN_ISSUES.md) — current limits and outstanding gates; this is not a general feature roadmap.

## Contributing and maintaining documentation

- [Contributing guide](../CONTRIBUTING.md) — development environment, tests, safety, and pull request expectations.
- [Documentation rewrite workflow](DOCUMENTATION_WORKFLOW.md) — how to inventory, classify, write, verify, review, and maintain docs.
- [Security policy](../SECURITY.md) — reporting process and security boundaries.
- [Changelog](../CHANGELOG.md) — user-visible changes by release/candidate.

## Engineering plans and historical records

The remaining `m*`, `p*`, proposal, implementation-plan, benchmark, and evidence files document development history or a specific engineering effort. They are not all current usage instructions and must not be treated as a single current specification. Before relying on one, check its status, date, scope, and whether the implemented behavior is covered by current code and tests. A plan or evidence packet is not proof that a feature is shipped or authorized.

## Where facts come from

Runtime behavior is defined by the shipped MCP entrypoint, workflow contracts, storage and execution implementation, schemas, and tests. Documentation describes that behavior; it does not override it. If a page conflicts with the implementation, record the discrepancy and resolve it before presenting the claim as current.
