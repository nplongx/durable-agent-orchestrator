#!/usr/bin/env node
// Offline-only tests for the fresh, one-shot v3.7 authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE2_V37_AUTHORIZATION_ID, draftV37SpecPath, authorizedV37SpecPath,
  v37AuthorizationRecordPath, validatePhase2V37Authorization } from './phase2-v37-execution-authorization.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const record=JSON.parse(fs.readFileSync(v37AuthorizationRecordPath,'utf8'));
const bytes=fs.readFileSync(authorizedV37SpecPath);
const output=path.resolve(repo,record.output_path);
assert.equal(record.decision_id,PHASE2_V37_AUTHORIZATION_ID);
assert.equal(record.consumption_status,'consumed-before-workspace-or-model-invocation');
const consumption=JSON.parse(fs.readFileSync(path.join(repo,'benchmarks/plugin-workflow-benchmark/runs/phase2-pilot-20261011/case-01-v3.7-authorization-consumed.json'),'utf8'));
assert.equal(consumption.authorization_id,record.decision_id);
assert.equal(consumption.run_id,'4efd8173-6245-4f35-b90c-8d87ff719241');
assert.equal(consumption.case_id,record.case_id);
assert.equal(path.resolve(consumption.output_path),output);
assert.equal(consumption.status,record.consumption_status);
assert.equal(JSON.parse(fs.readFileSync(draftV37SpecPath,'utf8')).execution_gate.status,'blocked');
assert.equal(JSON.parse(bytes).execution_gate.status,'authorized');
assert.throws(()=>validatePhase2V37Authorization({specPath:authorizedV37SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:output}),/already consumed/i);
assert.throws(()=>validatePhase2V37Authorization({specPath:authorizedV37SpecPath,specBytes:bytes,caseId:'CASE-02',outputPath:output}),/scoped to CASE-01/);
assert.throws(()=>validatePhase2V37Authorization({specPath:authorizedV37SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:path.join(repo,'wrong-output.json')}),/output path differs/);
assert.throws(()=>validatePhase2V37Authorization({specPath:draftV37SpecPath,specBytes:fs.readFileSync(draftV37SpecPath),caseId:'CASE-01',outputPath:output}),/only the one-case authorized v3.7 execution spec/);
console.log('PASS: consumed v3.7 authorization reconciles to its durable one-shot consumption record');
console.log('PASS: v3.7 authorization rejects reuse, other cases, and paths; source draft remains blocked');
console.log('PASS: offline authorization tests execute no model or benchmark scenario');
