import { JournalBackend } from '../src/web/journal.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { AdventureService } from '../src/web/service.js';
import { createWebServer } from '../src/web/server.js';
import type { Adapter, GenerateOptions, Message, StreamChunk } from '../src/types.js';
import { Rules } from '../src/tools.js';
import { Store } from '../src/store.js';
import { chooseTestCommand } from 'witcher-combat-engine';

const text = (text: string): StreamChunk => ({ type: 'text', text });
const call = (name: string, args: unknown = {}): StreamChunk => ({ type: 'call', call: { id: crypto.randomUUID(), name, arguments: JSON.stringify(args) } });

test('story projection hides memos in live updates, old history and restored snapshots but retains raw events', async t => {
  const memo = JSON.stringify({ currentSituation: '坠落中', necessaryFacts: '女术士在附近', unfinishedActionsAndIntent: '等待玩家' });
  const raw = `地面崩塌，你要怎么做？\n\n\`\`\`json\n${memo}\n\`\`\``;
  const main = new Mock([[...Array.from(raw, text), { type: 'usage', input: 100, output: 10 }], [text(memo)]]);
  const { service, id, root } = fixture(t, main);
  const updates: string[] = [];
  const unsubscribe = service.subscribe(() => { updates.push(service.state(id).stream?.text ?? ''); });
  t.after(unsubscribe);
  service.submit(id, 'memo-story', '玩家原文：' + memo); await service.idle(id);
  assert.ok(updates.every(text => !text.includes('currentSituation') && !text.includes('女术士在附近')));
  assert.equal(service.state(id).story.at(-1)?.text, '地面崩塌，你要怎么做？');
  assert.equal(service.state(id).story[0]?.text, '玩家原文：' + memo);
  assert.ok(service.events(id).some(e => e.type === 'message.complete' && e.text === raw));
  const snapshot = await service.save(id, '备忘隐藏前的原始记录');
  service.submit(id, 'memo-only', '继续'); await service.idle(id);
  assert.equal(service.state(id).story.at(-1)?.role, 'user');
  await service.restore(id, snapshot.id);
  assert.equal(service.state(id).story.at(-1)?.text, '地面崩塌，你要怎么做？');
  await service.close();
  const reopened = new AdventureService(root, { main: new Mock([]), combat: new Mock([]) });
  t.after(() => reopened.close());
  assert.equal(reopened.state(id).story.at(-1)?.text, '地面崩塌，你要怎么做？');
  assert.ok(reopened.events(id).some(e => e.type === 'message.complete' && e.text === raw));
});
class Mock implements Adapter {
  inputs: Message[][] = []; options: GenerateOptions[] = [];
  constructor(readonly responses: (StreamChunk[] | Error | (() => Promise<StreamChunk[]>))[]) {}
  async *generate(messages: Message[], options: GenerateOptions) {
    this.inputs.push(structuredClone(messages)); this.options.push(options);
    const response = this.responses.shift(); assert.ok(response, 'unexpected request');
    if (response instanceof Error) throw response;
    yield* typeof response === 'function' ? await response() : response;
  }
}
function fixture(t: TestContext, main: Mock, combat = new Mock([])) {
  const root = mkdtempSync(join(tmpdir(), 'witcher-web-'));
  const service = new AdventureService(root, { main, combat });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const id = service.create('河畔手记').id;
  return { service, id, root };
}
async function webEndpoint(t: TestContext, service: AdventureService) {
  const server = createWebServer(service, join(import.meta.dirname, '../../Frontend/dist'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
test('queued safe snapshot restores story, rules and memory, retains current settings and creates backup', async t => {
  let release!: (v: StreamChunk[]) => void;
  const main = new Mock([() => new Promise(resolve => { release = resolve; }), [call('narrative_roll', { difficulty: 12 })], [text('未来的故事')], [text('读档之后')]]);
  const { service, id, root } = fixture(t, main);
  service.submit(id, 'first', '河畔');
  await new Promise(resolve => setImmediate(resolve));
  let saved = false;
  const saving = service.save(id, '路口').then(s => { saved = true; return s; });
  assert.equal(saved, false); assert.equal(service.state(id).phase, 'running');
  release([text('你来到路口')]); const snapshot = await saving;
  await service.idle(id);
  const original = service.state(id);
  service.submit(id, 'second', '掷骰前进'); await service.idle(id);
  assert.equal(service.state(id).rules.revision, 1);
  const settings = structuredClone(service.settings.value); settings.main.model = 'changed'; settings.main.style = '新的风格'; settings.providers.local!.apiKey = 'secret-value'; service.settings.update(settings);
  await service.restore(id, snapshot.id);
  assert.deepEqual(service.state(id).story, original.story); assert.deepEqual(service.state(id).rules, original.rules);
  assert.equal(service.settings.value.main.model, 'changed');
  assert.ok(service.snapshots(id).some(s => s.name.startsWith('读取前备份')));
  for (const s of service.snapshots(id)) assert.ok(!readFileSync(join(root, 'adventures', id, 'snapshots', `${s.id}.json`), 'utf8').includes('secret-value'));
  service.submit(id, 'third', '继续'); await service.idle(id);
  assert.ok(!JSON.stringify(main.inputs.at(-1)).includes('未来的故事'));
  assert.equal(main.options.at(-1)?.model, 'changed');
  assert.equal(service.submit(id, 'second', '重复').status, 'done');
});
test('failed request and restart preserve accepted input and committed dice without duplicate execution', async t => {
  const main = new Mock([[call('narrative_roll', { difficulty: 10 })], new Error('offline'), [text('恢复成功')]]);
  const { service, id, root } = fixture(t, main);
  service.submit(id, 'roll', '检查足迹'); await service.idle(id);
  assert.equal(service.state(id).phase, 'recovery'); const revision = service.state(id).rules.revision;
  await service.close();
  const restarted = new AdventureService(root, { main, combat: new Mock([]) });
  t.after(() => restarted.close());
  assert.equal(restarted.state(id).phase, 'recovery');
  restarted.submit(id, 'retry', undefined, true); await restarted.idle(id);
  assert.equal(restarted.state(id).phase, 'waiting'); assert.equal(restarted.state(id).rules.revision, revision);
  assert.equal(restarted.state(id).story.filter(m => m.role === 'user').length, 1);
  assert.equal(restarted.events(id).filter(e => e.type === 'tool.result').length, 1);
});
test('queued restore survives model failure and its backup can recover the interrupted adventure', async t => {
  let release!: (value: StreamChunk[]) => void;
  const main = new Mock([[text('路口')], () => new Promise(resolve => { release = resolve; }), new Error('offline'), [text('恢复足迹')]]);
  const { service, id } = fixture(t, main);
  service.submit(id, 'first', '前往路口'); await service.idle(id);
  const saved = await service.save(id, '路口'); const original = service.state(id);
  service.submit(id, 'failed', '检查足迹'); await new Promise(resolve => setImmediate(resolve));
  let restored = false;
  const restoring = service.restore(id, saved.id).then(value => { restored = true; return value; });
  assert.equal(restored, false);
  release([call('narrative_roll', { difficulty: 10 })]);
  await restoring; await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting');
  assert.deepEqual(service.state(id).story, original.story);
  assert.deepEqual(service.state(id).rules, original.rules);
  const backup = service.snapshots(id).find(s => s.name.startsWith('读取前备份'))!;
  assert.ok(backup);
  await service.restore(id, backup.id);
  const failed = service.state(id);
  assert.equal(failed.phase, 'recovery'); assert.equal(failed.error, 'offline');
  assert.equal(failed.rules.revision, 1);
  assert.ok(failed.story.some(m => m.text === '检查足迹'));
  await assert.rejects(service.save(id, '不安全的手动存档'), /安全节点/);
  service.submit(id, 'retry-backup', undefined, true); await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting');
  assert.equal(service.state(id).rules.revision, failed.rules.revision);
  assert.equal(service.events(id).filter(e => e.type === 'tool.result').length, 1);
});
test('raising battle result budget lets manual retry settle a finished battle without replay', async t => {
  const { service, id, root } = fixture(t, new Mock([]));
  const config = structuredClone(service.settings.value); config.battleResultTokens = 1; service.settings.update(config);
  await service.close();
  // A finished engine step with its application context still awaiting settlement.
  const dir = join(root, 'adventures', id); const rules = new Rules(join(dir, 'rules.json'));
  const ledger = rules.adventure.status();
  const battle = rules.handoff.start(ledger.revision, { monsterId: 'drowner', seed: 7, maxActions: 1 }, {
    scene: '河畔', facts: [], objectives: [], environment: [], risks: [],
    participants: [{ id: 'geralt', role: 'geralt' }, { id: 'enemy', role: 'monster' }],
    resources: { revision: ledger.revision, ...ledger.resources }
  });
  rules.handoff.act(battle.battleId, 0, chooseTestCommand(rules.adventure.battleRecord().state));
  const store = new Store(join(dir, 'journal.ndjson'), new JournalBackend(join(dir, 'journal.ndjson'))); store.data.battleId = battle.battleId; store.save();
  const main = new Mock([[text('战斗后继续')]]);
  const restarted = new AdventureService(root, { main, combat: new Mock([]) });
  t.after(() => restarted.close());
  restarted.submit(id, 'settle', '继续'); await restarted.idle(id);
  assert.equal(restarted.state(id).phase, 'recovery'); assert.match(restarted.state(id).error!, /超过预算/);
  const revision = restarted.state(id).rules.revision;
  const updated = structuredClone(restarted.settings.value); updated.battleResultTokens = 5000; restarted.settings.update(updated);
  restarted.submit(id, 'retry-settle', undefined, true); await restarted.idle(id);
  assert.equal(restarted.state(id).phase, 'waiting'); assert.equal(restarted.state(id).battle, null);
  assert.equal(restarted.state(id).rules.revision, revision);
  assert.equal(main.inputs.length, 1);
  assert.equal(main.inputs[0]!.filter(m => m.content.includes('战斗子 Agent 的结构化结果')).length, 1);
});
test('an isolated monster test preserves the original adventure', async t => {
  const { service, id } = fixture(t, new Mock([]));
  const { sequence: _beforeCursor, ...before } = service.state(id);
  const isolated = await service.testBattle(id, 'drowner');
  // Queue notifications advance the transport cursor without advancing the original adventure.
  const { sequence: _afterCursor, ...after } = service.state(id);
  assert.deepEqual(after, before);
  assert.ok(service.state(isolated.id).battle);
});
test('battle handoff contains only battle context', async t => {
  const main = new Mock([[call('start_battle', { monsterId: 'drowner', monsterObjectId: 'enemy', scene: '河畔', facts: [], objectives: [], environment: [], risks: [] })]]);
  const combat = new Mock([[text('水鬼逼近，等待你的行动。')]]);
  const { service, id } = fixture(t, main, combat);
  service.submit(id, 'battle', '迎战水鬼'); await service.idle(id);
  assert.equal(service.state(id).awaiting, 'player_action');
  assert.ok(service.events(id).some(e => e.type === 'battle.handoff'));
  assert.ok(!JSON.stringify(combat.inputs[0]).includes('迎战水鬼'));
});
test('a battle snapshot restores earlier public rules after progress and survives reopening', async t => {
  const main = new Mock([[call('start_battle', { monsterId: 'drowner', monsterObjectId: 'enemy', scene: '河畔', facts: [], objectives: [], environment: [], risks: [] })], [text('战后故事')]]);
  const combat = new Mock([[text('水鬼逼近，等待你的行动。')], [call('battle_act', { command: { type: 'action', id: 'potion:swallow' } })],
    [call('battle_act', { command: { type: 'action', id: 'attack:normal' } })], [text('药剂已经喝下')]]);
  const { service, id, root } = fixture(t, main, combat);
  service.submit(id, 'battle', '迎战水鬼'); await service.idle(id);
  const saved = await service.save(id, '战斗中');
  const before = service.state(id);
  service.submit(id, 'drink', '喝燕子'); await service.idle(id);
  assert.ok(service.state(id).rules.revision > before.rules.revision);
  await service.restore(id, saved.id);
  assert.deepEqual(service.state(id).rules, before.rules);
  assert.deepEqual(service.state(id).battle, before.battle);
  assert.equal(service.state(id).awaiting, 'player_action');
  await service.close();
  const reopened = new AdventureService(root, { main: new Mock([]), combat: new Mock([]) });
  t.after(() => reopened.close());
  assert.deepEqual(reopened.state(id).rules, before.rules);
  assert.deepEqual(reopened.state(id).battle, before.battle);
});
test('settings change between requests, current request uses original options and style', async t => {
  let release!: (v: StreamChunk[]) => void;
  const main = new Mock([() => new Promise(resolve => { release = resolve; }), [text('之后')]]);
  const { service, id } = fixture(t, main);
  service.submit(id, 'settings', '查看'); await new Promise(resolve => setImmediate(resolve));
  const config = structuredClone(service.settings.value); config.main.model = 'next-model'; config.main.style = '新风格'; config.maxOutputTokens = 512; service.settings.update(config);
  release([call('rules_status')]); await service.idle(id);
  assert.equal(main.options[0]!.model, 'local-model'); assert.equal(main.options[0]!.maxTokens, 2048);
  assert.equal(main.options[1]!.model, 'next-model'); assert.equal(main.options[1]!.maxTokens, 512);
  assert.ok(main.inputs[1]![0]!.content.includes('新风格')); assert.ok(!main.inputs[0]![0]!.content.includes('新风格'));
});
test('HTTP story and each SSE reconnect project raw saved memos while retaining console events', async t => {
  const memo = JSON.stringify({ currentSituation: '地下', necessaryFacts: '石壁', unfinishedActionsAndIntent: '等待选择' });
  const { service, id } = fixture(t, new Mock([[text(`你要怎么做？\n\n\`\`\`json\n${memo}\n\`\`\``)]]));
  service.submit(id, 'memo', '继续'); await service.idle(id);
  const server = createWebServer(service, join(import.meta.dirname, '../../Frontend/dist'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/adventures/${id}`;
  const state = await (await fetch(base + '/state')).json();
  assert.equal(state.story.at(-1).text, '你要怎么做？');
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    const response = await fetch(base + '/events'); const reader = response.body!.getReader();
    const baseline = new TextDecoder().decode((await reader.read()).value);
    const payload = JSON.parse(baseline.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    assert.equal(payload.history, true);
    assert.equal(payload.state.story.at(-1).text, '你要怎么做？');
    assert.ok(payload.events.some((e: any) => e.type === 'message.complete' && e.text.includes('currentSituation')));
    await reader.cancel();
  }
});

test('HTTP API rejects cross-origin writes without creating an adventure', async t => {
  const { service } = fixture(t, new Mock([]));
  const base = await webEndpoint(t, service), before = service.list();
  assert.equal((await fetch(`${base}/api/adventures`, { method: 'POST', headers: { origin: 'https://other.test', 'content-type': 'application/json' }, body: '{"name":"bad"}' })).status, 400);
  assert.deepEqual(service.list(), before);
});
test('SSE marks the initial baseline as history', async t => {
  const { service, id } = fixture(t, new Mock([]));
  const base = await webEndpoint(t, service);
  const response = await fetch(`${base}/api/adventures/${id}/events`); const reader = response.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const baseline = new TextDecoder().decode((await reader.read()).value); assert.ok(baseline.includes('"history":true')); await reader.cancel();
});
test('an accepted HTTP operation finishes after its SSE observer disconnects', async t => {
  let release!: (chunks: StreamChunk[]) => void, started!: () => void;
  const generating = new Promise<void>(resolve => { started = resolve; });
  const main = new Mock([() => new Promise(resolve => { release = resolve; started(); })]);
  const { service, id } = fixture(t, main);
  const base = await webEndpoint(t, service);
  const response = await fetch(`${base}/api/adventures/${id}/events`), reader = response.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  await reader.read();
  const submitted = await fetch(`${base}/api/adventures/${id}/turn`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: 'disconnected', input: '继续' }) });
  assert.equal(submitted.ok, true);
  await generating; await reader.cancel();
  release([text('断线后完成的故事')]); await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting');
  assert.equal(service.state(id).story.at(-1)?.text, '断线后完成的故事');
  assert.equal(service.submit(id, 'disconnected', '重复').status, 'done');
});
async function connectionFixture(t: TestContext) {
  const requests: any[] = [];
  const mockServer = createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; requests.push(JSON.parse(body)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } })); });
  await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { mockServer.closeAllConnections(); mockServer.close(); });
  const { service } = fixture(t, new Mock([]));
  const config = structuredClone(service.settings.value); config.providers.local!.baseURL = `http://127.0.0.1:${(mockServer.address() as any).port}`; config.providers.local!.reasoning = { field: 'reasoning_effort', values: { low: 'low', high: 'high' } }; config.main.reasoning = 'low'; config.combat.reasoning = 'high'; service.settings.update(config);
  return { service, requests };
}
test('provider capability mapping keeps each Agent reasoning setting independent', async t => {
  const { service, requests } = await connectionFixture(t);
  await service.settings.test('main'); await service.settings.test('combat');
  assert.equal(requests[0].reasoning_effort, 'low'); assert.equal(requests[1].reasoning_effort, 'high');
});
test('connection tests limit output and omit sampling overrides', async t => {
  const { service, requests } = await connectionFixture(t);
  await service.settings.test('main');
  assert.equal(requests[0].temperature, undefined); assert.equal(requests[0].top_p, undefined); assert.equal(requests[0].max_tokens, 32);
});
test('settings reject protected request fields without changing the saved configuration', t => {
  const { service } = fixture(t, new Mock([]));
  const before = service.settings.public(), config = structuredClone(service.settings.value);
  config.providers.local!.requestFields = { messages: [] }; assert.throws(() => service.settings.update(config));
  assert.deepEqual(service.settings.public(), before);
});

test('main compression preserves complete story and exposes separate compression requests', async t => {
  const old = '渡船旁的渔夫讲述着古老的传说。'.repeat(300);
  const main = new Mock([[text(old), { type: 'usage', input: 27000, output: 100 }],
    [text('{"currentSituation":"河畔","necessaryFacts":"渔夫","unfinishedActionsAndIntent":"询问"}')], [text('故事继续')]]);
  const { service, id } = fixture(t, main);
  const config = structuredClone(service.settings.value); config.recentTokens = 1; service.settings.update(config);
  service.submit(id, 'long-story', '旅途开始'); await service.idle(id);
  service.submit(id, 'continuation', '继续询问'); await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting');
  assert.ok(service.state(id).story.some(m => m.text === old));
  assert.ok(!JSON.stringify(main.inputs.at(-1)).includes(old));
  assert.ok(service.events(id).some(e => e.type === 'request.end' && e.purpose === 'compression'));
  assert.ok(!service.state(id).story.some(m => m.text.startsWith('{"currentSituation"')));
});

test('48-step loop stops safely without an extra request', async t => {
  const main = new Mock(Array.from({ length: 48 }, () => [call('rules_status')]));
  const { service, id } = fixture(t, main);
  service.submit(id, 'loop', '检查状态'); await service.idle(id);
  assert.equal(main.inputs.length, 48); assert.equal(service.state(id).phase, 'recovery');
  assert.equal(service.events(id).filter(e => e.type === 'tool.result').length, 48);
  assert.equal(service.state(id).rules.revision, 0);
});

test('cleared model overrides use the Provider default in adventure requests and connection tests', async t => {
  const requests: { model: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '河畔' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const root = mkdtempSync(join(tmpdir(), 'witcher-default-model-'));
  const service = new AdventureService(root);
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const config = structuredClone(service.settings.value);
  config.providers.local!.baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  config.providers.local!.stream = false;
  config.providers.local!.defaultModel = 'provider-default';
  config.main.model = 'previous-override'; service.settings.update(config);
  config.main.model = ''; config.combat.model = '   '; service.settings.update(config);
  const id = service.create('默认模型').id;
  service.submit(id, 'default-model', '继续'); await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting');
  await service.settings.test('main'); await service.settings.test('combat');
  assert.deepEqual(requests.map(r => r.model), ['provider-default', 'provider-default', 'provider-default']);
});

test('each compression attempt snapshots the latest model and output limit', async t => {
  let release!: (value: StreamChunk[]) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const main = new Mock([
    [text('渡船边的往事。'.repeat(1000)), { type: 'usage', input: 27000, output: 100 }],
    () => new Promise(resolve => { release = resolve; markStarted(); }),
    [text('{"currentSituation":"河畔","necessaryFacts":"渡船","unfinishedActionsAndIntent":"询问"}')],
    [text('继续故事')],
  ]);
  const { service, id } = fixture(t, main);
  const config = structuredClone(service.settings.value); config.recentTokens = 1; service.settings.update(config);
  service.submit(id, 'old-story', '出发'); await service.idle(id);
  service.submit(id, 'compress', '继续'); await started;
  const changed = structuredClone(service.settings.value);
  changed.main.model = 'next-model'; changed.maxOutputTokens = 512; service.settings.update(changed);
  release([text('invalid summary')]); await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting');
  assert.equal(main.options[1]!.model, 'local-model'); assert.equal(main.options[1]!.maxTokens, 2048);
  assert.equal(main.options[2]!.model, 'next-model'); assert.equal(main.options[2]!.maxTokens, 512);
  assert.equal(main.options[3]!.model, 'next-model');
  const starts = service.events(id).filter(e => e.type === 'request.start' && e.purpose === 'compression');
  assert.deepEqual(starts.map(e => e.type === 'request.start' ? e.model : undefined), ['local-model', 'next-model']);
});

test('manual snapshots restore narrative dice and the next battle roll across restart', async t => {
  const roll = () => [call('narrative_roll', { difficulty: 12 })];
  const battle = () => [call('start_battle', { monsterId: 'drowner', monsterObjectId: 'enemy', scene: '河畔', facts: [], objectives: [], environment: [], risks: [] })];
  const main = new Mock([roll(), [text('第一次判定')], roll(), [text('第二次判定')], battle(),
    roll(), [text('第一次判定')], roll(), [text('第二次判定')], battle()]);
  const attack = () => [call('battle_act', { command: { type: 'action', id: 'sword:normal' } })];
  const combat = new Mock([[text('等待玩家行动')], attack(), new Error('offline after committed attack'),
    [text('等待玩家行动')], attack(), new Error('offline after committed attack')]);
  const { service, id, root } = fixture(t, main, combat);
  const saved = await service.save(id, '判定之前');
  const advance = async (current: AdventureService, suffix: string) => {
    current.submit(id, `first-${suffix}`, '查看足迹'); await current.idle(id);
    const first = current.state(id).rules;
    current.submit(id, `second-${suffix}`, '继续调查'); await current.idle(id);
    const second = current.state(id).rules;
    current.submit(id, `battle-${suffix}`, '迎战'); await current.idle(id);
    assert.equal(current.state(id).phase, 'waiting');
    current.submit(id, `attack-${suffix}`, '普通剑击'); await current.idle(id);
    assert.equal(current.state(id).phase, 'recovery');
    const result = current.events(id).filter(e => e.type === 'tool.result' && e.call.name === 'battle_act').at(-1);
    assert.ok(result?.type === 'tool.result');
    assert.ok('events' in result.result);
    // A replay creates a new battle identity; compare its authoritative checks and effects.
    return { first, second, battle: current.state(id).battle, events: result.result.events };
  };
  const original = await advance(service, 'original');
  await service.restore(id, saved.id); await service.close();
  const restarted = new AdventureService(root, { main, combat });
  t.after(() => restarted.close());
  const replayed = await advance(restarted, 'restored');
  assert.deepEqual(replayed, original);
});
