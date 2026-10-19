# Release policy: testing pre-release vs production release

This policy separates a public, explicitly experimental GitHub pre-release from an official frozen or production release. A strict readiness audit is scoped to the deployment/production gate; its `BLOCKED_NOT_READY` result must remain visible, but it is not by itself a veto on publishing a clearly labeled testing pre-release.

## Tier 1 — Testing pre-release (`-rc.N`)

A pre-release lets users install and evaluate a candidate and report defects. It is **not** a production-readiness statement, formal deployment authorization, or claim that all integration work is complete. A maintainer may publish one with known non-production gates still open when all minimum pre-release checks below pass and the unresolved limitations are prominent in the release notes.

### Minimum pre-release checks

1. **Exact source identity:** identify the commit the package is built from. Create the release tag on that same commit; do not attach a package built from a different code snapshot and imply it came from the tag.
2. **Package integrity:** package creation completes successfully; package MCP initialization/tool discovery and extracted tool-schema checks pass; the final artifact has a recorded byte size and SHA-256. Reproducible builds should match where the project has a reproducibility check (`npm run test:package-reproducibility`). Attach the exact `.mcpb` and a checksum file, or publish an equivalent verifiable artifact handoff.
3. **Relevant automated checks:** run the normal regression suite (`npm test`), batch tests (`npm run test:batch`), package validation, and documentation link check (`npm run docs:check`). Run focused suites affected by the change. If a check is not run or fails, disclose that explicitly; do not describe it as passing.
4. **Install/use boundary:** smoke-test the packaged runtime when feasible. If the candidate has only been checked in a package harness and not installed into the target host, state that limitation. Do not claim a live Gateway, remote worker, or other integration works without evidence for that path.
5. **Honest release notes:** list the exact version, tag/source commit, package filename, size and SHA-256; summarize changes and verification; state that the build is experimental and not for production; list significant known gaps, workarounds, and tests not performed. Do not imply formal approval or a clean readiness audit if neither exists.
6. **No release-critical known failure:** do not publish if the artifact checksum/build identity is inconsistent, package startup/tool discovery fails, the package is corrupted, or there is an unresolved issue likely to cause severe data loss or compromise in the stated test scope. Fix the failure or narrow/disable the affected test path before publishing.

### Not required solely for a testing pre-release

The following are **production/frozen-release gates**, not universal prerequisites for an experimental GitHub pre-release: an official frozen-bundle custody record, formal signed exact-scope deployment authorization, a separate independent review attestation for the frozen bundle, a signed CASE-06 disposition, Phase 2 static deployment-policy validation, and authorization-audit reconciliation. These items must remain recorded as open; they must not be fabricated, silently waived in their own records, or represented as passed. A pre-release publisher accepts and communicates the residual risk instead of claiming those gates have passed.

The Phase 2 readiness audit remains authoritative for the scope it evaluates. Keep its result as `BLOCKED_NOT_READY` when applicable. Do not edit audit/authorization records to turn that result into a pass. A pre-release decision under this policy is an explicitly limited testing publication, not a substitution for the formal audit result.

## Tier 2 — Official frozen or production release

Do not label an artifact official, frozen, production-ready, or deployment-authorized until the formal gates for its scope are satisfied. These include, where applicable:

- exact frozen-artifact identity and custody;
- fresh, valid, signed, exact-scope authorization and gate approval;
- independent review of the exact artifact and inventory;
- valid CASE-06 policy disposition verified against a trusted authority key;
- successful static release/deployment policy validation;
- authorization-audit reconciliation by the designated custodian;
- required live integration and host acceptance evidence for the features being claimed.

The complete Phase 2 readiness audit is required for the formal Phase 2 deployment/production lane. Passing unit tests or publishing an experimental pre-release does not close these gates.

## Publishing checklist

Before using `gh release create` or the GitHub Releases UI for a testing pre-release, confirm the minimum checks above, choose the GitHub **pre-release** setting, attach the package and checksum, use notes that say **testing only — not production**, and link to [Known issues](KNOWN_ISSUES.md). After publishing, verify the tag target, release URL, asset names, downloaded asset checksum, and pre-release flag. If any minimum check cannot be demonstrated, keep the release as a draft and state the missing evidence.

For `1.0.9-rc.4`, the existing local candidate hash identifies only the artifact in its candidate dossier. If source or package inputs change before publication, rebuild and re-verify from the intended release commit, then update all candidate/release notes to the new identity.
