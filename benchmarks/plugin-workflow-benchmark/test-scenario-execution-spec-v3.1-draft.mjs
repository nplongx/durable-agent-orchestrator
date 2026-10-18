#!/usr/bin/env node
// Offline-only regression for the post-pilot remediation draft. Never launches a model/plugin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const v3=JSON.parse(fs.readFileSync(path.join(here,'scenario-execution-spec-v3-draft.json'),'utf8'));
const nextBytes=fs.readFileSync(path.join(here,'scenario-execution-spec-v3.1-draft.json'));
const next=JSON.parse(nextBytes.toString('utf8'));
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(here,'scenario-execution-spec-v3-draft.json'))).digest('hex'),
  '7126828e54c46f5764e684027e298d9bbfb24edfb404461b6bcd6c1588102f08');
assert.deepEqual(next.cases,v3.cases,'all frozen prompts and per-case grants must remain unchanged');
assert.equal(next.cases.length,10);
assert.equal(next.status,'draft-not-authorized');
assert.equal(next.execution_gate.status,'blocked');
assert.deepEqual(next.execution_gate.authorized_case_ids,[]);
assert.equal(next.execution_gate.authorization_record,null);
assert.equal(next.model.max_elapsed_seconds_per_condition,600);
assert.match(next.system_context,/Both paired conditions receive byte-identical system instructions/);
assert.match(next.system_context,/if workflow-specific tools are offered, you MUST use a minimal local workflow/);
assert.match(next.system_context,/Do not use basic write_file to directly create the required deliverable files in the plugin condition/);
assert.match(next.system_context,/when workflow-specific tools are not offered \(the control condition\)/);
assert.doesNotMatch(next.system_context,/Use basic tools for the requested files\./);
console.log(`PASS: v3.1 remediation draft ${createHash('sha256').update(nextBytes).digest('hex')} preserves all ten prompts/policies, resolves tool-selection conflict, extends cold-start budget, and remains blocked`);
console.log('PASS: static-only test; no scenario, plugin process, or model inference executed');
