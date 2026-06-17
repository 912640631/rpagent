#!/usr/bin/env node
import { createEngine, DiceError } from './index.js';

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--state' || !args[1])) {
    throw new DiceError('INVALID_ARGUMENTS', '用法：node NarrativeDice/cli.js [--state 路径]，从 stdin 读取一条 JSON 命令');
  }
  const command = JSON.parse(await readStdin());
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new DiceError('INVALID_COMMAND', '命令必须是 JSON 对象');
  }
  const engine = createEngine(args.length ? { statePath: args[1] } : undefined);
  let result;
  switch (command.action) {
    case 'status': result = await engine.status(); break;
    case 'roll': result = await engine.roll(command); break;
    case 'spendFear': result = await engine.spendFear(); break;
    case 'reset': result = await engine.reset(); break;
    default: throw new DiceError('UNKNOWN_ACTION', 'action 必须是 status、roll、spendFear 或 reset');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
}

main().catch((error) => {
  const code = error instanceof DiceError ? error.code : 'INTERNAL_ERROR';
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message: error.message } })}\n`);
  process.exitCode = 1;
});
