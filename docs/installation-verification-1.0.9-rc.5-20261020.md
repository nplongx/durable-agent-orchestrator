# Local install verification: Runalith 1.0.9-rc.5 (2026-10-20)

> **Scope: local engineering evidence only.** This record describes a fresh workspace-built candidate and the installed local plugin tree checked after reinstall. It is not a verification record for the GitHub release asset, the official frozen Phase 2 artifact, or a production release.

## Candidate identity

- Local candidate: `dist/runalith-1.0.9-rc.5-candidate-20261020T142019Z.mcpb`.
- Size: `427013` bytes.
- SHA-256: `22a2ff82bccc2bb5c3ec7fcf637216e40d90c66d77dfa16fd70177cd7f40a04d`.
- Immutable build workflow: `job_542a3bc0-b859-4af3-9858-e1aac3cff8f6`.
- Approved plan SHA-256: `272584cc1e30f78b62e8872a8513c3c0065704f635d6121587705ff110904a5d`.
- Build execution: `exec_a4ad6174-2ec5-463b-8d79-aed98b9f6a8c`, attempt `1`, exit code `0`.
- Package profile: `mcpb-package-build-isolated@1`.

The archive SHA-256 was recomputed from the local file during post-install verification and matched the successful packager output. This timestamped workspace candidate is separate from the asset and checksum recorded in the pre-existing [RC.5 testing release notes](release-notes-1.0.9-rc.5.md). Do not substitute this local hash for the published asset hash.

The source checkout was not clean: the observed Git `HEAD` was `65b82b268dc279b6ce9e15a55daf644dd5e88996` with uncommitted and untracked changes present. Therefore, this candidate is not claimed to have been built from a clean checkout of that commit or from the `v1.0.9-rc.5` release tag. No ordered source inventory hash or independent source attestation was established as part of this verification.

## Package checks

The approved local packager task returned exit code `0` and reported:

- Archive creation and package validation passed.
- Packaged MCP runtime initialization and `tools/list` smoke passed; all `50/50` manifest tools were exposed.
- Extracted package tool-schema validation passed for `50/50` tools.
- All six extracted validation/regression test files exited `0`.
- The final Runalith local MCP E2E passed.
- The scoped workspace-write E2E passed, including the path that had failed on the earlier build when the nested test expected six default tasks but the repository default catalog contained eleven.

These are results from the one approved build attempt and its package-internal checks; no second build attempt or fallback command was run.

## Post-install verification

After reinstall, the local `orchestrator_health` check returned `status=ok` and plugin version `1.0.9-rc.5`. The workflow catalog responded, and a Node process was present running `server/index.js` from the installed Runalith plugin directory.

A read-only comparison enumerated every file entry in the candidate archive and compared its SHA-256 with the corresponding file in the installed plugin tree:

| Check | Result |
|---|---|
| Archive file entries compared | `62` |
| Missing files in installed tree | `0` |
| Content hash mismatches | `0` |
| Installed `package.json` / manifest version | `1.0.9-rc.5` |

This demonstrates byte-identical **file contents for all 62 archive entries** in the inspected installed tree. The host does not expose the original installed `.mcpb` archive bytes, so this is not an independent hash of the installed archive container itself. The running health/version result plus content comparison is strong local install evidence, but it does not establish official frozen-artifact identity or custody.

The independent post-install checks also confirmed that these important archive entries match the installed files:

| Entry | SHA-256 |
|---|---|
| `package.json` | `638258a501175808cb90c6fc61ff0f5a3f5b2823e6b1e9918c7b3748a11cc047` |
| `manifest.json` | `98323ef1170ca5ae2d4cfd2e2699bcdb9ea06daf63917e837a9a488a0a39d42b` |
| `server/index.js` | `241f5dd452602e29d5fd0f52ea52ad7fe84751f60b33a7a32e9a46e507ef01b6` |
| `src/runtime/workflow/policy-contract.js` | `025aea84c760ebc9bbe02f153a334b97011e83e2cf1df77522021206ebbbce92` |

## What this does not close

- The strict Phase 2 readiness state remains `BLOCKED_NOT_READY`; `execution_permitted=false`.
- Independent `output_commit` attestation is still missing. The successful build result and installed-file comparison are not independent attestation. Track this in [issue #19](https://github.com/nplongx/runalith/issues/19).
- The separate candidate review in [issue #3](https://github.com/nplongx/runalith/issues/3) still requires a verified candidate/inventory identity and an authorized independent reviewer disposition.
- Official frozen-artifact custody, exact-scope authorization, CASE-06 disposition, static release-policy validation, host preflight, and authorization-audit reconciliation remain distinct gates. No official release/assessment records were changed.
- No installation test against a live OpenClaw Gateway, remote worker, or external delivery path was performed by this verification.

Keep this dossier as supplemental local evidence. It does not authorize publishing, distribution, formal deployment, or production use.
