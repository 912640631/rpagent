import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ChatCompletionsAdapter } from '../src/adapter.js';
import { compact, emptyMemo, tokens } from '../src/context.js';
import { Store } from '../src/store.js';
import { Harness } from '../src/harness.js';
import { Rules } from '../src/tools.js';
import { initConfig, loadConfig } from '../src/config.js';
import { chooseTestCommand } from 'witcher-combat-engine';
import type { Adapter, Config, GenerateOptions, Message, StreamChunk, ToolCall } from '../src/types.js';

const config: Config = {
  providers: { mock: { protocol: 'openai-chat', baseURL: 'http://localhost/v1', defaultModel: 'mock', contextTokens: 32768 } },
  main: { provider: 'mock' }, combat: { provider: 'mock' }, maxOutputTokens: 2048, recentTokens: 6000, battleResultTokens: 1500
};
const call = (id: string, name: string, args = {}): StreamChunk => ({ type: 'call', call: { id, name, arguments: JSON.stringify(args) } });
class Mock implements Adapter {
  inputs: Message[][] = [];
  options: GenerateOptions[] = [];
  constructor(private responses: (StreamChunk[] | Error)[]) {}
  async *generate(messages: Message[], options: GenerateOptions) {
    this.inputs.push(structuredClone(messages)); this.options.push(options);
    const response = this.responses.shift();
    assert.ok(response, 'unexpected generation');
    if (response instanceof Error) throw response;
    yield* response;
  }
}
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rpg-agent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new Store(join(dir, 'session.json')), rules: new Rules(join(dir, 'rules.json')) };
}
const output = { text: (_text: string) => {}, notice: (_text: string) => {} };
const startArgs = { monsterId: 'drowner', monsterObjectId: 'enemy-1', scene: '河边', facts: [], objectives: [], environment: [], risks: [] };

function startPlayerBattle(store: Store, rules: Rules, options = { seed: 7, maxActions: 1 }) {
  const ledger = rules.adventure.status();
  const battle = rules.handoff.start(ledger.revision, { monsterId: 'drowner', ...options }, {
    scene: '河边', facts: [], objectives: [], environment: [], risks: [],
    participants: [{ id: 'geralt', role: 'geralt' }, { id: 'enemy', role: 'monster' }],
    resources: { revision: ledger.revision, ...ledger.resources }
  });
  store.data.battleId = battle.battleId; store.save();
  return battle;
}

test('out-of-scope tool errors stay paired with the calling Agent in both directions', async t => {
  for (const owner of ['main', 'combat'] as const) {
    const { store, rules } = fixture(t);
    if (owner === 'combat') startPlayerBattle(store, rules);
    const name = owner === 'main' ? 'battle_status' : 'rules_status';
    const mock = new Mock([[call('wrong-tool', name)], [{ type: 'text', text: '请继续。' }]]);
    await new Harness(config, store, rules, output, { main: mock, combat: mock }).turn('继续');
    const nextRequest = mock.inputs[1]!;
    const response = nextRequest.find(m => m.role === 'tool' && m.callId === 'wrong-tool');
    assert.match(response!.content, /无权调用/);
    assert.ok(nextRequest.some(m => m.role === 'assistant' && m.calls?.some(c => c.id === 'wrong-tool')));
    assert.equal(store.data[owner === 'main' ? 'combat' : 'main'].filter(m => m.role === 'tool').length, 0);
  }
});

test('recovery routes denied tools to their recorded or legacy calling Agent', async t => {
  for (const recorded of [true, false]) {
    const { store, rules } = fixture(t);
    const tool = (call('wrong-tool', 'battle_status') as { type: 'call'; call: ToolCall }).call;
    store.data.main.push({ role: 'assistant', content: '', calls: [tool] });
    store.data.pending = { call: tool, revision: 0, playerAuthorized: false, ...(recorded ? { owner: 'main' as const } : {}) };
    store.save();
    const reopened = new Store(store.path); const mock = new Mock([]);
    await new Harness(config, reopened, rules, output, { main: mock, combat: mock }).recover();
    assert.match(reopened.data.main.at(-1)!.content, /无权调用/);
    assert.equal(reopened.data.combat.length, 0);
    assert.equal(reopened.data.pending, undefined);
  }
});

