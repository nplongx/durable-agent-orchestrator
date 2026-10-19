# Terminology and naming compatibility

Runalith uses host-neutral product language. The MCPB package format is a bundle container; the MCP server identity, runtime semantics, and client integration are separate concepts. This guide distinguishes user-facing descriptions from identifiers that remain necessary for compatibility or historical evidence.

## Preferred wording

| Preferred explanatory wording | Exact identifier when needed | Notes |
|---|---|---|
| **Runalith runtime** | `runalith-agent-orchestrator` | Current MCP server identity and package name. |
| **MCP bundle** or **MCPB** | `.mcpb`, bundle-root `manifest.json` | A package/container format, not a claim of vendor-specific behavior. Client-side installation support varies. |
| **MCP stdio server** | `server/index.js`, newline-delimited JSON-RPC | The direct integration path for clients that launch local stdio servers. |
| **Local dashboard** | `dashboard/public/`, existing `/api/...` routes | Read-only local UI. Do not rename routes, browser storage keys, or database identifiers in a documentation-only change. |
| **Workflow run** or **workflow** | `job_id`, `workflow_create`, `workflow_dispatch` | “Run” describes the user's workflow instance; code and tool names retain their exact spelling. |
| **Custom role profile** | `custom_role_id`, `custom_role_version`, `custom_role_create` | Use generic wording in prose, but preserve API fields and role IDs in examples. |
| **Agent Skill** | `SKILL.md`, `skills`, `custom_role_update` | The upstream skill format is retained; do not invent another file format or change property names. |
| **Execution record** | `ExecutionManager`, `execute_batch`, `task_execute_local` | Preserve internal class names where source tracing or debugging requires them. |
| **Policy pack** | `workflow_policy_*`, policy IDs and version fields | A reusable versioned definition; it does not grant permissions and only catalogued predicates are enforced. |
| **Explicit approval** | `workflow_approve`, plan hash, approval events | Proposal creation and preview are not approval. Keep this distinction explicit. |
| **Historical engineering record** | `M0`, `M11`, `M12`, `P0`–`P14`, case IDs, evidence filenames | These identify particular milestones, tests and records. Do not rewrite literal identifiers inside source evidence. |

## Compatibility boundary

These strings can be externally observable or operationally significant. Do not mass-rename them without a separately reviewed migration, compatibility and test plan:

- MCP tool names and arguments, workflow/template IDs, built-in role IDs, custom role IDs, artifact types, enum values and JSON protocol fields.
- SQLite schema/table/column names, stored events, record IDs, hashes, signed authorizations, benchmark identities and historical artifact identities.
- Existing environment-variable names and data paths. The neutral `RUNALITH_*` variables are the preferred documentation surface; legacy aliases remain accepted for backward compatibility.
- Historical filenames that identify the pre-rebrand frozen package and the scripts that verify that exact artifact. They are not the current Runalith package name.

Historical benchmark evidence may still contain exact identifiers from the software and host environment that were observed at that time. Do not change a recorded hash or represent an old artifact as a newly branded build. Public product copy should use Runalith and refer to historical materials only where their provenance matters.

## Custom role ID examples

Custom role IDs are local database records, not populated by copying a documentation example:

```json
{
  "role": "engineer",
  "custom_role_id": "example-implementation-specialist",
  "custom_role_version": 1
}
```

Create/import the role first and replace the placeholder with the exact ID and version that exists in the target database. Never rewrite a literal stored ID to match a placeholder.

## Naming-change rules

1. Search source, docs, tests, manifests, UI text, routes, storage keys and generated/package inputs before changing a term.
2. Classify occurrences as descriptive copy, public contract, stored/compatibility identifier, upstream proper name or historical evidence.
3. Change descriptive copy and current public package identity; preserve immutable historical identities and compatibility paths.
4. Run `npm run docs:check`, `git diff --check`, and focused UI/API/contract tests for the affected surface.
5. For any protocol or stored-identifier migration, prepare a separately reviewed migration plan instead of mixing it into a documentation change.
