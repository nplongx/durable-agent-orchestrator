# M8 — Rework, Recovery, Idempotency

Standard-engineering rework is revision-based.

- Existing tasks remain immutable history; rework creates new pending task revisions.
- Active artifacts in the affected branch are marked `invalidated`; new agent runs create new artifacts.
- QA failure routes `Engineer -> QA -> Reviewer`.
- Security failure routes `Engineer -> Security -> Reviewer`.
- Architecture failure routes `Architect -> Engineer -> affected verification -> Reviewer`.
- Requirements failure reopens the planning/implementation/verification chain.
- Rework preparation is idempotent by CTO decision artifact ID.
- M8 does not modify the legacy `engineering` workflow.
