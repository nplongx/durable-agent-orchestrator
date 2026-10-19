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

This evidence does not establish autonomous reasoning quality, live Gateway acceptance, exactly-once external side effects, OS sandboxing, or production readiness. The strict Phase 2 readiness audit remains authoritative for formal deployment/production use and may remain `BLOCKED_NOT_READY`. None of its official authorization/audit records are bypassed or rewritten by this testing release.

## Links

- [Runalith project site](https://nplongx.github.io/runalith/)
- [Repository](https://github.com/nplongx/runalith)
- [Release assets and checksum](https://github.com/nplongx/runalith/releases)
- [Release policy](https://github.com/nplongx/runalith/blob/main/docs/RELEASE_POLICY.md)
- [Known issues](https://github.com/nplongx/runalith/blob/main/docs/KNOWN_ISSUES.md)
