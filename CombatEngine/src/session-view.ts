import { assertNever, type ActionEffect } from './rule-types.js';
import { findActionRule } from './action-rules.js';
import { combatData } from './data.js';
import { getOptions } from './engine.js';
import type { ActionOption, BattleState, Combatant, Outcome, PendingDecision, Side, TimedEffect } from './types.js';

export interface CombatantSummary {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  defense: number;
  heavyThreshold: number;
  severeThreshold: number;
  armor: number;
  maxArmor: number;
  signPoints: number;
  maxSignPoints: number;
  toxicity: number;
  maxToxicity: number;
  statuses: Record<string, number>;
  trauma: Record<string, number>;
  effects: TimedEffect[];
  nextAttackDice: string[];
  thunderboltUses: number;
  potions: string[];
}

export interface SessionOption extends ActionOption {
  description: string;
}

export interface TargetPartSummary {
  id: string;
  name: string;
  attackModifier: number;
  damageMultiplier: number;
}

export interface SessionDecisionOption {
  id: string;
  name: string;
  description: string;
}

export interface SessionView {
  monsterId: string;
  combatants: Record<Side, CombatantSummary>;
  initiative: Side;
  fear: number;
  hope: number;
  actionCount: number;
  maxActions: number;
  pending: Pick<PendingDecision, 'kind' | 'actingSide'> & { options: SessionDecisionOption[] } | null;
  outcome: Outcome | null;
  options: SessionOption[];
  targetParts: TargetPartSummary[];
}

function combatantSummary(actor: Combatant): CombatantSummary {
  const {
    id, name, hp, maxHp, defense, heavyThreshold, severeThreshold, armor, maxArmor,
    signPoints, maxSignPoints, toxicity, maxToxicity, statuses, trauma, effects,
    nextAttackDice, thunderboltUses, potions
  } = actor;
  return {
    id, name, hp, maxHp, defense, heavyThreshold, severeThreshold, armor, maxArmor,
    signPoints, maxSignPoints, toxicity, maxToxicity,
    statuses: { ...statuses }, trauma: { ...trauma }, effects: structuredClone(effects),
    nextAttackDice: [...nextAttackDice], thunderboltUses, potions: [...potions]
  };
}

const statusName = (id: string): string => combatData.global.statuses[id]?.name_zh ?? id;

function effectDescription(effect: ActionEffect): string {
  switch (effect.type) {
    case 'apply_status': return `施加${statusName(effect.status)}${effect.stacks ?? 1}层`;
    case 'clear_status': return `清除${statusName(effect.status)}`;
    case 'heal_hp': return `恢复${effect.amount}点生命`;
    case 'restore_resource': return `恢复${effect.amount}点${effect.resource}`;
    case 'grant_immunity': return `暂时免疫${statusName(effect.status)}`;
    case 'grant_counter_effect': return `获得${effect.effect}效果${effect.uses}次`;
    case 'grant_next_attack_modifier_die': return `下次攻击判定增加${effect.value}`;
    case 'grant_temporary_stat_modifier': return `暂时${effect.stat}${effect.value >= 0 ? '+' : ''}${effect.value}`;
    case 'grant_temporary_check_modifier': return `后续判定增加${effect.modifier_die}，最多${effect.uses}次`;
    case 'interrupt_prepared_action': return '打断准备中的行动';
    case 'override_applied_status_stacks': return `将${statusName(effect.status)}改为${effect.stacks}层`;
    case 'increase_damage_rank': return `伤害等级提高${effect.steps}级`;
    case 'reduce_damage_rank': return `伤害等级降低${effect.steps}级`;
    case 'remove_self': return '移除本效果';
    default: return assertNever(effect);
  }
}

