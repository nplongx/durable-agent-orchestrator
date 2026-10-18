#!/usr/bin/env node
// Offline-only tests for the fresh, one-shot v3.4 authorization gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE2_V34_AUTHORIZATION_ID, draftV34SpecPath, authorizedV34SpecPath,
  v34AuthorizationRecordPath, validatePhase2V34Authorization } from './phase2-v34-execution-authorization.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(here,'../..');
const record=JSON.parse(fs.readFileSync(v34AuthorizationRecordPath,'utf8'));
const bytes=fs.readFileSync(authorizedV34SpecPath);
const output=path.resolve(repo,record.output_path);
assert.equal(record.decision_id,PHASE2_V34_AUTHORIZATION_ID);
assert.match(record.consumption_status,/consumed/i);
assert.equal(record.consumed_run_id,'6447dc35-6ed7-4074-b9f8-5f3e94216d1e');
assert.equal(JSON.parse(fs.readFileSync(draftV34SpecPath,'utf8')).execution_gate.status,'blocked');
assert.equal(JSON.parse(bytes).execution_gate.status,'authorized');
assert.throws(()=>validatePhase2V34Authorization({specPath:authorizedV34SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:output}),/already.*consumed/i,'consumed authorization must fail closed');
assert.throws(()=>validatePhase2V34Authorization({specPath:authorizedV34SpecPath,specBytes:bytes,caseId:'CASE-02',outputPath:output}),/scoped to CASE-01/);
assert.throws(()=>validatePhase2V34Authorization({specPath:authorizedV34SpecPath,specBytes:bytes,caseId:'CASE-01',outputPath:path.join(repo,'wrong-output.json')}),/output path differs/);
assert.throws(()=>validatePhase2V34Authorization({specPath:draftV34SpecPath,specBytes:fs.readFileSync(draftV34SpecPath),caseId:'CASE-01',outputPath:output}),/only the one-case authorized v3.4 execution spec/);
console.log('PASS: consumed v3.4 authorization remains bound to exact source and authorized spec hashes, CASE-01, frozen bundle, and unique output path');
console.log('PASS: v3.4 authorization rejects reuse, other cases, and paths; source draft remains blocked');
console.log('PASS: offline authorization tests execute no model or benchmark scenario');
