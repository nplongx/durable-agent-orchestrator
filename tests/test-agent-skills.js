import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAgentSkills } from '../src/runtime/workflow/agent-skills.js';
import { DatabaseSync } from 'node:sqlite';
import { getCustomRole, initializeCustomRoleStore } from '../src/runtime/workflow/custom-roles.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-agent-skills-'));
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

try {
  const localDir = path.join(temp, 'code-review');
  put(path.join(localDir, 'SKILL.md'), [
    '---',
    'name: code-review',
    'description: >-',
    '  Reviews changed code for correctness and security.',
    '---',
    '',
    '# Review procedure',
    'Check control flow, errors, and test coverage.'
  ].join('\n'));
  put(path.join(localDir, 'references', 'checklist.md'), '# Checklist\nCheck tests before claiming success.\n');
  put(path.join(localDir, 'scripts', 'check.js'), 'export const informationalOnly = true;\n');
  put(path.join(localDir, 'assets', 'template.json'), '{"format":"markdown"}\n');
  put(path.join(localDir, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  const local = await loadAgentSkills([localDir]);
  assert.equal(local.length, 1);
  assert.equal(local[0].name, 'code-review');
  assert.match(local[0].description, /Reviews changed code/);
  assert.match(local[0].instructions, /Check control flow/);
  assert.match(local[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(local[0].files.some(file => file.path === 'references/checklist.md'));
  assert.ok(local[0].files.some(file => file.path === 'scripts/check.js'));
  assert.ok(local[0].files.some(file => file.path === 'assets/template.json'));
  assert.equal(local[0].files.some(file => file.path.endsWith('.png')), false, 'binary assets are skipped by the text-only MVP importer');

  const missingDir = path.join(temp, 'missing-skill');
  fs.mkdirSync(missingDir);
  await assert.rejects(() => loadAgentSkills([missingDir]), /root SKILL\.md/i);
  await assert.rejects(() => loadAgentSkills(['https://example.com/skill/SKILL.md']), /public GitHub/i);
  await assert.rejects(() => loadAgentSkills([localDir, localDir]), /duplicate sources/i);
  await assert.rejects(() => loadAgentSkills(Array.from({ length: 9 }, (_, index) => `${localDir}-${index}`)), /at most 8/i);

  const remoteSource = 'https://github.com/example-org/example-skills/tree/main/skills/remote-review';
  const remoteContents = new Map([
    ['https://api.github.com/repos/example-org/example-skills/git/trees/main?recursive=1', JSON.stringify({
      tree: [
        { type: 'blob', path: 'skills/remote-review/SKILL.md', size: 110 },
        { type: 'blob', path: 'skills/remote-review/references/guide.md', size: 35 },
        { type: 'blob', path: 'skills/unrelated/SKILL.md', size: 45 }
      ], truncated: false
    })],
    ['https://raw.githubusercontent.com/example-org/example-skills/main/skills/remote-review/SKILL.md', '---\nname: remote-review\ndescription: Reviews code from an approved public GitHub skill source.\n---\n\nUse the review checklist.\n'],
    ['https://raw.githubusercontent.com/example-org/example-skills/main/skills/remote-review/references/guide.md', '# Remote guide\nCollect evidence.\n']
  ]);
  const mockFetch = async url => {
    const body = remoteContents.get(String(url));
    if (body === undefined) throw new Error(`unexpected URL in remote-skill test: ${url}`);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(body, 'utf8')
    };
  };
  const remote = await loadAgentSkills([remoteSource], { fetchImpl: mockFetch });
  assert.equal(remote.length, 1);
  assert.equal(remote[0].name, 'remote-review');
  assert.equal(remote[0].source.kind, 'github');
  assert.ok(remote[0].files.some(file => file.path === 'references/guide.md'));
  assert.equal(remote[0].files.some(file => file.path.includes('unrelated')), false, 'remote imports must stay inside the selected skill directory');

  const legacyDb = new DatabaseSync(path.join(temp, 'legacy-role-store.db'));
  try {
    legacyDb.exec(`CREATE TABLE custom_role_versions (
      role_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), name TEXT NOT NULL,
      description TEXT NOT NULL, system_prompt TEXT NOT NULL, input_contract_json TEXT NOT NULL,
      output_artifact_type TEXT NOT NULL, allowed_capabilities_json TEXT NOT NULL,
      permissions_json TEXT NOT NULL, allowed_tools_json TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, PRIMARY KEY(role_id,version)
    );`);
    legacyDb.prepare(`INSERT INTO custom_role_versions
      (role_id,version,name,description,system_prompt,input_contract_json,output_artifact_type,
       allowed_capabilities_json,permissions_json,allowed_tools_json,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'legacy-skill-role', 1, 'Legacy role', 'Migrated role without skills', 'Existing instructions',
      '["job.request"]', 'documentation', '[]', '["workspace.read","artifact.create"]', '[]',
      '2026-01-01T00:00:00.000Z', 'migration-test'
    );
    initializeCustomRoleStore(legacyDb);
    assert.ok(legacyDb.prepare('PRAGMA table_info(custom_role_versions)').all().some(column => column.name === 'skills_json'));
    assert.deepEqual(getCustomRole(legacyDb, 'legacy-skill-role', 1).skills, [], 'legacy custom roles must migrate without losing role definitions');
  } finally {
    legacyDb.close();
  }

  console.log('test-agent-skills: PASS');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
