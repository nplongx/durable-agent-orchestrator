# Review candidate: 1.0.9-rc.4

**Status:** candidate documented for a testing-only pre-release under the [tiered release policy](RELEASE_POLICY.md). It is not the official frozen artifact, is not deployment-authorized, and is not approved for production release.

For code and workflow context, see the [architecture explanation](architecture.md), [hybrid engineering workflow](hybrid-engineering-workflow.md), and [architecture illustrations](diagrams/README.md). These docs explain the implementation; they do not satisfy any of the formal release blockers below.

## Candidate identity

- Package version: `1.0.9-rc.4` in `package.json`, `package-lock.json`, and `plugin/manifest.json`.
- Bundle filename: `chat-on-steroids-local-orchestrator-1.0.9-rc.4.mcpb`.
- Bundle size: `324541` bytes.
- Bundle SHA-256: `bfb68c11317dc394f6d1ea85368a801dc9f6f473974e34e96d02736747776552`.
- Source identity: `v1.0.9-rc.4` tag target; the package and source inventory were generated from that commit.
- Candidate inventory: `benchmarks/plugin-workflow-benchmark/phase2-candidate-inventory-v1.0.9-rc.4-20261019.json` (supplemental local evidence; the inventory must be regenerated from the final tag target and independently hashed; its status is unapproved candidate evidence only).
- Two independent validated package builds were byte-identical with the SHA-256 above. The release bundle is attached to the GitHub testing pre-release; verify the downloaded asset SHA-256 before installation.

The `.mcpb` bundle is an ignored build output and is not committed to the Git repository; the GitHub release carries the package and checksum sidecar. Verify the asset SHA-256 before use. A hash establishes byte identity only; it does not establish authorization, correctness, or production release readiness.

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
- `npm run test:package-reproducibility` — two independent validated builds were byte-identical; the final candidate is `324541` bytes with SHA-256 `bfb68c11317dc394f6d1ea85368a801dc9f6f473974e34e96d02736747776552`.
- `npm test` — includes a regression for diagnosis/revision eligibility mismatch; current `npm run docs:check` verifies 66 Markdown files and 211 local links, and `npm run docs:check:external` inspected 8 unique HTTP(S) URLs.
- Packaged MCP runtime smoke and strict extracted-package schema validation: 46/46 manifest tools.
- Lease-fencing, stdio framing/backpressure/shutdown regressions and hybrid-engineering E2E in the package validation path.
- A separately installed local runtime check confirmed that its 44 package entries matched the earlier `1.0.9-rc.3` candidate, and a fresh `hybrid-engineering` workflow completed 11/11 tasks, ran both approved syntax checks with exit code `0`, and passed 11/11 recovery invariants. That runtime check was against the installed `1.0.9-rc.3` bundle, not this `1.0.9-rc.4` artifact; do not present it as an installation test of this candidate.

These results are useful engineering evidence. They support a testing-candidate assessment only and do not replace a post-install test where needed, or the formal production/frozen-release gates. The installed-runtime workflow is specifically identified above to avoid confusing its `rc.3` provenance with this `rc.4` package.

## Artifact identity and handoff

The release tag `v1.0.9-rc.4` identifies the source commit from which the package was built and the inventory was generated. The public release includes the `.mcpb` and checksum sidecar; the candidate inventory is supplemental, unapproved review evidence. Verify the downloaded package checksum before installation. The testing pre-release is not an official frozen artifact and a hash does not imply authorization or production readiness.

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
