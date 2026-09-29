# Durable Agent Orchestrator — Agent Architecture Proposal

## Architecture decision

Use fewer OpenClaw agents with explicit bounded capabilities. LangGraph remains the workflow authority. WorkflowCompiler compiles a workflow definition into a DAG. SQLite is durable source of truth. ExecutionManager is the sole authority for commands and execution evidence.

## OpenClaw roles

- ProductOwner — requirements and durable acceptance criteria.
- Researcher — read-mostly repository/API/dependency/external research.
- Architect — structured architecture, implementation tasks, verification plan.
- Engineer — code modification and authorized execution requests.
- QA — verification/testing; execution evidence must come from ExecutionManager.
- Security — conditional independent security review.
- Platform — conditional infrastructure/deployment/runtime review.
- Reviewer — evaluates requirements, architecture, implementation, and evidence.
- Writer — documentation after review; no implementation changes.
- CTO — evidence synthesis and executive decision artifact only.

No Coordinator, Planner Agent, or initial Debugger Agent.

## ProductOwner

Contract:

```js
{
  role: "product-owner",
  capability: "product.requirements",
  output: {
    goal,
    scope,
    nonGoals,
    acceptanceCriteria,
    constraints,
    priority
  }
}
```

Acceptance criteria become a durable artifact shared by Architect, Engineer, QA, and Reviewer.

## Researcher

Spawn only when research is needed:

- repository exploration
- existing implementation discovery
- API/library research
- dependency analysis
- migration impact
- external technical research
- precedent/design-pattern discovery

Read-mostly. No production-code modification.

```js
{
  role: "researcher",
  capability: "research.collect",
  permissions: ["workspace.read", "web.search", "artifact.create"]
}
```

## Architect

Architect should produce structured evidence, not only prose:

```js
{
  architecture: {
    approach,
    components,
    interfaces,
    dependencies,
    risks,
    migrationPlan
  },
  implementationTasks: [...],
  verificationPlan: [...]
}
```

WorkflowCompiler converts the artifact into the execution plan.

## Engineer

Engineer is the code-modifying role:

```
Engineer
  |
  +-- modify files
  +-- request authorized commands
  +-- emit evidence
          |
          v
   ExecutionManager
```

LLM prose is not execution evidence. Engineer does not control workflow state.

## QA

Two future layers:

- Static: `node --check`, lint, typecheck.
- Behavioral: unit, integration, E2E, regression.

QA may propose test specifications, but ExecutionManager executes commands and supplies actual exit codes/trajectory.

## Security

Conditional. Compiler spawns it when:

```
risk.requiresSecurityReview === true
```

Typical triggers: authentication, authorization, secrets, external APIs, filesystem permissions, SQL, shell execution, network exposure, PII, dependency upgrades, deployment.

Security is independent of Engineer.

## Platform

Conditional. Trigger for Docker, deployment, CI/CD, cloud, networking, database infrastructure, process/runtime, or observability changes.

Example:

```
Engineer -> QA -> Reviewer

Engineer -> QA ----+
                  +-> Platform -> Reviewer
Security ----------+
```

## Reviewer

Reviewer remains separate from QA.

```
Engineer
   |
  QA
   |
Reviewer
   |
 CTO
```

QA asks: "Does it work?"

Reviewer asks: "Is this change acceptable relative to requirements, architecture and evidence?"

Reviewer consumes:

- requirements
- architecture plan
- implementation changes
- QA evidence
- Security evidence
- Platform evidence

Reviewer artifact:

```js
{
  review: {
    requirementsSatisfied,
    architectureConformant,
    implementationIssues,
    evidenceIssues,
    blockingIssues
  }
}
```

## Writer

Runs after Reviewer and before CTO.

Can create README, changelog, migration guide, API documentation, release notes, and user-facing summaries. Does not modify implementation.

```js
{
  role: "writer",
  capability: "documentation.write",
  inputs: [
    "requirements",
    "architecture",
    "implementation",
    "qa",
    "security",
    "review"
  ]
}
```

## CTO

CTO is not a generic manager agent.

CTO performs:

- evidence synthesis
- executive decision artifact

CTO does not spawn agents, retry Engineer, or mark workflow completion. LangGraph owns those decisions.

## Verifier

Verifier is a deterministic system component, not an OpenClaw agent.

It validates:

- workflow plan exists
- plan hash is valid
- required tasks exist
- dependencies are satisfied
- every required execution has evidence
- exit codes are valid
- no required task failed
- review artifact exists
- documentation requirement is satisfied
- synthesis is valid
- durable report exists
- Slack projection pending is zero

Only after verification may terminalization occur.

## Failure/remediation

No dedicated Debugger Agent initially.

```
QA failure
   |
LangGraph failure transition
   |
Engineer remediation
   |
ExecutionManager
   |
QA
```

Retry is a workflow transition, not agent self-orchestration.

## No Planner Agent

LangGraph + WorkflowCompiler + WorkflowPlan already form the planner/control plane.

Adding a Planner Agent would create two competing authorities:

```
Planner LLM says A
LangGraph plan says B
```

Avoid this.

## System components

These are not OpenClaw agents:

- LangGraph Orchestrator
- Workflow Compiler
- ExecutionManager
- ProviderAdmission
- RecoveryManager
- Verifier
- SQLite
- Slack Projection

Ownership:

```
LANGGRAPH — workflow authority
        |
        +-- ProductOwner / Researcher / Architect
        |
        +-- Engineer
        |     +-- QA
        |     +-- Security (conditional)
        |     +-- Platform (conditional)
        |
        +-- Reviewer
        +-- Writer (conditional)
        +-- Verifier
        +-- CTO
        |
        +-- TERMINALIZE
```

This is not a fixed pipeline. Compiler decides which nodes exist for each workflow.

## Implementation roadmap

### M4

```
Architect -> Engineer -> QA -> Reviewer -> CTO
```

Vertical slice for code-changing workflow.

### M5

- Verifier
- dependency DAG
- prerequisite gates
- failure/remediation transitions

### M6

- ProductOwner
- Researcher
- Writer

### M7

- Security
- Platform

### Generalized model

```
WorkflowDefinition
       |
WorkflowCompiler
       |
WorkflowPlan
       |
TaskCapability
       |
ExecutionManager
       |
Evidence
       |
Verifier
       |
Terminalization
```

## Final technical position

Roles:

ProductOwner, Researcher, Architect, Engineer, QA, Security, Platform, Reviewer, Writer, CTO.

Security and Platform are conditional.

Do not add Coordinator, Planner Agent, or initial Debugger Agent.

Core principle: bounded agent capabilities + deterministic control plane + durable evidence. Verifier and ExecutionManager are more important than adding another LLM controller.
