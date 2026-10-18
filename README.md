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
        ├── Immutable System Workflow Coordinator role
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
| `workflow_coordinator_role` | Inspect the immutable built-in system coordinator role (not stored in custom-role CRUD) |
| `workflow_coordinator_step` | Drive an approved workflow lifecycle in one high-level step; submit task results or synthesis and let the plugin advance dependencies |
| `workflow_create` | Create a proposal without approving it |
| `workflow_approve` | Approve the proposal and compile the immutable plan |
| `workflow_dispatch` | Start the local workflow and durable coordinator task |
| `workflow_prepare_tasks` | Create/recover planned child tasks |
| `workflow_next_task` | Return the next dependency-ready task and predecessor results |
| `workflow_request_reviewer_revision` | Create a linked reviewer revision when a standard-engineering v2 review is accepted but blocked solely by documented `evidenceIssues` |
| `workflow_complete_task` | Persist the real task result and typed artifact |
| `task_execute_local` | Run an approved deterministic structured command locally |
| `workflow_complete_synthesis` | Validate and terminalize the workflow after required evidence is present |
| `workflow_get`, `workflow_events`, `workflow_artifacts` | Inspect state and evidence |

### Built-in System Workflow Coordinator

The `system-workflow-coordinator` role is compiled into the plugin and returned by `workflow_coordinator_role`; it is not inserted into `custom_role_versions`. The custom-role API reserves the `system-` namespace, so users cannot create, update or clone a custom role that impersonates this role. The role contract is versioned with the plugin source, not with user-managed role data.

Use `workflow_coordinator_step` as the primary lifecycle API. Before approval it returns `AWAITING_APPROVAL` and does not dispatch. After `workflow_approve` has explicitly authorized the immutable plan, the coordinator step can dispatch it, prepare its planned tasks, and execute only approved deterministic local tasks. For reasoning tasks it returns the current role-specific instructions and completed predecessor evidence. Submit the actual result through `task_result`; the coordinator persists it and advances to the next dependency-ready task. When all planned work passes the existing reviewer/QA checks, it returns the synthesis contract; submit the CTO artifact through `synthesis` to invoke the same independent success-contract evaluator and terminalization gates.

This removes the need for the host assistant to manually orchestrate every low-level dispatch/prepare/next/complete call. It does **not** run a separate model in the plugin: Chat On Steroids remains the reasoning host, and the built-in role is a fixed system-level coordination contract for that assistant. Human approval, immutable plans, typed evidence, and runtime PASS/FAIL checks remain mandatory.

## Built-in engineering evidence contracts

The `engineering` (Engineering M4) and `standard-engineering` templates compile version 2 immutable plans with nine specialist roles: product owner, researcher, architect, engineer, security, QA, platform, writer, and reviewer. The reviewer depends on security, QA, platform, and writer; those dependencies transitively include requirements, research, architecture, and implementation producers.

Plan validation rejects a built-in engineering role input without a producer in its transitive dependency graph. The runtime does not issue the reviewer task until each of its seven required input artifacts is active, schema/hash-valid, and bound to exactly one successful producer result. The review artifact durably references those upstream artifacts and its own result. CTO synthesis and recovery verification re-check reviewer evidence provenance; an `accept` decision alone cannot bypass missing, substituted, or invalid evidence.

For standard-engineering plan v2+, `workflow_request_reviewer_revision` is a narrowly scoped recovery path for a review that is otherwise accepted but remains blocked solely by a non-empty `evidenceIssues` list. The runtime checks approval, active CTO ownership, completed task state, reviewer provenance, and the accepted review fields; it then invalidates the prior active review artifact and creates a new linked reviewer task under the same immutable plan. The old task/result/artifact remains in history, while the revision chain is validated during task discovery, synthesis, and recovery. This tool cannot revise rejected reviews, clear implementation/security/blocking findings, change the plan, or bypass independent synthesis/success-contract gates. Report non-blocking test limitations in the revised review's `limitations` field and clear `evidenceIssues` only when the reviewer can substantiate that no required evidence remains missing or invalid.

## Goal, constraints, and success criteria (strict JSON predicates)

Every run pins a `success_contract` into its immutable plan. `workflow_create` and `custom_workflow_run_create` accept `goal` plus optional `constraints` and `success_criteria`. Each check is a **closed JSON predicate** with a unique `id` and a `type`; the type determines which other fields are allowed and how the runtime computes PASS/FAIL. Free-text-only check definitions and unknown predicate types are rejected.

Example for the built-in `standard-engineering` workflow:

