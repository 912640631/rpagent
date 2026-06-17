import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type Rule = Record<string, any>;
export interface CombatData extends Rule {
  global: Rule;
  actors: Record<string, Rule>;
}

const dataUrl = new URL('../data/combat.json', import.meta.url);
const dataText = readFileSync(dataUrl, 'utf8');
export const dataRevision = createHash('sha256').update(dataText).digest('hex');
export const combatData = JSON.parse(dataText) as CombatData;
export const monsterIds = Object.keys(combatData.actors).filter(id => id !== 'geralt');

const actionEffectTypes = new Set([
  'apply_status', 'heal_hp', 'grant_next_attack_modifier_die', 'grant_temporary_stat_modifier',
  'clear_status', 'grant_counter_effect', 'grant_immunity', 'restore_resource',
  'interrupt_prepared_action', 'override_applied_status_stacks', 'increase_damage_rank',
  'grant_temporary_check_modifier', 'reduce_damage_rank', 'remove_self'
]);
const partEffectTypes = new Set([
  'modifier', 'death', 'tagged_action_modifier_die', 'tagged_attack_modifier_die',
  'disable_tagged_actions', 'disable_action', 'reduce_status_effect'
]);
const traitEffectTypes = new Set([
  'vs_sign_defense_modifier', 'suppress_positive_rule_modifier_dice_from_tagged_ability',
  'immunity', 'on_hit_by_sign', 'increase_incoming_damage_rank_if', 'modifier',
  'suppress_tagged_trait_effect', 'on_owner_full_action_end', 'suppress_action',
  'reduce_incoming_damage_rank_if', 'on_death_if_not_status', 'while_tag_disabled',
  'conditional_check_modifier', 'conditional_check_modifier_die', 'allied_trait_modifier',
  'allied_monster_modifier', 'conditional_modifier'
]);
const statusIds = new Set(['burning', 'poisoned', 'bleeding', 'unbalanced', 'hesitant', 'blinded', 'spined']);
const signIds = new Set(['aard', 'igni', 'yrden', 'quen', 'axii']);
const allyConditions = new Set([
  'another_allied_pack_hunter_present', 'two_or_more_allied_nekkers_present',
  'another_allied_insectoid_present'
]);

