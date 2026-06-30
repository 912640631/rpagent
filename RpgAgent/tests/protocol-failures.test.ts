import { JournalBackend } from '../src/web/journal.js';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { ChatCompletionsAdapter } from '../src/adapter.js';
import { Rules } from '../src/tools.js';
import { Store } from '../src/store.js';
import type { Adapter, StreamChunk } from '../src/types.js';
import { temporaryAdventures } from './helpers/adventures.js';

const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const usage = frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
const partial = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'roll',
  function: { name: 'narrative_roll', arguments: '{"difficulty":' } }] } }] });
function completeRoll(res: ServerResponse) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'roll',
    function: { name: 'narrative_roll', arguments: '{"difficulty":12}' } }] }, finish_reason: 'tool_calls' }] }) + usage + 'data: [DONE]\n\n');
}
function completeText(res: ServerResponse) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.end(frame({ choices: [{ delta: { content: '继续旅程' }, finish_reason: 'stop' }] }) + usage + 'data: [DONE]\n\n');
}
async function upstream(t: TestContext, replies: ((res: ServerResponse) => void)[]) {
  const server = createServer(async (req, res) => {
    // Consume the real HTTP request before sending the scripted protocol response.
    for await (const _ of req) { /* drain */ }
    const reply = replies.shift();
    if (!reply) { res.writeHead(500); res.end('unexpected test request'); return; }
    reply(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}
function serviceFixture(t: TestContext, url: string) {
  const { root, open } = temporaryAdventures(t, 'witcher-wire-');
  const service = open();
  const settings = structuredClone(service.settings.value);
  settings.providers.local!.baseURL = url;
  settings.providers.local!.stream = true;
  service.settings.update(settings);
  return { service, root, open, id: service.create('协议恢复').id };
}

const failures: { name: string; reply: (res: ServerResponse, fragment: string) => void }[] = [
  { name: 'EOF before tool arguments finish', reply: (res, fragment) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(fragment); } },
  { name: 'connection reset during a tool stream', reply: (res, fragment) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(fragment, () => res.destroy());
  } },
  { name: 'upstream error frame after partial tool arguments', reply: (res, fragment) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.end(fragment + frame({ error: { message: 'upstream failed' } }));
  } },
  { name: 'malformed SSE after partial tool arguments', reply: (res, fragment) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.end(fragment + 'data: {invalid\n\n');
  } },
  { name: 'HTTP 503', reply: res => { res.writeHead(503); res.end('private upstream body'); } },
];
for (const failure of failures) {
  test(`${failure.name} preserves rules and random state; manual retry commits one complete roll`, async t => {
    const wire = await upstream(t, [res => failure.reply(res, partial), completeRoll, completeText, completeRoll, completeText]);
    const { service, id } = serviceFixture(t, wire.url);
    const snapshot = await service.save(id, '判定前');
    const before = service.state(id);
    service.submit(id, 'failed', '检查足迹'); await service.idle(id);
    assert.equal(service.state(id).phase, 'recovery');
    assert.deepEqual(service.state(id).rules, before.rules);
    assert.ok(!service.events(id).some(e => e.type === 'tool.result'));
    assert.ok(!service.state(id).error?.includes('private upstream body'));
    service.submit(id, 'retry', undefined, true); await service.idle(id);
    assert.equal(service.state(id).phase, 'waiting', service.state(id).error);
    assert.equal(service.state(id).rules.revision, before.rules.revision + 1);
    assert.equal(service.state(id).story.filter(m => m.role === 'user').length, 1);
    const results = service.events(id).filter(e => e.type === 'tool.result');
    assert.equal(results.length, 1);
    const authoritative = results[0]!.result;
    const after = service.state(id).rules;
    // Replay from the saved random state; a failed stream must not have consumed any dice.
    await service.restore(id, snapshot.id);
    service.submit(id, 'replay', '检查足迹'); await service.idle(id);
    assert.deepEqual(service.events(id).find(e => e.type === 'tool.result')?.result, authoritative);
    assert.deepEqual(service.state(id).rules, after);
  });
}

