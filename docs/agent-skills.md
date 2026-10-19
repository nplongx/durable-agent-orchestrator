# Agent Skills for custom roles

Agent Skills are optional instruction bundles attached to a versioned custom role. A skill can give a role a reusable process, reference material, or templates. It does not add runtime tools or permissions. Role versions and imported skill snapshots are stored in the local SQLite database.

## Skill directory format

Each skill directory must contain a root-level `SKILL.md`. The file starts with YAML frontmatter using the supported scalar fields `name` and `description`, followed by Markdown instructions:

```markdown
---
name: documentation-style
description: Writes clear technical documentation and records verification status.
---

# Documentation style

When writing release notes:
- Summarize the user-visible change.
- Distinguish checks that ran from checks that are only recommended.
- Do not claim a test passed without execution evidence.
```

`name` must be a lowercase slug of letters, digits, and hyphens, up to 64 characters. For directory imports, the name must match the directory name. `description` is required and has a 1,024-character limit. Keep frontmatter simple: one scalar field per line.

Optional text resources may live next to `SKILL.md`:

```text
documentation-style/
├── SKILL.md
├── references/
│   └── style-guide.md
├── scripts/
│   └── lint-docs.sh
└── assets/
    └── template.md
```

The `references/`, `scripts/`, and `assets/` directories are optional. Supported text files are snapshotted and may be added to task context; binary files such as PNG images are ignored. Keep supplemental material small and relevant. Do not use a skill directory as a secret store or as a general project-file archive.

## Import a skill into a custom role

The `custom_role_create`, `custom_role_update`, and `custom_role_clone` tools accept an optional `skills` array. Each entry can be a local skill directory or a supported public GitHub URL:

```json
{
  "role_id": "release-documenter",
  "name": "Release Documenter",
  "description": "Writes release notes with verifiable claims.",
  "system_prompt": "Write concise release notes. Do not claim unverified work.",
  "input_contract": ["job.request", "implementation", "qa-report"],
  "output_artifact_type": "documentation",
  "allowed_capabilities": ["documentation.write"],
  "permissions": ["workspace.read", "artifact.create"],
  "allowed_tools": ["workflow_get", "workflow_artifacts"],
  "skills": [
    ".agents/skills/documentation-style",
    "https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill>"
  ]
}
```

Local paths can be absolute, begin with `~/`, or be relative to the configured workspace (`RUNALITH_WORKSPACE` or the configured workspace setting). The importer requires a root `SKILL.md` and rejects symbolic links inside local skill directories. It skips hidden files/directories and common dependency/build folders.

Supported remote forms are:

- `https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill>` — import a skill directory.
- `https://github.com/<owner>/<repo>/blob/<branch>/<path-to-skill>/SKILL.md` — import the directory containing that file.
- `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path-to-skill>/SKILL.md` — import using the raw `SKILL.md` URL.

Remote import is restricted to public GitHub-hosted sources over HTTPS; arbitrary hosts, redirects, private repositories, credentials, and branch/ref names containing `/` are not supported by this implementation. A remote import happens only when a role tool is called with `skills`; it is not an automatic network crawl.

## Snapshot and version behavior

- A role can contain up to 8 skills.
- Each skill can contain up to 40 supported text files, each at most 32 KiB; imported skill text for a role is capped at 160 KiB total.
- Imported content and SHA-256 fingerprints are snapshotted with the immutable role version. Editing or deleting the source directory does not change an existing snapshot.
- `custom_role_update` without a `skills` property preserves the current snapshot. Pass `skills: []` to remove skills in the new version, or a new array to replace them.
- `custom_role_clone` preserves the source snapshots unless replacement skills are supplied.
- Custom workflow versions pin exact role versions, so existing previews and runs keep the version they referenced.

## How skills are used

When `workflow_next_task` issues a custom-role task, the task description can include the role's system prompt, skill names/descriptions/hashes, `SKILL.md` text, and supported supplemental files. Treat all imported content as untrusted instructions, not as configuration.

- Skills cannot grant shell execution, workspace-write permissions, or new runtime tools.
- Files under `scripts/` are imported as text guidance; the plugin does not execute them just because a skill was attached.
- Skill content cannot override the system, role, workflow, approval, or runtime permission boundaries.
- If a skill asks for resources or permissions that are unavailable, the role must report the limitation rather than attempting to grant itself access.

Because imported text is included in the model context, it consumes context and can contain prompt-injection instructions. Review the source before import, and never include credentials, personal data, or secrets. This is a local-development feature, not a sandbox or a production supply-chain security guarantee.

## Add a profile overlay to a built-in workflow

The `standard-engineering` template supports `role_bindings` in `workflow_create`. Each binding references an existing custom-role version; it does not accept a free-form prompt or skill body in the workflow proposal.

```json
{
  "workflow": "standard-engineering",
  "role_bindings": [
    {
      "role": "architect",
      "custom_role_id": "example-architecture-specialist",
      "custom_role_version": 1
    }
  ]
}
```

The example role ID is a placeholder. Create or import that role first, then substitute its actual `role_id` and version.

- `role` identifies the built-in specialist that receives supplemental guidance; each built-in role can be bound at most once.
- `custom_role_id` and `custom_role_version` must identify a stored version. There is no implicit `latest` selector.
- The runtime records a `profile_hash` when the proposal is created. During approval/compilation it resolves the same version again and checks the hash; the prompt, skill instructions, and supporting text are pinned into the immutable plan and its hash.
- The profile input contract must cover the built-in role's required inputs, and the output artifact type must match. Invalid schema, version, hash, or contract bindings fail closed.
- This overlay currently applies to `standard-engineering`. The supported specialist role IDs are `product-owner`, `researcher`, `architect`, `engineer`, `security`, `qa`, `platform`, `writer`, and `reviewer`.
- Built-in identity, capabilities, permissions, allowed tools, executor, artifact schema, dependencies, completion criteria, and safety/review gates remain authoritative. Profile `permissions` and `allowed_tools` do not expand runtime authority.
- The `cto` and `system-workflow-coordinator` roles cannot receive these overlays. Custom workflows keep their existing pinned custom-role-version behavior.
- Omitting `role_bindings` preserves the built-in behavior; skills are not automatically attached to every role.

The local dashboard's **Roles & skills → Built-in role profile overlays** view displays proposal bindings. A displayed pin does not prove that the workflow was approved, dispatched, or completed.

## External references

- [Agent Skills specification](https://github.com/agentskills/agentskills) — the `SKILL.md` format and directory convention.
- [OpenAI: Skills](https://developers.openai.com/api/docs/guides/tools-skills/) — how skills differ from MCP servers and tools.
- [OpenAI: Build skills](https://developers.openai.com/plugins/build/skills) — guidance on triggers, inputs, steps, outputs, and limits.
