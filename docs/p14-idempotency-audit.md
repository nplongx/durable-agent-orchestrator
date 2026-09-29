# P14 — Idempotency Audit

P14 audits retry/recovery boundaries.

## Guards

- An active lease with a persisted provider run is returned instead of dispatched again.
- An active lease without a persisted provider run fails closed.
- Verified results are rejected when the same provider run was already recorded.
- Existing lease fencing rejects late results from expired/completed leases.
- Existing event dedupe uses deterministic event IDs.

## External side-effect boundary

There is one unavoidable crash window:

\`\`\`
POST GitHub workflow_dispatch
        |
        +-- process dies before provider_runs is persisted
\`\`\`

SQLite and the GitHub API do not share a transaction. Therefore exactly-once GitHub dispatch cannot be proven locally. P14 does not pretend otherwise.

The scheduler now fails closed for an active lease with no persisted provider run. Recovery after that lease expires still requires provider-side reconciliation to distinguish a genuinely unsubmitted dispatch from an external dispatch that happened immediately before the crash.

Run:

\`\`\`bash
npm run test:p14-idempotency
\`\`\`
