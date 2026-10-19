# MCP tool reference

This page is generated from the shipped stdio MCP server by the documentation generator. It describes registered tool names and input schemas returned by `tools/list`; it does not claim that every tool is safe in every workflow state. Follow the linked guides for lifecycle preconditions, permissions, evidence rules, and limitations.

- Source: `server/index.js` and its runtime schema definitions.
- Server identity reported by the checked-out source: `chat-on-steroids-local-orchestrator`.
- Source package version reported at generation time: `1.0.9-rc.4`. This is source-runtime metadata, not proof of which bundle is installed in Chat On Steroids.
- Registered tools: **46**.

## Choosing the right operation

- Use `workflow_catalog` to discover available built-in templates.
- Use `workflow_create` to make a proposal; it does not authorize execution.
- Explicitly approve the inspected proposal with `workflow_approve` before dispatch.
- Use `workflow_get`, `workflow_events`, `workflow_artifacts`, and `workflow_diagnose` to inspect durable state and investigate blocked work.
- The local dashboard is read-only; use MCP workflow tools for approved mutations.
- Tool schema validity is not permission to bypass approval, immutable-plan, artifact-provenance, or success-evaluation gates.

## Tool index

| Tool | Purpose | Required inputs |
|---|---|---|
| [`workflow_coordinator_role`](#workflow_coordinator_role) | Read the immutable built-in System Workflow Coordinator role used by the host assistant. It is not a custom role and cannot be created or modified through custom-role tools. | None |
| [`workflow_coordinator_step`](#workflow_coordinator_step) | Use as the normal high-level lifecycle interface after a proposal exists: it waits for explicit human approval, advances an already-approved workflow, prepares tasks, executes only approved deterministic local steps, and returns the next specialist task or synthesis contract. Submit task_result/synthesis to persist actual work. Do not use it to approve a proposal or bypass gates; use low-level tools for explicit state inspection or a documented recovery path. | `job_id` |
| [`orchestrator_health`](#orchestrator_health) | Read-only local health check for plugin/storage and local execution readiness. Use before diagnosing local setup problems; it never probes remote services and does not prove an individual workflow's evidence or success gates. | None |
| [`workflow_catalog`](#workflow_catalog) | Read-only discovery of supported local workflow templates and their intended shape. Use before workflow_create when choosing a template; this does not create, approve, or run a workflow. | None |
| [`workflow_policy_catalog`](#workflow_policy_catalog) | Read-only discovery of policy predicate types and their real runtime enforcement points. Use before drafting a policy; do not invent predicates or treat a catalog entry as proof a policy is attached/enforced for a particular run. | None |
| [`workflow_policy_create`](#workflow_policy_create) | State-changing: create immutable version 1 of a reusable workflow policy pack after reviewing workflow_policy_catalog. Use only the closed predicate schema; no executable code/arbitrary expressions are accepted. Validate before attaching; creation alone does not attach the policy to a workflow. | `policy_id`, `name` |
| [`workflow_policy_list`](#workflow_policy_list) | Read-only list/search of saved policy packs. Set include_versions when comparing immutable revisions; use workflow_policy_get for a specific pack. This does not validate or attach a policy. | None |
| [`workflow_policy_get`](#workflow_policy_get) | Read-only inspection of a policy pack's latest or exact immutable version and workflows that pin it. Use to verify the intended revision/attachments before changes; it does not attach or update anything. | `policy_id` |
| [`workflow_policy_update`](#workflow_policy_update) | State-changing: create the next immutable version of an existing policy pack. Omitted fields are retained; old versions and plans already pinned to them do not change. Validate the new version and explicitly attach an exact version to an eligible unapproved proposal if needed. | `policy_id` |
| [`workflow_policy_validate`](#workflow_policy_validate) | Read-only validation of a proposed policy pack without storing it. Checks closed schema, rule conflicts and policy-level invariants; target-plan compatibility is checked again when attaching. Use before create/update/attach; a valid policy is not yet attached or enforced. | `policy_id`, `name` |
| [`workflow_policy_attach`](#workflow_policy_attach) | State-changing: attach an exact policy version only to an active, unapproved workflow proposal. The snapshot is pinned into the later plan hash; attachment is prohibited after approval/compilation. Use after policy validation and before workflow_approve; create a new proposal if the plan is already approved. | `job_id`, `policy_id` |
| [`workflow_create`](#workflow_create) | State-changing proposal creation: use after choosing a template and writing a bounded request. Optional role_bindings pin exact custom-role versions/Skill snapshots as supplementary prompts for supported templates; built-in contracts and permissions stay authoritative. Goal/constraints/success criteria become part of the contract. Inspect the proposal and plan, then call workflow_approve only after explicit approval; create does not approve, dispatch, or execute. | `title`, `task` |
| [`workflow_list`](#workflow_list) | Read-only list of locally stored active workflows. Use to find a job_id when it is not known, then inspect that run with workflow_get; this does not advance or mutate any workflow. | None |
| [`workflow_get`](#workflow_get) | Read-only inspection of local workflow state, immutable plan/hash, task states, artifact metadata and phase. Use before approval or when diagnosing a specific job; it does not expose full result bodies or mutate state. | `job_id` |
| [`workflow_approve`](#workflow_approve) | State-changing approval: use only after inspecting the current proposal and intended immutable plan and obtaining explicit user confirmation. Compiles/pins the plan; do not edit it in place afterward. Approval is not dispatch—call workflow_dispatch next. | `job_id`, `confirmation` |
| [`workflow_dispatch`](#workflow_dispatch) | State-changing dispatch: use only for a proposal already approved with a current immutable plan. Starts the local workflow and creates its durable coordinator task; no cloud/remote worker is contacted. Then prepare tasks or use workflow_coordinator_step to advance. | `job_id` |
| [`workflow_prepare_tasks`](#workflow_prepare_tasks) | State-changing task preparation/recovery: use after workflow_dispatch when the immutable plan's child tasks need creating or reconciling. Safe to repeat for the same approved plan; does not execute tasks. Next call workflow_next_task or workflow_coordinator_step. | `job_id` |
| [`workflow_next_task`](#workflow_next_task) | Use after task preparation and after each recorded completion to obtain the next dependency-ready task, exact role contract and predecessor evidence. Deterministic tasks must use the approved task_execute_local/execute_batch path; specialist reasoning tasks use workflow_complete_task. If no task is ready or a gate blocks progress, inspect/diagnose rather than inventing a result. | `job_id` |
| [`workflow_diagnose`](#workflow_diagnose) | Read-only diagnosis when a local workflow is blocked, stuck, failed, or unexpectedly pending. Correlates task states, reviewer findings, stale/missing artifacts and safe next actions; it never mutates state. Use diagnosis before authorized rework/reviewer revision and never treat it as a repair or gate bypass. | `job_id` |
| [`workflow_request_rework`](#workflow_request_rework) | State-changing recovery for a supported standard-engineering v2 workflow after a completed reviewer decision when findings require specialist changes. Provide a concrete reason; this invalidates affected active artifacts and creates linked revision tasks while preserving plan and approval/CTO gates. It does not complete the work; diagnose first and re-run affected tasks/review. | `job_id`, `reason` |
| [`workflow_request_reviewer_revision`](#workflow_request_reviewer_revision) | Narrow state-changing recovery: use only for an accepted standard-engineering v2 review blocked solely by documented evidenceIssues, with upstream evidence and acceptance flags otherwise valid. It invalidates/replaces the review artifact; it is not for security/implementation/blocking findings and never approves synthesis or weakens the contract. | `job_id`, `reason` |
| [`workflow_complete_task`](#workflow_complete_task) | State-changing completion for a currently issued, dependency-ready non-deterministic local specialist task. Persist the actual result and typed artifact; record outcome=failed when work failed. Do not fabricate results or use this for deterministic tasks, which require task_execute_local/execute_batch. Request the next task after completion. | `task_id`, `content`, `artifact` |
| [`task_execute_local`](#task_execute_local) | State-changing local execution for one prepared deterministic task whose executable, arguments and workspace are fixed by the approved immutable plan. Use only when the task contract marks it deterministic; no arbitrary commands or remote execution are accepted. Inspect the actual exit/output and then request the next task. | `task_id` |
| [`execute_batch`](#execute_batch) | State-changing batch execution for 1–32 prepared, dependency-ready deterministic tasks within one approved active workflow. Use only tasks authorized for ExecutionManager; each is resolved from the immutable plan, and callers cannot supply command/args/cwd/timeout/role. Do not use for specialist reasoning tasks; inspect per-task outcomes and recover failures through the documented path. | `job_id`, `task_ids` |
| [`workflow_complete_synthesis`](#workflow_complete_synthesis) | State-changing finalization: use only when all required tasks and evidence are ready and the coordinator has returned the synthesis contract. Record the typed CTO decision and exact success_assessment IDs/evidence_refs; the runtime independently checks task state, lineage, reviewer/QA gates and predicates. A call or narrative cannot bypass a failed gate; CASE-01 also requires the exact consumed workspace bytes. | `job_id`, `content`, `artifact` |
| [`workflow_events`](#workflow_events) | Read-only view of a workflow's durable event history and observability summary. Use to reconstruct ordering or investigate an unexpected state; it does not change task/job state. Pair with workflow_get or workflow_diagnose when needed. | `job_id` |
| [`workflow_artifacts`](#workflow_artifacts) | Read-only listing of persisted typed artifacts and their metadata/status for a local workflow; content is redacted and bounded. Use to check artifact presence/lineage before review or synthesis, not as a replacement for schema/provenance validation. | `job_id` |
| [`workflow_e2e_run`](#workflow_e2e_run) | State-changing convenience runner for deterministic local steps of an already-approved workflow. Use only when advancing deterministic tasks without host reasoning is sufficient; it never fabricates specialist results, approves a proposal, or self-approves synthesis. Use the coordinator/next-task path when specialist work is required. | `job_id` |
| [`workflow_recovery_verify`](#workflow_recovery_verify) | Read-only post-recovery check of persisted workflow invariants using an independent fresh Node process against the same SQLite database. Use to verify stored-state consistency; this does not prove runtime correctness, a supervisor restart, or external service health. | `job_id` |
| [`workflow_record_intervention`](#workflow_record_intervention) | State-changing audit note for a real manual intervention/workaround, capturing reason and what was done for future automation. Use only after an actual intervention; it does not change workflow state, approval, or security policy and must not be used to manufacture evidence. | `reason`, `workaround` |
| [`workflow_interventions`](#workflow_interventions) | Read-only query of previously recorded manual interventions, optionally scoped to a workflow. Use for operational learning; it does not apply or validate a workaround. | None |
| [`workflow_validate_artifact`](#workflow_validate_artifact) | Read-only validation of typed artifact content against a known schema/optional role. Use before persisting a candidate artifact to catch missing/invalid fields; this alone does not persist it or prove task-result lineage, approval, or overall workflow success. | `artifact_type`, `artifact` |
| [`workflow_access_diagnostics`](#workflow_access_diagnostics) | Read-only local diagnostics for trust/config clues relevant to CHAT_NOT_TRUSTED. Use to investigate the underlying configuration; it never bypasses or changes trust policy. | None |
| [`custom_role_create`](#custom_role_create) | State-changing creation of immutable custom role version 1. Use when a reusable specialist definition is needed; optional local Agent Skills directories/public GitHub URLs are validated and snapshotted. Treat attached skill text as supplementary, review permissions separately, and do not assume role declarations grant runtime access. | `role_id`, `name`, `description`, `system_prompt`, `input_contract`, `output_artifact_type` |
| [`custom_role_update`](#custom_role_update) | State-changing creation of the next immutable custom-role version; omitted fields (including skills) are retained, while skills: [] removes attachments. Existing workflow plans keep their pinned snapshots. Inspect the resulting version and use it only in newly compiled plans when appropriate. | `role_id` |
| [`custom_role_get`](#custom_role_get) | Read-only inspection of the latest or an exact immutable custom-role version and its pinned skill metadata. Use to verify the definition before cloning or binding; this does not update permissions or grant runtime access. | `role_id` |
| [`custom_role_list`](#custom_role_list) | Read-only list of custom roles; set include_versions to inspect immutable history. Use custom_role_get to inspect one role's content. This does not create or change roles. | None |
| [`custom_role_clone`](#custom_role_clone) | State-changing clone into a new custom-role ID. The clone preserves pinned skill snapshots unless replacement skills are supplied; review its full definition/permissions and remember its declarations do not grant runtime tool access. | `source_role_id`, `role_id` |
| [`custom_workflow_create`](#custom_workflow_create) | State-changing creation of immutable custom-workflow definition version 1. Use only after checking dependencies/input-output contracts; creation does not produce an executable run. Call custom_workflow_preview to compile and inspect the pinned plan before explicit approval. | `workflow_id`, `name`, `description`, `input_contract`, `tasks` |
| [`custom_workflow_update`](#custom_workflow_update) | State-changing creation of the next immutable custom-workflow definition version; provide the complete definition. Existing previews/runs keep pinned versions. Preview and inspect the new version before approving a run from it. | `workflow_id`, `name`, `description`, `input_contract`, `tasks` |
| [`custom_workflow_get`](#custom_workflow_get) | Read-only inspection of the latest or exact immutable custom-workflow definition version. Use before preview/clone/update to verify task graph and contract; this does not execute it. | `workflow_id` |
| [`custom_workflow_list`](#custom_workflow_list) | Read-only list/search of custom workflow definitions; include_versions shows immutable history. Use custom_workflow_get to inspect a specific definition; listing does not validate or execute it. | None |
| [`custom_workflow_clone`](#custom_workflow_clone) | State-changing clone into a new custom-workflow ID. Cloned tasks retain pinned custom-role versions unless a complete revised definition is supplied; preview and inspect the clone before approval or execution. | `source_workflow_id`, `workflow_id` |
| [`custom_workflow_preview`](#custom_workflow_preview) | State-changing preview creation: compile and persist an immutable custom-workflow plan with pinned role versions, validated dependencies, and hash. Review the preview before custom_workflow_approve; this does not create/approve/execute a workflow run. | `workflow_id` |
| [`custom_workflow_approve`](#custom_workflow_approve) | State-changing approval of the exact immutable custom-workflow preview after inspection and explicit user confirmation. This approves the definition preview only; custom_workflow_run_create and a separate workflow_approve for the resulting run are still required before dispatch. | `plan_id`, `confirmation` |
| [`custom_workflow_run_create`](#custom_workflow_run_create) | State-changing creation of a local run proposal from an already-approved immutable custom-workflow preview. Add run-specific goal/constraints/success criteria here; inspect the proposal, then call workflow_approve for the run and dispatch only after approval. This call itself does not dispatch or execute. | `plan_id`, `title`, `request` |

## Tool schemas

The expandable schema block under each tool contains the exact JSON Schema returned by the server. Input schemas describe shape and constraints; runtime state, authorization, and evidence checks are enforced separately.

### `workflow_coordinator_role`

Read the immutable built-in System Workflow Coordinator role used by the host assistant. It is not a custom role and cannot be created or modified through custom-role tools.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

</details>

### `workflow_coordinator_step`

Use as the normal high-level lifecycle interface after a proposal exists: it waits for explicit human approval, advances an already-approved workflow, prepares tasks, executes only approved deterministic local steps, and returns the next specialist task or synthesis contract. Submit task_result/synthesis to persist actual work. Do not use it to approve a proposal or bypass gates; use low-level tools for explicit state inspection or a documented recovery path.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_result` | `object` | No | — | no additional properties; required fields: `task_id`, `content`, `artifact` |
| `synthesis` | `object` | No | — | no additional properties; required fields: `content`, `artifact` |
| `max_local_steps` | `integer` | No | — | minimum: `1`; maximum: `20`; default: `5` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_result": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "task_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000000
        },
        "artifact": {
          "type": "object"
        },
        "outcome": {
          "type": "string",
          "enum": [
            "success",
            "failed"
          ],
          "default": "success"
        }
      },
      "required": [
        "task_id",
        "content",
        "artifact"
      ]
    },
    "synthesis": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 1000000
        },
        "artifact": {
          "type": "object"
        },
        "consumed_workspace_bytes": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "path": {
                "type": "string",
                "enum": [
                  "config.json",
                  "result.json"
                ]
              },
              "sha256": {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              "encoding": {
                "type": "string",
                "enum": [
                  "base64"
                ]
              },
              "bytes": {
                "type": "string",
                "maxLength": 2000000
              }
            },
            "required": [
              "path",
              "sha256",
              "encoding",
              "bytes"
            ]
          }
        }
      },
      "required": [
        "content",
        "artifact"
      ]
    },
    "max_local_steps": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20,
      "default": 5
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `orchestrator_health`

Read-only local health check for plugin/storage and local execution readiness. Use before diagnosing local setup problems; it never probes remote services and does not prove an individual workflow's evidence or success gates.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

</details>

### `workflow_catalog`

Read-only discovery of supported local workflow templates and their intended shape. Use before workflow_create when choosing a template; this does not create, approve, or run a workflow.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

</details>

### `workflow_policy_catalog`

Read-only discovery of policy predicate types and their real runtime enforcement points. Use before drafting a policy; do not invent predicates or treat a catalog entry as proof a policy is attached/enforced for a particular run.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

</details>

### `workflow_policy_create`

State-changing: create immutable version 1 of a reusable workflow policy pack after reviewing workflow_policy_catalog. Use only the closed predicate schema; no executable code/arbitrary expressions are accepted. Validate before attaching; creation alone does not attach the policy to a workflow.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | maxLength: `2000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "policy_id",
    "name"
  ]
}
```

</details>

### `workflow_policy_list`

Read-only list/search of saved policy packs. Set include_versions when comparing immutable revisions; use workflow_policy_get for a specific pack. This does not validate or attach a policy.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `include_versions` | `boolean` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |
| `query` | `string` | No | — | maxLength: `120` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_versions": {
      "type": "boolean"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    },
    "query": {
      "type": "string",
      "maxLength": 120
    }
  }
}
```

</details>

### `workflow_policy_get`

Read-only inspection of a policy pack's latest or exact immutable version and workflows that pin it. Use to verify the intended revision/attachments before changes; it does not attach or update anything.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "policy_id"
  ]
}
```

</details>

### `workflow_policy_update`

State-changing: create the next immutable version of an existing policy pack. Omitted fields are retained; old versions and plans already pinned to them do not change. Validate the new version and explicitly attach an exact version to an eligible unapproved proposal if needed.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | maxLength: `2000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "policy_id"
  ]
}
```

</details>

### `workflow_policy_validate`

Read-only validation of a proposed policy pack without storing it. Checks closed schema, rule conflicts and policy-level invariants; target-plan compatibility is checked again when attaching. Use before create/update/attach; a valid policy is not yet attached or enforced.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | maxLength: `2000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "maxLength": 2000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 39
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "policy_id",
    "name"
  ]
}
```

</details>

### `workflow_policy_attach`

State-changing: attach an exact policy version only to an active, unapproved workflow proposal. The snapshot is pinned into the later plan hash; attachment is prohibited after approval/compilation. Use after policy validation and before workflow_approve; create a new proposal if the plan is already approved.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `policy_id` | `string` | Yes | — | minLength: `1`; maxLength: `38`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "policy_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 38
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "job_id",
    "policy_id"
  ]
}
```

</details>

### `workflow_create`

State-changing proposal creation: use after choosing a template and writing a bounded request. Optional role_bindings pin exact custom-role versions/Skill snapshots as supplementary prompts for supported templates; built-in contracts and permissions stay authoritative. Goal/constraints/success criteria become part of the contract. Inspect the proposal and plan, then call workflow_approve only after explicit approval; create does not approve, dispatch, or execute.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `title` | `string` | Yes | — | minLength: `1`; maxLength: `180` |
| `task` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `workflow` | `string` | No | — | enum: `standard-engineering`, `hybrid-engineering`, `engineering`, `production`; default: `"standard-engineering"` |
| `workspace` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `role_bindings` | `array` | No | — | maxItems: `9`; items: object |
| `goal` | `string` | No | — | minLength: `1`; maxLength: `4000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 180
    },
    "task": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "workflow": {
      "type": "string",
      "enum": [
        "standard-engineering",
        "hybrid-engineering",
        "engineering",
        "production"
      ],
      "default": "standard-engineering"
    },
    "workspace": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "role_bindings": {
      "type": "array",
      "maxItems": 9,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "role": {
            "type": "string",
            "enum": [
              "product-owner",
              "researcher",
              "architect",
              "engineer",
              "security",
              "qa",
              "platform",
              "writer",
              "reviewer"
            ]
          },
          "custom_role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "custom_role_version": {
            "type": "integer",
            "minimum": 1
          }
        },
        "required": [
          "role",
          "custom_role_id",
          "custom_role_version"
        ]
      }
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "title",
    "task"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_list`

Read-only list of locally stored active workflows. Use to find a job_id when it is not known, then inspect that run with workflow_get; this does not advance or mutate any workflow.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `limit` | `integer` | No | — | minimum: `1`; maximum: `100` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    }
  },
  "additionalProperties": false
}
```

</details>

### `workflow_get`

Read-only inspection of local workflow state, immutable plan/hash, task states, artifact metadata and phase. Use before approval or when diagnosing a specific job; it does not expose full result bodies or mutate state.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_approve`

State-changing approval: use only after inspecting the current proposal and intended immutable plan and obtaining explicit user confirmation. Compiles/pins the plan; do not edit it in place afterward. Approval is not dispatch—call workflow_dispatch next.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `confirmation` | `string` | Yes | — | minLength: `3`; maxLength: `2000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "confirmation": {
      "type": "string",
      "minLength": 3,
      "maxLength": 2000
    }
  },
  "required": [
    "job_id",
    "confirmation"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_dispatch`

State-changing dispatch: use only for a proposal already approved with a current immutable plan. Starts the local workflow and creates its durable coordinator task; no cloud/remote worker is contacted. Then prepare tasks or use workflow_coordinator_step to advance.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_prepare_tasks`

State-changing task preparation/recovery: use after workflow_dispatch when the immutable plan's child tasks need creating or reconciling. Safe to repeat for the same approved plan; does not execute tasks. Next call workflow_next_task or workflow_coordinator_step.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_next_task`

Use after task preparation and after each recorded completion to obtain the next dependency-ready task, exact role contract and predecessor evidence. Deterministic tasks must use the approved task_execute_local/execute_batch path; specialist reasoning tasks use workflow_complete_task. If no task is ready or a gate blocks progress, inspect/diagnose rather than inventing a result.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_diagnose`

Read-only diagnosis when a local workflow is blocked, stuck, failed, or unexpectedly pending. Correlates task states, reviewer findings, stale/missing artifacts and safe next actions; it never mutates state. Use diagnosis before authorized rework/reviewer revision and never treat it as a repair or gate bypass.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    }
  },
  "required": [
    "job_id"
  ]
}
```

</details>

### `workflow_request_rework`

State-changing recovery for a supported standard-engineering v2 workflow after a completed reviewer decision when findings require specialist changes. Provide a concrete reason; this invalidates affected active artifacts and creates linked revision tasks while preserving plan and approval/CTO gates. It does not complete the work; diagnose first and re-run affected tasks/review.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `reason` | `string` | Yes | — | minLength: `1`; maxLength: `4000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    }
  },
  "required": [
    "job_id",
    "reason"
  ]
}
```

</details>

### `workflow_request_reviewer_revision`

Narrow state-changing recovery: use only for an accepted standard-engineering v2 review blocked solely by documented evidenceIssues, with upstream evidence and acceptance flags otherwise valid. It invalidates/replaces the review artifact; it is not for security/implementation/blocking findings and never approves synthesis or weakens the contract.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `reason` | `string` | Yes | — | minLength: `1`; maxLength: `4000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "reason": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    }
  },
  "required": [
    "job_id",
    "reason"
  ]
}
```

</details>

### `workflow_complete_task`

State-changing completion for a currently issued, dependency-ready non-deterministic local specialist task. Persist the actual result and typed artifact; record outcome=failed when work failed. Do not fabricate results or use this for deterministic tasks, which require task_execute_local/execute_batch. Request the next task after completion.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `task_id` | `string` | Yes | — | minLength: `1` |
| `content` | `string` | Yes | — | minLength: `1`; maxLength: `1000000` |
| `artifact` | `object` | Yes | — | — |
| `outcome` | `string` | No | — | enum: `success`, `failed`; default: `"success"` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "minLength": 1
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000000
    },
    "artifact": {
      "type": "object"
    },
    "outcome": {
      "type": "string",
      "enum": [
        "success",
        "failed"
      ],
      "default": "success"
    }
  },
  "required": [
    "task_id",
    "content",
    "artifact"
  ],
  "additionalProperties": false
}
```

</details>

### `task_execute_local`

State-changing local execution for one prepared deterministic task whose executable, arguments and workspace are fixed by the approved immutable plan. Use only when the task contract marks it deterministic; no arbitrary commands or remote execution are accepted. Inspect the actual exit/output and then request the next task.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `task_id` | `string` | Yes | — | minLength: `1` |
| `timeout_ms` | `integer` | No | — | minimum: `1000`; maximum: `600000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "task_id": {
      "type": "string",
      "minLength": 1
    },
    "timeout_ms": {
      "type": "integer",
      "minimum": 1000,
      "maximum": 600000
    }
  },
  "required": [
    "task_id"
  ]
}
```

</details>

### `execute_batch`

State-changing batch execution for 1–32 prepared, dependency-ready deterministic tasks within one approved active workflow. Use only tasks authorized for ExecutionManager; each is resolved from the immutable plan, and callers cannot supply command/args/cwd/timeout/role. Do not use for specialist reasoning tasks; inspect per-task outcomes and recover failures through the documented path.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1`; maxLength: `200` |
| `task_ids` | `array` | Yes | — | minItems: `1`; maxItems: `32`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200
    },
    "task_ids": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "required": [
    "job_id",
    "task_ids"
  ]
}
```

</details>

### `workflow_complete_synthesis`

State-changing finalization: use only when all required tasks and evidence are ready and the coordinator has returned the synthesis contract. Record the typed CTO decision and exact success_assessment IDs/evidence_refs; the runtime independently checks task state, lineage, reviewer/QA gates and predicates. A call or narrative cannot bypass a failed gate; CASE-01 also requires the exact consumed workspace bytes.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `content` | `string` | Yes | — | minLength: `1`; maxLength: `1000000` |
| `artifact` | `object` | Yes | — | — |
| `consumed_workspace_bytes` | `array` | No | — | minItems: `2`; maxItems: `2`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 1000000
    },
    "artifact": {
      "type": "object"
    },
    "consumed_workspace_bytes": {
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "enum": [
              "config.json",
              "result.json"
            ]
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "encoding": {
            "type": "string",
            "enum": [
              "base64"
            ]
          },
          "bytes": {
            "type": "string",
            "maxLength": 2000000
          }
        },
        "required": [
          "path",
          "sha256",
          "encoding",
          "bytes"
        ]
      }
    }
  },
  "required": [
    "job_id",
    "content",
    "artifact"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_events`

Read-only view of a workflow's durable event history and observability summary. Use to reconstruct ordering or investigate an unexpected state; it does not change task/job state. Pair with workflow_get or workflow_diagnose when needed.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `500` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_artifacts`

Read-only listing of persisted typed artifacts and their metadata/status for a local workflow; content is redacted and bounded. Use to check artifact presence/lineage before review or synthesis, not as a replacement for schema/provenance validation.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_e2e_run`

State-changing convenience runner for deterministic local steps of an already-approved workflow. Use only when advancing deterministic tasks without host reasoning is sufficient; it never fabricates specialist results, approves a proposal, or self-approves synthesis. Use the coordinator/next-task path when specialist work is required.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |
| `max_tasks` | `integer` | No | — | minimum: `1`; maximum: `20` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    },
    "max_tasks": {
      "type": "integer",
      "minimum": 1,
      "maximum": 20
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_recovery_verify`

Read-only post-recovery check of persisted workflow invariants using an independent fresh Node process against the same SQLite database. Use to verify stored-state consistency; this does not prove runtime correctness, a supervisor restart, or external service health.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | Yes | — | minLength: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "job_id"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_record_intervention`

State-changing audit note for a real manual intervention/workaround, capturing reason and what was done for future automation. Use only after an actual intervention; it does not change workflow state, approval, or security policy and must not be used to manufacture evidence.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | No | — | — |
| `task_id` | `string` | No | — | — |
| `actor` | `string` | No | — | — |
| `reason` | `string` | Yes | — | minLength: `1` |
| `workaround` | `string` | Yes | — | minLength: `1` |
| `proposed_automation` | `string` | No | — | — |
| `duration_minutes` | `number` | No | — | minimum: `0` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string"
    },
    "task_id": {
      "type": "string"
    },
    "actor": {
      "type": "string"
    },
    "reason": {
      "type": "string",
      "minLength": 1
    },
    "workaround": {
      "type": "string",
      "minLength": 1
    },
    "proposed_automation": {
      "type": "string"
    },
    "duration_minutes": {
      "type": "number",
      "minimum": 0
    }
  },
  "required": [
    "reason",
    "workaround"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_interventions`

Read-only query of previously recorded manual interventions, optionally scoped to a workflow. Use for operational learning; it does not apply or validate a workaround.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `job_id` | `string` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  },
  "additionalProperties": false
}
```

</details>

### `workflow_validate_artifact`

Read-only validation of typed artifact content against a known schema/optional role. Use before persisting a candidate artifact to catch missing/invalid fields; this alone does not persist it or prove task-result lineage, approval, or overall workflow success.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `artifact_type` | `string` | Yes | — | minLength: `1` |
| `artifact` | `object` | Yes | — | — |
| `role` | `string` | No | — | — |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {
    "artifact_type": {
      "type": "string",
      "minLength": 1
    },
    "artifact": {
      "type": "object"
    },
    "role": {
      "type": "string"
    }
  },
  "required": [
    "artifact_type",
    "artifact"
  ],
  "additionalProperties": false
}
```

</details>

### `workflow_access_diagnostics`

Read-only local diagnostics for trust/config clues relevant to CHAT_NOT_TRUSTED. Use to investigate the underlying configuration; it never bypasses or changes trust policy.

This tool accepts no named input properties.

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

</details>

### `custom_role_create`

State-changing creation of immutable custom role version 1. Use when a reusable specialist definition is needed; optional local Agent Skills directories/public GitHub URLs are validated and snapshotted. Treat attached skill text as supplementary, review permissions separately, and do not assume role declarations grant runtime access.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | Yes | — | minLength: `1`; maxLength: `2000` |
| `system_prompt` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `input_contract` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: string |
| `output_artifact_type` | `string` | Yes | — | enum: `requirements`, `research`, `architecture`, `implementation`, `security-review`, `qa-report`, `platform-review`, `documentation`, `review`, `cto-decision` |
| `allowed_capabilities` | `array` | No | — | maxItems: `32`; items: string |
| `permissions` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `allowed_tools` | `array` | No | — | maxItems: `32`; items: string |
| `skills` | `array` | No | — | maxItems: `8`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "system_prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "output_artifact_type": {
      "type": "string",
      "enum": [
        "requirements",
        "research",
        "architecture",
        "implementation",
        "security-review",
        "qa-report",
        "platform-review",
        "documentation",
        "review",
        "cto-decision"
      ]
    },
    "allowed_capabilities": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "product.requirements",
          "research.collect",
          "architecture.design",
          "code.modify",
          "security.audit",
          "code.verify",
          "infrastructure.verify",
          "documentation.write",
          "change.review",
          "synthesis.approve"
        ]
      }
    },
    "permissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workspace.read",
          "artifact.create"
        ]
      }
    },
    "allowed_tools": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workflow_catalog",
          "workflow_list",
          "workflow_get",
          "workflow_events",
          "workflow_artifacts",
          "workflow_validate_artifact"
        ]
      }
    },
    "skills": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048,
        "description": "Local skill directory or public GitHub skill directory URL."
      }
    }
  },
  "required": [
    "role_id",
    "name",
    "description",
    "system_prompt",
    "input_contract",
    "output_artifact_type"
  ]
}
```

</details>

### `custom_role_update`

State-changing creation of the next immutable custom-role version; omitted fields (including skills) are retained, while skills: [] removes attachments. Existing workflow plans keep their pinned snapshots. Inspect the resulting version and use it only in newly compiled plans when appropriate.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `system_prompt` | `string` | No | — | minLength: `1`; maxLength: `12000` |
| `input_contract` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `output_artifact_type` | `string` | No | — | enum: `requirements`, `research`, `architecture`, `implementation`, `security-review`, `qa-report`, `platform-review`, `documentation`, `review`, `cto-decision` |
| `allowed_capabilities` | `array` | No | — | maxItems: `32`; items: string |
| `permissions` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `allowed_tools` | `array` | No | — | maxItems: `32`; items: string |
| `skills` | `array` | No | — | maxItems: `8`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "system_prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "output_artifact_type": {
      "type": "string",
      "enum": [
        "requirements",
        "research",
        "architecture",
        "implementation",
        "security-review",
        "qa-report",
        "platform-review",
        "documentation",
        "review",
        "cto-decision"
      ]
    },
    "allowed_capabilities": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "product.requirements",
          "research.collect",
          "architecture.design",
          "code.modify",
          "security.audit",
          "code.verify",
          "infrastructure.verify",
          "documentation.write",
          "change.review",
          "synthesis.approve"
        ]
      }
    },
    "permissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workspace.read",
          "artifact.create"
        ]
      }
    },
    "allowed_tools": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workflow_catalog",
          "workflow_list",
          "workflow_get",
          "workflow_events",
          "workflow_artifacts",
          "workflow_validate_artifact"
        ]
      }
    },
    "skills": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048,
        "description": "Local skill directory or public GitHub skill directory URL."
      }
    }
  },
  "required": [
    "role_id"
  ]
}
```

</details>

### `custom_role_get`

Read-only inspection of the latest or an exact immutable custom-role version and its pinned skill metadata. Use to verify the definition before cloning or binding; this does not update permissions or grant runtime access.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "role_id"
  ]
}
```

</details>

### `custom_role_list`

Read-only list of custom roles; set include_versions to inspect immutable history. Use custom_role_get to inspect one role's content. This does not create or change roles.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `include_versions` | `boolean` | No | — | default: `false` |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_versions": {
      "type": "boolean",
      "default": false
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

</details>

### `custom_role_clone`

State-changing clone into a new custom-role ID. The clone preserves pinned skill snapshots unless replacement skills are supplied; review its full definition/permissions and remember its declarations do not grant runtime tool access.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `source_role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `role_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `system_prompt` | `string` | No | — | minLength: `1`; maxLength: `12000` |
| `input_contract` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `output_artifact_type` | `string` | No | — | enum: `requirements`, `research`, `architecture`, `implementation`, `security-review`, `qa-report`, `platform-review`, `documentation`, `review`, `cto-decision` |
| `allowed_capabilities` | `array` | No | — | maxItems: `32`; items: string |
| `permissions` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `allowed_tools` | `array` | No | — | maxItems: `32`; items: string |
| `skills` | `array` | No | — | maxItems: `8`; unique items; items: string |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "role_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "system_prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "output_artifact_type": {
      "type": "string",
      "enum": [
        "requirements",
        "research",
        "architecture",
        "implementation",
        "security-review",
        "qa-report",
        "platform-review",
        "documentation",
        "review",
        "cto-decision"
      ]
    },
    "allowed_capabilities": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "product.requirements",
          "research.collect",
          "architecture.design",
          "code.modify",
          "security.audit",
          "code.verify",
          "infrastructure.verify",
          "documentation.write",
          "change.review",
          "synthesis.approve"
        ]
      }
    },
    "permissions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workspace.read",
          "artifact.create"
        ]
      }
    },
    "allowed_tools": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "workflow_catalog",
          "workflow_list",
          "workflow_get",
          "workflow_events",
          "workflow_artifacts",
          "workflow_validate_artifact"
        ]
      }
    },
    "skills": {
      "type": "array",
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048,
        "description": "Local skill directory or public GitHub skill directory URL."
      }
    }
  },
  "required": [
    "source_role_id",
    "role_id"
  ]
}
```

</details>

### `custom_workflow_create`

State-changing creation of immutable custom-workflow definition version 1. Use only after checking dependencies/input-output contracts; creation does not produce an executable run. Call custom_workflow_preview to compile and inspect the pinned plan before explicit approval.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | Yes | — | minLength: `1`; maxLength: `2000` |
| `input_contract` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: string |
| `tasks` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_version": {
            "type": "integer",
            "minimum": 1
          },
          "depends_on": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "type": "string"
            }
          },
          "input_contract": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "items": {
              "type": "string",
              "enum": [
                "job.request",
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision"
              ]
            }
          },
          "output_artifact_type": {
            "type": "string",
            "enum": [
              "requirements",
              "research",
              "architecture",
              "implementation",
              "security-review",
              "qa-report",
              "platform-review",
              "documentation",
              "review",
              "cto-decision"
            ]
          }
        },
        "required": [
          "id",
          "role_id"
        ]
      }
    }
  },
  "required": [
    "workflow_id",
    "name",
    "description",
    "input_contract",
    "tasks"
  ]
}
```

</details>

### `custom_workflow_update`

State-changing creation of the next immutable custom-workflow definition version; provide the complete definition. Existing previews/runs keep pinned versions. Preview and inspect the new version before approving a run from it.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | Yes | — | minLength: `1`; maxLength: `2000` |
| `input_contract` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: string |
| `tasks` | `array` | Yes | — | minItems: `1`; maxItems: `32`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_version": {
            "type": "integer",
            "minimum": 1
          },
          "depends_on": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "type": "string"
            }
          },
          "input_contract": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "items": {
              "type": "string",
              "enum": [
                "job.request",
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision"
              ]
            }
          },
          "output_artifact_type": {
            "type": "string",
            "enum": [
              "requirements",
              "research",
              "architecture",
              "implementation",
              "security-review",
              "qa-report",
              "platform-review",
              "documentation",
              "review",
              "cto-decision"
            ]
          }
        },
        "required": [
          "id",
          "role_id"
        ]
      }
    }
  },
  "required": [
    "workflow_id",
    "name",
    "description",
    "input_contract",
    "tasks"
  ]
}
```

</details>

### `custom_workflow_get`

Read-only inspection of the latest or exact immutable custom-workflow definition version. Use before preview/clone/update to verify task graph and contract; this does not execute it.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "maxLength": 80
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "workflow_id"
  ]
}
```

</details>

### `custom_workflow_list`

Read-only list/search of custom workflow definitions; include_versions shows immutable history. Use custom_workflow_get to inspect a specific definition; listing does not validate or execute it.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `include_versions` | `boolean` | No | — | — |
| `limit` | `integer` | No | — | minimum: `1`; maximum: `200` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "include_versions": {
      "type": "boolean"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 200
    }
  }
}
```

