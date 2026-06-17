import assert from 'node:assert/strict';
import test from 'node:test';
import { combatData, monsterIds, validateCombatData } from '../src/data.js';
import { advanceBattle, createBattle, getOptions } from '../src/engine.js';
import { simulateBattle } from '../src/policy.js';
import type { BattleState } from '../src/types.js';

function monsterTurn(id: string, seed = 1): BattleState {
  const state = createBattle(id, seed);
  state.initiative = 'monster';
  state.fear = 99;
  return state;
}

test('all 24 monster definitions map to supported mechanic families', () => {
  assert.equal(monsterIds.length, 24);
  assert.doesNotThrow(() => validateCombatData());
  assert.equal(combatData.actors.water_hag?.traits.wetland_hunter, undefined);
  assert.equal(combatData.actors.rotfiend?.traits.corpse_explosion.effects[0].effect.target_scope, 'all_other_actors');
});

test('every monster attack and action can be submitted and resolved', () => {
  for (const monsterId of monsterIds) {
    const template = combatData.actors[monsterId]!;
    for (const id of Object.keys(template.attacks)) {
      const state = monsterTurn(monsterId);
      state.combatants.geralt.defense = -100;
      const next = advanceBattle(state, { type: 'action', id: `attack:${id}` });
      assert(next.events.some(event => event.type === 'check'), `${monsterId}/${id} has no check`);
      assert(next.events.some(event => event.type === 'action_started' && event.details.id === `attack:${id}`));
    }
    for (const id of Object.keys(template.actions)) {
      const state = monsterTurn(monsterId);
      state.combatants.geralt.defense = -100;
      const next = advanceBattle(state, { type: 'action', id: `action:${id}` });
      assert(next.events.some(event => event.type === 'action_started' && event.details.id === `action:${id}`));
    }
  }
});

test('every targetable monster part can resolve a hit and each trauma stage', () => {
  for (const monsterId of monsterIds) {
    const parts = combatData.actors[monsterId]!.parts;
    for (const [partId, part] of Object.entries<{ trauma_track?: boolean }>(parts)) {
      const state = createBattle(monsterId, 23);
      state.combatants.monster.defense = -100;
      const hit = advanceBattle(state, { type: 'action', id: 'sword:normal', part: partId });
      assert(hit.events.some(event => event.type === 'damage' && event.details.part === partId), `${monsterId}/${partId}`);
      if (part.trauma_track) {
        for (const stage of [1, 2, 3]) {
          const staged = monsterTurn(monsterId);
          staged.combatants.monster.trauma[partId] = stage;
          assert.doesNotThrow(() => getOptions(staged), `${monsterId}/${partId}/${stage}`);
        }
      }
    }
  }
});

test('every monster completes an automatic battle, with deterministic event logs', () => {
  for (const [index, id] of monsterIds.entries()) {
    const first = simulateBattle(createBattle(id, 1000 + index, 200));
    const second = simulateBattle(createBattle(id, 1000 + index, 200));
    assert(first.outcome, `${id} did not finish`);
    assert.deepEqual(first, second, `${id} was not deterministic`);
    assert(first.actionCount <= 200);
  }
});

test('only attack hit checks accept AI advantage', () => {
  const state = createBattle('wolf', 4);
  const before = structuredClone(state);
  assert.throws(() => advanceBattle(state, { type: 'action', id: 'sign:quen', advantage: 'advantage' }), /only to attack/);
  assert.deepEqual(state, before);
  const next = advanceBattle(state, { type: 'action', id: 'sword:normal', advantage: 'advantage' });
  const check = next.events.find(event => event.type === 'check')!;
  assert.equal(check.details.advantage, 'advantage');
});

test('fear cost and destroyed body parts constrain monster options', () => {
  const state = monsterTurn('manticore_test');
  assert(getOptions(state).some(option => option.id === 'attack:diving_assault'));
  state.combatants.monster.trauma.wings = 3;
  assert(!getOptions(state).some(option => option.id === 'attack:diving_assault'));
  assert(!getOptions(state).some(option => option.id === 'action:flying_escape'));
  assert(getOptions(state).some(option => option.id === 'attack:normal'));
  state.fear = 0;
  assert(!getOptions(state).some(option => option.id === 'attack:venomous_tail_sting'));
});

