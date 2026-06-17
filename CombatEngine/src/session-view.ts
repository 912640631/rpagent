import { combatData, type Rule } from './data.js';
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

function effectDescription(effect: Rule): string {
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
    default: return `效果：${String(effect.type)}`;
  }
}

function effectsDescription(effects: unknown): string[] {
  return Array.isArray(effects) ? effects.map(effect => effectDescription(effect as Rule)) : [];
}

function damageDescription(damage: unknown): string[] {
  if (typeof damage === 'string') return [`伤害${damage}`];
  if (damage && typeof damage === 'object' && typeof (damage as Rule).formula === 'string') {
    return [`伤害${(damage as Rule).formula}`];
  }
  return [];
}

function optionDescription(state: BattleState, option: ActionOption): string {
  const [group, id] = option.id.split(':');
  let rule: Rule | undefined;
  if (group === 'sword') rule = combatData.actors.geralt!.weapons.silver_sword.attacks[id!];
  else if (group === 'attack') rule = combatData.actors[state.monsterId]!.attacks?.[id!];
  else if (group === 'action') rule = combatData.actors[state.monsterId]!.actions?.[id!];
  else if (group === 'sign') rule = combatData.global.signs[id!];
  else if (group === 'potion') rule = combatData.global.potions[id!];
  if (group === 'clear') return `清除${statusName(id!)}`;
  if (!rule) return option.name;

  const parts = [
    ...damageDescription(rule.damage),
    ...effectsDescription(rule.effects),
    ...effectsDescription(rule.apply),
    ...effectsDescription(rule.on_success).map(text => `成功：${text}`),
    ...effectsDescription(rule.on_hit).map(text => `命中：${text}`),
    ...effectsDescription(rule.on_miss).map(text => `未命中：${text}`),
    ...effectsDescription(rule.on_critical).map(text => `暴击：${text}`)
  ];
  if (rule.on_success?.choices) {
    for (const choice of rule.on_success.choices as Rule[]) {
      parts.push(`${choice.id}：${effectsDescription(choice.effects).join('、')}`);
    }
  }
  if (group === 'sign' && id === 'yrden') parts.push('暂时降低目标防御和攻击判定');
  if (group === 'sign' && id === 'quen') parts.push('生成抵挡伤害的护盾');
  if (rule.when_uncertain_check) parts.push(`难度${rule.when_uncertain_check.difficulty}判定成功后逃跑`);
  if (group === 'potion' && rule.effect?.damage_modifier) {
    parts.push(`剑攻击命中后额外伤害${rule.effect.damage_modifier}`);
  }
  if (group === 'potion') parts.push(`毒性+${rule.toxicity}`);
  return parts.length ? parts.join('；') : option.name;
}

function decisionOption(state: BattleState, id: string): SessionDecisionOption {
  if (id === 'skip') return { id, name: '跳过', description: '不使用附加动作' };
  if (id === 'survive') return { id, name: '保命', description: '战斗结束，杰洛特失去行动能力' };
  if (id === 'gamble') return { id, name: '搏命', description: '掷希望骰与恐惧骰；失败则死亡，成功则恢复生命' };
  if (id.startsWith('potion:')) {
    const potion = combatData.global.potions[id.slice('potion:'.length)];
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
    targetParts: options.some(option => option.targetParts?.length) ? Object.entries<Rule>(parts).map(([id, part]) => ({
      id, name: part.name_zh, attackModifier: part.attack_modifier ?? 0,
      damageMultiplier: part.damage_multiplier ?? 1
    })) : []
  };
}
