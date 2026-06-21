import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Rules } from '../src/tools.js';
import { AdventureService } from '../src/web/service.js';
import { ScriptedModel, text } from './helpers/scripted-model.js';

async function fixture(t: TestContext, kind: 'cli' | 'web') {
  const root = mkdtempSync(join(tmpdir(), `witcher-${kind}-lock-`));
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  if (kind === 'cli') {
    const config = join(root, 'providers.json');
    writeFileSync(config, JSON.stringify({ providers: { local: { protocol: 'openai-chat', baseURL: 'http://127.0.0.1:1/v1',
      defaultModel: 'local', contextTokens: 32768 } }, main: { provider: 'local' }, combat: { provider: 'local' },
      maxOutputTokens: 2048, recentTokens: 6000, battleResultTokens: 1500 }));
    const store = new Store(join(root, 'session.json'));
    store.data.main.push({ role: 'user', content: '已保存的旅程' }); store.save();
    const rules = new Rules(join(root, 'rules.json'));
    rules.adventure.narrativeRoll(0, { difficulty: 12 }, (() => { const dice = [9, 4]; return () => dice.shift()!; })());
    return { root, cleanups, args: ['--import', 'tsx', fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--save', root, '--config', config],
      ready: 'RPG 已就绪', state: () => ({ memory: new Store(store.path).data.main, rules: new Rules(rules.path).status() }) };
  }
  const model = new ScriptedModel([[text('已保存的旅程')]]);
  const service = new AdventureService(root, { main: model, combat: new ScriptedModel() });
  const id = service.create('并发打开').id;
  service.submit(id, 'past', '继续'); await service.idle(id); await service.close();
  return { root, cleanups, args: ['--import', 'tsx', fileURLToPath(new URL('./helpers/lock-worker.ts', import.meta.url)), root, id],
    ready: 'WEB_READY', state: async () => {
      const reader = new AdventureService(root);
      try { return { story: reader.state(id).story, rules: reader.state(id).rules }; }
      finally { await reader.close(); }
    } };
}

function start(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, f.args, { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let stdout = '', stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`process readiness timed out: ${stderr}`)); }, 10_000);
    child.stdout!.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes(f.ready)) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`process exited before ready (${code}): ${stderr}`)); });
  });
  f.cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return { child, ready, exited };
}
async function stop(process: ReturnType<typeof start>, kind: 'cli' | 'web') {
  if (kind === 'cli') process.child.stdin!.end('/quit\n');
  else process.child.send('close');
  assert.equal(await process.exited, 0);
}

for (const kind of ['cli', 'web'] as const) {
  test(`${kind} rejects a concurrent writer without damaging the saved adventure`, async t => {
    const f = await fixture(t, kind), before = await f.state();
    const first = start(f); await first.ready;
    const second = spawnSync(process.execPath, f.args, { encoding: 'utf8', timeout: 10_000 });
    assert.equal(second.error, undefined);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /另一个 RPG 进程/);
    await stop(first, kind);
    assert.deepEqual(await f.state(), before);
  });
  test(`${kind} releases its locks on normal exit and can reopen the same progress`, async t => {
    const f = await fixture(t, kind), before = await f.state();
    const first = start(f); await first.ready; await stop(first, kind);
    const reopened = start(f); await reopened.ready; await stop(reopened, kind);
    assert.deepEqual(await f.state(), before);
  });
  test(`${kind} recovers stale process locks after an abnormal exit`, async t => {
    const f = await fixture(t, kind), before = await f.state();
    const first = start(f); await first.ready;
    first.child.kill('SIGKILL'); await first.exited;
    const reopened = start(f); await reopened.ready; await stop(reopened, kind);
    assert.deepEqual(await f.state(), before);
  });
  for (const invalid of ['not-a-pid', '0', '-1', '1.5']) {
    test(`${kind} refuses invalid lock content ${invalid} without changing saved progress`, async t => {
      const f = await fixture(t, kind), before = await f.state();
      const lock = join(f.root, 'process.lock');
      writeFileSync(lock, invalid);
      const rejected = spawnSync(process.execPath, f.args, { encoding: 'utf8', timeout: 10_000 });
      assert.equal(rejected.error, undefined);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /存档锁无效/);
      // Remove only the deliberately corrupt input so the public reader can reopen.
      unlinkSync(lock);
      assert.deepEqual(await f.state(), before);
    });
  }
}
