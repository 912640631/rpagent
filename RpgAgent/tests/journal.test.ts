import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JournalBackend, type WebSave } from '../src/web/journal.js';
import { Store } from '../src/store.js';
import { ContextCapacityError } from '../src/recovery.js';
import { Rules } from '../src/tools.js';
import type { BattleState } from 'witcher-combat-engine';
import { ScriptedModel, text, call } from './helpers/scripted-model.js';
import { temporaryAdventures } from './helpers/adventures.js';

test('1000 text chunks write bounded checkpoints and less than 2 MiB, independent of old story length', async t => {
  const { root, open } = temporaryAdventures(t, 'witcher-journal-size-');
  const model = new ScriptedModel();
  const service = open({ main: model, combat: new ScriptedModel() });
  const id = service.create('流式日志').id;
  const path = join(root, 'adventures', id, 'journal.ndjson');
  service.state(id);
  const measure = async (operation: string) => {
    const before = readFileSync(path).length;
    model.responses.push([...Array.from({ length: 1000 }, () => text('x')), { type: 'usage', input: 100, output: 1000 }]);
    service.submit(id, operation, '继续'); await service.idle(id);
    const bytes = readFileSync(path).subarray(before);
    const records = bytes.toString().trim().split('\n').map(line => JSON.parse(line));
    const checkpoints = records.filter(record => record.checkpoint);
    assert.ok(checkpoints.length <= 20, String(checkpoints.length));
    assert.ok(bytes.length < 2 * 1024 * 1024, String(bytes.length));
    assert.equal(records.filter(record => record.event?.type === 'request.chunk' && record.event.chunk.type === 'text').length, 1000);
    for (const record of checkpoints) {
      assert.ok(!('story' in record.checkpoint.web)); assert.ok(!('events' in record.checkpoint.web)); assert.ok(!('stream' in record.checkpoint.web));
    }
    return bytes.length;
  };
  const first = await measure('first');
  await service.close();
  const backend = new JournalBackend(path); const save = backend.load()!;
  const event = { id: ++save.web.sequence, adventureId: id, time: new Date().toISOString(), type: 'message.complete' as const,
    agent: 'main' as const, requestId: 'large-history', text: '过往故事'.repeat(100_000) };
  save.web.events.push(event); backend.event(event, save);
  // Keep execution context identical to the first operation: only public history grew.
  save.main = []; backend.save(save);
  const reopened = open({ main: model, combat: new ScriptedModel() });
  const before = readFileSync(path).length;
  model.responses.push([...Array.from({ length: 1000 }, () => text('x')), { type: 'usage', input: 100, output: 1000 }]);
  reopened.submit(id, 'second', '继续'); await reopened.idle(id);
  const increase = readFileSync(path).length - before;
  assert.ok(increase < first + 4096, `${first} -> ${increase}`);
  assert.ok(reopened.state(id).story.some(story => story.id === 'large-history'));
  t.diagnostic(`1000 chunks: ${first} bytes; with 1.2 MB old story: ${increase} bytes`);
});

test('opening discards only an incomplete final record; complete middle corruption is preserved and rejected', async t => {
  const { root, open } = temporaryAdventures(t, 'witcher-journal-tail-');
  const service = open(); const id = service.create('截断日志').id; await service.close();
  const path = join(root, 'adventures', id, 'journal.ndjson');
  const original = readFileSync(path);
  appendFileSync(path, '{"version":2,"kind":"checkpoint","checkpoint":');
  const reopened = open(); assert.equal(reopened.state(id).phase, 'waiting');
  assert.deepEqual(readFileSync(path), original); await reopened.close();
  appendFileSync(path, '{invalid}\nunfinished'); const corrupt = readFileSync(path);
  const rejected = open(); assert.throws(() => rejected.state(id), /中间记录损坏/);
  assert.deepEqual(readFileSync(path), corrupt);
});

