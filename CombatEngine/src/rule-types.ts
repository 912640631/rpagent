import type { DamageRank } from './types.js';
import type rawData from '../data/combat.json';

export type StatusId = 'burning' | 'poisoned' | 'bleeding' | 'unbalanced' | 'hesitant' | 'blinded' | 'spined';
export type SignId = 'aard' | 'igni' | 'yrden' | 'quen' | 'axii';
export type Stat = 'defense' | 'attack_check';
export type Duration = { type: 'until_next_attack'; count?: never } |
  { type: 'actor_completed_full_actions_after_apply' | 'owner_completed_full_actions_after_apply' | 'target_completed_full_actions_after_apply' | 'caster_completed_full_actions_after_apply'; count: number };
type Target = { target?: 'self' | 'player' };
export type ActionEffect = Target & (
  | { type: 'apply_status'; status: StatusId; stacks: number }
  | { type: 'heal_hp'; amount: number; cap: 'max_hp' }
  | { type: 'grant_next_attack_modifier_die'; value: string }
  | { type: 'grant_temporary_stat_modifier'; stat: Stat; value: number; duration: Duration }
  | { type: 'clear_status'; status: StatusId }
  | { type: 'grant_counter_effect'; effect: 'thunderbolt'; uses: number }
  | { type: 'grant_immunity'; status: StatusId; duration: Duration }
  | { type: 'restore_resource'; resource: 'sign_points'; amount: number; cap: 'max' }
  | { type: 'interrupt_prepared_action' }
  | { type: 'override_applied_status_stacks'; status: StatusId; stacks: number }
  | { type: 'increase_damage_rank'; steps: number }
  | { type: 'grant_temporary_check_modifier'; target_scope: 'same_target_hostile_checks'; modifier_die: string; uses: number; expires: 'battle_end_or_uses_exhausted' }
  | { type: 'reduce_damage_rank'; steps: number }
  | { type: 'remove_self' }
);
export type PartEffect =
  | { type: 'modifier'; stat: Stat; value: number }
  | { type: 'death' }
  | { type: 'tagged_action_modifier_die'; tag: string; value: string }
  | { type: 'tagged_attack_modifier_die'; tag: string; value: string }
  | { type: 'disable_tagged_actions'; tag: string }
  | { type: 'disable_action'; action: string }
  | { type: 'reduce_status_effect'; status: StatusId; remaining_uses: number };
export type SignHitEffect = Extract<ActionEffect, { type: 'clear_status' }> |
  { type: 'temporarily_disable_tagged_actions'; tag: string; until: 'owner_completed_next_full_action' } |
  { type: 'temporarily_disable_action'; action: string; until: 'owner_completed_next_full_action' };
export type AllyCondition = 'another_allied_pack_hunter_present' | 'two_or_more_allied_nekkers_present' | 'another_allied_insectoid_present';
export type TraitEffect =
  | { type: 'vs_sign_defense_modifier'; sign: SignId; value: number }
  | { type: 'suppress_positive_rule_modifier_dice_from_tagged_ability'; tag: string }
  | { type: 'immunity'; scope: 'fear_or_morale' }
  | ({ type: 'on_hit_by_sign'; sign: SignId } & ({ effects: SignHitEffect[]; effect?: never } | { effect: SignHitEffect; effects?: never }))
  | { type: 'increase_incoming_damage_rank_if'; condition: { damage_type: 'fire' }; steps: number }
  | { type: 'modifier'; stat: Stat; value: number; tag?: string }
  | { type: 'suppress_tagged_trait_effect'; tag: string }
  | { type: 'on_owner_full_action_end'; if_not_status_any?: StatusId[]; effect: ActionEffect }
  | { type: 'suppress_action'; action: string; while_status_or_effect?: string }
  | { type: 'reduce_incoming_damage_rank_if'; condition: { final_roll_below: number }; steps: number }
  | { type: 'on_death_if_not_status'; status: StatusId; effect: { type: 'area_damage'; damage: string; target_scope: 'all_other_actors'; can_chain_trigger_same_trait: boolean } }
  | { type: 'while_tag_disabled'; tag: string; modifiers: { stat: Stat; value: number }[] }
  | { type: 'conditional_check_modifier'; condition: AllyCondition; stat: Stat; value: number }
  | { type: 'conditional_check_modifier_die'; condition: AllyCondition; value: string; max_from_trait_per_check: string }
  | { type: 'allied_trait_modifier'; target_trait: string; stat: Stat; value: number }
  | { type: 'allied_monster_modifier'; target_monster_id: string; stat: Stat; value: number }
  | { type: 'conditional_modifier'; condition: 'hp_at_or_below_half'; stat: Stat; value: number };
export type StatusEffect =
  | { type: 'check_modifier_die'; value: string; max_from_status_per_action?: string }
  | { type: 'attacker_check_modifier_die'; value: string; max_from_status_per_check?: string }
  | { type: 'decrement_counter'; amount: number }
  | { type: 'direct_hp_loss'; amount: number }
  | { type: 'direct_hp_loss_to_attacker'; amount: number; classification: string };
