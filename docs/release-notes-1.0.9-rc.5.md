# Runalith 1.0.9-rc.5 — Testing Pre-release

> **TESTING ONLY — NOT FOR PRODUCTION.** This package introduces the Runalith product identity and neutral MCP package naming. It is not an official frozen artifact or a production-readiness certification.

## Highlights

- Product, manifest and MCP server identity now use Runalith naming (`runalith-agent-orchestrator`).
- The package filename uses `runalith-1.0.9-rc.5.mcpb`. MCPB is a bundle container used by compatible clients; it is not a vendor-specific protocol or feature guarantee.
- Added `RUNALITH_DATA_DIR`, `RUNALITH_WORKFLOW_DB`, `RUNALITH_EXECUTION_TMP_DIR`, `RUNALITH_WORKSPACE`, `RUNALITH_DASHBOARD_HOST` and `RUNALITH_DASHBOARD_PORT` as the preferred environment-variable names. Legacy aliases continue to work. Fresh installs use `~/.runalith/agent-orchestrator`; an existing legacy data directory is preserved automatically when no new directory exists.
- Renamed the local packager and acceptance-test command to `npm run pack:runalith-mcpb` and `npm run test:runalith-plugin`.
- Added a responsive static project site in `site/` and a GitHub Actions workflow to publish it to GitHub Pages.
- Updated architecture, quickstart, dashboard, terminology, benchmark-template and MCP reference documentation to use neutral client/runtime language.

## Package and checksum

The current verified build is `324551` bytes with SHA-256 `b1bea277f60e355796f5bf945d1f8697f076466d8aa59ff62c4e4f27ea84402f`. It was built reproducibly and validated from this source snapshot. Before publishing, the packager is rerun from the final tagged source commit and the hash must match this value. The GitHub release attaches the `.mcpb` file and a `.sha256` sidecar; the release description records the final tag-target commit. Verify the downloaded package with the sidecar before installing it.

## Validation scope

The candidate is validated through local regression tests, deterministic package reproducibility, archive validation, package-extracted MCP initialization/tool discovery, all 46 tool schemas, lease-fencing and stdio/shutdown regressions, hybrid workflow E2E, CASE-01 recovery, and the local plugin acceptance harness. The static site is plain HTML/CSS and does not require a backend service.

## Additional local rebuild and post-install verification (2026-10-20)

The package/checksum above describe the testing pre-release asset documented by this release note. A separate, timestamped candidate was subsequently built from the local workspace and checked after reinstall; **it is not the published GitHub release asset and must not be substituted for that asset or its checksum**. The local candidate was `runalith-1.0.9-rc.5-candidate-20261020T142019Z.mcpb`, `427013` bytes, SHA-256 `22a2ff82bccc2bb5c3ec7fcf637216e40d90c66d77dfa16fd70177cd7f40a04d`.

The approved local build exited `0`; packaged runtime smoke and `50/50` tool-schema checks passed; all six extracted validation tests exited `0`; and the final Runalith MCP and scoped-workspace-write E2E tests passed. After reinstall, health reported `ok` at version `1.0.9-rc.5`. A read-only per-file SHA-256 comparison found all `62` candidate archive entries present in the installed plugin tree with no content hash mismatches. See the [local install verification dossier](installation-verification-1.0.9-rc.5-20261020.md) for the immutable build evidence and exact file-entry hashes.

This is local testing evidence only. The candidate was built with uncommitted/untracked source changes present and no independent source inventory was established. The host does not expose the installed archive container hash. Independent `output_commit` attestation and all strict Phase 2 release blockers remain outstanding; see [known issues](KNOWN_ISSUES.md), [issue #19](https://github.com/nplongx/runalith/issues/19), and [issue #3](https://github.com/nplongx/runalith/issues/3). This additional local candidate does not alter the checksum, source identity, or status of the published release asset.

This evidence does not establish autonomous reasoning quality, live Gateway acceptance, exactly-once external side effects, OS sandboxing, or production readiness. The strict Phase 2 readiness audit remains authoritative for formal deployment/production use and may remain `BLOCKED_NOT_READY`. None of its official authorization/audit records are bypassed or rewritten by this testing release.

## Links

- [Runalith project site](https://nplongx.github.io/runalith/)
- [Repository](https://github.com/nplongx/runalith)
- [Release assets and checksum](https://github.com/nplongx/runalith/releases)
- [Release policy](https://github.com/nplongx/runalith/blob/main/docs/RELEASE_POLICY.md)
- [Known issues](https://github.com/nplongx/runalith/blob/main/docs/KNOWN_ISSUES.md)