test('web rejects legacy session and snapshot formats without modifying them or current rules', async t => {
  const { root, open } = temporaryAdventures(t, 'witcher-journal-legacy-');
  const service = open(); const id = service.create('旧格式检查').id;
  const before = service.state(id).rules; const snapshot = await service.save(id, '新快照');
  const snapshotPath = join(root, 'adventures', id, 'snapshots', `${snapshot.id}.json`);
  const value = JSON.parse(readFileSync(snapshotPath, 'utf8')); value.version = 1;
  writeFileSync(snapshotPath, JSON.stringify(value)); const bytes = readFileSync(snapshotPath);
  await assert.rejects(service.restore(id, snapshot.id), /快照格式/);
  assert.deepEqual(service.state(id).rules, before); assert.deepEqual(readFileSync(snapshotPath), bytes);
  await service.close();
  const legacy = join(root, 'adventures', id, 'session.json'); writeFileSync(legacy, '{"version":1,"web":{"version":1}}');
  const original = readFileSync(legacy); const log = readFileSync(join(root, 'adventures', id, 'journal.ndjson'));
  const reopened = open(); assert.throws(() => reopened.state(id), /旧网页存档/);
  assert.deepEqual(readFileSync(legacy), original); assert.deepEqual(readFileSync(join(root, 'adventures', id, 'journal.ndjson')), log);
  const replacement = reopened.create('新冒险'); await reopened.select(replacement.id);
  assert.equal(reopened.list().active, replacement.id);
});

for (const stage of ['before-tool', 'after-rule', 'partial-input', 'partial-tool-result', 'after-text']) {
  test(`crash at ${stage} recovers accepted input and commits exactly one rule action across restart`, async t => {
    const { root, open } = temporaryAdventures(t, 'witcher-journal-crash-');
    const setup = open(); const id = setup.create('执行边界').id;
    await setup.save(id, '初始化随机数'); await setup.close();
    const path = join(root, 'adventures', id, 'journal.ndjson');
    const child = spawnSync(process.execPath, ['--import', new URL('./helpers/journal-crash.ts', import.meta.url).href,
      '--import', 'tsx', fileURLToPath(new URL('./helpers/journal-worker.ts', import.meta.url)), root, id], {
      encoding: 'utf8', timeout: 15000, env: { ...process.env, WITCHER_TEST_JOURNAL: path, WITCHER_TEST_JOURNAL_STAGE: stage }
    });
    assert.equal(child.error, undefined); assert.equal(child.status, 74, child.stdout + child.stderr);
    const replies = stage === 'partial-input' || stage === 'after-text' ? [[call('narrative_roll', { difficulty: 12 })], [text('河畔恢复')]] : [[text('河畔恢复')]];
    const model = new ScriptedModel(replies); let service = open({ main: model, combat: new ScriptedModel() });
    assert.equal(service.state(id).phase, 'recovery');
    assert.equal(service.state(id).stream, undefined);
    if (stage === 'after-text') {
      await service.close(); service = open({ main: model, combat: new ScriptedModel() });
      assert.equal(service.state(id).stream, undefined, 'a second restart cannot resurrect interrupted output');
      assert.ok(service.events(id).some(event => event.type === 'request.chunk'), 'retain the raw partial output for the console');
    }
    const committed = stage === 'after-rule' || stage === 'partial-tool-result';
    assert.equal(service.state(id).rules.revision, committed ? 1 : 0);
    assert.equal(model.inputs.length, 0);
    service.submit(id, 'recovered', undefined, true); await service.idle(id);
    assert.equal(service.state(id).phase, 'waiting', service.state(id).error);
    assert.equal(service.state(id).rules.revision, 1);
    assert.equal(service.state(id).story.filter(story => story.role === 'user').length, 1);
    const state = service.state(id); await service.close();
    const twice = open({ main: new ScriptedModel(), combat: new ScriptedModel() });
    assert.deepEqual(twice.state(id).story, state.story); assert.deepEqual(twice.state(id).rules, state.rules);
    assert.equal(twice.submit(id, 'recovered', undefined, true).status, 'done');
  });
}