function assertKnownKeys(value: Rule, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unmapped field ${path}.${key}`);
  }
}

function assertEffects(effects: unknown, allowed: Set<string>, path: string): void {
  if (effects === undefined || effects === null) return;
  if (!Array.isArray(effects)) throw new Error(`${path} must be an array`);
  for (let i = 0; i < effects.length; i++) {
    const effect = effects[i] as Rule;
    if (!effect || typeof effect.type !== 'string' || !allowed.has(effect.type)) {
      throw new Error(`Unsupported effect ${path}[${i}]: ${String(effect?.type)}`);
    }
    if (effect.type === 'on_hit_by_sign') {
      assertEffects(effect.effects ?? (effect.effect ? [effect.effect] : []), new Set([
        'temporarily_disable_tagged_actions', 'clear_status', 'temporarily_disable_action'
      ]), `${path}[${i}].effects`);
    }
    if (effect.type === 'on_owner_full_action_end') {
      assertEffects([effect.effect], actionEffectTypes, `${path}[${i}].effect`);
    }
    if (effect.type === 'on_death_if_not_status') {
      if (effect.effect?.type !== 'area_damage' || effect.effect.target_scope !== 'all_other_actors') {
        throw new Error(`Unsupported death effect at ${path}[${i}]`);
      }
    }
    if (effect.type === 'apply_status' && !statusIds.has(effect.status)) {
      throw new Error(`Unknown status at ${path}[${i}]: ${effect.status}`);
    }
    if (effect.type === 'conditional_check_modifier' || effect.type === 'conditional_check_modifier_die') {
      if (!allyConditions.has(effect.condition)) throw new Error(`Unknown ally condition at ${path}[${i}]`);
    }
    if (effect.type === 'conditional_modifier' && effect.condition !== 'hp_at_or_below_half') {
      throw new Error(`Unknown condition at ${path}[${i}]`);
    }
    if (effect.type === 'immunity' && effect.scope !== 'fear_or_morale') {
      throw new Error(`Unknown immunity scope at ${path}[${i}]`);
    }
  }
}

export function validateCombatData(data: CombatData = combatData): void {
  if (data.meta?.schema_version !== '1.0.0') throw new Error('Unsupported data version');
  if (!data.actors.geralt) throw new Error('Geralt template missing');
  if (!data.global.armor || !data.global.damage_rank || !data.global.statuses) throw new Error('Missing global mechanics');
  const families = data.global.status_families;
  if (!families?.persistent_damage || Object.keys(families).some(id => id !== 'persistent_damage')) {
    throw new Error('Unsupported status families');
  }
  const persistentDamage = families.persistent_damage;
  assertKnownKeys(persistentDamage, ['classification', 'decrement_per_action', 'ends_at_counter'], 'status_families.persistent_damage');
  if (!Number.isSafeInteger(persistentDamage.decrement_per_action) || persistentDamage.decrement_per_action < 1 ||
    persistentDamage.ends_at_counter !== 0 || persistentDamage.classification !== 'special_persistent_damage') {
    throw new Error('Invalid persistent damage family');
  }
  for (const [id, status] of Object.entries<Rule>(data.global.statuses)) {
    if (!statusIds.has(id)) throw new Error(`Unsupported status definition: ${id}`);
    if (status.family === undefined) continue;
    if (status.family !== 'persistent_damage' || status.counter !== 'stacks' ||
      !Number.isSafeInteger(status.damage_per_action) || status.damage_per_action < 1 ||
      status.on_owner_full_action_end !== undefined || status.ends_at_counter !== undefined) {
      throw new Error(`Invalid persistent damage status: ${id}`);
    }
  }
  for (const id of Object.keys(data.global.signs)) if (!signIds.has(id)) throw new Error(`Unsupported sign definition: ${id}`);
  const expected = new Set(['geralt', ...monsterIds]);
  for (const [id, actor] of Object.entries(data.actors)) {
    if (!expected.has(id) || actor.id !== id) throw new Error(`Invalid actor id: ${id}`);
    if (!actor.stats?.hp || !actor.stats?.damage_thresholds) throw new Error(`Missing stats: ${id}`);
    for (const [attackId, attack] of Object.entries<Rule>(actor.attacks ?? {})) {
      assertKnownKeys(attack, ['name_zh', 'cost', 'damage', 'narrative_forms', 'narrative_forms_have_distinct_mechanics',
        'allow_other_body_appropriate_forms', 'tags', 'check_modifier_die', 'on_hit', 'on_miss'], `${id}.attacks.${attackId}`);
      assertEffects(attack.on_hit, actionEffectTypes, `${id}.attacks.${attackId}.on_hit`);
      assertEffects(attack.on_miss, actionEffectTypes, `${id}.attacks.${attackId}.on_miss`);
      for (const effect of asArray(attack.on_miss)) if (effect.target !== 'self' && effect.target !== 'player') {
        throw new Error(`Miss effect target required at ${id}.attacks.${attackId}`);
      }
      if (attack.damage !== null && attack.damage !== undefined && typeof attack.damage !== 'string') {
        throw new Error(`Invalid damage at ${id}.attacks.${attackId}`);
      }
    }
    for (const [actionId, action] of Object.entries<Rule>(actor.actions ?? {})) {
      assertKnownKeys(action, ['name_zh', 'cost', 'tags', 'check', 'when_uncertain_check', 'on_success', 'effects'], `${id}.actions.${actionId}`);
      assertEffects(action.effects, actionEffectTypes, `${id}.actions.${actionId}.effects`);
      assertEffects(action.on_success, actionEffectTypes, `${id}.actions.${actionId}.on_success`);
      if (action.check && action.check.type !== 'monster_d20') throw new Error(`Unsupported check at ${id}.actions.${actionId}`);
      if (action.when_uncertain_check && action.when_uncertain_check.type !== 'monster_fixed_difficulty') {
        throw new Error(`Unsupported check at ${id}.actions.${actionId}`);
      }
    }
    for (const [traitId, trait] of Object.entries<Rule>(actor.traits ?? {})) {
      assertKnownKeys(trait, ['name_zh', 'effects', 'immunities', 'while_affected_by', 'does_not'], `${id}.traits.${traitId}`);
      assertEffects(trait.effects, traitEffectTypes, `${id}.traits.${traitId}.effects`);
    }
    for (const [partId, part] of Object.entries<Rule>(actor.parts ?? {})) {
      assertKnownKeys(part, ['name_zh', 'grouped_part', 'attack_modifier', 'damage_multiplier', 'trauma_track', 'effects'], `${id}.parts.${partId}`);
      for (const stage of ['light', 'heavy', 'destroyed']) {
        assertEffects(part.effects?.[stage], partEffectTypes, `${id}.parts.${partId}.${stage}`);
      }
    }
  }
  for (const [id, sign] of Object.entries<Rule>(data.global.signs)) {
    if (id === 'aard') {
      for (const choice of sign.on_success.choices) assertEffects(choice.effects, actionEffectTypes, `sign.${id}.${choice.id}`);
    } else {
      assertEffects(Array.isArray(sign.on_success) ? sign.on_success : undefined, actionEffectTypes, `sign.${id}.on_success`);
    }
    assertEffects(Array.isArray(sign.on_hit) ? sign.on_hit : undefined, actionEffectTypes, `sign.${id}.on_hit`);
    assertEffects(Array.isArray(sign.on_critical) ? sign.on_critical : undefined, actionEffectTypes, `sign.${id}.on_critical`);
  }
  for (const [id, potion] of Object.entries<Rule>(data.global.potions)) {
    assertEffects(potion.apply, actionEffectTypes, `potion.${id}`);
  }
}

function asArray(value: unknown): Rule[] {
  return Array.isArray(value) ? value as Rule[] : [];
}
