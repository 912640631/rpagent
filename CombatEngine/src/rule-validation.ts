import type { ActionEffect, PartEffect, TraitEffect } from './rule-types.js';

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown, path: string) => void;
type Fields = Record<string, Check>;
export function record(value: unknown, path: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as ObjectValue;
}
const scalar = (type: string): Check => (value, path) => {
  if (typeof value !== type || type === 'number' && !Number.isFinite(value)) throw new Error(`Invalid ${path}: expected ${type}`);
};
export const text = scalar('string'), number = scalar('number'), boolean = scalar('boolean');
const integer: Check = (value, path) => { number(value, path); if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${path}: expected nonnegative integer`); };
export const oneOf = (...values: unknown[]): Check => (value, path) => { if (!values.includes(value)) throw new Error(`Invalid ${path}`); };
export const array = (check: Check): Check => (value, path) => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  value.forEach((item, i) => check(item, `${path}[${i}]`));
};
export const object = (fields: Fields, allowExtra = false): Check => (value, path) => {
  const row = record(value, path);
  for (const [field, check] of Object.entries(fields)) {
    const optional = field.endsWith('?'), key = optional ? field.slice(0, -1) : field;
    if (optional && row[key] === undefined) continue;
    check(row[key], `${path}.${key}`);
  }
  if (!allowExtra) for (const key of Object.keys(row)) {
    if (!Object.hasOwn(fields, key) && !Object.hasOwn(fields, `${key}?`)) throw new Error(`Unmapped field ${path}.${key}`);
  }
};
export const dictionary = (check: Check): Check => (value, path) => {
  for (const [key, item] of Object.entries(record(value, path))) check(item, `${path}.${key}`);
};
const status = oneOf('burning', 'poisoned', 'bleeding', 'unbalanced', 'hesitant', 'blinded', 'spined');
const sign = oneOf('aard', 'igni', 'yrden', 'quen', 'axii');
const stat = oneOf('defense', 'attack_check');
const ally = oneOf('another_allied_pack_hunter_present', 'two_or_more_allied_nekkers_present', 'another_allied_insectoid_present');
const duration: Check = (value, path) => {
  const row = record(value, path);
  if (row.type === 'until_next_attack') object({ type: oneOf('until_next_attack') })(value, path);
  else object({ type: oneOf('actor_completed_full_actions_after_apply', 'owner_completed_full_actions_after_apply', 'target_completed_full_actions_after_apply', 'caster_completed_full_actions_after_apply'), count: integer })(value, path);
};
const formula: Check = (value, path) => {
  text(value, path);
  if (!/^-?\d+d\d+(?:[+-]\d+(?:d\d+)?)*$/.test(String(value))) throw new Error(`Invalid dice formula ${path}`);
};
const actionFields = {
  apply_status: { status, stacks: integer }, heal_hp: { amount: integer, cap: oneOf('max_hp') },
  grant_next_attack_modifier_die: { value: formula },
  grant_temporary_stat_modifier: { stat, value: number, duration },
  clear_status: { status }, grant_counter_effect: { effect: oneOf('thunderbolt'), uses: integer },
  grant_immunity: { status, duration }, restore_resource: { resource: oneOf('sign_points'), amount: integer, cap: oneOf('max') },
  interrupt_prepared_action: {}, override_applied_status_stacks: { status, stacks: integer },
  increase_damage_rank: { steps: integer }, reduce_damage_rank: { steps: integer }, remove_self: {},
  grant_temporary_check_modifier: { target_scope: oneOf('same_target_hostile_checks'), modifier_die: formula, uses: integer, expires: oneOf('battle_end_or_uses_exhausted') }
} satisfies Record<ActionEffect['type'], Fields>;
const partFields = {
  modifier: { stat, value: number }, death: {}, tagged_action_modifier_die: { tag: text, value: formula },
  tagged_attack_modifier_die: { tag: text, value: formula }, disable_tagged_actions: { tag: text },
  disable_action: { action: text }, reduce_status_effect: { status, remaining_uses: integer }
} satisfies Record<PartEffect['type'], Fields>;
const signHitFields: Record<string, Fields> = {
  clear_status: { status }, temporarily_disable_tagged_actions: { tag: text, until: oneOf('owner_completed_next_full_action') },
  temporarily_disable_action: { action: text, until: oneOf('owner_completed_next_full_action') }
};
function effect(fields: Record<string, Fields>, target = false): Check {
  return (value, path) => {
    const row = record(value, path);
    if (typeof row.type !== 'string' || !Object.hasOwn(fields, row.type)) throw new Error(`Unsupported effect ${path}: ${String(row.type)}`);
    object({ type: oneOf(row.type), ...fields[row.type], ...(target ? { 'target?': oneOf('self', 'player') } : {}) })(value, path);
  };
}
export const actionEffect = effect(actionFields, true), partEffect = effect(partFields);
const traitFields = {
  vs_sign_defense_modifier: { sign, value: number }, suppress_positive_rule_modifier_dice_from_tagged_ability: { tag: text },
  immunity: { scope: oneOf('fear_or_morale') },
  on_hit_by_sign: { sign, 'effect?': effect(signHitFields), 'effects?': array(effect(signHitFields)) },
  increase_incoming_damage_rank_if: { condition: object({ damage_type: oneOf('fire') }), steps: integer },
  modifier: { stat, value: number, 'tag?': text }, suppress_tagged_trait_effect: { tag: text },
  on_owner_full_action_end: { 'if_not_status_any?': array(status), effect: actionEffect },
  suppress_action: { action: text, 'while_status_or_effect?': text },
  reduce_incoming_damage_rank_if: { condition: object({ final_roll_below: number }), steps: integer },
  on_death_if_not_status: { status, effect: object({ type: oneOf('area_damage'), damage: formula, target_scope: oneOf('all_other_actors'), can_chain_trigger_same_trait: boolean }) },
  while_tag_disabled: { tag: text, modifiers: array(object({ stat, value: number })) },
  conditional_check_modifier: { condition: ally, stat, value: number },
  conditional_check_modifier_die: { condition: ally, value: formula, max_from_trait_per_check: formula },
  allied_trait_modifier: { target_trait: text, stat, value: number }, allied_monster_modifier: { target_monster_id: text, stat, value: number },
  conditional_modifier: { condition: oneOf('hp_at_or_below_half'), stat, value: number }
} satisfies Record<TraitEffect['type'], Fields>;
export const traitEffect: Check = (value, path) => {
  effect(traitFields)(value, path);
  const row = record(value, path);
  if (row.type === 'on_hit_by_sign' && (row.effect === undefined) === (row.effects === undefined)) throw new Error(`Invalid ${path}: exactly one of effect/effects required`);
};
const statusEffect = effect({
  check_modifier_die: { value: formula, 'max_from_status_per_action?': formula },
  attacker_check_modifier_die: { value: formula, 'max_from_status_per_check?': formula },
  decrement_counter: { amount: integer }, direct_hp_loss: { amount: integer },
  direct_hp_loss_to_attacker: { amount: integer, classification: text }
});
export const attack = object({
  name_zh: text, 'cost?': dictionary(integer), 'damage?': (v, p) => { if (v !== null) formula(v, p); },
  'attack_modifier?': number, 'tags?': array(text), 'check_modifier_die?': formula,
  'on_hit?': array(actionEffect), 'on_miss?': array(actionEffect), 'narrative_forms?': array(text),
  'narrative_forms_have_distinct_mechanics?': boolean, 'allow_other_body_appropriate_forms?': boolean
});
export const monsterAction = object({
  name_zh: text, 'cost?': dictionary(integer), 'tags?': array(text),
  'check?': object({ type: oneOf('monster_d20'), target: oneOf('player_defense') }),
  'when_uncertain_check?': object({ type: oneOf('monster_fixed_difficulty'), difficulty: number }),
  'effects?': array(actionEffect), 'on_success?': array(actionEffect)
});
export const trait = object({ name_zh: text, 'effects?': array(traitEffect), 'immunities?': array(text), 'while_affected_by?': text, 'does_not?': array(text) });
export const part = object({ name_zh: text, 'grouped_part?': boolean, attack_modifier: number, damage_multiplier: number, trauma_track: boolean,
  'effects?': object({ 'light?': array(partEffect), 'heavy?': array(partEffect), 'destroyed?': array(partEffect) }) });
export const statusRule = object({
  name_zh: text, 'family?': oneOf('persistent_damage'), counter: oneOf('stacks', 'remaining_uses'),
  reapply: object({ mode: oneOf('keep_higher', 'add_remaining', 'no_stack') }), 'damage_per_action?': integer, 'ends_at_counter?': integer,
  'clear_action?': object({ type: oneOf('no_check_full_action'), name_zh: text }), 'modifiers?': array(object({ scope: text, value: number })),
  'while_taking_full_action?': object({ 'forbid?': array(text), if_check_required: array(statusEffect) }),
  'on_incoming_hostile_check?': array(statusEffect), 'on_incoming_melee_hit?': array(statusEffect), 'on_owner_full_action_end?': array(statusEffect)
});
const signBase = { name_zh: text, cost: object({ sign_points: integer }), 'is_attack?': boolean, 'part_targeting?': boolean };
const hostile = object({ type: oneOf('player_hostile') });
const fixed = object({ type: oneOf('fixed_difficulty'), difficulty: number });
export const signs = object({
  aard: object({ ...signBase, check: hostile, damage: oneOf(null), on_success: object({ mode: oneOf('choose_one'), choices: array(object({ id: text, effects: array(actionEffect) })) }), on_critical: object({ mode: oneOf('apply_all_success_choices') }) }),
  igni: object({ ...signBase, check: hostile, damage: object({ formula, damage_type: oneOf('fire') }), on_hit: array(actionEffect), on_critical: array(actionEffect) }),
  yrden: object({ ...signBase, check: fixed, duration, modifiers: array(object({ stat, value: number })), target_count: integer, restrictions: array(text), ghosts_become_normally_attackable: boolean, max_simultaneous_instances: integer }),
  quen: object({ ...signBase, check: fixed, creates: text, duration_end_any: (value, path) => {
    if (!Array.isArray(value) || value.length !== 2) throw new Error(`Invalid ${path}`);
    object({ type: oneOf('incoming_damage_would_lose_hp_before_quen') })(value[0], `${path}[0]`);
    object({ type: oneOf('caster_completed_full_actions_after_apply'), count: integer })(value[1], `${path}[1]`);
  }, on_trigger: array(actionEffect) }),
  axii: object({ ...signBase, check: hostile, on_success: array(actionEffect), on_critical: array(actionEffect), mental_resistance: object({ trait_id: text, target_defense_modifier: number }) })
});
export const potions = dictionary(object({ name_zh: text, toxicity: integer, apply: array(actionEffect),
  'effect?': object({ trigger: text, damage_modifier: formula, consume_on_check_even_on_miss: boolean, expires_on_battle_end: boolean }), 'cannot_restore?': array(text) }));
const resource = object({ current: integer, max: integer });
export const actor = object({
  id: text, name_zh: text, kind: text, 'difficulty?': integer, 'monster_type?': text,
  stats: object({ defense: number, hp: resource, damage_thresholds: object({ heavy: number, severe: number }), 'base_attack_modifier?': number, 'armor?': (v, p) => { if (v !== null) resource(v, p); }, 'sign_points?': resource, 'toxicity?': resource }),
  'state?': object({ 'quen_active?': boolean, 'statuses?': array((value, path) => { if (typeof value === 'string') text(value, path); else object({ id: text, 'stacks?': integer })(value, path); }) }),
  'attacks?': dictionary(attack), 'actions?': dictionary(monsterAction), 'traits?': dictionary(trait), 'parts?': dictionary(part), 'parts_initial_trauma?': dictionary(integer),
  'weapons?': object({ silver_sword: object({ name_zh: text, attacks: dictionary(attack) }) }), 'inventory?': object({ potions: array(text) })
});