export interface AttackRule {
  name_zh: string; cost?: Record<string, number>; damage?: string | null;
  attack_modifier?: number; tags?: string[]; check_modifier_die?: string;
  on_hit?: ActionEffect[]; on_miss?: ActionEffect[];
  narrative_forms?: string[]; narrative_forms_have_distinct_mechanics?: boolean; allow_other_body_appropriate_forms?: boolean;
}
export interface MonsterActionRule {
  name_zh: string; cost?: Record<string, number>; tags?: string[];
  check?: { type: 'monster_d20'; target: 'player_defense' };
  when_uncertain_check?: { type: 'monster_fixed_difficulty'; difficulty: number };
  effects?: ActionEffect[]; on_success?: ActionEffect[];
}
export interface TraitRule { name_zh: string; effects?: TraitEffect[]; immunities?: string[]; while_affected_by?: string; does_not?: string[] }
export interface PartRule { name_zh: string; grouped_part?: boolean; attack_modifier: number; damage_multiplier: number; trauma_track: boolean; effects?: Partial<Record<'light' | 'heavy' | 'destroyed', PartEffect[]>> }
export interface ActorRule {
  id: string; name_zh: string; kind: string; difficulty?: number; monster_type?: string;
  stats: { defense: number; hp: { current: number; max: number }; damage_thresholds: { heavy: number; severe: number }; base_attack_modifier?: number; armor?: { current: number; max: number } | null; sign_points?: { current: number; max: number }; toxicity?: { current: number; max: number } };
  state?: { statuses?: (string | { id: string; stacks?: number })[]; quen_active?: boolean };
  attacks?: Record<string, AttackRule>; actions?: Record<string, MonsterActionRule>; traits?: Record<string, TraitRule>; parts?: Record<string, PartRule>;
  parts_initial_trauma?: Record<string, number>;
  weapons?: { silver_sword: { name_zh: string; attacks: Record<string, AttackRule> } }; inventory?: { potions: string[] };
}
export interface GeraltRule extends ActorRule { weapons: { silver_sword: { name_zh: string; attacks: Record<string, AttackRule> } }; inventory: { potions: string[] } }
type SignBase = { name_zh: string; cost: { sign_points: number }; is_attack?: boolean; part_targeting?: boolean };
export interface SignRules {
  aard: SignBase & { check: { type: 'player_hostile' }; damage: null; on_success: { mode: 'choose_one'; choices: { id: string; effects: ActionEffect[] }[] }; on_critical: { mode: 'apply_all_success_choices' } };
  igni: SignBase & { check: { type: 'player_hostile' }; damage: { formula: string; damage_type: 'fire' }; on_hit: ActionEffect[]; on_critical: ActionEffect[] };
  yrden: SignBase & { check: { type: 'fixed_difficulty'; difficulty: number }; duration: Duration; modifiers: { stat: Stat; value: number }[]; target_count: number; restrictions: string[]; ghosts_become_normally_attackable: boolean; max_simultaneous_instances: number };
  quen: SignBase & { check: { type: 'fixed_difficulty'; difficulty: number }; creates: string; duration_end_any: [{ type: 'incoming_damage_would_lose_hp_before_quen' }, { type: 'caster_completed_full_actions_after_apply'; count: number }]; on_trigger: ActionEffect[] };
  axii: SignBase & { check: { type: 'player_hostile' }; on_success: ActionEffect[]; on_critical: ActionEffect[]; mental_resistance: { trait_id: string; target_defense_modifier: number } };
}
export type SignRule = SignRules[SignId];
export interface PotionRule { name_zh: string; toxicity: number; apply: ActionEffect[]; effect?: { trigger: string; damage_modifier: string; consume_on_check_even_on_miss: boolean; expires_on_battle_end: boolean }; cannot_restore?: string[] }
interface StatusBase {
  name_zh: string; counter: 'stacks' | 'remaining_uses'; reapply: { mode: 'keep_higher' | 'add_remaining' | 'no_stack' };
  ends_at_counter?: number; clear_action?: { type: 'no_check_full_action'; name_zh: string };
  modifiers?: { scope: string; value: number }[];
  while_taking_full_action?: { forbid?: string[]; if_check_required: StatusEffect[] };
  on_incoming_hostile_check?: StatusEffect[]; on_incoming_melee_hit?: StatusEffect[]; on_owner_full_action_end?: StatusEffect[];
}
export type StatusRule = StatusBase & ({ family: 'persistent_damage'; damage_per_action: number } | { family?: never; damage_per_action?: never });
export interface CombatData {
  meta: typeof rawData.meta; enums: typeof rawData.enums;
  actors: Record<string, ActorRule> & { geralt: GeraltRule };
  global: Omit<typeof rawData.global, 'signs' | 'potions' | 'statuses' | 'armor' | 'critical'> & {
    signs: SignRules; potions: Record<string, PotionRule> & { thunderbolt: PotionRule & { effect: NonNullable<PotionRule['effect']> } };
    statuses: Record<string, StatusRule>;
    armor: Omit<typeof rawData.global.armor, 'absorb_from_rank'> & { absorb_from_rank: DamageRank };
    critical: Omit<typeof rawData.global.critical, 'apply_bleeding_if_final_damage_rank'> & { apply_bleeding_if_final_damage_rank: DamageRank };
  };
}
export function assertNever(value: never): never { throw new Error(`Unsupported rule: ${JSON.stringify(value)}`); }