test('damage rank, armor and part trauma follow the same final rank', () => {
  const state = createBattle('wild_dog', 42);
  state.combatants.monster.defense = -100;
  const next = advanceBattle(state, { type: 'action', id: 'sword:normal', part: 'legs' });
  const damage = next.events.find(event => event.type === 'damage')!;
  const trauma = next.events.find(event => event.type === 'part_trauma')!;
  assert.equal(trauma.details.after, combatData.global.part_trauma.increase_by_final_damage_rank[damage.details.rank as string]);
  assert.equal(next.combatants.monster.hp, next.combatants.monster.maxHp - combatData.global.damage_rank.hp_loss[damage.details.rank as string]);
});

test('Quen triggers only when damage would cost HP after armor', () => {
  const blocked = advanceBattle(createBattle('wolf', 1003), { type: 'action', id: 'sign:quen' });
  assert.equal(blocked.initiative, 'monster');
  const absorbed = advanceBattle(blocked, { type: 'action', id: 'attack:normal' });
  assert.equal(absorbed.combatants.geralt.hp, 6);
  assert.equal(absorbed.combatants.geralt.armor, 2);
  assert(absorbed.combatants.geralt.effects.some(effect => effect.kind === 'quen'));
  assert(!absorbed.events.some(event => event.type === 'quen_triggered'));

  const exposed = advanceBattle(createBattle('wolf', 1003), { type: 'action', id: 'sign:quen' });
  exposed.combatants.geralt.armor = 0;
  const shielded = advanceBattle(exposed, { type: 'action', id: 'attack:normal' });
  assert.equal(shielded.combatants.geralt.hp, 6);
  assert(shielded.events.some(event => event.type === 'quen_triggered'));
  assert(!shielded.combatants.geralt.effects.some(effect => effect.kind === 'quen'));

  const heavy = advanceBattle(createBattle('wolf', 1009), { type: 'action', id: 'sign:quen' });
  const reduced = advanceBattle(heavy, { type: 'action', id: 'attack:normal' });
  assert(reduced.events.some(event => event.type === 'quen_triggered'));
  assert.equal(reduced.combatants.geralt.armor, 2);
  assert(!reduced.combatants.geralt.effects.some(effect => effect.kind === 'quen'));
});

test('Geralt dying choice pauses resolution and resumes after a decision', () => {
  const state = monsterTurn('fiend', 17);
  state.combatants.geralt.hp = 1;
  state.combatants.geralt.armor = 0;
  state.combatants.geralt.defense = -100;
  const hit = advanceBattle(state, { type: 'action', id: 'attack:normal' });
  assert.equal(hit.pending?.kind, 'dying');
  assert.equal(hit.outcome, null);
  const resolved = advanceBattle(hit, { type: 'decision', choice: 'survive' });
  assert.equal(resolved.outcome, 'geralt_incapacitated');
});

test('a critical attack offers an immediate bonus potion decision', () => {
  let found: BattleState | undefined;
  for (let seed = 1; seed < 1000; seed++) {
    const state = createBattle('fiend', seed);
    state.combatants.monster.defense = -100;
    state.combatants.monster.hp = 8;
    const next = advanceBattle(state, { type: 'action', id: 'sword:normal' });
    if (next.pending?.kind === 'bonus_action') { found = next; break; }
  }
  assert(found, 'No critical seed found');
  const oldToxicity = found.combatants.geralt.toxicity;
  const next = advanceBattle(found, { type: 'decision', choice: 'potion:thunderbolt' });
  assert.equal(next.pending, null);
  assert.equal(next.combatants.geralt.toxicity, oldToxicity + 1);
  assert.equal(next.combatants.geralt.thunderboltUses, 3);
});

test('rotfiend death explosion remains active without position data', () => {
  const state = createBattle('rotfiend', 42);
  state.combatants.monster.hp = 1;
  state.combatants.monster.defense = -100;
  state.combatants.geralt.armor = 0;
  const next = advanceBattle(state, { type: 'action', id: 'sword:normal' });
  assert(next.events.some(event => event.type === 'death_effect'));
  assert(next.events.some(event => event.type === 'damage' && event.actor === 'monster'));
});

test('status immunity and status ticks are mechanically resolved', () => {
  const state = monsterTurn('manticore_test', 16);
  state.combatants.geralt.defense = -100;
  const next = advanceBattle(state, { type: 'action', id: 'attack:venomous_tail_sting' });
  assert(next.combatants.geralt.statuses.poisoned);
  const immune = createBattle('manticore_test', 1);
  immune.combatants.monster.statuses.poisoned = 2;
  immune.initiative = 'monster';
  const after = advanceBattle(immune, { type: 'action', id: 'attack:normal' });
  assert.equal(after.combatants.monster.statuses.poisoned, 1);
});

