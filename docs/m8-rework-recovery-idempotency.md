# M8 — Rework, Recovery, Idempotency

> **Document type:** Historical milestone record. Status labels and claims describe the original milestone scope and time only; they have not been independently revalidated against today's source/runtime as a whole and do not certify current deployment or release readiness. Verify current behavior against source and tests before relying on it.

Standard-engineering rework is revision-based.

- Existing tasks remain immutable history; rework creates new pending task revisions.
- Active artifacts in the affected branch are marked `invalidated`; new agent runs create new artifacts.
- QA failure routes `Engineer -> QA -> Reviewer`.
- Security failure routes `Engineer -> Security -> Reviewer`.
- Architecture failure routes `Architect -> Engineer -> affected verification -> Reviewer`.
- Requirements failure reopens the planning/implementation/verification chain.
- Rework preparation is idempotent by CTO decision artifact ID.
- A blocked `standard-engineering` v2 reviewer decision can also start a review-driven rework cycle without inventing a CTO decision. The cycle is idempotent by review artifact, invalidates only the affected active role artifacts, and binds each new task to its prior task/artifact and immutable plan task ID.
- `workflow_diagnose` is read-only and recommends an eligible recovery tool; `workflow_request_rework` does not retry failed execution attempts, approve synthesis, or change the immutable plan/success contract.
- Dependency checks, reviewer evidence binding, synthesis, and recovery verification resolve the latest revision for each immutable plan task ID; superseded task results remain in history but cannot satisfy current artifact checks.
- M8 does not modify the legacy `engineering` workflow.
