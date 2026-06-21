import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { actor, array, dictionary, number, object, oneOf, potions, record, signs, statusRule, text } from './rule-validation.js';
import type { CombatData } from './rule-types.js';
export type { CombatData } from './rule-types.js';

const dataText = readFileSync(new URL('../data/combat.json', import.meta.url), 'utf8');
export const dataRevision = createHash('sha256').update(dataText).digest('hex');
const statusIds = ['burning', 'poisoned', 'bleeding', 'unbalanced', 'hesitant', 'blinded', 'spined'];
const rank = oneOf('none', 'light', 'heavy', 'severe');
const rankValues = object({ none: number, light: number, heavy: number, severe: number });
const numeric = dictionary(number);
const globalMechanics = object({
  dice: object({ player: object({ hope: text, fear: text }), monster: object({ check: text }), environment_advantage: text, environment_disadvantage: text }),
  difficulty: object({ easy: number, normal: number, hard: number, extreme: number, ultimate: number }), damage_rank: object({ hp_loss: rankValues, order: array(rank) }),
  part_trauma: object({ min: number, max: number, states: object({ '0': text, '1': text, '2': text, '3': text }), increase_by_final_damage_rank: rankValues, same_part_numeric_penalty_cap: number }),
  fear: object({ gm_initial: number, generic_empowerments: object({
    empower_hit: object({ cost: numeric, per_attack_max_uses: number, effects: array(object({ type: oneOf('check_modifier_die'), value: text })) }),
    empower_damage: object({ cost: numeric, per_attack_max_uses: number, effects: array(object({ type: oneOf('add_base_damage_die'), count: number })) })
  }) }), signs, potions, statuses: dictionary(statusRule),
  status_families: object({ persistent_damage: object({ classification: oneOf('special_persistent_damage'), decrement_per_action: number, ends_at_counter: oneOf(0) }) }),
  duality: object({ failure_with_fear_gm_fear_gain: number }),
  action: object({ max_bonus_actions_gained_per_full_action: number, current_bonus_action_allowed_uses: array(text) }),
  critical: object({ damage_rank_increase_steps_if_base_damage_gt_zero: number, apply_bleeding_if_final_damage_rank: rank }),
  toxicity: object({ saturation_when_current_equals_max: oneOf(true), saturation_defense_modifier: number, reset_current_to: number, reset_timing: oneOf('battle_end') }),
  dying_choice: object({ trigger_hp: number, gamble_roll: object({ hope: text, fear: text, modifier: number }), hope_gt_fear: object({ restore_hp: number, gain_initiative: oneOf(true) }), fear_gt_hope: object({ result: text }), equal: object({ restore_hp: number, gain_initiative: oneOf(true) }) }),
  monster_difficulty_scale: object({ min: number, max: number, scope: text, name_zh: text, description_zh: text, anchors: dictionary(text) }),
  armor: object({ absorb_from_rank: rank, points_per_hit: number, reduce_rank_steps: number, broken_at: number, broken_defense_modifier: number, recover_at: number }),
  environment_modifier_scope: text
});
export function validateCombatData(value: unknown = combatData): asserts value is CombatData {
  const data = record(value, 'data');
  if (record(data.meta, 'meta').schema_version !== '1.0.0') throw new Error('Unsupported data version');
  const actors = record(data.actors, 'actors');
  if (!actors.geralt) throw new Error('Geralt template missing');
  const global = record(data.global, 'global');
  // Keep the persistent-damage contract explicit and its diagnostics stable.
  const statuses = record(global.statuses, 'statuses');
  for (const [id, item] of Object.entries(statuses)) {
    if (!statusIds.includes(id)) throw new Error(`Unsupported status definition: ${id}`);
    const status = record(item, `statuses.${id}`);
    if (status.family !== undefined && (status.family !== 'persistent_damage' || status.counter !== 'stacks' || !Number.isSafeInteger(status.damage_per_action) || Number(status.damage_per_action) < 1 || status.on_owner_full_action_end !== undefined || status.ends_at_counter !== undefined)) throw new Error(`Invalid persistent damage status: ${id}`);
  }
  object({ meta: object({ schema_version: text, source: text, locale: text, purpose: text }), enums: object({ damage_rank: array(rank), initiative_side: array(text), check_kind: array(text), action_kind: array(text) }), actors: dictionary(actor), global: globalMechanics })(data, 'data');
  const typed = data as unknown as CombatData;
  const family = typed.global.status_families.persistent_damage;
  if (!Number.isSafeInteger(family.decrement_per_action) || family.decrement_per_action < 1) throw new Error('Invalid persistent damage family');
  for (const id of statusIds) if (!Object.hasOwn(statuses, id)) throw new Error(`Missing status: ${id}`);
  const geralt = record(actors.geralt, 'geralt');
  for (const key of ['weapons', 'inventory']) if (!geralt[key]) throw new Error(`Missing geralt.${key}`);
  if (!typed.global.potions.thunderbolt?.effect) throw new Error('Missing Thunderbolt effect');
  for (const [id, definition] of Object.entries(typed.actors)) {
    if (definition.id !== id) throw new Error(`Invalid actor id: ${id}`);
    for (const [attackId, attack] of Object.entries(definition.attacks ?? {})) {
      for (const effect of attack.on_miss ?? []) if (!effect.target) throw new Error(`Miss effect target required at ${id}.attacks.${attackId}`);
    }
  }
}
export function parseCombatData(value: unknown): CombatData { validateCombatData(value); return value; }
export const combatData = parseCombatData(JSON.parse(dataText) as unknown);
export const monsterIds = Object.keys(combatData.actors).filter(id => id !== 'geralt');
