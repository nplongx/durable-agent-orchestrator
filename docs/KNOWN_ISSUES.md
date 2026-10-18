# Known issues and release blockers

**Status as of 2026-10-18:** the repository supports controlled local development and test execution. A strict Phase 2 readiness audit returned `BLOCKED_NOT_READY`; it did not authorize execution or release. This list is intentionally conservative and does not include local database contents, credentials, or machine-specific evidence files.

## Release and governance blockers

1. **Frozen release artifact identity is not established.** The official frozen bundle is not present in the working tree, so the release process cannot prove that the artifact under review is exactly the frozen artifact. Resolve through the authorized bundle custodian; do not recreate or overwrite the frozen path as a workaround.
2. **Fresh exact-scope authorization and gate approval are missing.** No execution is permitted until the designated authorization authority supplies a valid, signed, scope-bound record and the gate custodian opens the correct gate.
3. **Independent candidate review is missing.** An authorized reviewer must independently review the precise candidate bundle and inventory hashes. Self-verification is not a substitute for this review.
4. **CASE-06 policy disposition is unresolved.** A valid signed disposition and verification against a trusted public-key anchor are required from the policy/specification authority.
5. **Static release-policy validation is blocked by prerequisites.** Re-run only after frozen identity and prerequisite review/authorization conditions are satisfied; passing unrelated unit tests does not close this gate.
6. **Authorization audit reconciliation is outstanding.** The one-shot authorization has been consumed and the audit metadata is stale. The authorized audit/authorization custodian must reconcile the official history; do not edit official records locally to manufacture a clean result.

## Runtime and acceptance gaps

- **Real autonomous specialist execution is not yet proven.** The successful local workflow evidence used scripted/prevalidated host task payloads. It proves workflow persistence and typed-evidence checks under that harness, not the quality or reliability of autonomous model workers.
- **Real OpenClaw/Gateway integration E2E is still required for M12.** Unit/contract tests do not prove native session/run identity, worker placement, cancellation/fencing, teardown, or recovery against a live isolated Gateway.
- **External delivery and exactly-once side effects are unproven.** Do not infer that durable local task completion guarantees a remote message/action was delivered exactly once.
- **Installed runtime and candidate source may differ.** Do not assume the local candidate has been installed or deployed just because it builds and passes extracted-package tests.
- **The local plugin is not an OS sandbox.** Workspace boundaries and structured command checks are defense-in-depth, not a replacement for a separately reviewed OS/container sandbox.
- **Legacy host-specific paths remain.** Some root-level compatibility/runtime scripts and older tests still refer to `/home/long/...`; the plugin entrypoint is `server/index.js`, but a broader portability cleanup needs targeted tests and should not be mixed with release-gate changes.

## Exit criteria

Release blockers close only when the required authorized records and independent verification exist for the exact candidate identity. Runtime gaps close only with reproducible isolated integration evidence. Keep unavailable, ambiguous, or stale evidence marked blocked/unverified; never reinterpret it as a pass.