```json
{
  "title": "Harden the local workflow",
  "task": "Add stronger completion checks and regression tests.",
  "goal": "Release only after the expected QA evidence exists and all planned tasks finish.",
  "constraints": [
    { "id": "local-only", "type": "local_execution_only" }
  ],
  "success_criteria": [
    {
      "id": "qa-accepts",
      "type": "artifact_field_equals",
      "artifact_type": "qa-report",
      "field": "decision",
      "expected": "accept"
    },
    {
      "id": "qa-task-finished",
      "type": "task_status_equals",
      "task_id": "standard-qa",
      "expected": "completed"
    },
    { "id": "all-work-finished", "type": "all_tasks_completed" }
  ]
}
```

Supported predicate types:

| `type` | Required fields | Runtime evaluation |
|---|---|---|
| `all_tasks_completed` | none | Every child slot in the immutable plan maps to a completed durable task. |
| `local_execution_only` | none | Every planned child uses an approved local execution contract. |
| `workflow_id_equals` | `expected` | Exact match against immutable `plan.workflow_id`. |
| `task_status_equals` | `task_id`, `expected: "completed"` | Exact planned task slot resolves to a completed durable task. |
| `execution_exit_code_equals` | `task_id`, `expected: 0` | Exact planned task has durable execution status `completed` and numeric exit code `0`. |
| `task_role_present` / `task_role_absent` | `role` | Checks the immutable plan's role list. |
| `artifact_exists` | `artifact_type`; optional `producer_role` | Requires an active, schema/hash-valid artifact bound to a successful durable result. |
| `artifact_field_equals` | `artifact_type`, `field`, `expected`; optional `producer_role` | Exact scalar comparison against a top-level field of an eligible artifact. |
| `artifact_field_includes` | `artifact_type`, `field`, `expected`; optional `producer_role` | The named artifact field must be an array containing the exact scalar value. |
| `artifact_field_non_empty` | `artifact_type`, `field`; optional `producer_role` | The named artifact field must contain a non-empty string, array, or object. |

The `field` operator is limited to a single top-level JSON property; arbitrary JSONPath, executable expressions and shell snippets are intentionally not supported. `expected` is a scalar string/number/boolean. For task-based checks, `task_id` means the immutable plan task ID (for example `standard-qa`), not the generated SQLite task ID.

After approval, the normalized predicates are part of the plan hash and are passed to role/CTO instructions. If at least one check is present, `workflow_complete_synthesis` requires `artifact.success_assessment` with `goal_status: "achieved"`, a row for each criterion (`status: "met"`) and a row for each constraint (`status: "satisfied"`). Each row contains exactly `id`, `status`, and `evidence_refs`. For `artifact_*` predicates, `evidence_refs` must include the exact artifact IDs that satisfy the predicate. For predicates read directly from the immutable plan or durable task state, `evidence_refs` must be an empty array; the runtime evaluates those facts itself. The runtime independently computes every predicate — a claimed status cannot override a failed comparison. Unknown fields/types, duplicate or missing IDs, failed predicates, wrong statuses, and invalid/mismatched evidence references block terminalization.

This gate supplements the existing approval, dependency, typed-artifact, provenance, specialized QA, and reviewer gates. It makes supported predicates deterministic, but it does not infer arbitrary semantic requirements from the `goal` prose; phrase measurable requirements as the supported predicates or a dedicated QA/reviewer contract. A goal by itself and older stored proposals remain compatible, but strict success assessment is activated only when at least one constraint or criterion is declared.

## Custom roles (Phase 1)

Custom role definitions are stored in the plugin's local SQLite database. They support a stable slug ID, display name, description, system prompt, input artifact contract, output artifact type, declared capabilities, a restricted permission set, an allowlist of read-only workflow tools, optional Agent Skills bundles, and immutable numbered versions. A role does not need extra files to exist; skills are optional reusable instruction packs that supplement the role's core system prompt and typed input/output contract.

| Tool | Purpose |
|---|---|
| `custom_role_create` | Create version 1 after schema and policy validation |
| `custom_role_get` | Read the latest version or a specific version |
| `custom_role_list` | List latest roles or all versions |
| `custom_role_update` | Store a new version without mutating prior versions |
| `custom_role_clone` | Copy a role into a new, independent role ID |

Custom roles are stored as immutable versions. Their permissions are intentionally limited to `workspace.read` and `artifact.create`; declared tools come from a read-only allowlist. A role definition cannot grant shell execution or workspace-write permission.

### Attach Agent Skills to a role

