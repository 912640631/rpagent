import { JournalBackend } from '../src/web/journal.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rules } from '../src/tools.js';
import { Store } from '../src/store.js';
import { ScriptedModel, call, text } from './helpers/scripted-model.js';
import { temporaryAdventures } from './helpers/adventures.js';

for (const stage of ['restore.json', 'rules.json', 'journal.ndjson']) {
  test(`crash after replacing ${stage} restores paired story, memory and dice across two restarts`, async t => {
    const { root, open } = temporaryAdventures(t, 'witcher-restore-crash-');
    const initial = new ScriptedModel([
      [call('narrative_roll', { difficulty: 12 })], [text('保存时的河畔')],
      [call('narrative_roll', { difficulty: 12 })], [text('未保存的未来')],
    ]);
    const service = open({ main: initial, combat: new ScriptedModel() });
    const id = service.create('读档事务').id;
    service.submit(id, 'past', '抵达河畔'); await service.idle(id);
    const saved = await service.save(id, '河畔');
    const before = service.state(id);
    service.submit(id, 'future', '查看足迹'); await service.idle(id);
    const expected = service.state(id).rules;
    const expectedRoll = service.events(id).filter(e => e.type === 'tool.result').at(-1)!.result;
    await service.close();
    const directory = join(root, 'adventures', id);
    const child = spawnSync(process.execPath, [
      '--import', new URL('./helpers/restore-crash.mjs', import.meta.url).href,
      '--import', 'tsx', fileURLToPath(new URL('./helpers/restore-worker.ts', import.meta.url)), root, id, saved.id,
    ], { encoding: 'utf8', timeout: 15_000, env: { ...process.env,
      WITCHER_TEST_RESTORE_DIRECTORY: directory, WITCHER_TEST_RESTORE_EXIT_AFTER: stage } });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 73, child.stderr || child.stdout);
    const empty = new ScriptedModel();
    const recovered = open({ main: empty, combat: empty });
    assert.deepEqual(recovered.state(id).story, before.story);
    assert.deepEqual(recovered.state(id).rules, before.rules);
    assert.equal(recovered.state(id).phase, 'waiting');
    assert.equal(empty.inputs.length, 0, 'opening must not execute a model request or pending action');
    await recovered.close();
    const model = new ScriptedModel([[call('narrative_roll', { difficulty: 12 })], [text('河畔继续')]]);
    const twice = open({ main: model, combat: new ScriptedModel() });
    assert.deepEqual(twice.state(id).story, before.story);
    assert.deepEqual(twice.state(id).rules, before.rules);
    twice.submit(id, 'continued', '查看足迹'); await twice.idle(id);
    assert.equal(twice.state(id).phase, 'waiting', twice.state(id).error);
    assert.ok(JSON.stringify(model.inputs[0]).includes('保存时的河畔'));
    assert.ok(!JSON.stringify(model.inputs[0]).includes('未保存的未来'));
    assert.deepEqual(twice.events(id).filter(e => e.type === 'tool.result').at(-1)!.result, expectedRoll);
    assert.deepEqual(twice.state(id).rules, expected);
    assert.equal(twice.submit(id, 'continued', '重复提交').status, 'done');
    assert.deepEqual(twice.state(id).rules, expected);
  });
}

for (const node of ['dying', 'bonus_action'] as const) {
  test(`${node} snapshot restores pending choice, combat memory and random state before replay`, async t => {
    const { root, open } = temporaryAdventures(t, 'witcher-pending-snapshot-');
    const setup = open();
    const id = setup.create('待决快照').id;
    await setup.close();
    // Arrange a supported saved adventure through the public rules and Store APIs.
    const directory = join(root, 'adventures', id);
    const rules = new Rules(join(directory, 'rules.json'));
    const status = rules.adventure.status();
    const battle = rules.handoff.start(status.revision, { monsterId: 'fiend',
      seed: node === 'dying' ? 5635 : 1, initiative: node === 'dying' ? 'monster' : 'geralt',
      ...(node === 'dying' ? { initial: { geralt: { hp: 1, armor: 0 } } } : {}),
    }, { scene: '河畔', facts: [], objectives: [], environment: [], risks: [],
      participants: [{ id: 'geralt', role: 'geralt' }, { id: 'enemy', role: 'monster' }],
      resources: { revision: status.revision, ...status.resources } });
    const store = new Store(join(directory, 'journal.ndjson'), new JournalBackend(join(directory, 'journal.ndjson'))); store.data.battleId = battle.battleId; store.save();
    const choice = { type: 'decision', choice: node === 'dying' ? 'gamble' : 'potion:thunderbolt' };
    const decisions = () => [
      [call('battle_act', { command: choice })],
      [call('battle_act', { command: { type: 'action', id: 'sword:normal' } })],
      [text('未保存的未来选择')],
    ];
    const model = new ScriptedModel([
      [call('battle_act', { command: { type: 'action', id: node === 'dying' ? 'attack:normal' : 'sword:normal' } })],
      [text('等待保存时的玩家选择')], ...decisions(),
    ]);
    const service = open({ main: new ScriptedModel(), combat: model });
    service.submit(id, 'reach-choice', '普通攻击'); await service.idle(id);
    assert.equal(service.state(id).battle?.pending?.kind, node);
    assert.equal(service.state(id).awaiting, 'player_decision');
    const saved = await service.save(id, '选择前');
    const before = service.state(id);
    service.submit(id, 'choose', '明确选择'); await service.idle(id);
    assert.equal(service.state(id).phase, 'waiting', service.state(id).error);
    assert.equal(service.state(id).rules.revision, before.rules.revision + 1);
    assert.ok(service.events(id).some(e => e.type === 'tool.result' && JSON.stringify(e.result).includes('等待玩家明确选择')));
    const expected = { rules: service.state(id).rules, battle: service.state(id).battle };
    await service.restore(id, saved.id);
    assert.deepEqual(service.state(id).story, before.story);
    assert.deepEqual(service.state(id).battle, before.battle);
    await service.close();
    const replay = new ScriptedModel(decisions());
    const restarted = open({ main: new ScriptedModel(), combat: replay });
    assert.deepEqual(restarted.state(id).battle, before.battle);
    assert.equal(restarted.state(id).awaiting, 'player_decision');
    assert.equal(replay.inputs.length, 0, 'reading the snapshot cannot automatically consume a choice');
    restarted.submit(id, 'replay', '明确选择'); await restarted.idle(id);
    assert.equal(restarted.state(id).phase, 'waiting', restarted.state(id).error);
    assert.ok(JSON.stringify(replay.inputs[0]).includes('等待保存时的玩家选择'));
    assert.ok(!JSON.stringify(replay.inputs[0]).includes('未保存的未来选择'));
    assert.deepEqual({ rules: restarted.state(id).rules, battle: restarted.state(id).battle }, expected);
    assert.ok(restarted.events(id).some(e => e.type === 'tool.result' && JSON.stringify(e.result).includes('等待玩家明确选择')));
    assert.equal(restarted.submit(id, 'replay', '重复选择').status, 'done');
    assert.deepEqual({ rules: restarted.state(id).rules, battle: restarted.state(id).battle }, expected);
  });
}
