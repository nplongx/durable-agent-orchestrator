# Durable Agent Orchestrator

Durable Agent Orchestrator is a local-first MCP plugin for approval-gated agent workflows in Chat On Steroids. It keeps workflow state in SQLite, compiles approved proposals into immutable plans, schedules dependency-aware tasks, and checks durable evidence before a workflow can finish successfully.

The reasoning host remains Chat On Steroids. The plugin provides orchestration, persistence, policy enforcement, and a constrained local execution path; it is not a separate model service or a general-purpose remote runner.

## What it provides

- **Approval before execution.** Creating a proposal does not authorize dispatch. The plan must be explicitly approved.
- **Durable workflow state.** Tasks, approvals, results, typed artifacts, execution records, and audit events are stored locally in SQLite.
- **Dependency-aware work.** A task becomes ready only when its planned dependencies and evidence requirements are satisfied.
- **Evidence-based completion.** Independent runtime checks validate supported success predicates, artifact schemas, hashes, and producer lineage. A model's claim of success is not enough.
- **Reusable workflow policy.** Versioned policy packs can add supported constraints and success criteria to a proposal before approval.
- **Optional local dashboard.** A separate loopback-only web process provides read-only inspection of workflow state.

## Quick start

### Requirements

- Node.js **22.13 or newer** and npm.
- `tmux` only when running deterministic local execution tasks.
- Chat On Steroids to install and use the MCP plugin.

### Check out and test the project

```bash
git clone https://github.com/nplongx/durable-agent-orchestrator.git
cd durable-agent-orchestrator
npm ci
npm test
```

### Build a local plugin bundle

```bash
npm run pack:chat-on-steroids-plugin
```

The packer creates a uniquely named candidate bundle under `dist/`, validates the archive, smoke-tests the extracted MCP runtime, and runs the local acceptance checks. In Chat On Steroids, install that candidate for **local development/testing**, enable **Local Agent Orchestrator**, and select the workspace. Then refresh the Chat On Steroids Plugins connector in ChatGPT and call `orchestrator_health` followed by `workflow_catalog` to verify the connection.

Candidate bundles are not automatically approved releases. Do not use a candidate for a controlled benchmark or release unless the exact artifact has been authorized through that process.

For the full first-run walkthrough and troubleshooting, see the [Quickstart](docs/quickstart.md).

## How a workflow runs

1. **Propose:** `workflow_create` records a request without authorizing execution.
2. **Review and approve:** inspect the proposed work, then call `workflow_approve` to authorize and compile its immutable plan.
3. **Dispatch and execute:** `workflow_dispatch` starts the approved workflow. Tasks are released in dependency order; deterministic commands must come from plan-bound execution contracts.
4. **Inspect and recover:** use workflow, event, artifact, and diagnosis tools to inspect durable state. Failed or incomplete work remains failed or blocked until it is actually resolved.
5. **Synthesize:** `workflow_complete_synthesis` applies the required reviewer, typed-artifact, provenance, and success-contract gates before terminalizing the workflow.

The built-in `workflow_coordinator_step` API can drive much of this lifecycle one high-level step at a time. It does not bypass approval or replace the host assistant's reasoning. See the [workflow guide and feature references](docs/README.md#using-the-plugin).

## Documentation

Start at the [documentation index](docs/README.md). It separates user tasks, feature references, architecture explanations, contributor guidance, and historical engineering records.

| I want to… | Read |
|---|---|
| Install the plugin and run a first health check | [Quickstart](docs/quickstart.md) |
| Understand approval, execution, recovery and synthesis | [Workflow lifecycle and recovery](docs/workflow-lifecycle.md) |
| Understand the runtime and trust boundaries | [Architecture](docs/architecture.md) |
| Understand the deterministic batch tool | [Durable batch execution](docs/batch-execution.md) |
| Look up MCP tool inputs and schemas | [MCP tool reference](docs/MCP_REFERENCE.md) |
| Understand names vs. compatibility identifiers | [Terminology guide](docs/TERMINOLOGY.md) |
| Use custom roles and Agent Skills | [Agent Skills](docs/agent-skills.md) |
| Combine specialist reasoning with deterministic batch execution | [Hybrid engineering workflow](docs/hybrid-engineering-workflow.md) |
| Define and attach reusable workflow policies | [Workflow policies](docs/workflow-policies.md) |
| Run the read-only local dashboard | [Dashboard guide](docs/local-dashboard.md) |
| Contribute code or documentation | [Contributing](CONTRIBUTING.md) and [documentation workflow](docs/DOCUMENTATION_WORKFLOW.md) |
| Understand current release blockers and known limitations | [Known issues](docs/KNOWN_ISSUES.md) |

## Development commands

| Command | Purpose |
|---|---|
| `npm start` | Start the MCP stdio server for local development. |
| `npm test` | Run the local acceptance and regression suite. |
| `npm run test:protocol` | Test the structured execution protocol. |
| `npm run test:workflow-m4` | Test workflow-plan, role-input, artifact, and orchestrator contracts. |
| `npm run dashboard` | Start the optional read-only dashboard, normally at `http://127.0.0.1:8318`. |
| `npm run test:dashboard` | Run dashboard integration and security regression tests. |
| `npm run pack:chat-on-steroids-plugin` | Build and verify a local plugin candidate. |
| `npm run docs:check` | Check local Markdown links and documentation constraints. |

The MCP entrypoint uses newline-delimited JSON-RPC on stdin/stdout and does not open an HTTP listener. The dashboard is a separate process, binds to loopback only, and cannot approve, dispatch, or mutate workflows.

## Security and project status

The plugin is intended for controlled local development and testing; it is **not certified for production use**. Structured local execution and filesystem checks are defense-in-depth, not an operating-system sandbox. The dashboard is not an authenticated remote admin service, and best-effort output redaction cannot guarantee that every secret is detected.

A candidate may be published as an explicitly experimental GitHub pre-release once the separate minimum checks in the [release policy](docs/RELEASE_POLICY.md) pass; a `BLOCKED_NOT_READY` Phase 2 audit does not by itself veto this testing-only tier. Such a publication is not a production approval or an official frozen artifact. Formal independent review, authorization, policy disposition, deployment validation, and audit reconciliation remain required for the production/frozen-release tier. See [Known issues and release blockers](docs/KNOWN_ISSUES.md) and the [candidate record](docs/review-candidate-1.0.9-rc.4.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Security issues should follow [SECURITY.md](SECURITY.md). The project is distributed under the [MIT license](LICENSE).