test('combat /retry retains an unexecuted player intent after a generation failure', async t => {
  const { store, rules } = fixture(t); const battle = startPlayerBattle(store, rules);
  const command = chooseTestCommand(rules.adventure.battleRecord().state);
  const combat = new Mock([new Error('network failed'), [call('retry-action', 'battle_act', { command })],
    [{ type: 'text', text: '交锋结束。' }]]);
  const main = new Mock([[{ type: 'text', text: '继续叙事。' }]]);
  const harness = new Harness(config, store, rules, output, { main, combat });
  await assert.rejects(harness.turn('普通剑击躯干'), /network failed/);
  assert.equal(new Store(store.path).data.playerIntent?.text, '普通剑击躯干');
  await harness.turn();
  assert.equal(rules.handoff.status(battle.battleId).view.actionCount, 1);
  assert.equal(store.data.playerIntent, undefined);
  assert.ok(!combat.inputs[2]!.some(m => m.role === 'tool' && m.content.includes('等待玩家明确选择')));
});

test('restart rebuild preserves only an unconsumed player intent for retry', async t => {
  const { store, rules } = fixture(t); const battle = startPlayerBattle(store, rules);
  const command = chooseTestCommand(rules.adventure.battleRecord().state);
  const failing = new Mock([new Error('network failed')]);
  await assert.rejects(new Harness(config, store, rules, output, { main: failing, combat: failing }).turn('普通剑击躯干'));
  const reopened = new Store(store.path);
  const combat = new Mock([[call('restart-action', 'battle_act', { command })], [{ type: 'text', text: '交锋结束。' }]]);
  const main = new Mock([[{ type: 'text', text: '继续叙事。' }]]);
  const harness = new Harness(config, reopened, rules, output, { main, combat });
  await harness.recover(); harness.rebuildCombat();
  assert.deepEqual(reopened.data.combat, [{ role: 'user', content: '普通剑击躯干' }]);
  await harness.turn();
  assert.ok(combat.inputs[0]!.some(m => m.role === 'user' && m.content === '普通剑击躯干'));
  assert.equal(rules.handoff.status(battle.battleId).view.actionCount, 1);
  assert.equal(new Store(store.path).data.playerIntent, undefined);
});

test('crashes around player tool journaling recover exactly one committed action', async t => {
  for (const stage of ['before-journal', 'before-engine', 'after-engine'] as const) {
    const { store, rules } = fixture(t); const battle = startPlayerBattle(store, rules);
    const command = chooseTestCommand(rules.adventure.battleRecord().state);
    const tool = (call('crashed-action', 'battle_act', { command }) as { type: 'call'; call: ToolCall }).call;
    store.data.playerIntent = { battleId: battle.battleId, revision: battle.revision, text: '普通剑击躯干' };
    store.data.combat.push({ role: 'user', content: '普通剑击躯干' }, { role: 'assistant', content: '', calls: [tool] });
    if (stage !== 'before-journal') {
      store.data.pending = { owner: 'combat', call: tool, revision: rules.adventure.status().revision, playerAuthorized: true };
    }
    store.save();
    if (stage === 'after-engine') rules.execute('battle_act', { command }, battle.battleId);
    const reopened = new Store(store.path); const mock = new Mock([]);
    const harness = new Harness(config, reopened, rules, output, { main: mock, combat: mock });
    await harness.recover(); await harness.recover();
    assert.equal(rules.handoff.status(battle.battleId).view.actionCount, 1, stage);
    assert.equal(reopened.data.playerIntent, undefined, stage);
    assert.equal(reopened.data.pending, undefined, stage);
    assert.equal(reopened.data.main.filter(m => m.content.includes('战斗子 Agent 的结构化结果')).length, 1, stage);
  }
});

test('retry after a committed player action cannot automatically resolve the next player decision', async t => {
  const { store, rules } = fixture(t);
  const battle = startPlayerBattle(store, rules, { seed: 1, maxActions: 20 });
  const command = chooseTestCommand(rules.adventure.battleRecord().state);
  const combat = new Mock([[call('attack', 'battle_act', { command })], new Error('network failed'),
    [call('unapproved-choice', 'battle_act', { command: { type: 'decision', choice: 'skip' } })],
    [{ type: 'text', text: '请明确选择是否喝药。' }]]);
  const harness = new Harness(config, store, rules, output, { main: combat, combat });
  await assert.rejects(harness.turn('普通剑击躯干'), /network failed/);
  assert.equal(rules.handoff.status(battle.battleId).view.pending?.kind, 'bonus_action');
  const revision = rules.adventure.status().revision;
  assert.equal(new Store(store.path).data.playerIntent, undefined);
  await harness.turn();
  assert.equal(rules.adventure.status().revision, revision);
  assert.ok(store.data.combat.some(m => m.role === 'tool' && m.callId === 'unapproved-choice' && m.content.includes('等待玩家明确选择')));
});

