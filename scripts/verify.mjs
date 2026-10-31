#!/usr/bin/env node
// Commit-scoped verification. Logs are local artifacts, never publication evidence by themselves.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGES = ['install', 'rust', 'node', 'wasm', 'sandbox'];
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WASM = 'target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm';
const NOFILE = 'soft=$(ulimit -Sn); hard=$(ulimit -Hn); echo "nofile soft=$soft hard=$hard required=65535"; if [ "$soft" != unlimited ] && [ "$soft" -lt 65535 ]; then ulimit -Sn 65535 || exit 1; fi; echo "nofile effective=$(ulimit -Sn)"';

export function parseArgs(args) {
  const skip = new Set();
  let ci = false;
  for (const arg of args) {
    if (arg === '--ci') ci = true;
    else if (arg.startsWith('--skip=')) {
      for (const stage of arg.slice(7).split(',')) {
        if (!STAGES.includes(stage)) throw new Error(`Unknown skip stage: ${stage}`);
        skip.add(stage);
      }
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (ci && skip.size) throw new Error('--ci does not allow skipped stages');
  return { ci, skip };
}

// Exit code alone is insufficient: Node treats t.skip() as a successful process.
export function sandboxResult(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = output.match(new RegExp(`^# ${key} (\\d+)\\s*$`, 'm'));
    if (!match) return { status: 'incomplete', reason: `Missing sandbox TAP summary: ${key}` };
    counts[key] = Number(match[1]);
  }
  if (counts.fail || counts.cancelled) return { status: 'failed', reason: 'Sandbox tests failed or were cancelled', counts };
  if (!counts.tests || !counts.pass || counts.skipped || counts.todo || counts.tests !== counts.pass) {
    return { status: 'incomplete', reason: 'Sandbox tests were skipped, pending, or empty', counts };
  }
  return { status: 'passed', counts };
}

export function verificationResult(stages) {
  if (stages.some((stage) => stage.status === 'failed')) return { status: 'failed', exitCode: 1 };
  if (stages.length !== STAGES.length || stages.some((stage) => stage.status !== 'passed')) return { status: 'incomplete', exitCode: 2 };
  return { status: 'passed', exitCode: 0 };
}

async function runCommand(command, args, { root, log, env = {} }) {
  const chunks = [];
  const result = await new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      chunks.push(chunk.toString());
      process.stdout.write(chunk);
    });
    child.on('error', (error) => { chunks.push(`${error.message}\n`); });
    child.on('close', (code, signal) => done({ code, signal }));
  });
  const output = chunks.join('');
  await writeFile(log, `$ ${command} ${args.join(' ')}\n${output}`);
  return { ...result, output };
}

export async function verify({ ci = false, skip = new Set() } = {}, { root = ROOT, run = runCommand } = {}) {
  if (ci && skip.size) throw new Error('--ci does not allow skipped stages');
  const directory = resolve(root, '.tmp/verification');
  await mkdir(directory, { recursive: true });
  // Avoid retaining an old hash or result if a later run skips/fails its build.
  for (const name of ['wasm.sha256', 'summary.json', 'toolchains.txt', ...STAGES.map((s) => `${s}.log`)]) {
    await rm(resolve(directory, name), { force: true });
  }
  const execute = (name, command, args, env) => run(command, args, { root, log: resolve(directory, `${name}.log`), env });
  const revision = await execute('commit', 'git', ['rev-parse', 'HEAD']);
  if (revision.code !== 0) throw new Error('Cannot identify tested commit (see commit.log)');
  const dirty = await execute('worktree', 'git', ['status', '--porcelain', '--untracked-files=normal']);
  if (dirty.code !== 0) throw new Error('Cannot identify worktree state (see worktree.log)');
  const summary = { commit: revision.output.trim(), dirty: Boolean(dirty.output.trim()), ci, startedAt: new Date().toISOString(), stages: [] };
  const versions = [`commit: ${summary.commit}`, `dirty: ${summary.dirty}`, `platform: ${process.platform}-${process.arch}`];
  for (const [command, args] of [['node', ['--version']], ['npm', ['--version']], ['rustc', ['-vV']], ['cargo', ['--version']], ['rustup', ['show', 'active-toolchain']]]) {
    const result = await execute(`version-${command}`, command, args);
    versions.push(`${command} (exit ${result.code}):\n${result.output}`);
  }
  const fileLimit = await execute('nofile', 'bash', ['-c', NOFILE]);
  versions.push(`file limit (exit ${fileLimit.code}):\n${fileLimit.output}`);
  versions.push(`pinned toolchain:\n${await readFile(resolve(root, 'rust-toolchain.toml'), 'utf8')}`);
  await writeFile(resolve(directory, 'toolchains.txt'), `${versions.join('\n')}\n`);
  const finish = async () => {
    Object.assign(summary, verificationResult(summary.stages), { finishedAt: new Date().toISOString() });
    await writeFile(resolve(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  };
  const commands = {
    install: ['npm', ['ci', '--ignore-scripts']],
    rust: ['cargo', ['test', '--locked']],
    node: ['npm', ['test']],
    wasm: ['cargo', ['build', '--locked', '--target', 'wasm32-unknown-unknown', '--release']],
    sandbox: ['bash', ['-c', `${NOFILE}; exec "$@"`, 'verify-sandbox', process.execPath, '--test', '--test-reporter=tap', 'integration/guard.test.mjs']],
  };
  for (const name of STAGES) {
    let stage = { name, status: 'incomplete', reason: 'Explicitly skipped with --skip' };
    if (!skip.has(name)) {
      if (name === 'sandbox' && summary.stages.find((s) => s.name === 'wasm')?.status !== 'passed') {
        stage.reason = 'Requires a successful WASM build in this verification run';
      } else {
        console.log(`\nVerifying ${name}…`);
        try {
          if (name === 'wasm') await rm(resolve(root, WASM), { force: true });
          const [command, args] = commands[name];
          const result = await execute(name, command, args, {
            CARGO_TARGET_DIR: resolve(root, 'target'),
            // Always exercise the integration suite's pinned downloader, never an override.
            ...(name === 'sandbox' ? { SPEND_GUARD_SANDBOX_BIN: '' } : {}),
          });
          stage = { name, status: result.code === 0 ? 'passed' : 'failed', exitCode: result.code, signal: result.signal ?? null };
          if (name === 'sandbox' && result.code === 0) Object.assign(stage, sandboxResult(result.output));
          if (name === 'wasm' && stage.status === 'passed') {
            const sha256 = createHash('sha256').update(await readFile(resolve(root, WASM))).digest('hex');
            summary.wasm = { path: WASM, sha256 };
            await writeFile(resolve(directory, 'wasm.sha256'), `${sha256}  ${WASM}\n`);
          }
        } catch (error) {
          stage = { name, status: 'failed', reason: error.message };
        }
      }
    }
    summary.stages.push(stage);
    await finish();
    console.log(`${name}: ${stage.status}${stage.reason ? ` (${stage.reason})` : ''}`);
  }
  console.log(`\nVerification: ${summary.status}. Artifacts: ${directory}`);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/verify.mjs [--ci] [--skip=install,rust,node,wasm,sandbox]\nSkipped stages make verification incomplete (exit 2); failures exit 1; complete verification exits 0.\nLogs, commit, toolchains and WASM sha256: .tmp/verification/');
  } else {
    try {
      const summary = await verify(parseArgs(process.argv.slice(2)));
      process.exitCode = summary.exitCode;
    } catch (error) {
      console.error(`Verification failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
