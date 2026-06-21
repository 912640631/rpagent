import { combatData } from './data.js';
import type { AttackRule, MonsterActionRule, PotionRule, StatusRule, SignRules } from './rule-types.js';
import type { BattleState } from './types.js';

const categories = ['sword', 'attack', 'action', 'sign', 'potion', 'clear'] as const;
export type ActionCategory = typeof categories[number];
export type ActionIdentifier = { [K in ActionCategory]: { category: K; key: string } }[ActionCategory];
interface RuleMap { sword: AttackRule; attack: AttackRule; action: MonsterActionRule; sign: SignRules[keyof SignRules]; potion: PotionRule; clear: StatusRule }
export type ActionRule = { [K in Exclude<ActionCategory, 'sign'>]: { category: K; key: string; rule: RuleMap[K] } }[Exclude<ActionCategory, 'sign'>] |
  { [K in keyof SignRules]: { category: 'sign'; key: K; rule: SignRules[K] } }[keyof SignRules];

export function parseActionId(id: string): ActionIdentifier | undefined {
  const match = /^([^:]+):([^:]+)$/.exec(id);
  if (!match || !(categories as readonly string[]).includes(match[1]!)) return undefined;
  return { category: match[1] as ActionCategory, key: match[2]! };
}
export function actionId(category: ActionCategory, key: string): string { return `${category}:${key}`; }

/** Rule locations live here; execution and descriptions consume the same lookup. */
export function actionRules<K extends ActionCategory>(state: Pick<BattleState, 'monsterId'>, category: K): Record<string, RuleMap[K]>;
export function actionRules(state: Pick<BattleState, 'monsterId'>, category: ActionCategory): Record<string, RuleMap[ActionCategory]> {
  switch (category) {
    case 'sword': return combatData.actors.geralt!.weapons.silver_sword.attacks;
    case 'attack': return combatData.actors[state.monsterId]?.attacks ?? {};
    case 'action': return combatData.actors[state.monsterId]?.actions ?? {};
    case 'sign': return { ...combatData.global.signs };
    case 'potion': return combatData.global.potions;
    case 'clear': return combatData.global.statuses;
  }
}
export function findActionRule(state: Pick<BattleState, 'monsterId'>, id: string): ActionRule | undefined {
  const parsed = parseActionId(id);
  if (!parsed) return undefined;
  const rules = actionRules(state, parsed.category);
  const rule = Object.hasOwn(rules, parsed.key) ? rules[parsed.key] : undefined;
  return rule ? { ...parsed, rule } as ActionRule : undefined;
}
export function requireActionRule<K extends ActionCategory>(state: Pick<BattleState, 'monsterId'>, id: string, category: K): Extract<ActionRule, { category: K }> {
  const found = findActionRule(state, id);
  if (!found || found.category !== category) throw new Error(`Unknown ${category} action: ${id}`);
  return found as Extract<ActionRule, { category: K }>;
}
