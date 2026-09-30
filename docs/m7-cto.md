# M7 — CTO Decision Artifact

The standard engineering CTO is the final synthesis gate. A successful CTO completion requires a durable `ReviewArtifact` and a structured decision.

`CTODecisionArtifact` contains:

- `decision`: `approve`, `reject`, or `rework`
- `summary`
- `accepted_requirements[]`
- `unresolved_risks[]`
- `follow_up_actions[]`
- `evidence_refs[]`

The durable artifact references the CTO result and the ReviewArtifact. M7 does not implement rework routing; that is M8.
