#!/usr/bin/env node
import { workflowStore } from './job-store.js';

const [command = 'overview', arg] = process.argv.slice(2);
if (command === 'trace') {
  if (!arg) throw new Error('usage: node workflow-dashboard.js trace <jobId>');
  console.log(JSON.stringify(workflowStore.getJobTrace(arg), null, 2));
} else if (command === 'jobs') {
  console.log(JSON.stringify(workflowStore.listActiveJobs(arg), null, 2));
} else if (command === 'overview') {
  console.log(JSON.stringify(workflowStore.getObservability(), null, 2));
} else if (command === 'reconcile') {
  const n = workflowStore.reconcileStaleAttempts(Number(arg) || 15 * 60 * 1000);
  console.log(JSON.stringify({ reconciled: n, ...workflowStore.getStats() }, null, 2));
} else {
  throw new Error('commands: overview | jobs [limit] | trace <jobId> | reconcile [maxAgeMs]');
}
