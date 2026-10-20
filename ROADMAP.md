# Runalith roadmap proposals

**Status date:** 2026-10-19
**Document type:** Proposed work and acceptance criteria, not a claim that each item is already implemented or release-approved.

This roadmap tracks the follow-on hardening proposals that remain after the initial job-liveness diagnostics work. Priorities are relative engineering priorities; production/frozen-release approval remains governed by [`docs/RELEASE_POLICY.md`](docs/RELEASE_POLICY.md) and [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md).

## Current change

- [x] **Job liveness diagnostics — read-only first increment.** Report durable activity age, running tasks, active lease heartbeat/expiry, runtime phase, and likely stale candidates. The tool does not change state, expire/reacquire leases, retry work, dispatch jobs, or claim that silence proves a worker is dead. Future work may add a heartbeat source for host reasoning only if it can be tied to the exact task/attempt and fenced against stale writers.

## Proposed follow-on work

### P0 — MCP manifest/runtime contract parity

**Problem:** A working host registry, checked-in manifest, packaged MCP server, and generated reference must expose the same intended tool set and compatible schemas.

**Proposal:** Add a contract test that compares unique tool names and relevant metadata between `server/index.js` `tools/list`, `plugin/manifest.json`, and `docs/MCP_REFERENCE.md`. Explicitly whitelist documented runtime-only tools if the host contract requires any; otherwise fail on missing, extra, or duplicate tools. Generate the reference in CI and require a clean diff.

**Acceptance:** A clean isolated run shows no unexplained tool-count or schema drift; a negative test proves a removed/renamed tool is caught before packaging.

### P0 — Evaluate `workflow_recommend_resources` against a benchmark

**Problem:** Successful invocation and lexical overlap do not establish recommendation relevance or policy compatibility.

**Proposal:** Build Vietnamese/English task fixtures with expected reusable workflow/role/skill/policy candidates, hard negatives, ambiguous tasks, and cases where no recommendation should be made. Measure top-1 accuracy, precision@k, false-positive rate, and abstention quality. Keep lexical scores as ranking evidence, not semantic proof.

**Safety boundary:** Resource matching stays read-only. Policy attachment, role binding, approval, and execution remain separate actions governed by target-plan compatibility checks and explicit authorization.

**Acceptance:** The benchmark reports reproducible metrics and regression fixtures; low-confidence or incompatible candidates are not silently promoted as safe matches.

### P1 — Expand crash/restart and durable-state invariant tests

**Problem:** Unit tests around individual transitions may miss inconsistent combinations of job, task, attempt, event, artifact, and lease records after interrupted writes or process death.

**Proposal:** Add failure injection at the remaining persistence boundaries and restart from a fresh process/SQLite connection. Verify terminal-event uniqueness, current attempt identity, job/task phase consistency, and that recovery never duplicates side effects or replays work without a valid idempotency/fencing contract.

**Acceptance:** Every injected crash point has an explicit expected durable state; the recovered state is independently read back and classified as recovered, blocked, or requiring intervention.

### P1 — Extend workspace-write security regressions

**Problem:** Scope enforcement needs negative tests for path normalization and filesystem edge cases, not only ordinary in-scope/out-of-scope paths.

**Proposal:** Expand tests for `..` normalization, absolute paths, symlink traversal and replacement races, path aliases, unexpected file types, partial multi-file writes, concurrent base-hash changes, and restart reconciliation of write receipts.

**Acceptance:** Every rejected write leaves disallowed paths unchanged; every partial outcome is explicitly reported; retry behavior is deterministic and hash-fenced. Preserve the warning that application checks are not an OS sandbox.

### P1 — Evidence-backed task completion and final claims

**Problem:** Narrative assertions such as “implemented” or “tests passed” must not exceed durable evidence.

**Proposal:** Standardize completion summaries around changed-file receipts/diff, exact test command and exit status, unresolved failures, and links/IDs for durable task results and artifacts. Distinguish *submitted*, *running*, *completed*, and *independently verified*. Add regression cases where missing, stale, or mismatched evidence must block a success claim.

**Acceptance:** Final success claims map to current task attempts and exact results/artifacts; missing or conflicting evidence is reported as unresolved rather than inferred successful.

### P1 — Reproducible packaging and release inventory

**Problem:** Passing source tests is not by itself proof that an installed package contains that source or that a candidate is the authorized release artifact.

**Proposal:** Run package construction from a clean workspace; compare packaged file inventory and hashes with the intended source; verify manifest/runtime parity, generated docs, and archive checksum; preserve a machine-readable inventory and test summary for the exact candidate. Keep experimental package identity separate from any frozen/authorized artifact identity.

**Acceptance:** Repeated clean builds meet the project's reproducibility contract; package contents, version, inventory, and SHA-256 are linked to one exact candidate; no production/frozen-release claim is made without the separate required authorization and independent review.

### P2 — Host integration and autonomous-worker E2E evidence

**Problem:** Local MCP workflow tests do not prove real host session identity, autonomous specialist execution quality, cancellation/fencing, or external delivery semantics.

**Proposal:** Run isolated end-to-end tests against the intended host/Gateway integration with explicit identities, lifecycle cancellation, teardown, restart, and uncertain-delivery scenarios. Report local runtime guarantees separately from host integration and external side effects.

**Acceptance:** Evidence names the exact environment and candidate, checks identity/fencing/recovery boundaries, and does not infer exactly-once delivery from a local completion record.

## Non-goals for these proposals

- No automatic retry merely because an activity timestamp is old.
- No policy or permission is granted by resource recommendation, a role label, or a green diagnostic result.
- No cloud runner or external model API is implied by local diagnostics.
- No local test can waive the authorized production/frozen-release gates.
