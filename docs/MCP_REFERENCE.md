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
| [`workflow_coordinator_step`](#workflow_coordinator_step) | Primary high-level workflow lifecycle tool for the built-in System Workflow Coordinator. It waits for explicit approval, dispatches an already-approved run, prepares tasks, runs approved deterministic local steps, and returns the next specialist task or synthesis contract. Submit task_result or synthesis to persist work and continue orchestration. Never approves a proposal or bypasses runtime evidence gates. | `job_id` |
| [`orchestrator_health`](#orchestrator_health) | Check local plugin, SQLite storage, active workflow counts, and local execution readiness. Never probes a remote service. | None |
| [`workflow_catalog`](#workflow_catalog) | List supported local workflow templates, including hybrid-engineering for pinned role/Skill overlays plus deterministic Batch Execution. | None |
| [`workflow_policy_catalog`](#workflow_policy_catalog) | List the closed JSON policy-rule types and exact runtime enforcement points supported by this plugin. Types without a real enforcement gate are not exposed. | None |
| [`workflow_policy_create`](#workflow_policy_create) | Create immutable version 1 of a reusable workflow policy pack. Rules use only the closed predicate schema; no executable code or arbitrary policy expressions are accepted. | `policy_id`, `name` |
| [`workflow_policy_list`](#workflow_policy_list) | List reusable workflow policy packs, optionally including all immutable versions. | None |
| [`workflow_policy_get`](#workflow_policy_get) | Read a policy pack at its latest or exact immutable version plus workflow attachments that pin it. | `policy_id` |
| [`workflow_policy_update`](#workflow_policy_update) | Create the next immutable version of an existing policy pack. Omitted fields are retained; earlier versions and existing workflow plan snapshots never change. | `policy_id` |
| [`workflow_policy_validate`](#workflow_policy_validate) | Validate a proposed policy pack without storing it. Checks closed schemas, rule conflicts and policy-level invariants; attaching also checks target-plan compatibility. | `policy_id`, `name` |
| [`workflow_policy_attach`](#workflow_policy_attach) | Attach an exact policy version to an active unapproved workflow proposal. The selected immutable snapshot is pinned into the approved plan hash; attachment is prohibited after approval or plan compilation. | `job_id`, `policy_id` |
| [`workflow_create`](#workflow_create) | Create a durable local workflow proposal. Optional role_bindings pin exact custom role versions and Skill snapshots as supplementary prompt overlays for built-in standard-engineering or hybrid-engineering specialist roles; the hybrid template also includes deterministic checks that can run together through the durable ExecutionManager batch path. Built-in contracts and permissions remain authoritative. Optionally declare a goal, hard constraints, and required success criteria. Creation does not approve or execute it. | `title`, `task` |
| [`workflow_list`](#workflow_list) | List active workflows from local SQLite. | None |
| [`workflow_get`](#workflow_get) | Inspect a local workflow, immutable plan, task states, artifact metadata, and current phase without exposing full stored result bodies. | `job_id` |
| [`workflow_approve`](#workflow_approve) | Explicitly approve the current immutable local workflow proposal and compile its plan. This is a state-changing approval. | `job_id`, `confirmation` |
| [`workflow_dispatch`](#workflow_dispatch) | Start the approved workflow in the local orchestrator and create its durable CTO task. Does not contact a cloud provider or spawn remote workers. | `job_id` |
| [`workflow_prepare_tasks`](#workflow_prepare_tasks) | Create or recover the immutable plan’s local child tasks under the dispatched workflow. Safe to repeat. | `job_id` |
| [`workflow_next_task`](#workflow_next_task) | Return the next dependency-ready task, its role-specific contract, and completed predecessor results with typed artifact evidence. For hybrid-engineering, ready deterministic tasks are automatically grouped into a durable execute_batch; other standalone deterministic tasks use task_execute_local. After completing a specialist task, call again. A blocked stage requires investigation/rework; do not report success. | `job_id` |
| [`workflow_diagnose`](#workflow_diagnose) | Read-only diagnosis of a stuck local workflow: identifies failed/pending tasks, current reviewer findings, stale or missing typed artifacts, and safe next actions. Never mutates state or bypasses approval/success gates. | `job_id` |
| [`workflow_request_rework`](#workflow_request_rework) | Request a provenance-preserving specialist rework cycle for a blocked standard-engineering v2 workflow after a completed reviewer decision. Invalidates the affected active artifacts, creates linked role revision tasks, and preserves the immutable plan and all approval/CTO gates. Does not mark work complete. | `job_id`, `reason` |
| [`workflow_request_reviewer_revision`](#workflow_request_reviewer_revision) | Request a provenance-preserving reviewer revision only when a standard-engineering v2 accepted review is blocked solely by documented evidenceIssues. Invalidates that review artifact and creates a linked reviewer revision task; it never approves synthesis or weakens the immutable success contract. | `job_id`, `reason` |
| [`workflow_complete_task`](#workflow_complete_task) | Persist the real result and typed artifact of a non-deterministic local specialist task. Requires that the task was issued by workflow_next_task; deterministic tasks must use task_execute_local. | `task_id`, `content`, `artifact` |
| [`task_execute_local`](#task_execute_local) | Execute an immutable deterministic task locally using its approved structured executable/arguments and workspace. No arbitrary command or remote execution is accepted. | `task_id` |
| [`execute_batch`](#execute_batch) | Execute 1..32 already-prepared, dependency-ready deterministic local tasks from one approved active workflow as a durable batch. Every task is resolved against its immutable approved plan; callers cannot supply commands, executables, arguments, working directories, timeouts, roles or parent IDs. Use only for tasks explicitly authorized for deterministic ExecutionManager execution. | `job_id`, `task_ids` |
| [`workflow_complete_synthesis`](#workflow_complete_synthesis) | Record the final synthesis and typed CTO decision artifact, then terminalize only after required task evidence and reviewer/QA gates pass. If the immutable plan declares constraints or success criteria, CTO artifact.success_assessment must mark all as satisfied/met and cite active artifact IDs bound to successful durable results. CASE-01 also requires the exact base64 workspace bytes consumed by synthesis. | `job_id`, `content`, `artifact` |
| [`workflow_events`](#workflow_events) | Read a workflow’s durable event history and observability summary. | `job_id` |
| [`workflow_artifacts`](#workflow_artifacts) | List durable artifacts for a local workflow. Content is redacted and bounded for safe context delivery. | `job_id` |
| [`workflow_e2e_run`](#workflow_e2e_run) | Advance an already-approved local workflow through safe deterministic tasks only. Never approves, fabricates specialist results, or self-approves synthesis. | `job_id` |
| [`workflow_recovery_verify`](#workflow_recovery_verify) | Verify persisted workflow invariants and independently read the same SQLite database from a fresh Node process. Does not prove runtime correctness or supervisor restart. | `job_id` |
| [`workflow_record_intervention`](#workflow_record_intervention) | Durably record a manual intervention/workaround to inform future automation. Does not alter workflow approval or security policy. | `reason`, `workaround` |
| [`workflow_interventions`](#workflow_interventions) | List recorded manual interventions, optionally filtered by workflow. | None |
| [`workflow_validate_artifact`](#workflow_validate_artifact) | Validate an artifact against the typed schema for a known artifact type and optionally a task role. | `artifact_type`, `artifact` |
| [`workflow_access_diagnostics`](#workflow_access_diagnostics) | Read-only diagnostics for local trust/config clues relevant to CHAT_NOT_TRUSTED. Never bypasses or changes trust policy. | None |
| [`custom_role_create`](#custom_role_create) | Create version 1 of a durable custom role. Optionally attach one or more local Agent Skills directories or public GitHub skill URLs; sources are validated and snapshotted into the immutable role version. | `role_id`, `name`, `description`, `system_prompt`, `input_contract`, `output_artifact_type` |
| [`custom_role_update`](#custom_role_update) | Create a new immutable role version. Omitted fields, including skills, are retained; pass skills: [] to remove attached skills. | `role_id` |
| [`custom_role_get`](#custom_role_get) | Read the latest or a specific immutable version of a custom role. | `role_id` |
| [`custom_role_list`](#custom_role_list) | List latest custom role definitions or all stored versions. | None |
| [`custom_role_clone`](#custom_role_clone) | Clone a custom role into a new role ID, preserving the pinned skill snapshots unless replacement skills are supplied. | `source_role_id`, `role_id` |
| [`custom_workflow_create`](#custom_workflow_create) | Create version 1 of a validated custom workflow definition. Does not execute it. | `workflow_id`, `name`, `description`, `input_contract`, `tasks` |
| [`custom_workflow_update`](#custom_workflow_update) | Create a new immutable version of a custom workflow definition; provide the complete new definition. | `workflow_id`, `name`, `description`, `input_contract`, `tasks` |
| [`custom_workflow_get`](#custom_workflow_get) | Read the latest or a specific immutable version of a custom workflow definition. | `workflow_id` |
| [`custom_workflow_list`](#custom_workflow_list) | List custom workflow definitions, optionally including all versions. | None |
| [`custom_workflow_clone`](#custom_workflow_clone) | Clone a custom workflow into a new workflow ID. Cloned tasks retain pinned custom-role versions. | `source_workflow_id`, `workflow_id` |
| [`custom_workflow_preview`](#custom_workflow_preview) | Build and persist an immutable custom workflow plan preview with pinned role versions, validated dependencies, and a hash. Does not execute. | `workflow_id` |
| [`custom_workflow_approve`](#custom_workflow_approve) | Record explicit approval for a specific immutable custom workflow preview. A separate workflow_approve call is required before execution. | `plan_id`, `confirmation` |
| [`custom_workflow_run_create`](#custom_workflow_run_create) | Create a local execution proposal from an already-approved immutable custom workflow preview. Optionally declare a goal, hard constraints, and success criteria for this run; a separate workflow_approve call is still required before dispatch. | `plan_id`, `title`, `request` |

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

Primary high-level workflow lifecycle tool for the built-in System Workflow Coordinator. It waits for explicit approval, dispatches an already-approved run, prepares tasks, runs approved deterministic local steps, and returns the next specialist task or synthesis contract. Submit task_result or synthesis to persist work and continue orchestration. Never approves a proposal or bypasses runtime evidence gates.

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

Check local plugin, SQLite storage, active workflow counts, and local execution readiness. Never probes a remote service.

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

List supported local workflow templates, including hybrid-engineering for pinned role/Skill overlays plus deterministic Batch Execution.

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

List the closed JSON policy-rule types and exact runtime enforcement points supported by this plugin. Types without a real enforcement gate are not exposed.

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

Create immutable version 1 of a reusable workflow policy pack. Rules use only the closed predicate schema; no executable code or arbitrary policy expressions are accepted.

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

List reusable workflow policy packs, optionally including all immutable versions.

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

Read a policy pack at its latest or exact immutable version plus workflow attachments that pin it.

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

Create the next immutable version of an existing policy pack. Omitted fields are retained; earlier versions and existing workflow plan snapshots never change.

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

Validate a proposed policy pack without storing it. Checks closed schemas, rule conflicts and policy-level invariants; attaching also checks target-plan compatibility.

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

Attach an exact policy version to an active unapproved workflow proposal. The selected immutable snapshot is pinned into the approved plan hash; attachment is prohibited after approval or plan compilation.

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

Create a durable local workflow proposal. Optional role_bindings pin exact custom role versions and Skill snapshots as supplementary prompt overlays for built-in standard-engineering or hybrid-engineering specialist roles; the hybrid template also includes deterministic checks that can run together through the durable ExecutionManager batch path. Built-in contracts and permissions remain authoritative. Optionally declare a goal, hard constraints, and required success criteria. Creation does not approve or execute it.

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

List active workflows from local SQLite.

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

Inspect a local workflow, immutable plan, task states, artifact metadata, and current phase without exposing full stored result bodies.

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

Explicitly approve the current immutable local workflow proposal and compile its plan. This is a state-changing approval.

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

Start the approved workflow in the local orchestrator and create its durable CTO task. Does not contact a cloud provider or spawn remote workers.

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

Create or recover the immutable plan’s local child tasks under the dispatched workflow. Safe to repeat.

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

Return the next dependency-ready task, its role-specific contract, and completed predecessor results with typed artifact evidence. For hybrid-engineering, ready deterministic tasks are automatically grouped into a durable execute_batch; other standalone deterministic tasks use task_execute_local. After completing a specialist task, call again. A blocked stage requires investigation/rework; do not report success.

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

Read-only diagnosis of a stuck local workflow: identifies failed/pending tasks, current reviewer findings, stale or missing typed artifacts, and safe next actions. Never mutates state or bypasses approval/success gates.

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

Request a provenance-preserving specialist rework cycle for a blocked standard-engineering v2 workflow after a completed reviewer decision. Invalidates the affected active artifacts, creates linked role revision tasks, and preserves the immutable plan and all approval/CTO gates. Does not mark work complete.

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

Request a provenance-preserving reviewer revision only when a standard-engineering v2 accepted review is blocked solely by documented evidenceIssues. Invalidates that review artifact and creates a linked reviewer revision task; it never approves synthesis or weakens the immutable success contract.

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

Persist the real result and typed artifact of a non-deterministic local specialist task. Requires that the task was issued by workflow_next_task; deterministic tasks must use task_execute_local.

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

Execute an immutable deterministic task locally using its approved structured executable/arguments and workspace. No arbitrary command or remote execution is accepted.

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

Execute 1..32 already-prepared, dependency-ready deterministic local tasks from one approved active workflow as a durable batch. Every task is resolved against its immutable approved plan; callers cannot supply commands, executables, arguments, working directories, timeouts, roles or parent IDs. Use only for tasks explicitly authorized for deterministic ExecutionManager execution.

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

Record the final synthesis and typed CTO decision artifact, then terminalize only after required task evidence and reviewer/QA gates pass. If the immutable plan declares constraints or success criteria, CTO artifact.success_assessment must mark all as satisfied/met and cite active artifact IDs bound to successful durable results. CASE-01 also requires the exact base64 workspace bytes consumed by synthesis.

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

Read a workflow’s durable event history and observability summary.

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

List durable artifacts for a local workflow. Content is redacted and bounded for safe context delivery.

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

Advance an already-approved local workflow through safe deterministic tasks only. Never approves, fabricates specialist results, or self-approves synthesis.

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

Verify persisted workflow invariants and independently read the same SQLite database from a fresh Node process. Does not prove runtime correctness or supervisor restart.

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

Durably record a manual intervention/workaround to inform future automation. Does not alter workflow approval or security policy.

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

List recorded manual interventions, optionally filtered by workflow.

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

Validate an artifact against the typed schema for a known artifact type and optionally a task role.

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

Read-only diagnostics for local trust/config clues relevant to CHAT_NOT_TRUSTED. Never bypasses or changes trust policy.

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

Create version 1 of a durable custom role. Optionally attach one or more local Agent Skills directories or public GitHub skill URLs; sources are validated and snapshotted into the immutable role version.

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

Create a new immutable role version. Omitted fields, including skills, are retained; pass skills: [] to remove attached skills.

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

Read the latest or a specific immutable version of a custom role.

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

List latest custom role definitions or all stored versions.

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

Clone a custom role into a new role ID, preserving the pinned skill snapshots unless replacement skills are supplied.

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

Create version 1 of a validated custom workflow definition. Does not execute it.

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

Create a new immutable version of a custom workflow definition; provide the complete new definition.

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

Read the latest or a specific immutable version of a custom workflow definition.

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

List custom workflow definitions, optionally including all versions.

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

Clone a custom workflow into a new workflow ID. Cloned tasks retain pinned custom-role versions.

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

Build and persist an immutable custom workflow plan preview with pinned role versions, validated dependencies, and a hash. Does not execute.

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

Record explicit approval for a specific immutable custom workflow preview. A separate workflow_approve call is required before execution.

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

Create a local execution proposal from an already-approved immutable custom workflow preview. Optionally declare a goal, hard constraints, and success criteria for this run; a separate workflow_approve call is still required before dispatch.

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
