# Known issues and release blockers

**Status as of 2026-10-19:** the repository supports controlled local development and test execution. A strict Phase 2 readiness audit returned `BLOCKED_NOT_READY`; it did not authorize execution or release. A separate `1.0.9-rc.4` review candidate has since been built and reproducibility-checked, but that does not close any of the formal release gates below. See [the exact candidate record](review-candidate-1.0.9-rc.4.md). This list is intentionally conservative and does not include local database contents, credentials, or machine-specific evidence files.

For codebase orientation, see the [visual documentation index](diagrams/README.md). The diagrams are explanatory views only; they do not close any release or authorization blocker listed here.

## Release and governance blockers

- **The recorded `1.0.9-rc.4` bundle is stale relative to the current checkout.** Additional workflow recovery, specialist guidance, documentation checker, tests, and documentation edits have been made after the recorded candidate was built. Its old bundle digest must not be presented as the identity of the current source. Rebuild and reproduce a fresh candidate, then complete all required authorization and independent-review gates before considering publication.

1. **Frozen release artifact identity is not established.** The locally built `1.0.9-rc.4` candidate has a recorded filename and SHA-256, but the official frozen bundle is not present in the working tree, so the release process cannot prove that the candidate under review is the authorized frozen artifact. Resolve through the authorized bundle custodian; do not recreate or overwrite the frozen path as a workaround.
2. **Fresh exact-scope authorization and gate approval are missing.** No execution is permitted until the designated authorization authority supplies a valid, signed, scope-bound record and the gate custodian opens the correct gate.
3. **Independent candidate review is missing.** An authorized reviewer must independently review the precise `1.0.9-rc.4` candidate bundle and inventory hashes recorded in [the candidate record](review-candidate-1.0.9-rc.4.md). Self-verification and CI results are not substitutes for this review.
4. **CASE-06 policy disposition is unresolved.** A valid signed disposition and verification against a trusted public-key anchor are required from the policy/specification authority.
5. **Static release-policy validation is blocked by prerequisites.** Re-run only after frozen identity and prerequisite review/authorization conditions are satisfied; passing unrelated unit tests does not close this gate.
6. **Authorization audit reconciliation is outstanding.** The one-shot authorization has been consumed and the audit metadata is stale. The authorized audit/authorization custodian must reconcile the official history; do not edit official records locally to manufacture a clean result.

## Runtime and acceptance gaps

- **Real autonomous specialist execution is not yet proven.** The successful local workflow evidence used scripted/prevalidated host task payloads. It proves workflow persistence and typed-evidence checks under that harness, not the quality or reliability of autonomous model workers.
- **Real OpenClaw/Gateway integration E2E is still required for M12.** Unit/contract tests do not prove native session/run identity, worker placement, cancellation/fencing, teardown, or recovery against a live isolated Gateway.
- **External delivery and exactly-once side effects are unproven.** Do not infer that durable local task completion guarantees a remote message/action was delivered exactly once.
- **Installed bundle identity has a narrower verification boundary.** After the latest reinstall, health reports runtime version `1.0.9-rc.4`, and the installed `server/index.js` and `src/runtime/job-store.js` SHA-256 values matched this checkout during recovery verification. The host does not expose the exact installed `.mcpb` archive hash, so this does not establish identity with any separately frozen/authorized release bundle.
- **The local plugin is not an OS sandbox.** Workspace boundaries and structured command checks are defense-in-depth, not a replacement for a separately reviewed OS/container sandbox.
- **Legacy host-specific paths remain.** Some root-level compatibility/runtime scripts and older tests still refer to `/home/long/...`; the plugin entrypoint is `server/index.js`, but a broader portability cleanup needs targeted tests and should not be mixed with release-gate changes.

## Exit criteria

Release blockers close only when the required authorized records and independent verification exist for the exact candidate identity. Runtime gaps close only with reproducible isolated integration evidence. Keep unavailable, ambiguous, or stale evidence marked blocked/unverified; never reinterpret it as a pass.
