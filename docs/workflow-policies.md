# Versioned workflow policy packs

Workflow policy packs let operators reuse deterministic constraints and success criteria across workflow proposals without changing plugin source code. They are a second layer over the fixed system safety and approval gates, not a replacement for them.

## Guarantees and limits

- A policy definition is validated against a closed JSON schema. Unknown rule types, unexpected fields, duplicate IDs, conflicting predicates, and non-JSON/executable rule content are rejected.
- Policy IDs are stable lowercase slugs. `workflow_policy_create` creates version 1; `workflow_policy_update` inserts a new immutable version. SQLite triggers reject updates/deletions to version rows, attachments and policy audit events.
- Attach an exact version to an active workflow proposal **before** approval. Attachment is rejected once approval or immutable plan compilation exists. The initial implementation intentionally has no detach/waive tool; make a new proposal to change its policy set.
- The exact policy ID, version, normalized snapshot and SHA-256 are embedded in the compiled plan. Policy constraints and success criteria are merged into the existing closed success contract using deterministic namespaced IDs, and the plan hash covers those values. Plan validation re-computes the merged contract; the store also compares embedded snapshots against the durable attachment ledger and the base contract against the original proposal.
- Existing system invariants remain authoritative. Policy packs can only add enforceable checks; they cannot grant permissions, provide arbitrary commands/code, override approval, change the execution plan, or make the runtime accept false evidence.
- Only types returned by `workflow_policy_catalog` may be stored. This version deliberately does **not** claim to enforce policy requests such as max retry counts, shell restrictions beyond existing execution contracts, prompt quality, coding style or citation quality unless there is a real, tested runtime gate for them. Qualitative requirements belong in role instructions and independent review until made objectively machine-checkable.

## Available MCP tools

| Tool | Purpose |
|---|---|
| `workflow_policy_catalog` | Show supported predicates and their actual enforcement points. |
| `workflow_policy_validate` | Validate an in-memory definition without storing it. Target-workflow compatibility is checked when attaching. |
| `workflow_policy_create` | Create version 1 of a reusable policy pack. |
| `workflow_policy_list` | List the latest versions or all versions, plus bounded attachment metadata. |
| `workflow_policy_get` | Retrieve a latest/specific version, its hash and workflow attachments. |
| `workflow_policy_update` | Insert the next immutable version; omitted fields retain their current values. |
| `workflow_policy_attach` | Attach an exact version to a workflow proposal before approval and plan compilation. |

## Supported rule catalog

The catalog is authoritative; don't assume any other `type` is supported.

| Rule type | Meaning and enforcement |
|---|---|
| `all_tasks_completed` | Every immutable planned child must have a completed durable task result; checked during independent synthesis/terminalization. |
| `local_execution_only` | The immutable plan must contain only known local execution contracts; checked against plan structure and again during independent synthesis evaluation. |
| `workflow_id_equals` | The target plan must use the specified workflow ID; target compatibility is checked at attachment and re-evaluated during synthesis. |
| `task_status_equals` | A named immutable child task must be durably completed; evaluated from task ledger rows during synthesis. Only `expected: "completed"` is accepted. |
| `execution_exit_code_equals` | A named deterministic `ExecutionManager` task must have durable completion and numeric exit code `0`; target must resolve to a deterministic local task and the runtime evaluates its ledger during synthesis. |
| `task_role_present` / `task_role_absent` | The immutable child-role list must include/exclude the named role; compatibility is checked at attachment and checked again during synthesis. |
| `artifact_exists` | Requires an active, schema/hash-valid artifact bound to a successful durable producer result; independently evaluated with provenance checks during synthesis. |
| `artifact_field_equals` | A top-level field of an eligible artifact must exactly equal a scalar; provenance and active result linkage are verified during synthesis. |
| `artifact_field_includes` | A top-level array in an eligible artifact must contain the specified scalar; provenance is verified during synthesis. |
| `artifact_field_non_empty` | A top-level string, array or object in an eligible artifact must be non-empty; provenance is verified during synthesis. |

