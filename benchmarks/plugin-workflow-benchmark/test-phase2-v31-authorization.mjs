#!/usr/bin/env node
// Offline-only tests for the fresh, one-shot v3.1 authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE2_V31_AUTHORIZATION_ID, draftV31SpecPath, authorizedV31SpecPath,
  v31AuthorizationRecordPath, validatePhase2V31Authorization } from './phase2-v31-execution-authorization.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const record=JSON.parse(fs.readFileSync(v31AuthorizationRecordPath,'utf8'));
const bytes=fs.readFileSync(authorizedV31SpecPath);
const output=path.resolve(repo,record.output_path);
assert.equal(record.decision_id,PHASE2_V31_AUTHORIZATION_ID);
assert.match(record.consumption_status,/consumed/i);
assert.equal(record.consumed_run_id,'9a697223-ad54-43f7-8f22-a2f5d6d7471a');
assert.equal(JSON.parse(fs.readFileSync(draftV31SpecPath,'utf8')).execution_gate.status,'blocked');
assert.equal(JSON.parse(bytes).execution_gate.status,'authorized');
assert.throws(()=>validatePhase2V31Authorization({specPath:authorizedV31SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:output}),/already.*consumed/i,'consumed authorization must fail closed even if a caller reuses the exact path');
assert.throws(()=>validatePhase2V31Authorization({specPath:authorizedV31SpecPath,specBytes:bytes,caseId:'CASE-02',outputPath:output}),/scoped to CASE-01/);
assert.throws(()=>validatePhase2V31Authorization({specPath:authorizedV31SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:path.join(repo,'wrong-output.json')}),/output path differs/);
assert.throws(()=>validatePhase2V31Authorization({specPath:draftV31SpecPath,specBytes:fs.readFileSync(draftV31SpecPath),caseId:'CASE-01',outputPath:output}),/only the one-case authorized v3.1 execution spec/);
console.log('PASS: consumed v3.1 authorization remains bound to its exact reviewed draft hash, authorized copy hash, CASE-01, and unique output path');
console.log('PASS: v3.1 authorization rejects reuse, other cases, and output paths; draft itself remains blocked');
console.log('PASS: offline authorization tests execute no model or benchmark scenario');