test('Chat Completions adapter assembles fragmented SSE tool arguments and usage', async t => {
  let received: any;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frames = [
      { choices: [{ delta: { content: '你好', tool_calls: [{ index: 0, id: 'c1', function: { name: 'roll', arguments: '{"d' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ifficulty":12}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 123, completion_tokens: 21 } }
    ].map(data => `data: ${JSON.stringify(data)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
    const bytes = Buffer.from(frames);
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const adapter = new ChatCompletionsAdapter({ ...config.providers.mock!, baseURL: `http://127.0.0.1:${address.port}/v1` });
  const chunks = [];
  for await (const chunk of adapter.generate([{ role: 'user', content: 'hello' }], { model: 'mock', maxTokens: 20 })) chunks.push(chunk);
  assert.deepEqual(chunks.filter(c => c.type === 'call'), [call('c1', 'roll', { difficulty: 12 })]);
  assert.ok(chunks.some(c => c.type === 'text' && c.text === '你好'));
  assert.ok(chunks.some(c => c.type === 'usage' && c.input === 123));
  assert.equal(received.stream_options.include_usage, true);
});

test('main calls NarrativeDice and uses the persisted authoritative result', async t => {
  const { store, rules } = fixture(t);
  const mock = new Mock([[call('r1', 'narrative_roll', { difficulty: 10 }), { type: 'usage', input: 100, output: 10 }],
    [{ type: 'text', text: '你越过了河。' }, { type: 'usage', input: 200, output: 20 }]]);
  await new Harness(config, store, rules, output, { main: mock, combat: mock }).turn('我要过河');
  assert.equal(rules.adventure.status().revision, 1);
  const tool = store.data.main.find(m => m.role === 'tool');
  assert.ok(JSON.parse(tool!.content).result);
  assert.equal(store.data.mainUsage, 220);
  assert.equal(new Store(store.path).data.main.length, 4);
});

test('battle child receives only handoff, cannot auto-select player moves, and uses fresh context', async t => {
  const { store, rules } = fixture(t);
  const main = new Mock([[call('s1', 'start_battle', startArgs)]]);
  const combat = new Mock([[call('a1', 'battle_act', { command: { type: 'action', id: 'sword:fast' } })],
    [{ type: 'text', text: '请选择行动。' }]]);
  await new Harness(config, store, rules, output, { main, combat }).turn('秘密：我曾偷走国王的信。现在遭遇水鬼。');
  assert.ok(store.data.battleId, 'battle was started');
  assert.equal(rules.handoff.status(store.data.battleId).view.actionCount, 0);
  assert.ok(!JSON.stringify(combat.inputs).includes('偷走国王'));
  assert.ok(store.data.combat.some(m => m.role === 'tool' && m.content.includes('等待玩家')));
});

test('battle handoff, saved retry and rebuild send dialogue content to Chat Completions', async t => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    res.setHeader('Content-Type', 'application/json');
    if (!request.messages.some((m: any) => m.role === 'user' && m.content)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'GenerateContentRequest.contents: contents is not specified' } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: '请选择行动。' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const combat = new ChatCompletionsAdapter({ ...config.providers.mock!, stream: false, baseURL: `http://127.0.0.1:${address.port}/v1` });
  const nonStreaming = structuredClone(config); nonStreaming.providers.mock!.stream = false;
  for (const mode of ['handoff', 'retry', 'rebuild']) {
    const { store, rules } = fixture(t);
    const main = new Mock(mode === 'handoff' ? [[call('start', 'start_battle', startArgs)]] : []);
    if (mode !== 'handoff') {
      startPlayerBattle(store, rules);
      if (mode === 'rebuild') store.data.combat.push({ role: 'assistant', content: '旧战斗上下文' });
    }
    const harness = new Harness(nonStreaming, new Store(store.path), rules, output, { main, combat });
    if (mode === 'rebuild') { harness.store.data.combat = store.data.combat; harness.rebuildCombat(); }
    const revision = rules.adventure.status().revision;
    await harness.turn(mode === 'handoff' ? '秘密：我曾偷走国王的信。现在遭遇水鬼。' : undefined);
    assert.equal(rules.handoff.status(harness.store.data.battleId).view.actionCount, 0, mode);
    assert.equal(harness.store.data.playerIntent, undefined, mode);
    assert.equal(rules.adventure.status().revision, revision + (mode === 'handoff' ? 1 : 0), mode);
    assert.ok(!JSON.stringify(requests.at(-1)).includes('偷走国王'), mode);
    assert.equal(harness.store.data.combat.filter(m => m.role === 'user').length, 0, mode);
  }
  assert.equal(requests.length, 3);
});

test('journal recovery does not repeat a committed dice roll', async t => {
  const { store, rules } = fixture(t);
  const tool = (call('r1', 'narrative_roll', { difficulty: 10 }) as { type: 'call'; call: ToolCall }).call;
  store.data.main.push({ role: 'assistant', content: '', calls: [tool] });
  store.data.pending = { call: tool, revision: 0, playerAuthorized: false }; store.save();
  rules.execute('narrative_roll', { difficulty: 10 });
  const reopened = new Store(store.path);
  const mock = new Mock([]);
  await new Harness(config, reopened, rules, output, { main: mock, combat: mock }).recover();
  assert.equal(rules.adventure.status().revision, 1);
  assert.equal(reopened.data.pending, undefined);
  assert.ok(reopened.data.main.at(-1)!.content.includes('ruleStepAlreadyCommitted'));
});

test('finished battle returns bounded truth to main once, with post-action flavor', async t => {
  const { store, rules } = fixture(t);
  const ledger = rules.adventure.status();
  const battle = rules.handoff.start(ledger.revision, { monsterId: 'drowner', seed: 7, maxActions: 1 }, {
    scene: '河边', facts: [], objectives: [], environment: [], risks: [],
    participants: [{ id: 'geralt', role: 'geralt' }, { id: 'enemy', role: 'monster' }],
    resources: { revision: ledger.revision, ...ledger.resources }
  });
  store.data.battleId = battle.battleId; store.save();
  const command = chooseTestCommand(rules.adventure.battleRecord().state);
  const combat = new Mock([[call('act-final', 'battle_act', { command })], [{ type: 'text', text: '本轮交锋结束。' }]]);
  const main = new Mock([[{ type: 'text', text: '你继续向村庄走去。' }]]);
  const harness = new Harness(config, store, rules, output, { main, combat });
  await harness.turn('执行当前合法攻击');
  assert.equal(rules.handoff.status(battle.battleId).phase, 'finished');
  assert.equal(store.data.battleId, undefined);
  assert.deepEqual(store.data.combat, []);
  const results = store.data.main.filter(m => m.content.includes('战斗子 Agent 的结构化结果'));
  assert.equal(results.length, 1);
  assert.ok(results[0]!.content.includes('本轮交锋结束'));
  assert.ok(results[0]!.content.includes('action_limit'));
  await harness.recover();
  assert.equal(store.data.main.filter(m => m.content.includes('战斗子 Agent 的结构化结果')).length, 1);
});

test('API usage triggers compaction before next main request, missing usage switches later requests', async t => {
  const { store, rules } = fixture(t);
  store.data.main = [{ role: 'user', content: 'A prior scene with a river and village. '.repeat(1600) },
    { role: 'assistant', content: '现在到了河边。' }];
  store.data.mainUsage = 26000;
  const memo = { currentSituation: '河边', necessaryFacts: '村庄在对岸', unfinishedActionsAndIntent: '准备过河' };
  const mock = new Mock([[{ type: 'text', text: JSON.stringify(memo) }],
    [{ type: 'text', text: '你站在河边。' }], [{ type: 'text', text: '你查看河水。' }]]);
  const harness = new Harness(config, store, rules, output, { main: mock, combat: mock });
  await harness.turn('继续');
  assert.deepEqual(store.data.memo, memo);
  assert.equal(mock.options[0]!.stream, false);
  assert.equal(mock.options[1]!.stream, true);
  assert.equal(store.data.streamWithoutUsage, true);
  await harness.turn('查看河水');
  assert.equal(mock.options[2]!.stream, false);
  assert.equal(store.data.mainUsage, undefined);
});

test('Provider can disable streaming without affecting the shared Adapter contract', async t => {
  const { store, rules } = fixture(t);
  const configured = structuredClone(config); configured.providers.mock!.stream = false;
  const mock = new Mock([[{ type: 'text', text: '冒险开始。' }, { type: 'usage', input: 100, output: 5 }]]);
  await new Harness(configured, store, rules, output, { main: mock, combat: mock }).turn('开始');
  assert.equal(mock.options[0]!.stream, false);
  assert.equal(store.data.mainUsage, 105);
});

test('compact retains complete recent tool pairs and strictly reduces old state', async () => {
  const messages: Message[] = [
    { role: 'user', content: '旧情节细节'.repeat(700) },
    { role: 'assistant', content: '回复'.repeat(300) },
    { role: 'assistant', content: '', calls: [{ id: 'recent', name: 'rules_status', arguments: '{}' }] },
    { role: 'tool', callId: 'recent', content: '{"hope":2}' },
    { role: 'user', content: '继续' }
  ];
  const memo = { currentSituation: '河边', necessaryFacts: '遇到水鬼', unfinishedActionsAndIntent: '等待玩家选择' };
  const mock = new Mock([[{ type: 'text', text: JSON.stringify(memo) }]]);
  const result = await compact(mock, 'mock', emptyMemo(), messages, 100, 32768);
  assert.deepEqual(result.messages, messages.slice(2));
  assert.deepEqual(result.memo, memo);
  assert.ok(tokens(result.memo) < tokens({ memo: emptyMemo(), messages: messages.slice(0, 2) }) * 0.5);
  assert.ok(!JSON.stringify(mock.inputs).includes('tool_call_id'));
});

test('two invalid summaries retain original saved context', async t => {
  const { store, rules } = fixture(t);
  store.data.main = [{ role: 'user', content: '旧历史'.repeat(4000) }, { role: 'user', content: '最近' }];
  store.save(); const before = structuredClone(store.data);
  const mock = new Mock([[{ type: 'text', text: 'invalid' }], [{ type: 'text', text: '{}' }]]);
  await assert.rejects(new Harness(config, store, rules, output, { main: mock, combat: mock }).compactMain(), /二次压缩/);
  assert.deepEqual(new Store(store.path).data, before);
  assert.equal(mock.inputs.length, 2);
});

test('settlement is bounded and next battle preserves supported character fields', t => {
  const { rules } = fixture(t);
  const started = rules.execute('start_battle', startArgs) as { battleId: string };
  for (let i = 0; i < 600; i++) {
    const record = rules.adventure.battleRecord(started.battleId);
    if (record.state.outcome) break;
    rules.handoff.act(started.battleId, record.revision, chooseTestCommand(record.state));
  }
  assert.equal(rules.handoff.status(started.battleId).phase, 'finished');
  const result = rules.settlement(started.battleId, 1500, '风味'.repeat(10000));
  assert.ok(tokens(result) <= 1500);
  assert.throws(() => rules.settlement(started.battleId, 1), /超过预算/);
  const previous = rules.latestCharacter()!;
  if (!previous.dead && previous.hp > 0) {
    const next = rules.execute('start_battle', { ...startArgs, monsterObjectId: 'enemy-2' }) as { battleId: string };
    const actor = rules.adventure.battleRecord(next.battleId).state.combatants.geralt;
    assert.equal(actor.hp, previous.hp);
    assert.equal(actor.armor, previous.armor);
    assert.deepEqual(actor.potions, previous.potions);
  } else assert.throws(() => rules.execute('start_battle', startArgs), /不能.*复活/);
});

test('init reads the existing source format and keeps routing separate from credentials', t => {
  const { dir } = fixture(t);
  const source = join(dir, 'api.txt'); const destination = join(dir, 'config.json');
  writeFileSync(source, 'local：\r\nbaseURL: http://localhost:8317/v1\r\napiKey： test-secret\r\nmodels:\r\n - id: mock\r\n\r\ndeepseek:\r\nbase_url (OpenAI):https://example.com\r\nmodel:\r\nother\r\napiKey: test-two\r\n');
  initConfig(source, destination); const result = loadConfig(destination);
  assert.equal(result.providers.local!.defaultModel, 'mock');
  assert.equal(result.providers.deepseek!.defaultModel, 'other');
  assert.equal(result.main.provider, 'local');
  assert.throws(() => initConfig(source, destination), /不覆盖/);
});
