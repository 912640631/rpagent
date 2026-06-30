#!/usr/bin/env node
// Keep the launcher usable before TypeScript has been built.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--state' || !args[1]?.trim())) {
    throw Object.assign(new Error('用法：node cli.ts [--state 路径]，从 stdin 读取一个 JSON 对象'), { code: 'INVALID_ARGUMENTS' });
  }
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw Object.assign(new Error('stdin 必须是一个有效的 JSON 对象'), { code: 'INVALID_COMMAND' }); }
  const entry = resolve(import.meta.dirname, 'CombatEngine/dist/src/adventure-command.js');
  if (!existsSync(entry)) {
    throw Object.assign(new Error(`请先在 ${import.meta.dirname} 运行 npm install 和 npm run build`), { code: 'BUILD_REQUIRED' });
  }
  const { executeAdventureCommand } = await import(pathToFileURL(entry).href) as typeof import('./CombatEngine/dist/src/adventure-command.js');
  const statePath = args[1] ?? (process.env.ADVENTURE_SESSION_FILE || resolve(import.meta.dirname, 'NarrativeDice/.local/adventure.json'));
  const result = executeAdventureCommand(input, statePath);
  process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: {
    code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error)
  } }) + '\n');
  process.exitCode = 1;
});