test('persistent damage statuses hurt once per owner action and expire at zero', () => {
  for (const status of ['burning', 'poisoned', 'bleeding']) {
    let state = createBattle({ monsterId: 'wolf', initiative: 'monster',
      initial: { monster: { hp: 3, statuses: { [status]: 2 } } } });
    state.combatants.geralt.defense = 100;
    for (const remaining of [1, 0]) {
      state = advanceBattle(state, { type: 'action', id: 'attack:normal' });
      assert.equal(state.combatants.monster.hp, 1 + remaining, status);
      assert.equal(state.combatants.monster.statuses[status], remaining || undefined, status);
      assert(state.events.some(event => event.type === 'status_changed' && event.details.status === status &&
        event.details.remaining === remaining), status);
      state.initiative = 'monster';
    }
    const damageEvents = state.events.filter(event => event.type === 'persistent_damage');
    assert.equal(damageEvents.length, 2, status);
    assert(damageEvents.every(event => event.details.status === status && event.details.hpLoss === 1), status);
  }
});

test('persistent damage waits for its owner and clearing prevents its next tick', () => {
  const state = createBattle({ monsterId: 'wolf', initiative: 'monster',
    initial: { geralt: { hp: 4, statuses: { bleeding: 2 } } } });
  state.combatants.geralt.defense = 100;
  const afterMonster = advanceBattle(state, { type: 'action', id: 'attack:normal' });
  assert.equal(afterMonster.combatants.geralt.hp, 4);
  assert.equal(afterMonster.combatants.geralt.statuses.bleeding, 2);
  const afterClear = advanceBattle(afterMonster, { type: 'action', id: 'clear:bleeding' });
  assert.equal(afterClear.combatants.geralt.hp, 4);
  assert.equal(afterClear.combatants.geralt.statuses.bleeding, undefined);
  assert(!afterClear.events.some(event => event.type === 'persistent_damage'));
});

test('all signs and potions are accepted through structured commands', () => {
  for (const signId of Object.keys(combatData.global.signs)) {
    const state = createBattle('wild_dog', 101);
    state.combatants.monster.defense = -100;
    const command = { type: 'action' as const, id: `sign:${signId}`, ...(signId === 'aard' ? { choice: 'unbalance' } : {}) };
    const next = advanceBattle(state, command);
    assert(next.events.some(event => event.type === 'check'), signId);
  }
  for (const potionId of Object.keys(combatData.global.potions)) {
    const state = createBattle('wild_dog', 101);
    const next = advanceBattle(state, { type: 'action', id: `potion:${potionId}` });
    assert(next.events.some(event => event.type === 'potion_drunk'), potionId);
  }
});

test('Yrden removes the noonwraith incorporeal defense bonus', () => {
  const plain = createBattle('noonwraith', 9);
  const plainCheck = advanceBattle(plain, { type: 'action', id: 'sword:normal' }).events.find(event => event.type === 'check')!;
  const affected = createBattle('noonwraith', 9);
  affected.combatants.monster.effects.push({ kind: 'yrden', remaining: 2 });
  const affectedCheck = advanceBattle(affected, { type: 'action', id: 'sword:normal' }).events.find(event => event.type === 'check')!;
  assert.equal((plainCheck.details.targetValue as number) - (affectedCheck.details.targetValue as number), 4);
});

test('Aard disables tagged flight actions until the monster finishes an action', () => {
  const state = createBattle('griffin', 2);
  state.combatants.monster.defense = -100;
  const hit = advanceBattle(state, { type: 'action', id: 'sign:aard', choice: 'unbalance' });
  const afterChoice = hit.pending?.kind === 'bonus_action'
    ? advanceBattle(hit, { type: 'decision', choice: 'skip' }) : hit;
  afterChoice.initiative = 'monster';
  afterChoice.fear = 10;
  assert(!getOptions(afterChoice).some(option => option.id === 'attack:diving_talon'));
  const afterAction = advanceBattle(afterChoice, { type: 'action', id: 'attack:normal' });
  afterAction.initiative = 'monster';
  assert(getOptions(afterAction).some(option => option.id === 'attack:diving_talon'));
});

