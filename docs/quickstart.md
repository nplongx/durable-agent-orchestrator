# Quickstart

This guide takes a contributor from a clean checkout to a locally tested MCP runtime. It does not authorize a real workflow or a release.

## Prerequisites

- Node.js **22.13 or newer** and npm.
- An MCP-compatible client for stdio integration.
- `tmux` only if you intend to exercise deterministic local execution tasks.

## 1. Install dependencies and run tests

```bash
git clone https://github.com/nplongx/runalith.git
cd runalith
npm ci
npm test
```

The tests use local fixtures and verify the current contracts. A passing suite does not certify autonomous worker quality, live service integration, exactly-once external effects, or production readiness.

## 2. Build a candidate MCPB

```bash
npm run pack:runalith-mcpb
```

The packer creates a uniquely named `.mcpb` under `dist/`, validates the archive, smoke-tests the extracted MCP entrypoint, validates all declared tool schemas, and runs package regressions. Use the exact path and SHA-256 printed by the command. The `.mcpb` extension identifies a bundle format; it is not a vendor-specific runtime protocol. Installation of a bundle depends on which formats the client supports.

## 3. Connect over stdio

For clients that launch an MCP stdio server directly, configure the server with the absolute path to `server/index.js`. Example configuration (adapt the outer shape to your client):

```json
{
  "mcpServers": {
    "runalith": {
      "command": "node",
      "args": ["/absolute/path/to/runalith/server/index.js"],
      "env": {
        "RUNALITH_DATA_DIR": "/absolute/path/to/private/runalith-data",
        "RUNALITH_WORKSPACE": "/absolute/path/to/workspace"
      }
    }
  }
}
```

Use a private data directory and a dedicated workspace. If your client supports MCPB installation, you can install the built bundle through the client's own package-management UI; the steps are client-specific. Once connected, call `orchestrator_health`, then `workflow_catalog`.

The runtime speaks newline-delimited JSON-RPC on stdin/stdout and does not open an HTTP listener. Port `8318` belongs to the optional dashboard only.

## 4. Understand the approval boundary

1. Call `workflow_create` to create a proposal. This does not authorize execution.
2. Inspect the returned proposal and intended work. Continue only when the plan is acceptable.
3. Call `workflow_approve` to explicitly approve the proposal and compile its immutable plan.
4. Call `workflow_dispatch` to start the approved workflow, or use `workflow_coordinator_step` to advance its lifecycle.
5. Inspect task state, events, results and artifacts. Successful completion requires runtime evidence and synthesis gates; a narrative claim is not proof.

Start with `workflow_catalog` to inspect available templates. When experimenting, use a disposable workspace and a low-risk task. Do not point local execution at a production checkout or sensitive data directory.

### Mandatory batch execution for deterministic tasks

When an approved plan contains deterministic local `ExecutionManager` tasks, inspect its pinned `batch_execution_policy` before execution. New schema-v2 plans record the route and evidence requirements in the immutable plan hash. Eligible tasks go through `execute_batch` only; do not use `task_execute_local` as a fallback. The batch API accepts one through 32 prepared task IDs, so a one-item batch is valid.

For code-writing workflows, preflight is expected to require exact deterministic validation task contracts. After execution, inspect per-item results and durable evidence rather than trusting a narrative summary. If approval predates the policy schema, preserve its original plan hash and diagnose the workflow rather than rewriting its stored plan.

**Current change status:** not release-ready. Retry-lineage verification, broader fingerprint roots, direct-completion binding checks, policy-denial audits and schema-v1 migration guards have been updated. Regression fixtures now cover missing/mismatched completion bindings, root-wrapper drift and full synthesis after a same-ID batch retry. No tests, syntax checks, documentation generation or docs checks have run. Preserve the approved plan hash. Run validation only after a separate immutable plan pins exact commands and is explicitly approved; dispatch the approved deterministic tasks only through `execute_batch`.

## 5. Optional: start the read-only dashboard

In a separate terminal:

```bash
npm run dashboard
```

Open the URL printed by the server (default: `http://127.0.0.1:8318`). The dashboard reads SQLite records and exposes no approval, dispatch, or mutation controls. Keep it on loopback; it is not designed to be exposed remotely. See the [dashboard guide](local-dashboard.md).

## Next steps

- [Architecture](architecture.md) explains runtime and durable-state boundaries.
- [Workflow policies](workflow-policies.md) explains supported constraints and success predicates.
- [Agent Skills](agent-skills.md) explains how role guidance is imported, versioned and bounded.
- [Contributing](../CONTRIBUTING.md) describes tests and review expectations.
- [Release policy](RELEASE_POLICY.md) explains the difference between testing pre-releases and production approval.

Building or installing a candidate is not release approval. Follow the release policy and [known issues](KNOWN_ISSUES.md) before relying on an artifact outside controlled testing.