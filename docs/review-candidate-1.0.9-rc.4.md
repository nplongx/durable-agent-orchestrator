# Review candidate: 1.0.9-rc.4

**Status:** reproducible review candidate prepared; no GitHub Release or version tag has been created. It may be considered for a testing-only pre-release under the [tiered release policy](RELEASE_POLICY.md) after rebuilding/confirming the exact intended tag commit and verifying the minimum pre-release checklist. It is not the official frozen artifact and is not approved for production release.

For code and workflow context, see the [architecture explanation](architecture.md), [hybrid engineering workflow](hybrid-engineering-workflow.md), and [architecture illustrations](diagrams/README.md). These docs explain the implementation; they do not satisfy any of the formal release blockers below.

## Candidate identity

- Package version: `1.0.9-rc.4` in `package.json`, `package-lock.json`, and `plugin/manifest.json`.
- Bundle filename: `chat-on-steroids-local-orchestrator-1.0.9-rc.4-candidate-20261019T064500Z.mcpb`.
- Bundle size: `324398` bytes.
- Bundle SHA-256: `dc40671ff74f9238bb8cbd89658e0dc72972fa4940951108f5469fd829c7b2a8`.
- Candidate inventory: `benchmarks/plugin-workflow-benchmark/phase2-candidate-inventory-ade73e6-20261019T064655Z.json` (SHA-256 `77f54e62e1c87fd6c63d37aeac605e08e12fed79d00351d007d44d58e83ced74`; local ignored evidence file).
- Prepared from commit `ade73e69626e3ce6d10386d97599765e47df8079` on branch `prep/local-orchestrator-1.0.9-rc.4`.
- Two independent validated package builds produced byte-identical bundles with the SHA-256 above. The exact local `.mcpb` is ignored by Git and is not committed; transfer the artifact through an agreed handoff and independently verify its SHA-256 before review.

The `.mcpb` bundle is a local, ignored build output and is intentionally not committed to the repository. Reviewers must obtain the exact candidate bytes through an agreed artifact handoff and verify the SHA-256 before reviewing it. A hash establishes byte identity only; it does not establish authorization, provenance, correctness, or release readiness.

## Main changes

- Adds the `hybrid-engineering` workflow template: nine dependency-ordered specialist roles and two independent, code-authored deterministic syntax checks, submitted together through durable local `ExecutionManager` Batch Execution after their dependencies are satisfied.
- Pins optional custom role and Agent Skill snapshots into the approved immutable workflow plan without weakening built-in capabilities or permissions.
- Hardens batch preflight by validating stored command and working directory against the immutable execution plan.
- Adds reusable workflow policy packs, immutable policy version/attachment snapshots, strict rule validation, plan-bound violations, and a read-only dashboard policy view.
- Expands regression coverage and documentation for batch execution, policy enforcement limits, provenance, recovery, and package reproducibility.
- Aligns workflow diagnosis suggestions with the actual reviewer-revision eligibility guard so an accepted review with unresolved security/implementation/blocking findings is not offered an ineligible revision action.

## Validation recorded for this candidate

The following local checks completed successfully on the candidate source snapshot:

- `npm run test:protocol`
- `npm run test:workflow-m4`
- `npm test`
- `npm run test:package-reproducibility` — two independent validated builds were byte-identical for the recorded source snapshot; the manually repeated package build also produced identical `324398`-byte bundles with SHA-256 `dc40671ff74f9238bb8cbd89658e0dc72972fa4940951108f5469fd829c7b2a8`.
- `npm test` — includes a regression for diagnosis/revision eligibility mismatch; current `npm run docs:check` verifies 65 Markdown files and 203 local links, and `npm run docs:check:external` inspected 8 unique HTTP(S) URLs.
- Packaged MCP runtime smoke and strict extracted-package schema validation: 46/46 manifest tools.
- Lease-fencing, stdio framing/backpressure/shutdown regressions and hybrid-engineering E2E in the package validation path.
- A separately installed local runtime check confirmed that its 44 package entries matched the earlier `1.0.9-rc.3` candidate, and a fresh `hybrid-engineering` workflow completed 11/11 tasks, ran both approved syntax checks with exit code `0`, and passed 11/11 recovery invariants. That runtime check was against the installed `1.0.9-rc.3` bundle, not this `1.0.9-rc.4` artifact; do not present it as an installation test of this candidate.

These results are useful engineering evidence. They support a testing-candidate assessment only and do not replace a post-install test where needed, or the formal production/frozen-release gates. The installed-runtime workflow is specifically identified above to avoid confusing its `rc.3` provenance with this `rc.4` package.

## Artifact identity and handoff

The artifact identity above is the freshly built candidate associated with commit `ade73e69626e3ce6d10386d97599765e47df8079`. The release-notes draft is [release-notes-1.0.9-rc.4.md](release-notes-1.0.9-rc.4.md). The inventory and `.mcpb` are local ignored files, not repository attachments; provide both by an agreed handoff and verify their SHA-256 values before independent review. A matching hash proves byte identity only, not source approval, authorization, correctness, or release readiness.

## Outstanding release blockers

The strict Phase 2 readiness audit remains `BLOCKED_NOT_READY`. These outstanding items prevent calling the artifact official/frozen, production-ready, or deployment-authorized. They are not, by themselves, a veto on an explicitly testing-only GitHub pre-release that satisfies the separate [minimum release policy](RELEASE_POLICY.md):

1. Official frozen-artifact identity and custody.
2. Fresh, signed, exact-scope authorization and gate approval.
3. Independent review of this candidate bundle and inventory hashes.
4. A valid signed CASE-06 policy disposition, verified against a trusted public-key anchor.
5. Static release-policy validation after its prerequisites are satisfied.
6. Fresh Phase 2 host preflight in the intended host environment.
7. Authorization-audit reconciliation by the designated custodian.

Do not call this candidate frozen/production-approved or edit official authorization/audit records to manufacture a pass. A testing pre-release is a separate, limited publication and must retain these blockers in its notes. For current scope and minimum criteria, see [the release policy](RELEASE_POLICY.md) and [Known issues](KNOWN_ISSUES.md).
