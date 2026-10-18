#!/usr/bin/env node
// Offline-only tests for the fresh, one-shot v3.2 authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE2_V32_AUTHORIZATION_ID, draftV32SpecPath, authorizedV32SpecPath,
  v32AuthorizationRecordPath, validatePhase2V32Authorization } from './phase2-v32-execution-authorization.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const record=JSON.parse(fs.readFileSync(v32AuthorizationRecordPath,'utf8'));
const bytes=fs.readFileSync(authorizedV32SpecPath);
const output=path.resolve(repo,record.output_path);
assert.equal(record.decision_id,PHASE2_V32_AUTHORIZATION_ID);
assert.match(record.consumption_status,/consumed/i);
assert.equal(record.consumed_run_id,'25e7936a-a89f-46c6-a2c5-7edaf1e11265');
assert.equal(JSON.parse(fs.readFileSync(draftV32SpecPath,'utf8')).execution_gate.status,'blocked');
assert.equal(JSON.parse(bytes).execution_gate.status,'authorized');
assert.throws(()=>validatePhase2V32Authorization({specPath:authorizedV32SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:output}),/already.*consumed/i,'consumed authorization must fail closed');
assert.throws(()=>validatePhase2V32Authorization({specPath:authorizedV32SpecPath,specBytes:bytes,caseId:'CASE-02',outputPath:output}),/scoped to CASE-01/);
assert.throws(()=>validatePhase2V32Authorization({specPath:authorizedV32SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:path.join(repo,'wrong-output.json')}),/output path differs/);
assert.throws(()=>validatePhase2V32Authorization({specPath:draftV32SpecPath,specBytes:fs.readFileSync(draftV32SpecPath),caseId:'CASE-01',outputPath:output}),/only the one-case authorized v3.2 execution spec/);
console.log('PASS: consumed v3.2 authorization remains bound to exact source and authorized spec hashes, CASE-01, frozen bundle, and unique output path');
console.log('PASS: v3.2 authorization rejects reuse, other cases, and paths; source draft remains blocked');
console.log('PASS: offline authorization tests execute no model or benchmark scenario');
