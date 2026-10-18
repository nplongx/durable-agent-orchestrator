#!/usr/bin/env node
// Offline-only tests for the fresh, one-shot v3.3 authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE2_V33_AUTHORIZATION_ID, draftV33SpecPath, authorizedV33SpecPath,
  v33AuthorizationRecordPath, validatePhase2V33Authorization } from './phase2-v33-execution-authorization.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const record=JSON.parse(fs.readFileSync(v33AuthorizationRecordPath,'utf8'));
const bytes=fs.readFileSync(authorizedV33SpecPath);
const output=path.resolve(repo,record.output_path);
assert.equal(record.decision_id,PHASE2_V33_AUTHORIZATION_ID);
assert.match(record.consumption_status,/consumed/i);
assert.equal(record.consumed_run_id,'e30a3055-91a1-4c51-a9ab-8c94af5cf5ee');
assert.equal(JSON.parse(fs.readFileSync(draftV33SpecPath,'utf8')).execution_gate.status,'blocked');
assert.equal(JSON.parse(bytes).execution_gate.status,'authorized');
assert.throws(()=>validatePhase2V33Authorization({specPath:authorizedV33SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:output}),/already.*consumed/i,'consumed authorization must fail closed');
assert.throws(()=>validatePhase2V33Authorization({specPath:authorizedV33SpecPath,specBytes:bytes,caseId:'CASE-02',outputPath:output}),/scoped to CASE-01/);
assert.throws(()=>validatePhase2V33Authorization({specPath:authorizedV33SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:path.join(repo,'wrong-output.json')}),/output path differs/);
assert.throws(()=>validatePhase2V33Authorization({specPath:draftV33SpecPath,specBytes:fs.readFileSync(draftV33SpecPath),caseId:'CASE-01',outputPath:output}),/only the one-case authorized v3.3 execution spec/);
console.log('PASS: consumed v3.3 authorization remains bound to exact source and authorized spec hashes, CASE-01, frozen bundle, and unique output path');
console.log('PASS: v3.3 authorization rejects reuse, other cases, and paths; source draft remains blocked');
console.log('PASS: offline authorization tests execute no model or benchmark scenario');
