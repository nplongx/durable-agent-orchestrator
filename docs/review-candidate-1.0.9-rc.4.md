# Review candidate: 1.0.9-rc.4

**Status:** candidate prepared for independent review; not a published GitHub Release, not the official frozen artifact, and not approved for production release.

For code and workflow context, see the [architecture explanation](architecture.md), [hybrid engineering workflow](hybrid-engineering-workflow.md), and [architecture illustrations](diagrams/README.md). These docs explain the implementation; they do not satisfy any of the formal release blockers below.

## Candidate identity

- Package version: `1.0.9-rc.4` in `package.json`, `package-lock.json`, and `plugin/manifest.json`.
- Bundle filename: `chat-on-steroids-local-orchestrator-1.0.9-rc.4-candidate-20261019T040737Z.mcpb`.
- Bundle size: `317698` bytes.
- Bundle SHA-256: `4a31a58173836bd4be7c183d679282beef454d6f4673ac8003ccf36b94a0177e`.
- Prepared from branch: `prep/local-orchestrator-1.0.9-rc.4`.
- Candidate source: `prep/local-orchestrator-1.0.9-rc.4` branch content including the rewritten root README with current documentation navigation. Two independent validated builds of the selected package inputs produced the same bundle SHA-256; the stable input SHA-256 is recorded below. The review must use the exact bundle bytes and verify the digest above.

The `.mcpb` bundle is a local, ignored build output and is intentionally not committed to the repository. Reviewers must obtain the exact candidate bytes through an agreed artifact handoff and verify the SHA-256 before reviewing it. A hash establishes byte identity only; it does not establish authorization, provenance, correctness, or release readiness.

## Main changes

- Adds the `hybrid-engineering` workflow template: nine dependency-ordered specialist roles and two independent, code-authored deterministic syntax checks, submitted together through durable local `ExecutionManager` Batch Execution after their dependencies are satisfied.
- Pins optional custom role and Agent Skill snapshots into the approved immutable workflow plan without weakening built-in capabilities or permissions.
- Hardens batch preflight by validating stored command and working directory against the immutable execution plan.
- Adds reusable workflow policy packs, immutable policy version/attachment snapshots, strict rule validation, plan-bound violations, and a read-only dashboard policy view.
- Expands regression coverage and documentation for batch execution, policy enforcement limits, provenance, recovery, and package reproducibility.

## Validation recorded for this candidate

The following local checks completed successfully on the candidate source snapshot:

- `npm run test:protocol`
- `npm run test:workflow-m4`
- `npm test`
- `npm run test:package-reproducibility` — two independent validated builds were byte-identical; stable input SHA-256 `f22de974db20097aa8d9947a0c559ca3b9b8a89ebd3152989a4a0252aac37afb`.
- Packaged MCP runtime smoke and strict extracted-package schema validation: 46/46 manifest tools.
- Lease-fencing, stdio framing/backpressure/shutdown regressions and hybrid-engineering E2E in the package validation path.
- A separately installed local runtime check confirmed that its 44 package entries matched the earlier `1.0.9-rc.3` candidate, and a fresh `hybrid-engineering` workflow completed 11/11 tasks, ran both approved syntax checks with exit code `0`, and passed 11/11 recovery invariants. That runtime check was against the installed `1.0.9-rc.3` bundle, not this `1.0.9-rc.4` artifact; do not present it as an installation test of this candidate.

These results are useful engineering evidence but do not replace independent review of the exact `1.0.9-rc.4` bytes or the formal release gates. The installed-runtime workflow is specifically identified above to avoid confusing its `rc.3` provenance with this `rc.4` package.

## Outstanding release blockers

The strict Phase 2 readiness audit remains `BLOCKED_NOT_READY`. Before creating a prerelease or calling this artifact frozen, the authorized process must establish all of the following for the exact candidate identity:

1. Official frozen-artifact identity and custody.
2. Fresh, signed, exact-scope authorization and gate approval.
3. Independent review of this candidate bundle and inventory hashes.
4. A valid signed CASE-06 policy disposition, verified against a trusted public-key anchor.
5. Static release-policy validation after its prerequisites are satisfied.
6. Authorization-audit reconciliation by the designated custodian.

Do not create a release tag, publish a GitHub prerelease, overwrite a frozen bundle, or edit official authorization/audit records to bypass these blockers. See [Known issues and release blockers](KNOWN_ISSUES.md).