function effectsDescription(effects: ActionEffect[] | undefined, prefix = ''): string[] {
  return (effects ?? []).map(effect => `${prefix}${effectDescription(effect)}`);
}
function damageDescription(damage: string | { formula: string } | null | undefined): string[] {
  return damage ? [`伤害${typeof damage === 'string' ? damage : damage.formula}`] : [];
}
function optionDescription(state: BattleState, option: ActionOption): string {
  const found = findActionRule(state, option.id);
  if (!found) return option.name;
  const parts: string[] = [];
  switch (found.category) {
    case 'clear': return `清除${statusName(found.key)}`;
    case 'sword': case 'attack':
      parts.push(...damageDescription(found.rule.damage), ...effectsDescription(found.rule.on_hit, '命中：'), ...effectsDescription(found.rule.on_miss, '未命中：')); break;
    case 'action':
      parts.push(...effectsDescription(found.rule.effects), ...effectsDescription(found.rule.on_success, '成功：'));
      if (found.rule.when_uncertain_check) parts.push(`难度${found.rule.when_uncertain_check.difficulty}判定成功后逃跑`);
      break;
    case 'potion':
      parts.push(...effectsDescription(found.rule.apply));
      if (found.rule.effect?.damage_modifier) parts.push(`剑攻击命中后额外伤害${found.rule.effect.damage_modifier}`);
      parts.push(`毒性+${found.rule.toxicity}`); break;
    case 'sign':
      switch (found.key) {
        case 'aard':
          for (const choice of found.rule.on_success.choices) parts.push(`${choice.id}：${effectsDescription(choice.effects).join('、')}`);
          break;
        case 'igni': parts.push(...damageDescription(found.rule.damage), ...effectsDescription(found.rule.on_hit, '命中：'), ...effectsDescription(found.rule.on_critical, '暴击：')); break;
        case 'yrden': parts.push('暂时降低目标防御和攻击判定'); break;
        case 'quen': parts.push('生成抵挡伤害的护盾'); break;
        case 'axii': parts.push(...effectsDescription(found.rule.on_success, '成功：'), ...effectsDescription(found.rule.on_critical, '暴击：')); break;
        default: assertNever(found);
      }
      break;
    default: assertNever(found);
  }
  return parts.length ? parts.join('；') : option.name;
}

function decisionOption(state: BattleState, id: string): SessionDecisionOption {
  if (id === 'skip') return { id, name: '跳过', description: '不使用附加动作' };
  if (id === 'survive') return { id, name: '保命', description: '战斗结束，杰洛特失去行动能力' };
  if (id === 'gamble') return { id, name: '搏命', description: '掷希望骰与恐惧骰；失败则死亡，成功则恢复生命' };
  const found = findActionRule(state, id);
  if (found?.category === 'potion') {
    const potion = found.rule;
    const option: ActionOption = { id, name: potion?.name_zh ?? id, actor: 'geralt', kind: 'potion' };
    return { id, name: option.name, description: optionDescription(state, option) };
  }
  return { id, name: id, description: id };
}

export function makeSessionView(state: BattleState): SessionView {
  const parts = combatData.actors[state.monsterId]!.parts ?? {};
  const options = getOptions(state);
  return {
    monsterId: state.monsterId,
    combatants: {
      geralt: combatantSummary(state.combatants.geralt),
      monster: combatantSummary(state.combatants.monster)
    },
    initiative: state.initiative,
    fear: state.fear,
    hope: state.hope,
    actionCount: state.actionCount,
    maxActions: state.maxActions,
    pending: state.pending ? {
      kind: state.pending.kind,
      options: state.pending.options.map(id => decisionOption(state, id)),
      actingSide: state.pending.actingSide
    } : null,
    outcome: state.outcome,
    options: options.map(option => ({ ...option, description: optionDescription(state, option) })),
    targetParts: options.some(option => option.targetParts?.length) ? Object.entries(parts).map(([id, part]) => ({
      id, name: part.name_zh, attackModifier: part.attack_modifier ?? 0,
      damageMultiplier: part.damage_multiplier ?? 1
    })) : []
  };
}
