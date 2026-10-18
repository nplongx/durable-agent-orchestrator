import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BWRAP = '/usr/bin/bwrap';
const SYSTEMD_RUN = '/usr/bin/systemd-run';

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} must be a directory`);
  return real;
}

export function buildPluginSandboxLaunch({
  pluginRoot,
  workspace,
  dataDirectory,
  executionTmpDirectory,
  nodeExecutable = process.execPath,
  entryPoint = '/plugin/server/index.js',
  memoryMax = '768M',
  cpuQuota = '100%',
  tasksMax = 64,
} = {}) {
  if (process.platform !== 'linux') throw new Error('OS containment requires Linux');
  if (!fs.existsSync(BWRAP) || !fs.existsSync(SYSTEMD_RUN)) throw new Error('bwrap and systemd-run are required; refusing unsandboxed plugin launch');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) throw new Error('cannot determine UID for user-scope resource limits');
  const runtimeDir = `/run/user/${uid}`;
  if (!fs.existsSync(path.join(runtimeDir, 'bus'))) throw new Error('user systemd bus is unavailable; refusing to launch without cgroup limits');

  const plugin = requireAbsoluteDirectory(pluginRoot, 'pluginRoot');
  const work = requireAbsoluteDirectory(workspace, 'workspace');
  const data = requireAbsoluteDirectory(dataDirectory, 'dataDirectory');
  const execTmp = requireAbsoluteDirectory(executionTmpDirectory, 'executionTmpDirectory');
  const nodeBin = fs.realpathSync(nodeExecutable);
  if (!fs.statSync(nodeBin).isFile()) throw new Error('nodeExecutable must resolve to a file');
  if (!/^\d+(?:\.\d+)?(?:K|M|G)$/.test(memoryMax)) throw new Error('memoryMax must be a finite K/M/G size');
  if (!/^\d+(?:\.\d+)?%$/.test(cpuQuota)) throw new Error('cpuQuota must be a percentage');
  if (!Number.isInteger(tasksMax) || tasksMax < 8 || tasksMax > 256) throw new Error('tasksMax must be an integer from 8 through 256');

  const bwrapArgs = [
    '--die-with-parent', '--new-session', '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  ];
  if (fs.existsSync('/usr/share/ollama')) bwrapArgs.push('--tmpfs', '/usr/share/ollama');
  bwrapArgs.push(
    '--dir', '/opt', '--dir', '/opt/node', '--dir', '/opt/node/bin',
    '--ro-bind', nodeBin, '/opt/node/bin/node',
    '--dir', '/plugin', '--ro-bind', plugin, '/plugin',
    '--dir', '/case', '--dir', '/case/workspace', '--bind', work, '/case/workspace',
    '--dir', '/case/data', '--bind', data, '/case/data',
    '--dir', '/case/execution-tmp', '--bind', execTmp, '/case/execution-tmp',
    '--dir', '/home', '--dir', '/home/benchmark', '--dir', '/root',
    '--proc', '/proc', '--dev', '/dev', '--size', '67108864', '--tmpfs', '/tmp',
    '--clearenv',
    '--setenv', 'PATH', '/opt/node/bin:/usr/bin:/bin',
    '--setenv', 'HOME', '/home/benchmark',
    '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TZ', 'UTC',
    '--setenv', 'WORKFLOW_DATA_DIR', '/case/data',
    '--setenv', 'CHAT_ON_STEROIDS_DATA_DIR', '/case/data',
    '--setenv', 'CHAT_ON_STEROIDS_WORKFLOW_DB', '/case/data/workflow.db',
    '--setenv', 'WORKFLOW_DB', '/case/data/workflow.db',
    '--setenv', 'WORKFLOW_WORKSPACE', '/case/workspace',
    '--setenv', 'CHAT_ON_STEROIDS_WORKSPACE', '/case/workspace',
    '--setenv', 'EXECUTION_TMP_DIR', '/case/execution-tmp',
    '--setenv', 'CHAT_ON_STEROIDS_EXECUTION_TMP_DIR', '/case/execution-tmp',
    '--chdir', '/plugin',
    '/opt/node/bin/node', entryPoint,
  );

  return {
    command: SYSTEMD_RUN,
    args: ['--user', '--scope', '--quiet', `--property=MemoryMax=${memoryMax}`,
      `--property=CPUQuota=${cpuQuota}`, `--property=TasksMax=${tasksMax}`, '--', BWRAP, ...bwrapArgs],
    env: {
      PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'C.UTF-8', TZ: 'UTC',
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(runtimeDir, 'bus')}`,
    },
    policy: {
      backend: 'bubblewrap+systemd-user-scope', network_namespace: 'unshared',
      pid_namespace: 'unshared', plugin_bundle: 'read-only', system_tree: 'read-only',
      writable_mounts: ['/case/workspace', '/case/data', '/case/execution-tmp', '/tmp (64 MiB tmpfs)'],
      host_home_mounted: false, ollama_model_directory_visible: false,
      memory_max: memoryMax, cpu_quota: cpuQuota, tasks_max: tasksMax,
      timeout_seconds: 300,
    },
  };
}
