import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceBattle, createBattle, createCombatSession, type SessionSuccess } from '../src/index.js';

for (const { seed, dice, hp, outcome } of [
  { seed: 5635, dice: { hope: 3, fear: 2 }, hp: 2, outcome: null },
  { seed: 5642, dice: { hope: 8, fear: 8 }, hp: 3, outcome: null },
  { seed: 5632, dice: { hope: 4, fear: 6 }, hp: 0, outcome: 'geralt_dead' },
]) {
  test(`dying gamble ${dice.hope}:${dice.fear} restores ${hp} HP or ends in death`, () => {
    const hit = advanceBattle(createBattle({ monsterId: 'fiend', seed, initiative: 'monster',
      initial: { geralt: { hp: 1, armor: 0 } } }), { type: 'action', id: 'attack:normal' });
    assert.equal(hit.pending?.kind, 'dying');
    const result = advanceBattle(hit, { type: 'decision', choice: 'gamble' });
    assert.deepEqual(result.events.find(e => e.type === 'dying_roll')?.details, dice);
    assert.equal(result.combatants.geralt.hp, hp);
    assert.equal(result.outcome, outcome);
    assert.equal(result.pending, null);
    if (hp) assert.equal(result.initiative, 'geralt');
    else assert.equal(result.combatants.geralt.dead, true);
  });
}

test('recovering from a fatal rotfiend explosion wins when both combatants reached zero HP', () => {
  const hit = advanceBattle(createBattle({ monsterId: 'rotfiend', seed: 1,
    initial: { geralt: { hp: 1, armor: 0 }, monster: { hp: 1 } } }), { type: 'action', id: 'sword:normal' });
  assert.equal(hit.pending?.kind, 'dying');
  assert.equal(hit.combatants.monster.hp, 0);
  assert.equal(hit.combatants.geralt.hp, 0);
  const recovered = advanceBattle(hit, { type: 'decision', choice: 'gamble' });
  assert.deepEqual(recovered.events.find(e => e.type === 'dying_roll')?.details, { hope: 2, fear: 2 });
  assert.equal(recovered.combatants.geralt.hp, 3);
  assert.equal(recovered.outcome, 'geralt_won');
});

test('a reloaded dying choice is committed once and a repeated revision cannot roll again', t => {
  const root = mkdtempSync(join(tmpdir(), 'witcher-dying-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'battle.json');
  const session = createCombatSession(path);
  const start = session.start({ monsterId: 'fiend', seed: 5635, initiative: 'monster',
    initial: { geralt: { hp: 1, armor: 0 } } }) as SessionSuccess;
  const hit = session.act(start.battleId, 0, { type: 'action', id: 'attack:normal' }) as SessionSuccess;
  assert.equal(hit.view.pending?.kind, 'dying');
  const reopened = createCombatSession(path);
  const choice = { type: 'decision' as const, choice: 'gamble' };
  const recovered = reopened.act(start.battleId, hit.revision, choice) as SessionSuccess;
  assert.equal(recovered.ok, true);
  assert.equal(recovered.view.combatants.geralt.hp, 2);
  const before = reopened.view(start.battleId, true);
  const duplicate = createCombatSession(path).act(start.battleId, hit.revision, choice);
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, 'STALE_REVISION');
  assert.deepEqual(reopened.view(start.battleId, true), before);
});

for (const { potion, field, before, after } of [
  { potion: 'swallow', field: 'hp' as const, before: 2, after: 4 },
  { potion: 'swallow', field: 'hp' as const, before: 5, after: 6 },
  { potion: 'tawny_owl', field: 'signPoints' as const, before: 1, after: 3 },
  { potion: 'tawny_owl', field: 'signPoints' as const, before: 2, after: 3 },
]) {
  test(`${potion} restores ${field} from ${before} to ${after} without restoring other resources`, () => {
    const state = createBattle({ monsterId: 'fiend', initial: { geralt: { hp: 2, armor: 1, signPoints: 1, [field]: before } } });
    const result = advanceBattle(state, { type: 'action', id: `potion:${potion}` });
    assert.equal(result.combatants.geralt[field], after);
    assert.equal(result.combatants.geralt.armor, 1);
    assert.equal(result.combatants.geralt[field === 'hp' ? 'signPoints' : 'hp'], field === 'hp' ? 1 : 2);
    assert.equal(result.combatants.geralt.toxicity, 1);
    assert.ok(!result.combatants.geralt.potions.includes(potion));
  });
}

test('Thunderbolt boosts three sword checks, consumes a miss and gives no bonus to the fourth hit', () => {
  let state = advanceBattle(createBattle('fiend', 10001), { type: 'action', id: 'potion:thunderbolt' });
  const checks: { hit: unknown; uses: number; rolled?: unknown }[] = [];
  // Follow actual turns and player decisions; do not reset initiative or potion counters.
  for (let actions = 0; actions < 40 && checks.length < 4 && !state.outcome; actions++) {
    if (state.pending) { state = advanceBattle(state, { type: 'decision', choice: 'skip' }); continue; }
    const actor = state.initiative, cursor = state.events.length;
    state = advanceBattle(state, { type: 'action', id: actor === 'geralt' ? 'sword:normal' : 'attack:normal' });
    if (actor === 'geralt') {
      const events = state.events.slice(cursor);
      checks.push({ hit: events.find(e => e.type === 'check')?.details.success,
        uses: state.combatants.geralt.thunderboltUses, rolled: events.find(e => e.type === 'damage')?.details.rolled });
    }
  }
  // Independent worked seeded rolls, including the extra d6 only on the first three checks.
  assert.deepEqual(checks, [
    { hit: true, uses: 2, rolled: 18 }, { hit: true, uses: 1, rolled: 16 },
    { hit: false, uses: 0, rolled: undefined }, { hit: true, uses: 0, rolled: 12 },
  ]);
});

test('maximum toxicity lowers Geralt defense by one', () => {
  const state = createBattle({ monsterId: 'fiend', seed: 5632, initiative: 'monster', initial: { geralt: { toxicity: 3 } } });
  const result = advanceBattle(state, { type: 'action', id: 'attack:normal' });
  assert.equal(result.events.find(e => e.type === 'check')?.details.targetValue, 11);
});

test('an unaffordable potion preserves the whole state including the next random result', () => {
  const state = createBattle({ monsterId: 'fiend', seed: 10001, initial: { geralt: { toxicity: 3 } } });
  const before = structuredClone(state);
  assert.throws(() => advanceBattle(state, { type: 'action', id: 'potion:swallow' }), /Action unavailable/);
  assert.deepEqual(state, before);
  const attack = { type: 'action' as const, id: 'sword:normal' };
  assert.deepEqual(advanceBattle(state, attack), advanceBattle(before, attack));
});

for (const choice of ['survive', 'gamble']) {
  test(`battle end clears toxicity after choosing ${choice}`, () => {
    const hit = advanceBattle(createBattle({ monsterId: 'fiend', seed: 5632, initiative: 'monster',
      initial: { geralt: { hp: 1, armor: 0, toxicity: 2 } } }), { type: 'action', id: 'attack:normal' });
    const ended = advanceBattle(hit, { type: 'decision', choice });
    assert.ok(ended.outcome);
    assert.equal(ended.combatants.geralt.toxicity, 0);
  });
}