</details>

### `custom_workflow_clone`

State-changing clone into a new custom-workflow ID. Cloned tasks retain pinned custom-role versions unless a complete revised definition is supplied; preview and inspect the clone before approval or execution.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `source_workflow_id` | `string` | Yes | — | maxLength: `80` |
| `workflow_id` | `string` | Yes | — | maxLength: `80`; pattern: `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` |
| `name` | `string` | No | — | minLength: `1`; maxLength: `120` |
| `description` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `input_contract` | `array` | No | — | minItems: `1`; maxItems: `32`; items: string |
| `tasks` | `array` | No | — | minItems: `1`; maxItems: `32`; items: object |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "source_workflow_id": {
      "type": "string",
      "maxLength": 80
    },
    "workflow_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      "maxLength": 80
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input_contract": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "string",
        "enum": [
          "job.request",
          "requirements",
          "research",
          "architecture",
          "implementation",
          "security-review",
          "qa-report",
          "platform-review",
          "documentation",
          "review",
          "cto-decision"
        ]
      }
    },
    "tasks": {
      "type": "array",
      "minItems": 1,
      "maxItems": 32,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
            "maxLength": 80
          },
          "role_version": {
            "type": "integer",
            "minimum": 1
          },
          "depends_on": {
            "type": "array",
            "maxItems": 32,
            "items": {
              "type": "string"
            }
          },
          "input_contract": {
            "type": "array",
            "minItems": 1,
            "maxItems": 32,
            "items": {
              "type": "string",
              "enum": [
                "job.request",
                "requirements",
                "research",
                "architecture",
                "implementation",
                "security-review",
                "qa-report",
                "platform-review",
                "documentation",
                "review",
                "cto-decision"
              ]
            }
          },
          "output_artifact_type": {
            "type": "string",
            "enum": [
              "requirements",
              "research",
              "architecture",
              "implementation",
              "security-review",
              "qa-report",
              "platform-review",
              "documentation",
              "review",
              "cto-decision"
            ]
          }
        },
        "required": [
          "id",
          "role_id"
        ]
      }
    }
  },
  "required": [
    "source_workflow_id",
    "workflow_id"
  ]
}
```

</details>

### `custom_workflow_preview`

State-changing preview creation: compile and persist an immutable custom-workflow plan with pinned role versions, validated dependencies, and hash. Review the preview before custom_workflow_approve; this does not create/approve/execute a workflow run.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `workflow_id` | `string` | Yes | — | maxLength: `80` |
| `version` | `integer` | No | — | minimum: `1` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workflow_id": {
      "type": "string",
      "maxLength": 80
    },
    "version": {
      "type": "integer",
      "minimum": 1
    }
  },
  "required": [
    "workflow_id"
  ]
}
```

