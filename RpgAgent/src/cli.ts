import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve, join } from 'node:path';
import { initConfig, loadConfig } from './config.js';
import { Store, acquireLock } from './store.js';
import { Rules } from './tools.js';
import { Harness } from './harness.js';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}
async function main() {
  const configPath = resolve(argument('--config', '.local/rpg/providers.json'));
  if (process.argv.includes('--init')) {
    initConfig(resolve(argument('--api-file', 'api接入.txt')), configPath);
    console.log(`已生成本地 Provider 配置：${configPath}。contextTokens 默认 32768，请按模型实际容量调整。`); return;
  }
  const directory = resolve(argument('--save', '.local/rpg/default'));
  const release = acquireLock(join(directory, 'process.lock'));
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const config = loadConfig(configPath);
    const store = new Store(join(directory, 'session.json'));
    const harness = new Harness(config, store, new Rules(join(directory, 'rules.json')),
      { text: text => stdout.write(text), notice: text => console.log(`\n[${text}]`) });
    await harness.recover();
    // Resume from engine state without retaining a large previous child transcript.
    harness.rebuildCombat();
    console.log('RPG 已就绪。/compact 压缩，/status 规则状态，/retry 继续，/quit 退出。');
    while (true) {
      let input: string;
      try { input = (await reader.question(store.data.battleId ? '\n战斗 > ' : '\n冒险 > ')).trim(); }
      catch { break; }
      if (!input) continue;
      if (input === '/quit') break;
      try {
        if (input === '/compact') await harness.compactMain();
        else if (input === '/status') console.log(JSON.stringify(harness.rules.status(), null, 2));
        else await harness.turn(input === '/retry' ? undefined : input);
      } catch (error) { console.error(`\n${(error as Error).message}`); }
    }
  } finally { reader.close(); release(); }
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
