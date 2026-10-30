import { parseRequest, paymentExitCode } from './parse.mjs';
import { connectAgent, submitSpend } from './agent-key.mjs';

async function main() {
  const input = process.argv.slice(2);
  const submit = input.includes('--submit');
  const args = parseRequest(input.filter((x) => x !== '--submit').join(' '));
  if (!submit) {
    console.log(JSON.stringify({ mode: 'offline', network: 'testnet', method: 'spend', args }, null, 2));
    return;
  }
  const outcome = await submitSpend(await connectAgent(), args);
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.payment === 'refused') process.exitCode = 3;
  // `unknown` (no terminal event) is not success: keep the hash and exit 2 for reconciliation.
  else if (paymentExitCode(outcome.payment)) process.exitCode = 2;
}

main().catch((error) => {
  // Never echo key material or RPC request objects.
  console.error(error instanceof Error ? error.message : 'Demo failed');
  process.exitCode = 1;
});