</details>

### `custom_workflow_approve`

State-changing approval of the exact immutable custom-workflow preview after inspection and explicit user confirmation. This approves the definition preview only; custom_workflow_run_create and a separate workflow_approve for the resulting run are still required before dispatch.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `plan_id` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `confirmation` | `string` | Yes | — | minLength: `3`; maxLength: `2000` |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "plan_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "confirmation": {
      "type": "string",
      "minLength": 3,
      "maxLength": 2000
    }
  },
  "required": [
    "plan_id",
    "confirmation"
  ]
}
```

</details>

### `custom_workflow_run_create`

State-changing creation of a local run proposal from an already-approved immutable custom-workflow preview. Add run-specific goal/constraints/success criteria here; inspect the proposal, then call workflow_approve for the run and dispatch only after approval. This call itself does not dispatch or execute.

| Input | Type | Required | Description | Constraints |
|---|---|---|---|---|
| `plan_id` | `string` | Yes | — | minLength: `1`; maxLength: `120` |
| `title` | `string` | Yes | — | minLength: `1`; maxLength: `180` |
| `request` | `string` | Yes | — | minLength: `1`; maxLength: `12000` |
| `workspace` | `string` | No | — | minLength: `1`; maxLength: `2000` |
| `goal` | `string` | No | — | minLength: `1`; maxLength: `4000` |
| `constraints` | `array` | No | — | maxItems: `32`; items: union |
| `success_criteria` | `array` | No | — | maxItems: `32`; items: union |

<details>
<summary>Full input schema (JSON)</summary>

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "plan_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 180
    },
    "request": {
      "type": "string",
      "minLength": 1,
      "maxLength": 12000
    },
    "workspace": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "constraints": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    },
    "success_criteria": {
      "type": "array",
      "maxItems": 32,
      "items": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "all_tasks_completed"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "local_execution_only"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              }
            },
            "required": [
              "id",
              "type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "workflow_id_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "expected": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_status_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "string",
                "enum": [
                  "completed"
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "execution_exit_code_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "task_id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "expected": {
                "type": "number",
                "enum": [
                  0
                ]
              }
            },
            "required": [
              "id",
              "type",
              "task_id",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_present"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "task_role_absent"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "role"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_exists"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_equals"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_includes"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              },
              "expected": {
                "oneOf": [
                  {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                  },
                  {
                    "type": "number"
                  },
                  {
                    "type": "boolean"
                  }
                ]
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field",
              "expected"
            ]
          },
          {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "minLength": 1,
                "maxLength": 80
              },
              "type": {
                "type": "string",
                "enum": [
                  "artifact_field_non_empty"
                ]
              },
              "description": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
              },
              "artifact_type": {
                "type": "string",
                "enum": [
                  "requirements",
                  "research",
                  "architecture",
                  "implementation",
                  "security-review",
                  "qa-report",
                  "platform-review",
                  "documentation",
                  "review",
                  "cto-decision"
                ]
              },
              "producer_role": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
                "maxLength": 80
              },
              "field": {
                "type": "string",
                "pattern": "^[A-Za-z][A-Za-z0-9_]*$",
                "maxLength": 80
              }
            },
            "required": [
              "id",
              "type",
              "artifact_type",
              "field"
            ]
          }
        ]
      }
    }
  },
  "required": [
    "plan_id",
    "title",
    "request"
  ]
}
```

</details>

## Related guides

- [Quickstart](quickstart.md)
- [Durable batch execution](batch-execution.md)
- [Workflow policy packs](workflow-policies.md)
- [Agent Skills](agent-skills.md)
- [Local dashboard](local-dashboard.md)
- [Architecture](architecture.md)
- [Terminology and compatibility exceptions](TERMINOLOGY.md)