test('werewolf regeneration is suppressed by burning active at action end', () => {
  const plain = monsterTurn('werewolf', 4);
  plain.combatants.monster.hp = 4;
  plain.combatants.geralt.defense = 100;
  const healed = advanceBattle(plain, { type: 'action', id: 'attack:normal' });
  assert.equal(healed.combatants.monster.hp, 5);
  const burning = monsterTurn('werewolf', 4);
  burning.combatants.monster.hp = 4;
  burning.combatants.monster.statuses.burning = 1;
  burning.combatants.geralt.defense = 100;
  const next = advanceBattle(burning, { type: 'action', id: 'attack:normal' });
  assert.equal(next.combatants.monster.hp, 3);
  assert.equal(next.combatants.monster.statuses.burning, undefined);
});

test('monster self-buff actions affect their owner', () => {
  const wraith = monsterTurn('noonwraith', 1);
  wraith.combatants.monster.hp = 4;
  const split = advanceBattle(wraith, { type: 'action', id: 'action:split_phantoms' });
  assert.equal(split.combatants.monster.hp, 5);
  assert.equal(split.combatants.geralt.hp, 6);
  assert(split.combatants.monster.effects.some(effect => effect.kind === 'stat' && effect.stat === 'defense'));
  assert(!split.combatants.geralt.effects.some(effect => effect.kind === 'stat' && effect.stat === 'defense'));
});

test('Golden Oriole clears poison and blocks a new application', () => {
  const state = createBattle('manticore_test', 5);
  state.combatants.geralt.statuses.poisoned = 2;
  const medicated = advanceBattle(state, { type: 'action', id: 'potion:golden_oriole' });
  assert.equal(medicated.combatants.geralt.statuses.poisoned, undefined);
  medicated.initiative = 'monster';
  medicated.fear = 10;
  medicated.combatants.geralt.defense = -100;
  const attacked = advanceBattle(medicated, { type: 'action', id: 'attack:venomous_tail_sting' });
  assert(attacked.events.some(event => event.type === 'status_immune' && event.details.status === 'poisoned'));
});

test('burning suppresses the rotfiend death explosion', () => {
  const state = createBattle('rotfiend', 42);
  state.combatants.monster.hp = 1;
  state.combatants.monster.defense = -100;
  state.combatants.monster.statuses.burning = 1;
  const next = advanceBattle(state, { type: 'action', id: 'sword:normal' });
  assert(!next.events.some(event => event.type === 'death_effect'));
});

test('burning suppresses the rotfiend explosion when its last stack deals the fatal damage', () => {
  const state = createBattle({ monsterId: 'rotfiend', seed: 42, initiative: 'monster',
    initial: { monster: { hp: 1, statuses: { burning: 1 } } } });
  const next = advanceBattle(state, { type: 'action', id: 'attack:normal' });
  assert(next.events.some(event => event.type === 'persistent_damage' && event.details.hp === 0));
  assert.equal(next.outcome, 'geralt_won');
  assert(!next.events.some(event => event.type === 'death_effect'));
  assert.equal(next.combatants.geralt.hp, 6);
});

test('rotfiend explosion remains active when burning expires before bleeding deals fatal damage', () => {
  const state = createBattle({ monsterId: 'rotfiend', seed: 42, initiative: 'monster',
    initial: { monster: { hp: 2, statuses: { burning: 1, bleeding: 1 } } } });
  const next = advanceBattle(state, { type: 'action', id: 'attack:normal' });
  const persistentDamage = next.events.filter(event => event.type === 'persistent_damage');
  const fatalDamage = persistentDamage[persistentDamage.length - 1]!;
  assert.equal(fatalDamage.details.status, 'bleeding');
  assert.equal(fatalDamage.details.hp, 0);
  assert(next.events.some(event => event.type === 'death_effect'));
});

test('tagged action trauma penalties apply to monster checks beyond attacks', () => {
  const hypnosis = createBattle({ monsterId: 'fiend', seed: 8740, initiative: 'monster', fear: 1,
    initial: { monster: { trauma: { third_eye: 2 } } } });
  const afterHypnosis = advanceBattle(hypnosis, { type: 'action', id: 'action:third_eye_hypnosis' });
  const hypnosisCheck = afterHypnosis.events.find(event => event.type === 'check')!;
  assert((hypnosisCheck.details.modifier as number) < 0);

  const escape = createBattle({ monsterId: 'manticore_test', seed: 9728, initiative: 'monster',
    initial: { monster: { trauma: { wings: 2 } } } });
  const afterEscape = advanceBattle(escape, { type: 'action', id: 'action:flying_escape' });
  const escapeCheck = afterEscape.events.find(event => event.type === 'check')!;
  assert((escapeCheck.details.modifier as number) < 0);
  assert.notEqual(afterEscape.outcome, 'monster_escaped');
});