test('recovery policy uses typed reasons across restart, not display text', async t => {
  const { root, open } = temporaryAdventures(t, 'witcher-recovery-reason-');
  let requests = 0;
  const failing = { async *generate() { requests++; throw new Error('普通连接失败，其中包含上下文三个字'); } };
  const service = open({ main: failing, combat: failing }); const id = service.create('恢复原因').id;
  service.submit(id, 'first', '继续'); await service.idle(id); await service.close();
  const backend = new JournalBackend(join(root, 'adventures', id, 'journal.ndjson'));
  assert.equal(backend.load()!.web.recoveryReason, 'other');
  const model = new ScriptedModel([[text('普通重试成功')]]);
  const reopened = open({ main: model, combat: model }); reopened.submit(id, 'retry', undefined, true); await reopened.idle(id);
  assert.equal(reopened.state(id).phase, 'waiting'); assert.equal(model.inputs.length, 1); assert.equal(requests, 1);
  await reopened.close();
  const save = backend.load()!;
  save.main = [{ role: 'user', content: '很早的故事'.repeat(600) }, { role: 'assistant', content: '近期回复'.repeat(300) }];
  save.web.phase = 'recovery'; save.web.recoveryReason = 'main_context_capacity'; save.web.error = '容量不足'; backend.save(save);
  const compression = new ScriptedModel([[text('{"currentSituation":"河畔","necessaryFacts":"石壁","unfinishedActionsAndIntent":"继续"}')], [text('压缩后继续')]]);
  const typed = open({ main: compression, combat: compression });
  const settings = structuredClone(typed.settings.value); settings.recentTokens = 1; typed.settings.update(settings);
  typed.submit(id, 'typed-retry', undefined, true); await typed.idle(id);
  assert.equal(typed.state(id).phase, 'waiting', typed.state(id).error); assert.equal(compression.inputs.length, 2);
  assert.ok(typed.events(id).some(event => 'purpose' in event && event.purpose === 'compression'));
});

test('context capacity exceptions persist their reason even when their wording changes', async t => {
  const { root, open } = temporaryAdventures(t, 'witcher-typed-failure-');
  const failing = { async *generate() { throw new ContextCapacityError('main_context_capacity', '自定义容量错误'); } };
  const service = open({ main: failing, combat: failing }); const id = service.create('容量错误').id;
  service.submit(id, 'first', '继续'); await service.idle(id);
  const store = new Store(join(root, 'adventures', id, 'journal.ndjson'), new JournalBackend(join(root, 'adventures', id, 'journal.ndjson')));
  assert.equal((store.data as WebSave).web.recoveryReason, 'main_context_capacity');
  assert.equal(service.state(id).error, '自定义容量错误');
});

test('combat capacity recovery rebuilds only the battle context and preserves one unconsumed player intent', async t => {
  const { root, open } = temporaryAdventures(t, 'witcher-combat-capacity-');
  const failing = { async *generate() { throw new ContextCapacityError('combat_context_capacity', '容量不足'); } };
  const service = open({ main: new ScriptedModel(), combat: failing });
  const source = service.create('战斗上下文').id; const target = await service.testBattle(source, 'fiend');
  const rules = new Rules(join(root, 'adventures', target.id, 'rules.json'));
  const ruleSave = rules.exportSnapshot() as { battle: { state: BattleState; initialState: BattleState } };
  ruleSave.battle.state.seed = 1; ruleSave.battle.state.randomState = 1;
  ruleSave.battle.initialState = structuredClone(ruleSave.battle.state); rules.installSnapshot(ruleSave);
  service.submit(target.id, 'first', '普通剑攻击'); await service.idle(target.id);
  const revision = service.state(target.id).rules.revision; await service.close();
  const backend = new JournalBackend(join(root, 'adventures', target.id, 'journal.ndjson'));
  const save = backend.load()!;
  assert.equal(save.web.recoveryReason, 'combat_context_capacity');
  save.combat.push({ role: 'assistant', content: '早期战斗对话应被移除'.repeat(1000) }); backend.save(save);
  const combat = new ScriptedModel([[call('battle_act', { command: { type: 'action', id: 'sword:normal' } })], [text('战斗继续')]]);
  const reopened = open({ main: new ScriptedModel(), combat });
  reopened.submit(target.id, 'retry', undefined, true); await reopened.idle(target.id);
  assert.equal(reopened.state(target.id).phase, 'waiting', reopened.state(target.id).error);
  assert.equal(reopened.state(target.id).rules.revision, revision + 1);
  assert.ok(JSON.stringify(combat.inputs[0]).includes('普通剑攻击'));
  assert.ok(!JSON.stringify(combat.inputs[0]).includes('早期战斗对话应被移除'));
  assert.equal(backend.load()!.playerIntent, undefined);
});
