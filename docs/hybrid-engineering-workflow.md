# Hybrid engineering: custom roles, Agent Skills, and Batch Execution

`hybrid-engineering` is a local workflow template that combines the built-in nine-stage engineering review flow with explicitly declared deterministic checks. Use it when a change benefits from role-specific instructions and several Agent Skills, while also having independent local checks that can safely run together.

The template is selected by the stable `Hybrid Batch Execution:` title prefix emitted by `workflow_create`. The remainder of the title is arbitrary user text (for example, `Hybrid Batch Execution: Fix a bug`); it does not need to include phrases such as “custom role” or “skills”.

## What runs in the workflow

The approved plan contains eleven children:

| Stage | Execution | Dependency behavior |
|---|---|---|
| Product owner | Host conversation with optional pinned custom role/Skill overlay | Starts from the request |
| Researcher | Host conversation with optional pinned overlay | Waits for requirements |
| Architect | Host conversation with optional pinned overlay | Waits for requirements and research |
| Engineer | Host conversation with optional pinned overlay | Waits for architecture |
| `hybrid-server-syntax-check` | Deterministic local `node --check` of `server/index.js` | Waits for the engineer |
| `hybrid-workflow-compiler-syntax-check` | Deterministic local `node --check` of `src/runtime/workflow/compiler.js` | Waits for the engineer; independent of the other syntax check |
| Security, QA, platform, writer, reviewer | Host conversation with optional pinned overlays | Wait for the relevant implementation evidence and both syntax-check tasks; reviewer also waits for the other review artifacts |
| CTO synthesis | Host conversation | Waits for every planned child |

Once the engineer task is completed and both deterministic checks are pending and dependency-ready, the scheduler submits them together to `execute_batch`. The runtime does not label ordinary host-conversation tasks as batch tasks. Successful checks publish typed documentation artifacts linked to their actual execution result and session; downstream specialists receive those artifacts through normal task evidence.

## Create a proposal

Profiles and skills are local records: create them first using `custom_role_create` with their supported Agent Skills directories, or use existing profile versions shown by `custom_role_list`. A role binding names the built-in role being supplemented and pins an exact custom role version. The profile's Skill files are imported and hashed when the role version is created; later edits to the original files do not rewrite that snapshot.

Example using two existing local profiles (replace the workspace with the intended local checkout):

```json
{
  "title": "Hybrid Batch Execution: role and skill rollout",
  "task": "Implement the approved local change, validate it, and produce security, QA, platform, documentation and review evidence.",
  "workflow": "hybrid-engineering",
  "workspace": "/home/long/work/chatgpt-adapter",
  "role_bindings": [
    {
      "role": "engineer",
      "custom_role_id": "orbit-implementation-specialist",
      "custom_role_version": 1
    },
    {
      "role": "reviewer",
      "custom_role_id": "orbit-independent-reviewer",
      "custom_role_version": 1
    }
  ],
  "constraints": [
    { "id": "local-only", "type": "local_execution_only" }
  ],
  "success_criteria": [
    { "id": "all-tasks-complete", "type": "all_tasks_completed" }
  ]
}
```

Submit that object to `workflow_create`. Bindings for other roles are optional; add a profile only when it materially improves that stage. The current local database may already contain the `orbit-*` role IDs used in the example; a fresh installation or different database must create/import those role records before using their IDs.

## Approval and execution lifecycle

1. Create the proposal with `workflow_create` and inspect the stored bindings.
2. Explicitly approve the proposal with `workflow_approve`; this compiles and hashes the immutable plan with the pinned profile snapshots and built-in deterministic task contracts.
3. Start it with `workflow_dispatch` and prepare child tasks with `workflow_prepare_tasks` (or use `workflow_coordinator_step` as the main lifecycle tool after approval).
4. Let the coordinator return each host specialist task. Submit actual specialist work and its typed artifact with `workflow_coordinator_step.task_result`.
5. After the engineer task completes, the hybrid scheduler batches any ready deterministic checks using the same durable `ExecutionManager` batch path. Continue security, QA, platform, writing, review and CTO synthesis only with the returned durable results and typed evidence.

Approval is a prerequisite, not a claim that execution succeeded. The runtime independently validates batch membership, common CTO parent, dependency readiness, first-attempt state, exact executable/arguments/working directory/timeout, immutable plan identity and durable execution evidence. It rejects caller-supplied command overrides and fails closed on a batch mismatch. Synthesis and terminalization still require the normal QA, reviewer, typed-artifact, provenance and success-contract gates.

## Security and operational boundaries

- This template runs locally. It does not configure cloud workers, external model APIs, GitHub Actions, or remote deployment.
- Custom role profiles are supplementary instructions and Skill snapshots. Their declared permissions and tool allowlists do not expand built-in runtime permissions.
- Imported skills are untrusted instructional text; `scripts/` within a skill are not executed merely because the skill was attached.
- The deterministic task contracts are authored by plugin code. Callers cannot supply executable, arguments, cwd, timeout, role, parent or batch ID.
- The plan is immutable after approval. Change the request, role binding, skill version or task topology in a new proposal; never modify an approved plan in place.
- A valid content hash demonstrates snapshot integrity, not correctness of the task output. Review and QA use actual results, typed artifact lineage and independent runtime checks.
- The current built-in checks are syntax checks for two known files. They are not a substitute for the full test suite; QA must run the checks appropriate to the proposed change and report anything not run as unverified.

See [the root README](../README.md#hybrid-engineering-workflow) for how this mode relates to the broader local workflow, and [durable Batch Execution](../README.md#durable-batch-execution-through-the-shipped-mcp-runtime) for the batch protocol details.