Pass `skills` as an optional array to `custom_role_create`, `custom_role_update`, or `custom_role_clone`. Each entry is either a local skill directory (absolute path, `~/...`, or relative to the configured workspace) or a public GitHub URL that identifies a skill directory:

```json
{
  "skills": [
    ".agents/skills/documentation-style",
    "https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill>"
  ]
}
```

Each directory must contain a root `SKILL.md` with YAML frontmatter containing `name` and `description`, followed by the skill instructions. Skills follow the open Agent Skills directory convention; optional `references/`, `scripts/`, and `assets/` are recognized as supporting files. See [Agent Skills import, format, and limits](docs/agent-skills.md) for a complete example and restrictions.

When a role is created or its `skills` list is explicitly replaced, the plugin imports the skill text and records a content snapshot plus SHA-256 fingerprints with that immutable role version. Later edits or deletions in the source directory do not change existing role versions or workflows pinned to them. Updating a role without `skills` preserves its current skill snapshots; sending `skills: []` removes them in the new version. Cloning keeps the snapshots unless replacement skills are supplied.

The MVP accepts up to 8 skills per role, 40 supported text files per skill, 32 KiB per file, and 160 KiB combined across the role's imports. Hidden directories and common dependency/build folders are skipped, symbolic links inside local skill directories are rejected, and binary files are ignored. Remote import is limited to public GitHub tree/blob URLs and `raw.githubusercontent.com` `SKILL.md` URLs over HTTPS; private repositories, arbitrary domains, redirects and authenticated sources are not supported. Supporting file contents are passed to the host conversation as supplemental context, so keep large or sensitive data out of skill directories.

**Skills do not grant permissions or execute code.** Files such as `scripts/*.sh` or `scripts/*.py` are imported as text guidance only; the role runtime does not run them. Treat the imported instructions as untrusted content: they cannot override the role/workflow contract, host policy, approval gates or runtime permission boundary. This is a local-development MVP, not a hardened package sandbox.

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

### Durable Batch Execution through the shipped MCP runtime

The packaged entrypoint (`server/index.js`) exposes `execute_batch`. Call it with only `job_id` and `task_ids`, for example:

```json
{
  "job_id": "<approved-active-job-id>",
  "task_ids": ["<prepared-task-id-1>", "<prepared-task-id-2>"]
}
```

The workflow must already be explicitly approved, dispatched, and in `EXECUTING` state, with its immutable child tasks prepared beneath the active CTO coordinator. The requested IDs must be unique, pending, dependency-ready children of that same parent, with no previous execution/batch history. Each task is authorized independently against its exact immutable plan ID and role; only a plan-bound deterministic `ExecutionManager` contract can be used. Commands, executables, arguments, working directories, environment variables, timeouts, roles, parents, and batch IDs are intentionally not caller-supplied fields. The runtime validates every item and the Batch protocol before creating any batch rows, then calls the existing `WorkflowStore.createExecutionBatch()` and `ExecutionManager.executeBatch()` paths. Approval, immutable-command verification, claim/lease and spawn fencing, recovery, bounded output, durable terminal state, and production typed-artifact rules remain authoritative.

The returned evidence includes the durable batch ID/status/attempt, protocol summary, per-item task role/status/exit code/execution session, bounded redacted output previews, and an aggregate preview. The batch's recorded `initiator_role` is `system-workflow-coordinator`; task roles remain bound individually to the immutable plan. `execute_batch` is part of the current MCP `tools/list` and `tools/call` path, not just the legacy `server.js` adapter. It does not backfill or combine historical individual executions, and it rejects any task that already has an execution or batch ledger. The tool uses the batch manager's existing recovery semantics; it does not add a separate remote runner, cloud service, or cancellation API.

## Local monitoring dashboard

The optional **ORBIT / OPS** dashboard is a separate, read-only local web process. It does not change the MCP stdio entrypoint and exposes no workflow approval, dispatch, retry, or mutation controls. It reads the existing SQLite database, so it does not create a replacement database or change workflow records. Its workflow, role/skill, batch, event, artifact and file inspectors are documented in [ORBIT / OPS dashboard operations and security](docs/local-dashboard.md).

```bash
npm run dashboard
# Open the local URL printed by the command (default: http://127.0.0.1:8318)
npm run test:dashboard
```

The server listens on loopback only. Use the environment variables listed in [the dashboard guide](docs/local-dashboard.md#start-and-configure) to select the local data/database paths and port. Keep it on the local machine; it is not a remotely deployable admin console, and best-effort secret redaction is not a substitute for restrictive local filesystem permissions.

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
