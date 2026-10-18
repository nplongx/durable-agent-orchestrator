#!/usr/bin/env node
// Read-only reconciliation of the current Phase 2 readiness and v3.8 one-shot state.
// This is an audit only: it never issues, consumes, copies, or opens an authorization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStrictJson, readVerifiedRepoFile } from './phase2-approval-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function reconcileAuthorizationState({ manifest, draft, record, consumption, sourceHash, authorizedSpecHash }) {
  const consumed = Boolean(consumption)
    && consumption.authorization_id === record.decision_id
    && consumption.status === 'consumed-before-workspace-or-model-invocation'
    && consumption.case_id === record.case_id
    && typeof consumption.run_id === 'string'
    && consumption.run_id.length > 0
    && path.resolve(repo, consumption.output_path ?? '') === path.resolve(repo, record.output_path ?? '')
    && consumption.source_spec_sha256 === record.source_spec_sha256
    && consumption.authorized_execution_spec_sha256 === record.authorized_execution_spec_sha256;
  const sourceHashMatches = sourceHash === record.source_spec_sha256;
  const authorizedSpecHashMatches = authorizedSpecHash === record.authorized_execution_spec_sha256;
  const officialGateClosed = manifest?.protocol?.status === 'not-started'
    && manifest?.assessment?.final_status === 'not-started'
    && draft?.status === 'draft-not-authorized'
    && draft?.execution_gate?.status === 'blocked'
    && draft?.execution_gate?.authorization_record === null
    && Array.isArray(draft?.execution_gate?.authorized_case_ids)
    && draft.execution_gate.authorized_case_ids.length === 0;
  const scopeMatches = record.case_id === 'CASE-01'
    && record.decision === 'authorized-for-one-paired-CASE-01-v3.8-pilot-only'
    && typeof record.output_path === 'string'
    && record.scope?.external_network === false
    && record.scope?.external_credentials === false
    && record.scope?.shared_runtime === false
    && record.scope?.opshub === false
    && record.scope?.other_cases === false
    && record.scope?.automatic_retry === false;
  const staleConsumptionMetadata = consumed && record.consumption_status !== 'consumed-before-workspace-or-model-invocation';
  return {
    decision: officialGateClosed && consumed ? 'BLOCKED_PRIOR_ONE_SHOT_CONSUMED' : 'BLOCKED_REVIEW_REQUIRED',
    official_gate_closed: officialGateClosed,
    prior_authorization_consumed: consumed,
    authorization_record_metadata_stale: staleConsumptionMetadata,
    source_spec_hash_matches: sourceHashMatches,
    authorized_execution_spec_hash_matches: authorizedSpecHashMatches,
    scope_matches_expected_restrictions: scopeMatches,
    can_execute: false,
    findings: [
      ...(consumed ? ['The durable consumption record proves this one-shot has been consumed; never reuse it.'] : ['No matching durable consumption record was verified; authorization status requires independent review.']),
      ...(staleConsumptionMetadata ? ['The authorization record has stale consumption_status metadata; reconcile against durable consumption/run history and fail closed.'] : []),
      ...(!sourceHashMatches ? ['Source draft hash does not match the authorization record.'] : []),
      ...(!authorizedSpecHashMatches ? ['Authorized execution spec hash does not match the authorization record.'] : []),
      ...(!officialGateClosed ? ['Official manifest/draft state differs from the expected closed state; stop for independent review.'] : []),
      ...(!scopeMatches ? ['Authorization scope is incomplete or broader than the expected CASE-01-only restrictions.'] : []),
      'This audit is read-only and cannot issue authorization or open the execution gate.'
    ]
  };
}

function readJson(file) {
  const absolute = path.resolve(file);
  const relative = path.relative(repo, absolute).split(path.sep).join('/');
  const evidence = readVerifiedRepoFile(repo, relative, 'v3.8 authorization-state evidence');
  return parseStrictJson(evidence.bytes, `v3.8 authorization-state evidence ${relative}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = path.join(repo, 'benchmarks/plugin-workflow-benchmark');
  const manifest = readJson(path.join(base, 'runs/phase2-preparation-20261010/run-manifest.json'));
  const draft = readJson(path.join(base, 'scenario-execution-spec-v3.8-draft.json'));
  const record = readJson(path.join(base, 'phase2-case01-v3.8-execution-authorization-20261012-07.json'));
  const consumptionPath = path.resolve(repo, record.consumption_record_path);
  let consumption = null;
  try { consumption = readJson(consumptionPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const sourceHash = readVerifiedRepoFile(repo, record.source_spec_path, 'v3.8 source execution spec').sha256;
  const authorizedSpecHash = readVerifiedRepoFile(repo, record.authorized_execution_spec_path, 'v3.8 authorized execution spec').sha256;
  const result = reconcileAuthorizationState({ manifest, draft, record, consumption, sourceHash, authorizedSpecHash });
  assert.equal(result.can_execute, false, 'audit must never open the execution gate');
  console.log(JSON.stringify(result, null, 2));
}
