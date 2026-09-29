# P13 — Failure Injection

P13 verifies that expected failure modes fail closed and remain recoverable.

Run all injections:

```bash
npm run test:p13-failure-injection
```

Run selected modes:

```bash
P13_MODES=stale-lease,duplicate-result npm run test:p13-failure-injection
```

Covered modes:

- **stale-lease** — expired worker lease becomes `EXPIRED`, task returns to `pending`, next attempt gets a new lease.
- **duplicate-result** — first verified result completes the lease; the same result is rejected after the lease is no longer active.
- **provider-failure** — provider dispatch exception expires the acquired lease instead of leaving an orphaned active lease.
- **corrupt-evidence** — correlation tampering is rejected by the deterministic evidence verifier.
- **checkpoint-timeout** — a valid timeout checkpoint is accepted; mismatched checkpoint evidence is rejected.

P13 intentionally injects failures at the boundary rather than killing the development machine. Real process/runner kill tests belong to a later live GitHub Actions chaos run because they consume external runner time.
