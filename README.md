# Chat On Steroids — Local Agent Orchestrator

An MCP plugin for Chat On Steroids that manages approval-gated, durable agent workflows entirely on the local machine.

**The plugin is the product entrypoint.** It speaks MCP over stdio, stores workflow state in SQLite, asks for explicit approval before dispatch, follows a dependency-aware task plan, records typed artifacts and results, and only terminalizes a workflow when durable evidence satisfies the release checks.

## Local-first architecture

```text
Chat On Steroids / ChatGPT
        │ MCP stdio
        ▼
Local Agent Orchestrator plugin
        ├── WorkflowStore ── SQLite under ~/.chat-on-steroids/agent-orchestrator
        ├── Approval + immutable workflow plan
        ├── Dependency-aware local task queue
        ├── Typed artifacts, result history, audit events
        └── ExecutionManager ── local tmux + local workspace only
```

There is no cloud worker, GitHub Actions dispatch, remote runner, external model API, or HTTP listener in the plugin entrypoint. Reasoning happens in Chat On Steroids; local code/file tools do the actual workspace work; the plugin owns durable workflow state and evidence. It does not invent OpenClaw session or run IDs.

## Install as a local plugin

In Chat On Steroids:

1. Build a local candidate bundle with `npm run pack:chat-on-steroids-plugin`. The packer uses a unique `*-candidate-<UTC timestamp>.mcpb` filename by default, validates the staged archive and runtime, then publishes without overwriting an existing path.
2. In Chat On Steroids, open **Plugins** and install the candidate only for local development/testing. For a benchmark or controlled release, install only the exact artifact approved through that process; a candidate build is not automatically a frozen or authorized release.
3. Enable **Local Agent Orchestrator** and select the local workspace in plugin settings.
4. Refresh the **Chat On Steroids Plugins** connector in ChatGPT.

Build the candidate with `npm run pack:chat-on-steroids-plugin`; the pack step verifies the archive, smoke-tests the extracted MCP runtime and runs the local integration suite before publishing. Set `PLUGIN_BUNDLE_OUT` to select a distinct candidate path. The Phase 1 frozen path `dist/chat-on-steroids-local-orchestrator-1.0.8.mcpb` is explicitly protected and cannot be recreated by this script.

Requirements: Node.js 22.13+; `tmux` is needed only for approved deterministic execution tasks. No server port, cloud credentials, or model API key is required by the plugin.

## Run locally / test the MCP entrypoint

```bash
npm start       # development stdio server
npm test        # isolated local-only E2E test
npm run pack:chat-on-steroids-plugin  # creates the installable MCPB bundle
```

The process speaks newline-delimited JSON-RPC on stdin/stdout; diagnostic output goes to stderr. It does not listen on port 8318.

Run the isolated end-to-end plugin acceptance test:

```bash
npm test
```

The test creates a temporary SQLite database and workspace, exercises the MCP handshake, explicit approval, planning, dependency-gated task completion, typed artifacts, synthesis, and terminalization, then removes only its own temporary directory. It does not dispatch a workflow to any external service.

## Main tools

| Tool | Purpose |
|---|---|
| `orchestrator_health` | Local runtime/storage status and local-only mode declaration |
| `workflow_catalog` | List supported workflow templates |
| `workflow_create` | Create a proposal without approving it |
| `workflow_approve` | Approve the proposal and compile the immutable plan |
| `workflow_dispatch` | Start the local workflow and durable coordinator task |
| `workflow_prepare_tasks` | Create/recover planned child tasks |
| `workflow_next_task` | Return the next dependency-ready task and predecessor results |
| `workflow_complete_task` | Persist the real task result and typed artifact |
| `task_execute_local` | Run an approved deterministic structured command locally |
| `workflow_complete_synthesis` | Validate and terminalize the workflow after required evidence is present |
| `workflow_get`, `workflow_events`, `workflow_artifacts` | Inspect state and evidence |

## Built-in engineering evidence contracts

The `engineering` (Engineering M4) and `standard-engineering` templates compile version 2 immutable plans with nine specialist roles: product owner, researcher, architect, engineer, security, QA, platform, writer, and reviewer. The reviewer depends on security, QA, platform, and writer; those dependencies transitively include requirements, research, architecture, and implementation producers.

Plan validation rejects a built-in engineering role input without a producer in its transitive dependency graph. The runtime does not issue the reviewer task until each of its seven required input artifacts is active, schema/hash-valid, and bound to exactly one successful producer result. The review artifact durably references those upstream artifacts and its own result. CTO synthesis and recovery verification re-check reviewer evidence provenance; an `accept` decision alone cannot bypass missing, substituted, or invalid evidence.

## Custom roles (Phase 1)

Custom role definitions are stored in the plugin's local SQLite database. They support a stable slug ID, display name, description, system prompt, input artifact contract, output artifact type, declared capabilities, a restricted permission set, an allowlist of read-only workflow tools, and immutable numbered versions.