for (const failure of failures) {
  test(`battle ${failure.name} leaves the player action pending until one successful retry`, async t => {
    const completeAttack = (res: ServerResponse) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'attack', function: {
        name: 'battle_act', arguments: '{"command":{"type":"action","id":"sword:normal"}}',
      } }] }, finish_reason: 'tool_calls' }] }) + usage + 'data: [DONE]\n\n');
    };
    // The same protocol failure occurs while assembling a battle action rather than a narrative roll.
    const battlePartial = partial.replace('narrative_roll', 'battle_act').replace('difficulty', 'command');
    const wire = await upstream(t, [res => failure.reply(res, battlePartial), completeAttack, completeText, completeAttack, completeText]);
    const f = serviceFixture(t, wire.url);
    await f.service.close();
    const directory = join(f.root, 'adventures', f.id), rules = new Rules(join(directory, 'rules.json'));
    const status = rules.adventure.status();
    const battle = rules.handoff.start(status.revision, { monsterId: 'fiend', seed: 1 }, {
      scene: '河畔', facts: [], objectives: [], environment: [], risks: [],
      participants: [{ id: 'geralt', role: 'geralt' }, { id: 'enemy', role: 'monster' }],
      resources: { revision: status.revision, ...status.resources },
    });
    const store = new Store(join(directory, 'journal.ndjson'), new JournalBackend(join(directory, 'journal.ndjson'))); store.data.battleId = battle.battleId; store.save();
    const service = f.open();
    const id = f.id, saved = await service.save(id, '攻击前'), before = service.state(id);
    service.submit(id, 'failed', '普通攻击'); await service.idle(id);
    assert.equal(service.state(id).phase, 'recovery');
    assert.deepEqual(service.state(id).rules, before.rules);
    assert.deepEqual(service.state(id).battle, before.battle);
    assert.ok(!service.events(id).some(e => e.type === 'tool.result'));
    service.submit(id, 'retry', undefined, true); await service.idle(id);
    assert.equal(service.state(id).phase, 'waiting', service.state(id).error);
    assert.equal(service.state(id).battle?.actionCount, 1);
    assert.equal(service.state(id).rules.revision, before.rules.revision + 1);
    const results = service.events(id).filter(e => e.type === 'tool.result');
    assert.equal(results.length, 1);
    const expected = { rules: service.state(id).rules, battle: service.state(id).battle };
    await service.restore(id, saved.id);
    service.submit(id, 'replay', '普通攻击'); await service.idle(id);
    assert.deepEqual({ rules: service.state(id).rules, battle: service.state(id).battle }, expected);
    assert.equal(service.state(id).story.filter(m => m.role === 'user').length, 1);
    await service.close();
  });
}

test('a model request deadline enters service recovery and manual retry commits exactly once', async t => {
  const wire = await upstream(t, [res => {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(partial);
    // Keep the stream open until the Adapter signal deadline aborts its real HTTP reader.
  }, completeRoll, completeText]);
  const real = new ChatCompletionsAdapter({ protocol: 'openai-chat', baseURL: wire.url,
    defaultModel: 'local', contextTokens: 32768 });
  const bounded: Adapter = { async *generate(messages, options) {
    yield* real.generate(messages, { ...options, signal: AbortSignal.timeout(1000) });
  } };
  const { open } = temporaryAdventures(t, 'witcher-deadline-');
  const service = open({ main: bounded, combat: bounded }), id = service.create('请求超时').id;
  await service.save(id, '超时之前');
  const before = service.state(id).rules;
  service.submit(id, 'timeout', '检查足迹'); await service.idle(id);
  assert.equal(service.state(id).phase, 'recovery');
  assert.deepEqual(service.state(id).rules, before);
  assert.ok(!service.events(id).some(e => e.type === 'tool.result'));
  service.submit(id, 'retry-timeout', undefined, true); await service.idle(id);
  assert.equal(service.state(id).phase, 'waiting', service.state(id).error);
  assert.equal(service.state(id).rules.revision, before.revision + 1);
  assert.equal(service.events(id).filter(e => e.type === 'tool.result').length, 1);
  assert.equal(service.state(id).story.filter(m => m.role === 'user').length, 1);
});

test('an expired GenerateOptions signal cancels an unfinished stream without emitting a tool call', async t => {
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const wire = await upstream(t, [res => {
    res.setHeader('Content-Type', 'text/event-stream'); res.write(partial); started();
  }]);
  const adapter = new ChatCompletionsAdapter({ protocol: 'openai-chat', baseURL: wire.url,
    defaultModel: 'local', contextTokens: 32768 });
  const controller = new AbortController();
  const chunks: StreamChunk[] = [];
  const request = (async () => {
    for await (const chunk of adapter.generate([{ role: 'user', content: '检查足迹' }],
      { model: 'local', maxTokens: 32, signal: controller.signal })) chunks.push(chunk);
  })();
  // Register rejection handling before cancellation to avoid an unhandled rejection.
  const rejected = assert.rejects(request);
  await received;
  controller.abort(new DOMException('test deadline expired', 'TimeoutError'));
  await rejected;
  assert.ok(!chunks.some(chunk => chunk.type === 'call' || chunk.type === 'done'));
});
