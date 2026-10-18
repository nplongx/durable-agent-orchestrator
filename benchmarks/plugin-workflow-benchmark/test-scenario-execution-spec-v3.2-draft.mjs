#!/usr/bin/env node
// Offline-only static regression for the second remediation candidate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const v31=JSON.parse(fs.readFileSync(path.join(here,'scenario-execution-spec-v3.1-draft.json'),'utf8'));
const bytes=fs.readFileSync(path.join(here,'scenario-execution-spec-v3.2-draft.json'));
const v32=JSON.parse(bytes.toString('utf8'));
assert.deepEqual(v32.cases,v31.cases,'all frozen prompts and per-case grants must remain unchanged');
assert.equal(v32.cases.length,10);
assert.equal(v32.status,'draft-not-authorized');
assert.equal(v32.execution_gate.status,'blocked');
assert.deepEqual(v32.execution_gate.authorized_case_ids,[]);
assert.equal(v32.execution_gate.authorization_record,null);
assert.equal(v32.model.max_elapsed_seconds_per_condition,2400);
assert.equal(v32.model.max_model_turns_per_condition,20);
assert.match(v32.system_context,/make at most ONE tool call in each assistant response/i);
assert.match(v32.system_context,/CASE-01 PLUGIN CONDITION: this is a workflow-first task/i);
assert.match(v32.system_context,/Do not write files before step 9 returns an active task/i);
assert.match(v32.system_context,/workspace_artifacts exactly/i);
assert.match(v32.system_context,/evidence_refs includes the exact task artifact ID/i);
assert.match(v32.system_context,/CASE-06 is proposal-only/i);
assert.match(v32.system_context,/CASE-09 and CASE-10 are read-only/i);
console.log(`PASS: v3.2 draft ${createHash('sha256').update(bytes).digest('hex')} preserves all ten prompts/policies and strengthens workflow-first, sequential-tool, artifact-lineage instructions`);
console.log('PASS: 2400-second condition budget remains bounded and execution gate remains blocked');
console.log('PASS: static-only test; no scenario, plugin process, or model inference executed');
