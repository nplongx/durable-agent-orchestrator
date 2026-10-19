# M6 — Reviewer Artifact Gate

> **Document type:** Historical milestone record. It captures design, implementation, or validation context for that milestone; it is not by itself proof of current deployment or release readiness.

The standard engineering Reviewer now produces a durable `review` artifact only after all seven upstream artifacts exist: requirements, architecture, implementation, security-review, qa-report, platform-review, and documentation.

The review schema records acceptance for each evidence domain, issue arrays, and a decision of `accept`, `reject`, or `needs_changes`. The durable artifact references the reviewer result plus every upstream artifact ID.

M6 does not synthesize a CTO decision. CTO remains the M7 authority.
