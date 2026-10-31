import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs, sandboxResult, STAGES, verify, verificationResult } from './verify.mjs';

const tap = ({ tests = 9, pass = 9, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) =>
  Object.entries({ tests, pass, fail, cancelled, skipped, todo }).map(([key, n]) => `# ${key} ${n}`).join('\n');

test('verification flags allow explicit local skips and forbid skips in CI', () => {
  assert.deepEqual([...parseArgs(['--skip=rust,wasm', '--skip=sandbox']).skip], ['rust', 'wasm', 'sandbox']);
  assert.equal(parseArgs(['--ci']).ci, true);
  assert.throws(() => parseArgs(['--skip=unknown']), /Unknown skip/);
  assert.throws(() => parseArgs(['--skip=']), /Unknown skip/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
  assert.throws(() => parseArgs(['--ci', '--skip=sandbox']), /does not allow/);
});

test('sandbox verification requires a complete TAP summary with no skips or pending tests', () => {
  assert.equal(sandboxResult(tap()).status, 'passed');
  assert.equal(sandboxResult(tap({ tests: 1, pass: 0, skipped: 1 })).status, 'incomplete');
  assert.equal(sandboxResult(tap({ pass: 8, todo: 1 })).status, 'incomplete');
  assert.equal(sandboxResult(tap({ tests: 0, pass: 0 })).status, 'incomplete');
  assert.equal(sandboxResult('process exited 0').status, 'incomplete');
  assert.equal(sandboxResult(tap({ fail: 1 })).status, 'failed');
  assert.equal(sandboxResult(tap({ cancelled: 1 })).status, 'failed');
});

test('verification never labels partial or failed runs as a pass', () => {
  const passed = STAGES.map((name) => ({ name, status: 'passed' }));
  assert.deepEqual(verificationResult(passed), { status: 'passed', exitCode: 0 });
  assert.equal(verificationResult(passed.slice(1)).exitCode, 2);
  assert.equal(verificationResult([{ status: 'incomplete' }]).status, 'incomplete');
  assert.equal(verificationResult([{ status: 'incomplete' }, { status: 'failed' }]).exitCode, 1);
});

async function fixture(t, { sandboxOutput = tap(), wasmCode = 0 } = {}) {
  const parent = resolve('.tmp/verify-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(`${parent}/run-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.99.1"\n');
  const calls = [];
  const run = async (command, args, options) => {
    const name = options.log.split('/').at(-1).replace('.log', '');
    calls.push({ name, command, args, ...options });
    let output = 'fixture version\n';
    let code = 0;
    if (name === 'commit') output = `${'a'.repeat(40)}\n`;
    if (name === 'worktree') output = '';
    if (name === 'sandbox') output = sandboxOutput;
    if (name === 'wasm') {
      code = wasmCode;
      if (!code) {
        const path = resolve(root, 'target/wasm32-unknown-unknown/release/near_agent_spend_guard.wasm');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, 'fixture WASM bytes, not a contract build');
      }
    }
    await writeFile(options.log, output);
    return { code, output };
  };
  return { root, run, calls, artifact: (name) => resolve(root, '.tmp/verification', name) };
}

test('full verification records commit, versions and WASM hash and runs locked commands', async (t) => {
  const f = await fixture(t);
  const result = await verify({ ci: true }, f);
  assert.equal(result.status, 'passed');
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(result.dirty, false);
  assert.match(await readFile(f.artifact('wasm.sha256'), 'utf8'), /^[a-f0-9]{64}  target\//);
  assert.match(await readFile(f.artifact('toolchains.txt'), 'utf8'), /pinned toolchain/);
  assert.equal(JSON.parse(await readFile(f.artifact('summary.json'), 'utf8')).exitCode, 0);
  assert.deepEqual(f.calls.find((c) => c.name === 'install').args, ['ci', '--ignore-scripts']);
  for (const name of ['rust', 'wasm']) assert.ok(f.calls.find((c) => c.name === name).args.includes('--locked'));
  const sandbox = f.calls.find((c) => c.name === 'sandbox');
  assert.match(sandbox.args[1], /ulimit -Sn 65535/);
  assert.equal(sandbox.env.SPEND_GUARD_SANDBOX_BIN, '');
});

test('explicit local skips are incomplete and never run stale WASM in sandbox', async (t) => {
  const f = await fixture(t);
  const result = await verify({ skip: new Set(['wasm']) }, f);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.exitCode, 2);
  assert.equal(f.calls.some((c) => ['wasm', 'sandbox'].includes(c.name)), false);
  assert.match(result.stages.at(-1).reason, /Requires a successful WASM build/);
});

test('a zero-exit sandbox skip fails CI verification as incomplete', async (t) => {
  const f = await fixture(t, { sandboxOutput: tap({ tests: 1, pass: 0, skipped: 1 }) });
  const result = await verify({ ci: true }, f);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.exitCode, 2);
  assert.equal(result.stages.at(-1).counts.skipped, 1);
});

test('a failed WASM rebuild removes stale hash evidence and blocks sandbox', async (t) => {
  const f = await fixture(t, { wasmCode: 1 });
  await mkdir(dirname(f.artifact('wasm.sha256')), { recursive: true });
  await writeFile(f.artifact('wasm.sha256'), 'stale hash');
  const result = await verify({}, f);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.equal(f.calls.some((c) => c.name === 'sandbox'), false);
  await assert.rejects(readFile(f.artifact('wasm.sha256')), { code: 'ENOENT' });
});