| Tool | Purpose |
|---|---|
| `custom_role_create` | Create version 1 after schema and policy validation |
| `custom_role_get` | Read the latest version or a specific version |
| `custom_role_list` | List latest roles or all versions |
| `custom_role_update` | Store a new version without mutating prior versions |
| `custom_role_clone` | Copy a role into a new, independent role ID |

Custom roles are stored as immutable versions. Their permissions are intentionally limited to `workspace.read` and `artifact.create`; declared tools come from a read-only allowlist. A role definition cannot grant shell execution or workspace-write permission.

## Custom workflows (Phase 2)

Phase 2 adds versioned custom workflow definitions that reference custom roles by immutable role version. Each task declares an ID, input contract, output artifact type, and dependencies. Validation rejects unknown dependency IDs, dependency cycles, incompatible predecessor artifact contracts, unsupported role inputs, and task output types that do not match the referenced role.

The `custom_workflow_create`, `custom_workflow_update`, `custom_workflow_get`, `custom_workflow_list`, and `custom_workflow_clone` tools manage definitions. `custom_workflow_preview` creates a persisted immutable plan snapshot with role versions pinned and a SHA-256 hash; `custom_workflow_approve` records explicit approval for that exact preview.

Phase 3 integrates approved custom workflow plans into the existing local dependency-aware execution engine. Use `custom_workflow_run_create` with a plan that has already been approved using `custom_workflow_approve`; then separately call `workflow_approve` on the returned `job_id` before `workflow_dispatch`. The execution plan pins the custom workflow and role versions and preserves dependencies and typed artifact checks. Custom roles remain host-conversation reasoning tasks; their declared permissions do not grant new runtime tools, shell execution, or workspace-write access. Deterministic local execution remains available only when a built-in plan supplies its own structured execution contract.

The `execution_enabled` field reports whether the Phase 3 custom-workflow engine is available, not whether a specific run is authorized. `execution_authorized` remains `false` for definitions, previews, approved plans, and newly created proposals; it becomes `true` only after the separate `workflow_approve` call, and remains true on dispatch. Plan approval alone never authorizes execution.

## Persistence and safety

- Default data directory: `~/.chat-on-steroids/agent-orchestrator/`.
- Override paths with `CHAT_ON_STEROIDS_DATA_DIR`, `CHAT_ON_STEROIDS_WORKFLOW_DB`, `CHAT_ON_STEROIDS_EXECUTION_TMP_DIR`, and `CHAT_ON_STEROIDS_WORKSPACE`. These plugin-specific variables keep its SQLite state isolated from legacy adapter environment settings.
- A workflow is not executed until `workflow_approve` is called explicitly.
- The task queue follows the immutable plan's dependencies; it does not accept out-of-order completion.
- Model-completed tasks must provide a role-specific typed artifact. Deterministic tasks must use the stored structured executable/argument contract; arbitrary shell commands are not accepted by `task_execute_local`.
- Local execution output, task attempts, results, artifacts, approvals, and terminalization events are durable in SQLite.
- Results and artifact text returned to the model are bounded and common credential patterns are redacted.
- Failed or incomplete work stays failed/blocked; it is never converted into a successful terminal state just because the model says it succeeded.

## Project status and boundaries

The local MCP workflow is suitable for controlled local development and testing. It is **not yet certified for production use**. Passing unit/integration tests does not establish autonomous specialist quality, real OpenClaw/Gateway execution, external delivery, or exactly-once external side effects. Experimental distributed-worker and M12 integration work is documented separately and is not enabled by the local plugin entrypoint.

Release and benchmark gates remain blocked until the frozen release artifact is identified, exact-scope authorization and independent review are recorded, the CASE-06 policy disposition is verified, and the authorization audit trail is reconciled. See [Known issues and release blockers](docs/KNOWN_ISSUES.md) and the [M12 native specialist bridge boundary](docs/m12-native-specialist-bridge.md).

## Source layout

```text
plugin/manifest.json             # Chat On Steroids MCP plugin manifest
server/index.js                  # stdio MCP entrypoint and tool surface
src/runtime/job-store.js         # SQLite source of truth and lifecycle guards
src/runtime/execution-manager.js  # local deterministic execution + evidence
src/runtime/workflow/             # workflow definitions, plans, artifact contracts
protocol/                         # structured execution protocol schemas
tests/test-chat-on-steroids-plugin.js # isolated end-to-end MCP acceptance
```

The pack step verifies the archive contents and runs a fresh stdio handshake against the extracted bundle. The package excludes the legacy HTTP adapter and retired cloud-provider runtime.

## License

MIT — see `LICENSE`.

## Contributing and support

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Known issues and release blockers](docs/KNOWN_ISSUES.md)