Policy rules use the same predicate shape as the run's existing `constraints` and `success_criteria`. A policy rule ID is normalized to `p-<policy_id>-<rule_id>` when included in a workflow contract so IDs stay unique across base criteria and multiple policy packs. IDs are case-sensitive only after schema normalization; policy and rule IDs must follow the lowercase slug constraints. Role predicates and `producer_role` filters match the exact role identity in the immutable plan/artifact record. For built-in plans this is the built-in role slug (for example `qa`); in custom-workflow plans, child role identities are the generated `custom-task-1`, `custom-task-2`, and so on, not the underlying `custom_role_id`. `workflow_id_equals` likewise uses the exact `workflow_id` exposed by the immutable plan, including the `custom-` prefix for custom workflows.

## Example

First validate and create a reusable policy pack:

```json
{
  "policy_id": "secure-release",
  "name": "Secure release",
  "description": "Keep execution local and require QA acceptance evidence.",
  "constraints": [
    { "id": "local-only", "type": "local_execution_only" }
  ],
  "success_criteria": [
    {
      "id": "qa-accepted",
      "type": "artifact_field_equals",
      "artifact_type": "qa-report",
      "producer_role": "qa",
      "field": "decision",
      "expected": "accept"
    }
  ]
}
```

Use `workflow_policy_validate` with the definition, then `workflow_policy_create`. Create the workflow proposal using `workflow_create` (or `custom_workflow_run_create`), attach an exact policy version with `workflow_policy_attach`, inspect the proposal/attachment, and only then call `workflow_approve`. The policy attachment does not approve or dispatch a workflow. Dispatch and task execution retain their existing explicit approval requirements.

An update to `secure-release` creates version 2. A workflow already attached to version 1 remains pinned to version 1 when approved or recovered; updating the registry never rewrites old plan snapshots. To change a workflow's attachment set after approval, create a new proposal and obtain its approval rather than attempting to mutate the existing plan.

## How violations behave

The CTO's claimed `success_assessment` cannot override evaluation. A declared policy criterion that fails is rejected by the existing success-contract evaluator, preventing successful terminalization; the corresponding workflow remains uncompleted and its failure reason is recorded in workflow events/results. Fix the actual failed requirement or create a new proposal with authorized policy changes. There is no agent-controlled waiver or special override path.

Policy creation, immutable version updates and attachments are recorded in the `workflow_policy_events` audit table. When independent synthesis evaluation finds an attached policy predicate actually fails, the runtime records an idempotent `violation_detected` event bound to the job, exact policy ID/version/content hash, immutable plan hash, predicate ID/type and failure reason before rejecting successful synthesis. Repeated submission of the same failure for the same plan/rule does not multiply the same violation row. These events are historical observations: they are not removed automatically when later work fixes the condition.

`workflow_get` exposes attached policy pins; the ORBIT / OPS Policies view is GET-only and validates each displayed stored version against its canonical definition and SHA-256, then checks that each attachment hash matches that exact version. The view labels these checks `valid`/`invalid`, shows the number of recorded violations, and lists policy audit events. **A valid content hash only establishes snapshot integrity**, not that a workflow currently complies with the policy. This view is for inspection and does not modify policy state or claim to have evaluated every active workflow.

## Security boundary

Policy JSON is data, never executable source. The implementation accepts no `eval`, JavaScript, shell snippets, arbitrary expressions or open-ended predicate interpreter. Unknown types fail closed. Policies don't expand role permissions or runtime capabilities. Treat free-text descriptions as explanatory metadata, not security controls.

The runtime stores policy packs locally in the existing private SQLite database. The audit tables use append-only triggers as a guard against ordinary mutation; this doesn't make a local SQLite file cryptographically tamper-proof against an actor with unrestricted filesystem/database access. Keep the data directory private and preserve the independent immutable-plan and provenance checks.
