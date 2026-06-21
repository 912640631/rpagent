import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAdventureSession } from '../src/adventure-session.js';
import { createBattleHandoff, type BattleHandoffContext } from '../src/battle-handoff.js';

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'battle-handoff-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'adventure.json');
  const adventure = createAdventureSession(path);
  const handoff = createBattleHandoff(path);
  const context = (): BattleHandoffContext => {
    const state = adventure.status();
    return { scene: 'Forest bridge', facts: ['The bridge is damaged'],
      participants: [{ id: 'witcher-1', role: 'geralt' }, { id: 'wolf-7', role: 'monster' }],
      objectives: ['Remove the threat'], environment: ['Wet ground'], risks: ['More wolves nearby'],
      resources: { ...state.resources, revision: state.revision } };
  };
  return { directory, path, adventure, handoff, context };
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('durable context and immutable child binding survive a fresh process without advancing player decisions', t => {
  const f = fixture(t);
  const context = f.context();
  const started = f.handoff.start(0, { monsterId: 'wolf', seed: 42 }, context);
  assert.equal(started.awaiting, 'player_action');
  assert.equal(started.view.actionCount, 0);
  context.facts.push('Not committed');
  f.handoff.bindChild(started.battleId, 'child-123');
  const boundRevision = f.adventure.status().revision;
  f.handoff.bindChild(started.battleId, 'child-123');
  assert.equal(f.adventure.status().revision, boundRevision);
  assert.throws(() => f.handoff.bindChild(started.battleId, 'different-child'), code('CHILD_ALREADY_BOUND'));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    'import { createBattleHandoff } from "./src/battle-handoff.ts"; console.log(JSON.stringify(createBattleHandoff(process.env.TEST_LEDGER).status()));'],
    { cwd: new URL('../', import.meta.url), env: { ...process.env, TEST_LEDGER: f.path }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const recovered = JSON.parse(child.stdout);
  assert.equal(recovered.childSessionId, 'child-123');
  assert.equal(recovered.revision, 0);
  assert.deepEqual(recovered.context, started.context);
  // Binding changes the adventure revision, not the immutable handoff resource snapshot.
  assert.equal(recovered.context.resources.revision, 0);
  assert.deepEqual(readdirSync(f.directory), ['adventure.json']);
});

test('invalid context, resources, config and stale starts leave the ledger unchanged', t => {
  const f = fixture(t);
  const badParticipants = { ...f.context(), participants: [{ id: 'same', role: 'geralt' as const }, { id: 'same', role: 'monster' as const }] };
  assert.throws(() => f.handoff.start(0, { monsterId: 'wolf' }, badParticipants), code('INVALID_HANDOFF'));
  assert.throws(() => f.handoff.start(0, { monsterId: 'wolf' }, { ...f.context(), resources: { revision: 0, hope: 6, fear: 0 } }), code('RESOURCE_MISMATCH'));
  assert.throws(() => f.handoff.start(1, { monsterId: 'wolf' }, f.context()), code('STALE_REVISION'));
  assert.throws(() => f.handoff.start(0, { monsterId: 'missing' }, f.context()), code('INVALID_CONFIG'));
  assert.throws(() => f.handoff.start(0, { monsterId: 'wolf', hope: 2 }, f.context()), code('INVALID_CONFIG'));
  assert.equal(f.adventure.status().revision, 0);
  assert.deepEqual(readdirSync(f.directory), []);
  const old = f.context();
  f.adventure.narrativeRoll(0, { difficulty: 10 }, () => 6);
  assert.throws(() => f.handoff.start(0, { monsterId: 'wolf' }, old), code('STALE_REVISION'));
});

test('public monster commands commit once; illegal and stale commands never consume resources', t => {
  const f = fixture(t);
  const dice = [1, 12];
  f.adventure.narrativeRoll(0, { difficulty: 30 }, () => dice.shift()!);
  const started = f.handoff.start(1, { monsterId: 'wolf', seed: 42, initiative: 'monster' }, f.context());
  assert.equal(started.awaiting, 'monster_action');
  assert.throws(() => f.handoff.settlement(started.battleId), code('BATTLE_NOT_FINISHED'));
  const before = readFileSync(f.path, 'utf8');
  assert.throws(() => f.handoff.act(started.battleId, 0, { type: 'action', id: 'sword:normal' }), code('ILLEGAL_COMMAND'));
  assert.equal(readFileSync(f.path, 'utf8'), before);
  const next = f.handoff.act(started.battleId, 0, { type: 'action', id: 'attack:hamstring' });
  assert.equal(next.view.fear, 0);
  assert.equal(next.revision, 1);
  const committed = readFileSync(f.path, 'utf8');
  assert.throws(() => createBattleHandoff(f.path).act(started.battleId, 0, { type: 'action', id: 'attack:hamstring' }), code('STALE_REVISION'));
  assert.equal(readFileSync(f.path, 'utf8'), committed);
});

