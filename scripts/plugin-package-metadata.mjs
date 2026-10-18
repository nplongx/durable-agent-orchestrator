// Project the full repository package manifest into the dependency closure of
// the local-only MCPB. The repository's LangGraph dependency is used by the
// excluded full-app orchestrator, not by the modules shipped in this archive.
export function projectPluginPackageMetadata(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      typeof source.name !== 'string' || typeof source.version !== 'string' ||
      typeof source.description !== 'string') {
    throw new TypeError('source package metadata must declare name, version and description');
  }
  return {
    name: source.name,
    version: source.version,
    description: source.description,
    main: 'server/index.js',
    type: 'module',
    engines: { node: '>=22.13.0' },
    scripts: {
      start: 'node server/index.js',
      test: 'node tests/test-chat-on-steroids-plugin.js',
    },
  };
}

export function serializePluginPackageMetadata(source) {
  return Buffer.from(`${JSON.stringify(projectPluginPackageMetadata(source), null, 2)}\n`);
}
