// Observe runtime spawn options without changing them or replacing the process.
const cp = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const spawn = cp.spawn;
const record = (entry) => appendFileSync(process.env.NATIVE_E2E_SPAWN_LOG, JSON.stringify(entry) + '\n');
cp.spawn = function (file, args, options) {
  const child = spawn.apply(this, arguments);
  record({ event: 'spawn', file, args, parentPid: process.pid, pid: child.pid, windowsHide: options?.windowsHide, shell: options?.shell });
  child.once('exit', (code, signal) => record({ event: 'exit', pid: child.pid, code, signal }));
  return child;
};
syncBuiltinESMExports();
