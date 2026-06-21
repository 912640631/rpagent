import assert from 'node:assert/strict';
import test from 'node:test';
import { combatData, monsterIds, parseCombatData, validateCombatData } from '../src/data.js';
import type { TimedEffect } from '../src/types.js';

test('typed data entry accepts every current monster without altering rule data', () => {
  const value: unknown = JSON.parse(JSON.stringify(combatData));
  const parsed = parseCombatData(value);
  assert.deepEqual(parsed, combatData);
  assert.equal(Object.keys(parsed.actors).length, monsterIds.length + 1);
});
const badActionEffects = [
  { type: 'apply_status', stacks: 1 }, { type: 'apply_status', status: 'unknown', stacks: 1 },
  { type: 'grant_immunity', status: 'poisoned' },
  { type: 'grant_immunity', status: 'poisoned', duration: { type: 'until_next_attack', count: 1 } },
  { type: 'grant_temporary_stat_modifier', stat: 'defense', duration: { type: 'until_next_attack' } },
  { type: 'heal_hp', amount: '2', cap: 'max_hp' },
  { type: 'heal_hp', amount: 2, cap: 'max_hp', status: 'poisoned' },
  { type: 'grant_counter_effect', effect: 'not_supported', uses: 3 },
  { type: 'restore_resource', resource: 'armor', amount: 2, cap: 'max' },
  { type: 'grant_next_attack_modifier_die', value: 'garbage' },
  { type: 'apply_status', status: 'burning', stacks: 1, target: 'someone' }
];
for (const effect of badActionEffects) test(`invalid action effect is rejected at input: ${JSON.stringify(effect)}`, () => {
  const data = structuredClone(combatData);
  Reflect.set(data.global.potions.swallow!, 'apply', [effect]);
  assert.throws(() => validateCombatData(data));
});
test('invalid trait, nested sign-hit and part fields are rejected', () => {
  for (const effect of [
    { type: 'modifier', stat: 'defense' },
    { type: 'on_hit_by_sign', sign: 'aard' },
    { type: 'on_hit_by_sign', sign: 'aard', effect: { type: 'temporarily_disable_action', until: 'owner_completed_next_full_action' } },
    { type: 'on_owner_full_action_end', effect: { type: 'heal_hp', cap: 'max_hp' } },
    { type: 'on_death_if_not_status', status: 'burning', effect: { type: 'area_damage', damage: '2d8', target_scope: 'someone', can_chain_trigger_same_trait: true } }
  ]) {
    const data = structuredClone(combatData);
    Reflect.set(data.actors.wolf!.traits!, 'invalid', { name_zh: 'invalid', effects: [effect] });
    assert.throws(() => validateCombatData(data));
  }
  const data = structuredClone(combatData);
  Reflect.set(data.actors.wolf!.parts!.head!, 'effects', { heavy: [{ type: 'disable_action' }] });
  assert.throws(() => validateCombatData(data));
});
test('structural failures produce validation errors before rule execution', () => {
  for (const value of [null, [], {}, { meta: { schema_version: '1.0.0' }, actors: { geralt: {} }, global: {} }]) assert.throws(() => parseCombatData(value));
});
// These examples must fail compilation if the domain constraints are accidentally weakened.
function effectTypeContracts() {
  // @ts-expect-error immunity requires a status
  const missingStatus: TimedEffect = { kind: 'immunity' };
  // @ts-expect-error stat requires a value
  const missingValue: TimedEffect = { kind: 'stat', stat: 'defense' };
  // @ts-expect-error disabled_action cannot carry an immunity status
  const wrongFields: TimedEffect = { kind: 'disabled_action', action: 'cloak', status: 'poisoned' };
  return [missingStatus, missingValue, wrongFields];
}
void effectTypeContracts;
