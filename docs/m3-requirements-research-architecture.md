# M3 — Requirements, Research, Architecture

M3 makes the first three planning artifacts durable and typed.

## Flow

product-owner → requirements → researcher → research → architect → architecture → engineer

The standard-engineering DAG already expresses the same ordering. M3 makes the artifact contract explicit so the Architect's durable output is traceable to Requirements and Research evidence.

## Artifact schemas

- Requirements: scope, acceptance_criteria, non_goals
- Research: findings, sources, limitations
- Architecture: components, interfaces, failure_modes, implementation_boundary

Each artifact keeps evidence references and a SHA-256 content hash. Invalid required content is rejected before persistence.

## Agent inputs

Agent contracts now expose canonical input artifact types. Architect requires Requirements + Research; Engineer requires Requirements + Architecture.

## Compatibility

M3 is additive. The existing production and M4 workflow definitions remain unchanged. No provider, Chrome, OpenClaw, or live database state is modified by the M3 tests.
