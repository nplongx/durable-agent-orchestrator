# Terminology and naming compatibility

Use plain, descriptive language for concepts and UI copy. Keep literal names unchanged when they identify an actual public interface, stored record, installation step, or historical event. This table is the review boundary for naming changes; it is not an aliasing layer in the runtime.

## Preferred wording

| Prefer in explanatory text/UI | Use exact identifier when needed | Notes |
|---|---|---|
| **Local dashboard** | `dashboard/public/`, existing `/api/...` routes | Generic user-facing name for the read-only UI. Do not rename routes, browser storage keys, or database identifiers in a documentation-only change. |
| **Local orchestrator plugin** | `chat-on-steroids-local-orchestrator`, `Local Agent Orchestrator` | Use generic wording in prose. Preserve the actual package/manifest/plugin identity in installation and diagnostic instructions. |
| **Workflow run** or **workflow** | `job_id`, `workflow_create`, `workflow_dispatch` | “Run” describes the user's workflow instance; code and tool names retain their exact spelling. A `job_id` is a public field, not a prose synonym. |
| **Custom role profile** | `custom_role_id`, `custom_role_version`, `custom_role_create` | Use the generic term in prose, but preserve the API fields and role IDs in examples. |
| **Skill bundle** or **Agent Skill** | `SKILL.md`, `skills`, `custom_role_update` | “Agent Skills” is the upstream format/product name used in import guidance; do not invent another file format or change the literal property names. |
| **Execution record** | `ExecutionManager`, `execute_batch`, `task_execute_local` | Explain the concept in generic words; preserve internal class names when source tracing or debugging requires them, and preserve tool names in instructions. |
| **Policy pack** | `workflow_policy_*`, policy IDs and version fields | Use “policy pack” for the reusable versioned definition. It does not grant permissions and only its catalogued predicates are runtime-enforced. |
| **Approval** / **explicit approval** | `workflow_approve`, plan hash, approval events | Creating a proposal or preview is not approval. Keep this distinction explicit. |
| **Historical engineering record** | `M0`, `M11`, `M12`, `P0`–`P14`, case IDs, evidence filenames | These tokens identify particular milestones, tests, and records. Explain their scope; do not rewrite or normalize the identifiers inside their source records. |

## Names that should not be mass-renamed

These strings can be externally observable or operationally significant. A documentation cleanup must not change them unless a separate API/compatibility change has been designed, reviewed, migrated, and tested.

- MCP tool names and arguments, workflow/template IDs, built-in role IDs, custom role IDs, artifact types, enum values, and JSON protocol fields.
- The package name/version, manifest identifiers, connector/plugin display name needed for installation, script names, environment variables, filesystem paths, API route paths, and browser storage keys.
- SQLite schema/table/column names, stored events, existing record IDs, hashes, signed authorizations, benchmark identities, candidate bundle identities, or historical evidence content.
- Genuine upstream names required to reproduce a setup or integration, such as Chat On Steroids or OpenClaw. Keep these only where they are operationally meaningful, not as gratuitous decoration.

For example, the local dashboard still uses the browser storage key `orbit-dashboard-session-v1` for existing tab preferences. That string is retained for compatibility even though the current UI label is generic. Do not infer that it is a product name or a server API.

## Custom role ID examples

Custom role IDs are records in the local database. They are not populated merely by copying a documentation example. Use placeholders in generic examples, for example:

```json
{
  "role": "engineer",
  "custom_role_id": "example-implementation-specialist",
  "custom_role_version": 1
}
```

Create/import the role first and replace the placeholder with the exact ID and version that exist in the target database. Never rewrite a literal stored ID to match the placeholder.

## Rules for a naming change

1. Search source, docs, tests, manifests, UI text, routes, storage keys, and generated/package inputs before changing a term.
2. Classify each occurrence as descriptive copy, a public contract, a stored/compatibility identifier, a true upstream proper name, or a historical quotation.
3. Change descriptive copy only. Retain exact identifiers and annotate them if they look branded or installation-specific.
4. Run `npm run docs:check`, `git diff --check`, plus focused UI/API/contract tests for the affected surface.
5. For any identifier migration, stop and create a separately reviewed migration/compatibility plan; do not mix it into a documentation-only PR.
