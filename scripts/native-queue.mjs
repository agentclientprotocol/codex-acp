// No account, external provider, globally installed Codex, or saved fixture is used.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let output, wrongReply = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wrong-reply' && !wrongReply) wrongReply = true;
  else if (args[i] === '--output' && !output && args[i + 1] && !args[i + 1].startsWith('--')) output = args[++i];
  else {
    console.error('Usage: npm run test:native-queue -- [--wrong-reply] [--output <artifact-parent-directory>]');
    process.exit(2);
  }
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ is required');
const parent = path.resolve(output ?? path.join(repo, 'tmp', 'native-queue'));
mkdirSync(parent, { recursive: true });
const run = mkdtempSync(path.join(parent, 'run-'));
for (const name of ['home', 'workspace', 'tmp', 'home/appdata', 'home/localappdata', 'home/.config', 'home/.cache']) {
  mkdirSync(path.join(run, name), { recursive: true });
}
// A whitelist deliberately excludes credentials, proxies, NODE_OPTIONS, Git
// overrides, Codex configuration, and the invoking user's profile directories.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
Object.assign(env, {
  HOME: path.join(run, 'home'), USERPROFILE: path.join(run, 'home'),
  CODEX_HOME: path.join(run, 'home'), APPDATA: path.join(run, 'home/appdata'),
  LOCALAPPDATA: path.join(run, 'home/localappdata'),
  XDG_CONFIG_HOME: path.join(run, 'home/.config'), XDG_CACHE_HOME: path.join(run, 'home/.cache'),
  TMP: path.join(run, 'tmp'), TEMP: path.join(run, 'tmp'), TMPDIR: path.join(run, 'tmp'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(run, 'home/.gitconfig'),
  GIT_OPTIONAL_LOCKS: '0',
});
writeFileSync(env.GIT_CONFIG_GLOBAL, '');
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  }).sort();
}
function sources() {
  return Object.fromEntries([...walk(path.join(repo, 'src')),
    ...walk(path.join(repo, 'scripts/native-queue')),
    ...['package.json', 'package-lock.json', 'build.mjs', 'scripts/native-queue.mjs'].map((name) => path.join(repo, name))]
    .map((file) => [path.relative(repo, file), hash(file)]));
}
function command(binary, argv) {
  const result = spawnSync(binary, argv, {
    cwd: repo, env, windowsHide: true, encoding: 'utf8', timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${binary} failed: ${result.error ?? result.stderr ?? result.status}`);
  }
  return result.stdout.trim();
}
try {
  const require = createRequire(path.join(repo, 'package.json'));
  const codexManifest = require.resolve('@openai/codex/package.json');
  const installed = JSON.parse(readFileSync(codexManifest, 'utf8'));
  const version = installed.version.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  if (!version || !(version[0] > 0 || version[1] > 160 || (version[1] === 160 && version[2] >= 1))) {
    throw new Error(`Native queue requires @openai/codex 0.160.1+, found ${installed.version}`);
  }
  const packageName = `@openai/codex-${process.platform}-${process.arch}`;
  if (!installed.optionalDependencies?.[packageName]) throw new Error(`Unsupported native platform: ${packageName}`);
  const nativeManifest = createRequire(codexManifest).resolve(`${packageName}/package.json`);
  // Discover the actual installed layout; do not assume a vendor triple or bin/codex subdirectory.
  const candidates = walk(path.join(path.dirname(nativeManifest), 'vendor'))
    .filter((file) => path.basename(file) === (process.platform === 'win32' ? 'codex.exe' : 'codex'));
  if (candidates.length !== 1) throw new Error(`Expected one installed native executable, found ${candidates.length}`);
  const native = realpathSync(candidates[0]);
  const nativeVersion = command(native, ['--version']);
  if (nativeVersion !== `codex-cli ${installed.version}`) throw new Error(`Native/package version mismatch: ${nativeVersion}`);
  const before = sources();
  writeFileSync(path.join(run, 'build.log'), command(process.execPath, [path.join(repo, 'build.mjs')]));
  if (JSON.stringify(before) !== JSON.stringify(sources())) throw new Error('Sources changed during build; rerun after concurrent edits finish');
  const metadata = {
    repo, run, wrongReply, node: process.execPath, nodeVersion: process.version, native,
    nativePackage: packageName, codexVersion: installed.version,
    nativeVersion, nativeSha256: hash(native),
    distSha256: hash(path.join(repo, 'dist/index.js')), sources: before,
  };
  const manifest = path.join(run, 'build.json');
  writeFileSync(manifest, JSON.stringify(metadata, null, 2) + '\n');
  const python = process.env.NATIVE_E2E_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  console.log(`Native queue E2E artifacts: ${run}`);
  const result = spawnSync(python, ['-B', path.join(repo, 'scripts/native-queue/probe.py'), manifest], {
    // Python bounds each RPC/child shutdown and cleans up in finally. Killing
    // just Python on a launcher timeout would orphan its owned ACP/native tree.
    cwd: repo, env, windowsHide: true, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  writeFileSync(path.join(run, 'launcher-failure.txt'), String(error.stack ?? error));
  console.error(error);
  console.error(`Native queue E2E artifacts: ${run}`);
  process.exitCode = 1;
}
