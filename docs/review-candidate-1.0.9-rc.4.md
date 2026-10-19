# Review candidate: 1.0.9-rc.4

**Status:** candidate prepared for independent review; not a published GitHub Release, not the official frozen artifact, and not approved for production release.

## Candidate identity

- Package version: `1.0.9-rc.4` in `package.json`, `package-lock.json`, and `plugin/manifest.json`.
- Bundle filename: `chat-on-steroids-local-orchestrator-1.0.9-rc.4-review-candidate-20261019T024611Z-hybrid-engineering.mcpb`.
- Bundle size: `325107` bytes.
- Bundle SHA-256: `efbe0fe095613488f97969a45f66d8bf064ab725b994607aa80cd0f78e61cd6a`.
- Prepared from branch: `prep/local-orchestrator-1.0.9-rc.4`.
- Candidate source: `prep/local-orchestrator-1.0.9-rc.4` branch content. The final commit containing these review-documentation updates is part of the same PR; rerun reproducibility checks on the pushed head before accepting the candidate as the exact review input.

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
- `npm run test:package-reproducibility` — two independent validated builds were byte-identical; stable input SHA-256 `7c5e839021ffaf2dc1eb8c270470afa724bc7c50945b843c5b7b84620673431e`.
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