test('attack-check trauma penalties do not affect nonattack control checks', () => {
  const state = createBattle({ monsterId: 'fiend', seed: 8740, initiative: 'monster', fear: 1,
    initial: { monster: { trauma: { forelimbs: 2 } } } });
  const next = advanceBattle(state, { type: 'action', id: 'action:third_eye_hypnosis' });
  const check = next.events.find(event => event.type === 'check')!;
  assert.equal(check.details.modifier, 0);
  assert.equal(check.details.success, true);
  assert.equal(next.combatants.geralt.statuses.hesitant, 2);
});

test('a natural 20 succeeds on a hostile monster debuff action without an attack critical', () => {
  const state = createBattle({ monsterId: 'fiend', seed: 15360, initiative: 'monster', fear: 1 });
  state.combatants.geralt.defense = 22;
  const next = advanceBattle(state, { type: 'action', id: 'action:third_eye_hypnosis' });
  const check = next.events.find(event => event.type === 'check')!;
  assert.deepEqual(check.details.dice, { d20: 20 });
  assert.equal(check.details.success, true);
  assert.equal(check.details.critical, false);
  assert.equal(next.combatants.geralt.statuses.hesitant, 2);
});

test('a natural 20 still critically succeeds on a monster debuff in the attack table', () => {
  const state = createBattle({ monsterId: 'werewolf', seed: 15360, initiative: 'monster', fear: 1 });
  state.combatants.geralt.defense = 22;
  const next = advanceBattle(state, { type: 'action', id: 'attack:feral_howl' });
  const check = next.events.find(event => event.type === 'check')!;
  assert.deepEqual(check.details.dice, { d20: 20 });
  assert.equal(check.details.success, true);
  assert.equal(check.details.critical, true);
  assert.equal(next.combatants.geralt.statuses.hesitant, 2);
});

test('fear empowerment spends each point once and modifies the attack check', () => {
  const normal = monsterTurn('wolf', 7);
  const plain = advanceBattle(normal, { type: 'action', id: 'attack:normal' });
  const empowered = monsterTurn('wolf', 7);
  const boosted = advanceBattle(empowered, { type: 'action', id: 'attack:normal', empowerHit: true, empowerDamage: true });
  assert.equal(boosted.fear, normal.fear - 2);
  assert(boosted.events.some(event => event.type === 'fear_spent' && event.details.amount === 2));
  assert.notEqual(plain.events.find(event => event.type === 'check')?.details.modifier,
    boosted.events.find(event => event.type === 'check')?.details.modifier);
});

test('unknown mechanics are rejected by the data validator', () => {
  const bad = structuredClone(combatData);
  bad.actors.wolf!.attacks.normal.on_hit = [{ type: 'silently_do_magic' }];
  assert.throws(() => validateCombatData(bad), /Unsupported effect/);
  const badFamily = structuredClone(combatData);
  badFamily.global.statuses.bleeding.family = 'never_expires';
  assert.throws(() => validateCombatData(badFamily), /Invalid persistent damage status/);
});

test('battle config supplies a validated starting snapshot', () => {
  const state = createBattle({ monsterId: 'wolf', seed: 19, initiative: 'monster', fear: 3,
    initial: { geralt: { hp: 4, signPoints: 2, statuses: { poisoned: 2 }, potions: ['swallow'] },
      monster: { hp: 2, trauma: { head: 1 } } } });
  assert.equal(state.combatants.geralt.hp, 4);
  assert.equal(state.combatants.geralt.signPoints, 2);
  assert.equal(state.combatants.monster.trauma.head, 1);
  assert.equal(state.fear, 3);
  assert.equal(state.initiative, 'monster');
  assert.throws(() => createBattle({ monsterId: 'wolf', initial: { geralt: { hp: 99 } } }), /Invalid initial/);
  assert.throws(() => createBattle({ monsterId: 'wolf', initial: { monster: { trauma: { torso: 3 } } } }), /Invalid initial/);
  assert.throws(() => createBattle({ monsterId: 'wolf', initial: { monster: { trauma: { head: 3 } } } }), /Fatal initial/);
});

test('saved battles reject a different runtime data revision', () => {
  const state = createBattle('wolf', 1);
  state.dataRevision = 'outdated';
  assert.throws(() => advanceBattle(state, { type: 'action', id: 'sword:normal' }), /data revision/);
});
