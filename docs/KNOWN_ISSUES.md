# Known issues and release blockers

**Status as of 2026-10-19:** the repository supports controlled local development and test execution. The strict Phase 2 readiness audit returned `BLOCKED_NOT_READY` for its formal deployment/production scope. Under the separate [release policy](RELEASE_POLICY.md), that result does not alone prevent a clearly labeled testing-only GitHub pre-release when its minimum package, test, identity, and disclosure checks pass. It continues to block any claim that the candidate is the official frozen artifact, production-ready, or deployment-authorized. See [the exact candidate record](review-candidate-1.0.9-rc.4.md). This list is intentionally conservative and does not include local database contents, credentials, or machine-specific evidence files.

For codebase orientation, see the [visual documentation index](diagrams/README.md). The diagrams are explanatory views only; they do not close any release or authorization blocker listed here.

## Production/frozen-release blockers

The blockers below apply to calling the candidate official/frozen, using it for the formal Phase 2 deployment lane, or claiming production readiness. They do not by themselves veto an experimental pre-release under [the separate minimum standard](RELEASE_POLICY.md). Keep every status accurate; do not forge, silently waive, or report formal blockers as passed.

The historical RC.4 testing package is `324541` bytes (SHA-256 `bfb68c11317dc394f6d1ea85368a801dc9f6f473974e34e96d02736747776552`), built and inventoried from the source commit selected by tag `v1.0.9-rc.4`. Verify the release asset with its `.sha256` sidecar before use. This identity is for the experimental package only; it is not the missing official frozen release artifact and closes none of the production blockers.

1. **Frozen release artifact identity is not established.** The official frozen bundle is not present in the working tree, so the formal process cannot prove that the candidate under review is the authorized frozen artifact. Resolve this through the authorized bundle custodian; do not recreate or overwrite the frozen path as a workaround.
2. **Fresh exact-scope authorization and gate approval are missing.** The formal deployment lane requires a valid, signed, scope-bound record from the designated authorization authority and the correct gate transition by its custodian.
3. **Independent candidate review is missing.** An authorized reviewer must independently review the precise bundle and inventory hashes before a frozen/production release. Self-verification and CI results are not substitutes for this review.
4. **CASE-06 policy disposition is unresolved.** A valid signed disposition and verification against a trusted public-key anchor are required from the policy/specification authority for the formal release lane.
5. **Fresh Phase 2 host preflight is blocked.** Re-run the preflight in the intended host environment and satisfy its disk/resource requirements before formal Phase 2 deployment.
6. **Static release-policy validation is blocked by prerequisites.** Re-run after frozen identity, review, authorization, and host-preflight prerequisites are satisfied; unrelated unit tests do not close this gate.
7. **Authorization audit reconciliation is outstanding.** The one-shot authorization has been consumed and the audit metadata is stale. The authorized audit/authorization custodian must reconcile the official history before formal production/deployment approval; do not edit official records locally to manufacture a clean result.

## Runtime and acceptance gaps

- **Real autonomous specialist execution is not yet proven.** The successful local workflow evidence used scripted/prevalidated host task payloads. It proves workflow persistence and typed-evidence checks under that harness, not the quality or reliability of autonomous model workers.
- **Real OpenClaw/Gateway integration E2E is still required for M12.** Unit/contract tests do not prove native session/run identity, worker placement, cancellation/fencing, teardown, or recovery against a live isolated Gateway.
- **External delivery and exactly-once side effects are unproven.** Do not infer that durable local task completion guarantees a remote message/action was delivered exactly once.
- **Installed bundle identity has a narrower verification boundary.** After the latest reinstall, health reports runtime version `1.0.9-rc.4`, and the installed `server/index.js` and `src/runtime/job-store.js` SHA-256 values matched this checkout during recovery verification. The host does not expose the exact installed `.mcpb` archive hash, so this does not establish identity with any separately frozen/authorized release bundle.
- **The local plugin is not an OS sandbox.** Workspace boundaries and structured command checks are defense-in-depth, not a replacement for a separately reviewed OS/container sandbox.
- **Legacy host-specific paths remain.** Some root-level compatibility/runtime scripts and older tests still refer to `/home/long/...`; the plugin entrypoint is `server/index.js`, but a broader portability cleanup needs targeted tests and should not be mixed with release-gate changes.

## Exit criteria

For a testing pre-release, satisfy the minimum checklist in [the release policy](RELEASE_POLICY.md), identify the exact tagged source/package, attach a checksum-verified artifact, and disclose these open limitations. Formal production/frozen-release blockers close only when the required authorized records and independent verification exist for the exact candidate identity. Runtime gaps close only with reproducible isolated integration evidence. Keep unavailable, ambiguous, or stale evidence marked blocked/unverified; never reinterpret it as a pass.
