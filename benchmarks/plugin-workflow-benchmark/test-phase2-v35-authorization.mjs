#!/usr/bin/env node
// Offline-only tests for the fresh, one-shot v3.5 authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE2_V35_AUTHORIZATION_ID, draftV35SpecPath, authorizedV35SpecPath,
  v35AuthorizationRecordPath, validatePhase2V35Authorization } from './phase2-v35-execution-authorization.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const record=JSON.parse(fs.readFileSync(v35AuthorizationRecordPath,'utf8'));
const bytes=fs.readFileSync(authorizedV35SpecPath);
const output=path.resolve(repo,record.output_path);
assert.equal(record.decision_id,PHASE2_V35_AUTHORIZATION_ID);
assert.match(record.consumption_status,/consumed/i);
assert.equal(record.consumed_run_id,'f2686f55-38ca-44d2-ad9a-5072129af0be');
assert.equal(JSON.parse(fs.readFileSync(draftV35SpecPath,'utf8')).execution_gate.status,'blocked');
assert.equal(JSON.parse(bytes).execution_gate.status,'authorized');
assert.throws(()=>validatePhase2V35Authorization({specPath:authorizedV35SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:output}),/already.*consumed/i,'consumed authorization must fail closed');
assert.throws(()=>validatePhase2V35Authorization({specPath:authorizedV35SpecPath,specBytes:bytes,caseId:'CASE-02',outputPath:output}),/scoped to CASE-01/);
assert.throws(()=>validatePhase2V35Authorization({specPath:authorizedV35SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:path.join(repo,'wrong-output.json')}),/output path differs/);
assert.throws(()=>validatePhase2V35Authorization({specPath:draftV35SpecPath,specBytes:fs.readFileSync(draftV35SpecPath),caseId:'CASE-01',outputPath:output}),/only the one-case authorized v3.5 execution spec/);
console.log('PASS: consumed v3.5 authorization remains bound to exact source and authorized spec hashes, CASE-01, frozen bundle, and unique output path');
console.log('PASS: v3.5 authorization rejects reuse, other cases, and paths; source draft remains blocked');
console.log('PASS: offline authorization tests execute no model or benchmark scenario');