test('final settlement matches engine truth and remains stable through narrative rolls and later battles', t => {
  const f = fixture(t);
  const start = f.handoff.start(0, { monsterId: 'wolf', seed: 42, initial: { monster: { hp: 1 } } }, f.context());
  f.handoff.bindChild(start.battleId, 'child-wolf');
  const final = f.handoff.act(start.battleId, 0, { type: 'action', id: 'sword:normal', part: 'torso', useHopeAdvantage: true });
  assert.equal(final.phase, 'finished');
  const result = f.handoff.settlement(start.battleId, 'Everyone is alive and all potions restored!');
  const state = f.adventure.battleRecord(start.battleId).state;
  assert.equal(result.structured.outcome, state.outcome);
  assert.deepEqual(result.structured.events, state.events);
  assert.deepEqual(result.structured.resources.after, { hope: state.hope, fear: state.fear });
  assert.equal(result.structured.combatants[1]!.dead, state.combatants.monster.dead);
  assert.equal(result.structured.combatants[1]!.hp, state.combatants.monster.hp);
  assert.equal(result.structured.combatants[1]!.id, 'wolf-7');
  assert.equal(result.structured.combatants[1]!.deltas.hp, state.combatants.monster.hp - 1);
  assert.equal(result.narrativeSummary.trusted, false);
  assert.equal(result.structured.objectives[0]!.status, 'not_evaluated');
  assert.throws(() => f.handoff.act(start.battleId, 0, { type: 'action', id: 'sword:normal' }), code('STALE_REVISION'));
  assert.throws(() => f.handoff.act(start.battleId, final.revision, { type: 'action', id: 'sword:normal' }), code('BATTLE_FINISHED'));
  f.adventure.narrativeRoll(f.adventure.status().revision, { difficulty: 10 }, () => 6);
  f.handoff.start(f.adventure.status().revision, { monsterId: 'wolf', seed: 123 }, f.context());
  assert.deepEqual(createBattleHandoff(f.path).settlement(start.battleId).structured, result.structured);
  assert.equal(f.handoff.status(start.battleId).childSessionId, 'child-wolf');
  result.structured.combatants[0]!.hp = -100;
  assert.equal(f.handoff.settlement(start.battleId).structured.combatants[0]!.hp, state.combatants.geralt.hp);
});

test('dying choice remains pending across reload until the player explicitly decides', t => {
  const f = fixture(t);
  const start = f.handoff.start(0, { monsterId: 'fiend', seed: 6000, initiative: 'monster',
    initial: { geralt: { hp: 1, armor: 0 } } }, f.context());
  const hit = f.handoff.act(start.battleId, 0, { type: 'action', id: 'attack:normal' });
  assert.equal(hit.view.pending?.kind, 'dying');
  assert.equal(hit.awaiting, 'player_decision');
  const recovered = createBattleHandoff(f.path);
  assert.deepEqual(recovered.status(), hitWithoutTransientFields(hit));
  assert.throws(() => recovered.settlement(start.battleId), code('BATTLE_NOT_FINISHED'));
  const resolved = recovered.act(start.battleId, hit.revision, { type: 'decision', choice: 'survive' });
  assert.equal(resolved.view.outcome, 'geralt_incapacitated');
  assert.equal(recovered.settlement(start.battleId).structured.combatants[0]!.dead, false);
});

test('a fatal gamble identifies Geralt as dead in the returned settlement', t => {
  const f = fixture(t);
  const start = f.handoff.start(0, { monsterId: 'fiend', seed: 5632, initiative: 'monster',
    initial: { geralt: { hp: 1, armor: 0 } } }, f.context());
  const hit = f.handoff.act(start.battleId, 0, { type: 'action', id: 'attack:normal' });
  f.handoff.act(start.battleId, hit.revision, { type: 'decision', choice: 'gamble' });
  const result = createBattleHandoff(f.path).settlement(start.battleId).structured;
  assert.equal(result.outcome, 'geralt_dead');
  assert.deepEqual(result.dead, ['witcher-1']);
  assert.deepEqual(result.survivors, ['wolf-7']);
  assert.equal(result.combatants[0]!.dead, true);
});

function hitWithoutTransientFields<T extends { adventureRevision: number; events: unknown[] }>(hit: T) {
  const { adventureRevision: _revision, events: _events, ...status } = hit;
  return status;
}

test('item consumption and action-limit settlement are derived without inventing objective success', t => {
  const f = fixture(t);
  const start = f.handoff.start(0, { monsterId: 'wolf', seed: 42, maxActions: 1,
    initial: { geralt: { potions: ['swallow'], hp: 4 } } }, f.context());
  f.handoff.act(start.battleId, 0, { type: 'action', id: 'potion:swallow' });
  const result = f.handoff.settlement(start.battleId).structured;
  assert.equal(result.outcome, 'action_limit');
  assert.deepEqual(result.combatants[0]!.items.changes, [{ id: 'swallow', before: 1, after: 0, delta: -1 }]);
  assert.deepEqual(result.dead, []);
  assert.equal(result.objectives[0]!.status, 'not_evaluated');
});
