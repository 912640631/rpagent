import { combatData, dataRevision, monsterIds, type Rule, validateCombatData } from './data.js';
import { baseDie, rollFormula } from './dice.js';
import type {
  ActionCommand, ActionOption, Advantage, BattleConfig, BattleState, BattleView, Combatant,
  Command, DamageRank, DecisionCommand, Event, InitialCombatantState, Outcome, Side, TimedEffect
} from './types.js';

const ranks: DamageRank[] = ['none', 'light', 'heavy', 'severe'];
const other = (side: Side): Side => side === 'geralt' ? 'monster' : 'geralt';
const asRecord = (value: unknown): Rule => (value && typeof value === 'object' ? value as Rule : {});
const asEffects = (value: unknown): Rule[] => Array.isArray(value) ? value as Rule[] : [];
const statusModifier = (status: string, scope: string): number =>
  asEffects(combatData.global.statuses[status]?.modifiers)
    .filter(modifier => modifier.scope === scope).reduce((sum, modifier) => sum + modifier.value, 0);
const signModifier = (sign: string, stat: string): number =>
  asEffects(combatData.global.signs[sign]?.modifiers)
    .filter(modifier => modifier.stat === stat).reduce((sum, modifier) => sum + modifier.value, 0);

function templateToCombatant(id: string): Combatant {
  const actor = combatData.actors[id];
  if (!actor) throw new Error(`Unknown actor: ${id}`);
  const stats = actor.stats;
  const statuses: Record<string, number> = {};
  for (const item of actor.state?.statuses ?? []) {
    if (typeof item === 'string') statuses[item] = 1;
    else statuses[item.id] = item.stacks ?? 1;
  }
  const trauma: Record<string, number> = {};
  for (const [partId, part] of Object.entries<Rule>(actor.parts ?? {})) {
    if (part.trauma_track) trauma[partId] = actor.parts_initial_trauma?.[partId] ?? actor.parts_initial_trauma?.all_trauma_track_parts ?? 0;
  }
  return {
    id, name: actor.name_zh, hp: stats.hp.current, maxHp: stats.hp.max,
    defense: stats.defense, heavyThreshold: stats.damage_thresholds.heavy,
    severeThreshold: stats.damage_thresholds.severe,
    armor: stats.armor?.current ?? 0, maxArmor: stats.armor?.max ?? 0,
    signPoints: stats.sign_points?.current ?? 0, maxSignPoints: stats.sign_points?.max ?? 0,
    toxicity: stats.toxicity?.current ?? 0, maxToxicity: stats.toxicity?.max ?? 0,
    statuses, trauma, effects: [], nextAttackDice: [], thunderboltUses: 0,
    potions: [...(actor.inventory?.potions ?? [])], completedActions: 0, dead: false
  };
}

function applyInitial(combatant: Combatant, initial: InitialCombatantState, side: Side, monsterId: string): void {
  for (const field of ['hp', 'armor', 'signPoints', 'toxicity'] as const) {
    const value = initial[field];
    if (value === undefined) continue;
    const maxField = { hp: 'maxHp', armor: 'maxArmor', signPoints: 'maxSignPoints', toxicity: 'maxToxicity' }[field] as keyof Combatant;
    const max = combatant[maxField] as number;
    if (!Number.isSafeInteger(value) || value < (field === 'hp' ? 1 : 0) || value > max) {
      throw new Error(`Invalid initial ${side}.${field}: ${value}`);
    }
    combatant[field] = value;
  }
  if (initial.statuses) {
    for (const [status, amount] of Object.entries(initial.statuses)) {
      if (!combatData.global.statuses[status] || !Number.isSafeInteger(amount) || amount < 1) {
        throw new Error(`Invalid initial ${side} status: ${status}`);
      }
    }
    combatant.statuses = { ...initial.statuses };
  }
  if (initial.trauma) {
    if (side !== 'monster') throw new Error('Only monster parts can have trauma');
    const parts = combatData.actors[monsterId]!.parts ?? {};
    for (const [part, amount] of Object.entries(initial.trauma)) {
      if (!parts[part]?.trauma_track || !Number.isSafeInteger(amount) || amount < 0 || amount > combatData.global.part_trauma.max) {
        throw new Error(`Invalid initial part trauma: ${part}`);
      }
      if (amount === combatData.global.part_trauma.max &&
        asEffects(parts[part].effects?.destroyed).some(effect => effect.type === 'death')) {
        throw new Error(`Fatal initial part trauma: ${part}`);
      }
    }
    combatant.trauma = { ...combatant.trauma, ...initial.trauma };
  }
  if (initial.potions) {
    if (side !== 'geralt') throw new Error('Only Geralt can carry potions');
    const available = combatData.actors.geralt!.inventory.potions as string[];
    if (initial.potions.some(id => !available.includes(id))) throw new Error('Unknown initial potion');
    combatant.potions = [...initial.potions];
  }
}

export function createBattle(monsterId: string, seed?: number, maxActions?: number): BattleState;
export function createBattle(config: BattleConfig): BattleState;
export function createBattle(input: string | BattleConfig, seed = 1, maxActions = 200): BattleState {
  validateCombatData();
  const config: BattleConfig = typeof input === 'string' ? { monsterId: input, seed, maxActions } : input;
  const monsterId = config.monsterId;
  seed = config.seed ?? 1;
  maxActions = config.maxActions ?? 200;
  if (!monsterIds.includes(monsterId)) throw new Error(`Unknown monster: ${monsterId}`);
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(maxActions) || maxActions < 1) {
    throw new Error('Seed and maxActions must be valid integers');
  }
  const randomState = (seed >>> 0) || 0x6d2b79f5;
  if (config.initiative && !['geralt', 'monster'].includes(config.initiative)) throw new Error('Invalid initial initiative');
  if (config.fear !== undefined && (!Number.isSafeInteger(config.fear) || config.fear < 0 || config.fear > 12)) throw new Error('Invalid initial fear');
  if (config.hope !== undefined && (!Number.isSafeInteger(config.hope) || config.hope < 0 || config.hope > 6)) throw new Error('Invalid initial hope');
  const state: BattleState = {
    version: 1, dataRevision, seed, randomState, monsterId,
    combatants: { geralt: templateToCombatant('geralt'), monster: templateToCombatant(monsterId) },
    initiative: config.initiative ?? 'geralt', fear: config.fear ?? 0, hope: config.hope ?? 2,
    actionCount: 0, maxActions, pending: null, forcedGeraltInitiative: false,
    outcome: null, events: []
  };
  if (config.initial?.geralt) applyInitial(state.combatants.geralt, config.initial.geralt, 'geralt', monsterId);
  if (config.initial?.monster) applyInitial(state.combatants.monster, config.initial.monster, 'monster', monsterId);
  return state;
}

function actorTemplate(state: BattleState, side: Side): Rule {
  return combatData.actors[side === 'geralt' ? 'geralt' : state.monsterId]!;
}

function partEffects(state: BattleState, side: Side): Rule[] {
  const actor = state.combatants[side];
  const parts = actorTemplate(state, side).parts ?? {};
  const result: Rule[] = [];
  for (const [partId, level] of Object.entries(actor.trauma)) {
    const definition = parts[partId];
    if (!definition) continue;
    if (level >= 1) result.push(...asEffects(definition.effects?.light).map(effect => ({ ...effect, partId })));
    if (level >= 2) result.push(...asEffects(definition.effects?.heavy).map(effect => ({ ...effect, partId })));
    if (level >= 3) result.push(...asEffects(definition.effects?.destroyed).map(effect => ({ ...effect, partId })));
  }
  return result;
}

function traitEffects(state: BattleState, side: Side): Rule[] {
  const template = actorTemplate(state, side);
  const hasYrden = state.combatants[side].effects.some(effect => effect.kind === 'yrden');
  return Object.values<Rule>(template.traits ?? {}).flatMap(trait => {
    if (trait.while_affected_by && !(trait.while_affected_by === 'yrden' && hasYrden)) return [];
    return asEffects(trait.effects);
  });
}

function disabledTag(state: BattleState, side: Side, tag: string): boolean {
  if (partEffects(state, side).some(effect => effect.type === 'disable_tagged_actions' && effect.tag === tag)) return true;
  return state.combatants[side].effects.some(effect => effect.kind === 'disabled_tag' && effect.tag === tag);
}

function actionDisabled(state: BattleState, side: Side, id: string, tags: string[]): boolean {
  if (tags.some(tag => disabledTag(state, side, tag))) return true;
  if (partEffects(state, side).some(effect => effect.type === 'disable_action' && effect.action === id)) return true;
  if (state.combatants[side].effects.some(effect => effect.kind === 'disabled_action' && effect.action === id)) return true;
  return traitEffects(state, side).some(effect => effect.type === 'suppress_action' && effect.action === id &&
    (!effect.while_status_or_effect || Boolean(state.combatants[side].statuses[effect.while_status_or_effect]) ||
      state.combatants[side].effects.some(active => active.kind === effect.while_status_or_effect)));
}

export function getOptions(state: BattleState): ActionOption[] {
  if (state.outcome || state.pending) return [];
  const side = state.initiative;
  const actor = state.combatants[side];
  if (side === 'geralt') {
    const result: ActionOption[] = [];
    const sword = combatData.actors.geralt!.weapons.silver_sword.attacks;
    for (const [id, attack] of Object.entries<Rule>(sword)) {
      result.push({ id: `sword:${id}`, name: attack.name_zh, actor: side, kind: 'attack',
        targetParts: Object.keys(actorTemplate(state, 'monster').parts ?? {}) });
    }
    for (const [id, sign] of Object.entries<Rule>(combatData.global.signs)) {
      if (actor.signPoints < (sign.cost?.sign_points ?? 0)) continue;
      const option: ActionOption = { id: `sign:${id}`, name: sign.name_zh, actor: side, kind: 'sign', cost: sign.cost };
      if (id === 'aard') option.choices = sign.on_success.choices.map((choice: Rule) => choice.id);
      result.push(option);
    }
    for (const id of actor.potions) {
      const potion = combatData.global.potions[id];
      if (potion && actor.toxicity + potion.toxicity <= actor.maxToxicity) {
        result.push({ id: `potion:${id}`, name: potion.name_zh, actor: side, kind: 'potion' });
      }
    }
    if (actor.statuses.burning) result.push({ id: 'clear:burning', name: '灭火', actor: side, kind: 'clear' });
    if (actor.statuses.bleeding) result.push({ id: 'clear:bleeding', name: '处理伤口', actor: side, kind: 'clear' });
    return result;
  }
  const template = actorTemplate(state, side);
  const result: ActionOption[] = [];
  for (const [id, attack] of Object.entries<Rule>(template.attacks ?? {})) {
    if (actor.hp <= 0 || actionDisabled(state, side, id, attack.tags ?? [])) continue;
    if (state.fear < (attack.cost?.fear ?? 0)) continue;
    result.push({ id: `attack:${id}`, name: attack.name_zh, actor: side, kind: 'attack', cost: attack.cost,
      canEmpowerHit: !actor.statuses.hesitant && state.fear >= (attack.cost?.fear ?? 0) + combatData.global.fear.generic_empowerments.empower_hit.cost.fear,
      canEmpowerDamage: Boolean(attack.damage) && !actor.statuses.hesitant &&
        state.fear >= (attack.cost?.fear ?? 0) + combatData.global.fear.generic_empowerments.empower_damage.cost.fear });
  }
  for (const [id, action] of Object.entries<Rule>(template.actions ?? {})) {
    if (actor.hp <= 0 || actionDisabled(state, side, id, action.tags ?? [])) continue;
    if (state.fear < (action.cost?.fear ?? 0)) continue;
    result.push({ id: `action:${id}`, name: action.name_zh, actor: side, kind: 'action', cost: action.cost });
  }
  if (actor.statuses.burning) result.push({ id: 'clear:burning', name: '灭火', actor: side, kind: 'clear' });
  if (actor.statuses.bleeding) result.push({ id: 'clear:bleeding', name: '处理伤口', actor: side, kind: 'clear' });
  return result;
}

export function getBattleView(state: BattleState): BattleView {
  return { state: structuredClone(state), options: getOptions(state) };
}

interface CheckResult {
  success: boolean;
  critical: boolean;
  withHope: boolean;
  withFear: boolean;
  total: number;
}

class Resolver {
  constructor(readonly state: BattleState) {}

  emit(type: string, details: Record<string, unknown>, actor?: Side, target?: Side): void {
    const event: Event = { sequence: this.state.events.length + 1, type, details };
    if (actor) event.actor = actor;
    if (target) event.target = target;
    this.state.events.push(event);
  }

  private partNumeric(side: Side, stat: string): number {
    const perPart = new Map<string, number>();
    for (const effect of partEffects(this.state, side)) {
      if (effect.type === 'modifier' && effect.stat === stat) {
        perPart.set(effect.partId, (perPart.get(effect.partId) ?? 0) + effect.value);
      }
    }
    return [...perPart.values()].reduce((sum, value) => sum + Math.max(combatData.global.part_trauma.same_part_numeric_penalty_cap, value), 0);
  }

  private defense(side: Side, signId?: string): number {
    const actor = this.state.combatants[side];
    let value = actor.defense + this.partNumeric(side, 'defense');
    if (actor.maxArmor > 0 && actor.armor <= combatData.global.armor.broken_at) value += combatData.global.armor.broken_defense_modifier;
    if (actor.maxToxicity > 0 && actor.toxicity === actor.maxToxicity) value += combatData.global.toxicity.saturation_defense_modifier;
    if (actor.statuses.poisoned) value += statusModifier('poisoned', 'defense');
    if (actor.effects.some(effect => effect.kind === 'yrden')) value += signModifier('yrden', 'defense');
    value += actor.effects.filter(effect => effect.kind === 'stat' && effect.stat === 'defense')
      .reduce((sum, effect) => sum + (effect.value ?? 0), 0);
    const suppressTags = new Set(traitEffects(this.state, side)
      .filter(effect => effect.type === 'suppress_tagged_trait_effect').map(effect => effect.tag));
    for (const effect of traitEffects(this.state, side)) {
      if (effect.type === 'modifier' && effect.stat === 'defense' && !suppressTags.has(effect.tag)) value += effect.value;
      if (effect.type === 'vs_sign_defense_modifier' && effect.sign === signId) value += effect.value;
      if (effect.type === 'while_tag_disabled' && disabledTag(this.state, side, effect.tag)) {
        value += asEffects(effect.modifiers).filter(mod => mod.stat === 'defense').reduce((sum, mod) => sum + mod.value, 0);
      }
    }
    return value;
  }

  private checkModifier(side: Side, tags: string[], isAttack: boolean): number {
    const actor = this.state.combatants[side];
    let value = isAttack ? this.partNumeric(side, 'attack_check') : 0;
    if (actor.statuses.poisoned) value += statusModifier('poisoned', 'active_combat_checks');
    if (isAttack && actor.effects.some(effect => effect.kind === 'yrden')) value += signModifier('yrden', 'attack_check');
    for (const effect of traitEffects(this.state, side)) {
      if (isAttack && effect.type === 'modifier' && effect.stat === 'attack_check') value += effect.value;
      if (isAttack && effect.type === 'conditional_modifier' && effect.stat === 'attack_check' &&
        effect.condition === 'hp_at_or_below_half' && actor.hp * 2 <= actor.maxHp) value += effect.value;
      if (isAttack && effect.type === 'while_tag_disabled' && disabledTag(this.state, side, effect.tag)) {
        value += asEffects(effect.modifiers).filter(mod => mod.stat === 'attack_check').reduce((sum, mod) => sum + mod.value, 0);
      }
      // Ally conditions have zero qualifying allies in the current duel state.
      if (['conditional_check_modifier', 'conditional_check_modifier_die', 'allied_trait_modifier', 'allied_monster_modifier']
        .includes(effect.type)) continue;
    }
    for (const effect of partEffects(this.state, side)) {
      if (tags.includes(effect.tag) &&
        (effect.type === 'tagged_action_modifier_die' || (isAttack && effect.type === 'tagged_attack_modifier_die'))) {
        value += rollFormula(this.state, effect.value);
      }
    }
    return value;
  }

  private check(side: Side, targetValue: number, options: {
    attack: boolean; hostile: boolean; tags?: string[]; advantage?: Advantage;
    fixedModifier?: number; modifierDie?: string; sword?: boolean; useHopeAdvantage?: boolean;
  }): CheckResult {
    const actor = this.state.combatants[side];
    const tags = options.tags ?? [];
    let modifier = (options.fixedModifier ?? 0) + this.checkModifier(side, tags, options.attack);
    const dice: Record<string, number> = {};
    for (const status of Object.keys(actor.statuses)) {
      for (const effect of asEffects(combatData.global.statuses[status]?.while_taking_full_action?.if_check_required)) {
        if (effect.type !== 'check_modifier_die') throw new Error(`Unsupported check status effect: ${effect.type}`);
        modifier += rollFormula(this.state, effect.value);
      }
    }
    if (options.modifierDie) {
      const suppress = side === 'monster' && tags.includes('requires_flight') && actor.effects.some(effect => effect.kind === 'yrden') &&
        traitEffects(this.state, side).some(effect => effect.type === 'suppress_positive_rule_modifier_dice_from_tagged_ability' && effect.tag === 'requires_flight');
      if (!suppress) modifier += rollFormula(this.state, options.modifierDie);
    }
    if (options.attack && actor.nextAttackDice.length) {
      for (const die of actor.nextAttackDice) modifier += rollFormula(this.state, die);
      actor.nextAttackDice = [];
    }
    if (options.hostile && this.state.combatants[other(side)].statuses.unbalanced) {
      modifier += rollFormula(this.state, combatData.global.statuses.unbalanced.on_incoming_hostile_check[0].value);
      this.consumeStatus(other(side), 'unbalanced', 1);
    }
    if (options.hostile && side === 'geralt') {
      const bonus = actor.effects.find(effect => effect.kind === 'axii_bonus' && effect.target === other(side));
      if (bonus) {
        modifier += rollFormula(this.state, combatData.global.signs.axii.on_critical[0].modifier_die);
        bonus.uses = (bonus.uses ?? 1) - 1;
        if (bonus.uses <= 0) actor.effects = actor.effects.filter(effect => effect !== bonus);
      }
    }
    if (options.attack && options.advantage && options.advantage !== 'none') {
      modifier += rollFormula(this.state, options.advantage === 'advantage'
        ? combatData.global.dice.environment_advantage : combatData.global.dice.environment_disadvantage);
    }
    if (side === 'geralt' && options.useHopeAdvantage) {
      if (this.state.hope < 2) throw new Error('Insufficient hope');
      this.state.hope -= 2;
      modifier += 3;
      this.emit('hope_spent', { amount: 2, remaining: this.state.hope }, side);
    }
    let natural: number;
    let critical: boolean;
    let natural20Hostile = false;
    let withHope = false;
    let withFear = false;
    if (side === 'geralt') {
      const hope = rollFormula(this.state, combatData.global.dice.player.hope);
      const fear = rollFormula(this.state, combatData.global.dice.player.fear);
      dice.hope = hope; dice.fear = fear;
      natural = hope + fear;
      critical = hope === fear;
      withHope = critical || hope > fear;
      withFear = fear > hope;
    } else {
      const d20 = rollFormula(this.state, combatData.global.dice.monster.check);
      dice.d20 = d20;
      natural = d20;
      critical = options.attack && d20 === 20;
      natural20Hostile = options.hostile && d20 === 20;
    }
    const total = natural + modifier;
    const success = critical || natural20Hostile || total >= targetValue;
    this.emit('check', { dice, modifier, total, targetValue, success, critical,
      withHope, withFear, advantage: options.attack ? options.advantage ?? 'none' : 'none' }, side, options.hostile ? other(side) : undefined);
    if (side === 'geralt' && withHope) {
      const amount = Math.min(1, 6 - this.state.hope);
      this.state.hope += amount;
      this.emit('hope_gained', { amount, current: this.state.hope }, side);
    } else if (side === 'geralt' && withFear) {
      const amount = Math.min(1, 12 - this.state.fear);
      this.state.fear += amount;
      this.emit('fear_gained', { amount, current: this.state.fear }, side);
    }
    return { success, critical, withHope, withFear, total };
  }

  private consumeStatus(side: Side, status: string, amount: number): void {
    const actor = this.state.combatants[side];
    if (!actor.statuses[status]) return;
    actor.statuses[status] = Math.max(0, actor.statuses[status] - amount);
    const definition = combatData.global.statuses[status];
    const family = definition?.family && combatData.global.status_families[definition.family];
    if (actor.statuses[status] <= (family?.ends_at_counter ?? definition?.ends_at_counter ?? 0)) delete actor.statuses[status];
    this.emit('status_changed', { status, remaining: actor.statuses[status] ?? 0 }, side);
  }

  private immuneTo(side: Side, status: string): boolean {
    const actor = this.state.combatants[side];
    if (actor.effects.some(effect => effect.kind === 'immunity' && effect.status === status)) return true;
    return Object.values<Rule>(actorTemplate(this.state, side).traits ?? {})
      .some(trait => (trait.immunities ?? []).includes(status));
  }

  private applyStatus(side: Side, status: string, stacks: number): void {
    if (!combatData.global.statuses[status]) throw new Error(`Unknown status: ${status}`);
    if (this.immuneTo(side, status)) {
      this.emit('status_immune', { status }, side);
      return;
    }
    const actor = this.state.combatants[side];
    const previous = actor.statuses[status] ?? 0;
    const mode = combatData.global.statuses[status].reapply.mode;
    const updated = mode === 'keep_higher' ? Math.max(previous, stacks) : mode === 'add_remaining' ? previous + stacks : Math.max(previous, 1);
    actor.statuses[status] = updated;
    this.emit('status_applied', { status, previous, current: updated }, side);
  }

  private timedEffect(side: Side, effect: TimedEffect, appliedBy: Side): void {
    if (effect.remaining !== undefined) {
      effect.startAfterCompleted = this.state.combatants[side].completedActions + Number(side === appliedBy);
    }
    this.state.combatants[side].effects.push(effect);
    this.emit('effect_applied', { effect }, appliedBy, side);
  }

  private applyEffects(effects: Rule[], actorSide: Side, defaultTarget: Side): void {
    for (const effect of effects) {
      const selfByDefault = ['heal_hp', 'grant_temporary_stat_modifier', 'grant_counter_effect',
        'grant_immunity', 'restore_resource'].includes(effect.type);
      const target = effect.target === 'self' ? actorSide : effect.target === 'player' ? 'geralt'
        : selfByDefault ? actorSide : defaultTarget;
      const recipient = this.state.combatants[target];
      switch (effect.type) {
        case 'apply_status': this.applyStatus(target, effect.status, effect.stacks ?? 1); break;
        case 'heal_hp': {
          const before = recipient.hp;
          recipient.hp = Math.min(recipient.maxHp, recipient.hp + effect.amount);
          this.emit('healed', { amount: recipient.hp - before, current: recipient.hp }, actorSide, target);
          break;
        }
        case 'grant_next_attack_modifier_die':
          this.state.combatants[actorSide].nextAttackDice.push(effect.value);
          this.emit('next_attack_modifier', { die: effect.value }, actorSide);
          break;
        case 'grant_temporary_stat_modifier':
          this.timedEffect(target, { kind: 'stat', stat: effect.stat, value: effect.value,
            remaining: effect.duration?.count,
            untilNextAttack: effect.duration?.type === 'until_next_attack' }, actorSide);
          break;
        case 'clear_status':
          delete recipient.statuses[effect.status];
          this.emit('status_cleared', { status: effect.status }, actorSide, target);
          break;
        case 'grant_counter_effect':
          if (effect.effect !== 'thunderbolt') throw new Error(`Unsupported counter effect: ${effect.effect}`);
          recipient.thunderboltUses = effect.uses;
          this.emit('counter_effect', { effect: effect.effect, uses: effect.uses }, actorSide, target);
          break;
        case 'grant_immunity':
          this.timedEffect(target, { kind: 'immunity', status: effect.status, remaining: effect.duration.count }, actorSide);
          break;
        case 'restore_resource': {
          if (effect.resource !== 'sign_points') throw new Error(`Unsupported resource: ${effect.resource}`);
          const before = recipient.signPoints;
          recipient.signPoints = Math.min(recipient.maxSignPoints, recipient.signPoints + effect.amount);
          this.emit('resource_restored', { resource: effect.resource, amount: recipient.signPoints - before }, actorSide, target);
          break;
        }
        case 'interrupt_prepared_action':
          this.emit('prepared_action_interrupted', {}, actorSide, target);
          break;
        case 'grant_temporary_check_modifier':
          this.timedEffect(actorSide, { kind: 'axii_bonus', target, uses: effect.uses }, actorSide);
          break;
        case 'override_applied_status_stacks':
        case 'increase_damage_rank':
        case 'reduce_damage_rank':
        case 'remove_self':
          throw new Error(`${effect.type} must be applied during damage resolution`);
        default: throw new Error(`Unsupported action effect: ${effect.type}`);
      }
    }
  }

  private rankFor(target: Side, amount: number): DamageRank {
    if (amount <= 0) return 'none';
    const actor = this.state.combatants[target];
    if (amount >= actor.severeThreshold) return 'severe';
    if (amount >= actor.heavyThreshold) return 'heavy';
    return 'light';
  }

  private shiftRank(rank: DamageRank, steps: number): DamageRank {
    return ranks[Math.max(0, Math.min(3, ranks.indexOf(rank) + steps))]!;
  }

  private applyPartTrauma(partId: string, rank: DamageRank): void {
    const monster = this.state.combatants.monster;
    const definition = actorTemplate(this.state, 'monster').parts?.[partId];
    if (!definition?.trauma_track || rank === 'none') return;
    const before = monster.trauma[partId] ?? 0;
    const after = Math.min(combatData.global.part_trauma.max, before + combatData.global.part_trauma.increase_by_final_damage_rank[rank]);
    monster.trauma[partId] = after;
    this.emit('part_trauma', { partId, before, after }, 'geralt', 'monster');
    if (before < 2 && after >= 2) {
      for (const effect of asEffects(definition.effects?.heavy)) {
        if (effect.type === 'reduce_status_effect') this.consumeStatus('monster', effect.status, effect.remaining_uses ?? 1);
      }
    }
    if (before < 3 && after === 3 && asEffects(definition.effects?.destroyed).some(effect => effect.type === 'death')) {
      monster.hp = 0;
      this.emit('part_destroyed_fatal', { partId }, 'geralt', 'monster');
    }
  }

  private damage(source: Side, target: Side, formula: string, options: {
    critical?: boolean; part?: string; extraDie?: string; extraRank?: number; damageType?: string;
  } = {}): DamageRank {
    const targetActor = this.state.combatants[target];
    let rolled = rollFormula(this.state, formula);
    if (options.extraDie) rolled += rollFormula(this.state, options.extraDie);
    if (options.part) {
      const part = actorTemplate(this.state, target).parts?.[options.part];
      if (!part) throw new Error(`Unknown target part: ${options.part}`);
      rolled = rolled > 0 ? Math.max(1, Math.floor(rolled * part.damage_multiplier)) : Math.floor(rolled * part.damage_multiplier);
    }
    let rank = this.rankFor(target, rolled);
    if (rolled > 0 && options.critical) rank = this.shiftRank(rank, combatData.global.critical.damage_rank_increase_steps_if_base_damage_gt_zero);
    if (rolled > 0 && options.extraRank) rank = this.shiftRank(rank, options.extraRank);
    for (const effect of traitEffects(this.state, target)) {
      if (effect.type === 'increase_incoming_damage_rank_if' && effect.condition?.damage_type === options.damageType && rank !== 'none') {
        rank = this.shiftRank(rank, effect.steps);
      }
      if (effect.type === 'reduce_incoming_damage_rank_if' && effect.condition?.final_roll_below !== undefined &&
        rolled < effect.condition.final_roll_below) rank = this.shiftRank(rank, -effect.steps);
    }
    const armorApplies = (damageRank: DamageRank): boolean => targetActor.armor > 0 &&
      ranks.indexOf(damageRank) >= ranks.indexOf(combatData.global.armor.absorb_from_rank);
    const rankWithoutQuen = armorApplies(rank)
      ? this.shiftRank(rank, -combatData.global.armor.reduce_rank_steps) : rank;
    const quen = targetActor.effects.find(effect => effect.kind === 'quen');
    if (quen && combatData.global.damage_rank.hp_loss[rankWithoutQuen] > 0) {
      rank = this.shiftRank(rank, -combatData.global.signs.quen.on_trigger.find((effect: Rule) => effect.type === 'reduce_damage_rank').steps);
      targetActor.effects = targetActor.effects.filter(effect => effect !== quen);
      this.emit('quen_triggered', { rank }, target);
    }
    if (armorApplies(rank)) {
      targetActor.armor -= combatData.global.armor.points_per_hit;
      rank = this.shiftRank(rank, -combatData.global.armor.reduce_rank_steps);
      this.emit('armor_absorbed', { armor: targetActor.armor, rank }, target);
    }
    const loss = combatData.global.damage_rank.hp_loss[rank] as number;
    targetActor.hp = Math.max(0, targetActor.hp - loss);
    this.emit('damage', { formula, rolled, rank, hpLoss: loss, hp: targetActor.hp,
      part: options.part ?? null, critical: Boolean(options.critical) }, source, target);
    if (options.part && target === 'monster') this.applyPartTrauma(options.part, rank);
    if (options.critical && rank === combatData.global.critical.apply_bleeding_if_final_damage_rank) this.applyStatus(target, 'bleeding', 1);
    return rank;
  }

  private applySignHitTraits(sign: string): void {
    for (const effect of traitEffects(this.state, 'monster')) {
      if (effect.type !== 'on_hit_by_sign' || effect.sign !== sign) continue;
      const nested = effect.effects ?? (effect.effect ? [effect.effect] : []);
      for (const entry of nested as Rule[]) {
        if (entry.type === 'clear_status') {
          delete this.state.combatants.monster.statuses[entry.status];
          this.emit('status_cleared', { status: entry.status }, 'geralt', 'monster');
        } else if (entry.type === 'temporarily_disable_tagged_actions') {
          this.timedEffect('monster', { kind: 'disabled_tag', tag: entry.tag, remaining: 1 }, 'geralt');
        } else if (entry.type === 'temporarily_disable_action') {
          this.timedEffect('monster', { kind: 'disabled_action', action: entry.action, remaining: 1 }, 'geralt');
        } else throw new Error(`Unsupported sign hit trait: ${entry.type}`);
      }
    }
  }

  private resolveZero(actingSide: Side, initiativeAfter: Side, resume: 'finish_action' | 'resolve_initiative',
    deathStatuses?: Record<string, number>): void {
    const monster = this.state.combatants.monster;
    if (monster.hp === 0 && !monster.dead) {
      monster.dead = true;
      this.emit('monster_defeated', { monsterId: this.state.monsterId }, 'monster');
      for (const effect of traitEffects(this.state, 'monster')) {
        if (effect.type === 'on_death_if_not_status' && !(deathStatuses ?? monster.statuses)[effect.status]) {
          if (effect.effect.type !== 'area_damage') throw new Error(`Unsupported death effect: ${effect.effect.type}`);
          this.damage('monster', 'geralt', effect.effect.damage);
          this.emit('death_effect', { type: 'area_damage', targetScope: effect.effect.target_scope }, 'monster', 'geralt');
        }
      }
    }
    const geralt = this.state.combatants.geralt;
    if (geralt.hp === 0 && !this.state.pending && !this.state.outcome) {
      this.state.pending = { kind: 'dying', options: ['survive', 'gamble'], resume, actingSide, initiativeAfter };
      this.emit('decision_required', { kind: 'dying', options: this.state.pending.options }, 'geralt');
    }
    if (monster.dead && !this.state.pending && !this.state.outcome) this.endBattle('geralt_won');
  }

  private endBattle(outcome: Outcome): void {
    this.state.outcome = outcome;
    this.state.pending = null;
    this.state.combatants.geralt.toxicity = combatData.global.toxicity.reset_current_to;
    this.emit('battle_ended', { outcome });
  }

  private usePotion(id: string, bonus: boolean): void {
    const actor = this.state.combatants.geralt;
    const potion = combatData.global.potions[id];
    if (!potion || !actor.potions.includes(id)) throw new Error(`Potion unavailable: ${id}`);
    if (actor.toxicity + potion.toxicity > actor.maxToxicity) throw new Error(`Toxicity limit exceeded: ${id}`);
    actor.potions.splice(actor.potions.indexOf(id), 1);
    actor.toxicity += potion.toxicity;
    this.emit('potion_drunk', { id, bonus, toxicity: actor.toxicity }, 'geralt');
    this.applyEffects(potion.apply, 'geralt', 'geralt');
  }

  private afterAttack(side: Side): void {
    const actor = this.state.combatants[side];
    actor.effects = actor.effects.filter(effect => !effect.untilNextAttack);
  }

  private resolveAttack(side: Side, id: string, command: ActionCommand): { initiativeAfter: Side; bonus: boolean } {
    const target = other(side);
    const targetActor = this.state.combatants[target];
    const sword = side === 'geralt';
    const retaliatesOnHit = sword && Boolean(targetActor.statuses.spined);
    const attack = sword
      ? combatData.actors.geralt!.weapons.silver_sword.attacks[id.split(':')[1]!]
      : actorTemplate(this.state, side).attacks[id.split(':')[1]!];
    const tags: string[] = attack.tags ?? [];
    if (sword) tags.push('sword');
    const baseCost = attack.cost?.fear ?? 0;
    const empowermentCost = Number(Boolean(command.empowerHit)) * combatData.global.fear.generic_empowerments.empower_hit.cost.fear +
      Number(Boolean(command.empowerDamage)) * combatData.global.fear.generic_empowerments.empower_damage.cost.fear;
    if (side === 'monster') {
      if (this.state.combatants.monster.statuses.hesitant && empowermentCost) throw new Error('Hesitant monster cannot empower');
      if (this.state.fear < baseCost + empowermentCost) throw new Error('Insufficient fear');
      this.state.fear -= baseCost + empowermentCost;
      if (baseCost + empowermentCost) this.emit('fear_spent', { amount: baseCost + empowermentCost, remaining: this.state.fear }, side);
    } else if (empowermentCost) throw new Error('Geralt cannot use fear empowerment');
    let fixedModifier = (attack.attack_modifier ?? 0) + (side === 'monster' ? actorTemplate(this.state, side).stats.base_attack_modifier ?? 0 : 0);
    if (command.part) fixedModifier += actorTemplate(this.state, target).parts[command.part].attack_modifier;
    if (command.empowerHit) fixedModifier += rollFormula(this.state,
      combatData.global.fear.generic_empowerments.empower_hit.effects[0].value);
    const thunderboltActive = side === 'geralt' && this.state.combatants.geralt.thunderboltUses > 0;
    if (thunderboltActive) {
      this.state.combatants.geralt.thunderboltUses -= 1;
      this.emit('counter_effect_used', { effect: 'thunderbolt', remaining: this.state.combatants.geralt.thunderboltUses }, side);
    }
    const result = this.check(side, this.defense(target), {
      attack: true, hostile: true, tags, advantage: command.advantage ?? 'none', fixedModifier,
      modifierDie: attack.check_modifier_die, sword, useHopeAdvantage: command.useHopeAdvantage
    });
    const initiativeAfter: Side = side === 'monster' ? 'geralt' : result.success && (result.critical || result.withHope) ? 'geralt' : 'monster';
    if (result.success) {
      if (attack.damage) {
        let extraDie: string | undefined;
        if (command.empowerDamage) extraDie = Array(combatData.global.fear.generic_empowerments.empower_damage.effects[0].count)
          .fill(baseDie(attack.damage)).join('+');
        if (thunderboltActive) {
          // The Thunderbolt counter is consumed on the check and adds damage only on a hit.
          const thunderbolt = combatData.global.potions.thunderbolt.effect.damage_modifier;
          extraDie = extraDie ? `${extraDie}+${thunderbolt}` : thunderbolt;
        }
        this.damage(side, target, attack.damage, { critical: result.critical, part: command.part, extraDie });
      }
      this.applyEffects(asEffects(attack.on_hit), side, target);
      if (retaliatesOnHit) {
        const amount = combatData.global.statuses.spined.on_incoming_melee_hit[0].amount;
        this.state.combatants.geralt.hp = Math.max(0, this.state.combatants.geralt.hp - amount);
        this.emit('retaliation', { status: 'spined', hpLoss: amount }, 'monster', 'geralt');
      }
    } else {
      this.applyEffects(asEffects(attack.on_miss), side, side);
    }
    this.afterAttack(side);
    this.resolveZero(side, initiativeAfter, 'finish_action');
    return { initiativeAfter, bonus: side === 'geralt' && result.critical && result.success };
  }

  private resolveSign(id: string, command: ActionCommand): { initiativeAfter: Side; bonus: boolean } {
    const signId = id.split(':')[1]!;
    const sign = combatData.global.signs[signId];
    const actor = this.state.combatants.geralt;
    actor.signPoints -= sign.cost.sign_points;
    this.emit('resource_spent', { resource: 'sign_points', amount: sign.cost.sign_points, remaining: actor.signPoints }, 'geralt');
    const hostile = sign.check.type === 'player_hostile';
    const targetValue = hostile ? this.defense('monster', signId) : sign.check.difficulty;
    const result = this.check('geralt', targetValue, { attack: Boolean(sign.is_attack), hostile,
      advantage: sign.is_attack ? command.advantage ?? 'none' : 'none', useHopeAdvantage: command.useHopeAdvantage });
    const initiativeAfter: Side = result.success && (result.critical || result.withHope) ? 'geralt' : 'monster';
    if (result.success) {
      if (signId === 'aard') {
        const choice = sign.on_success.choices.find((item: Rule) => item.id === command.choice);
        const selected = result.critical ? sign.on_success.choices.flatMap((item: Rule) => item.effects) : choice.effects;
        this.applyEffects(selected, 'geralt', 'monster');
      } else if (signId === 'igni') {
        const extraRank = result.critical ? asEffects(sign.on_critical)
          .filter(effect => effect.type === 'increase_damage_rank').reduce((sum, effect) => sum + effect.steps, 0) : 0;
        this.damage('geralt', 'monster', sign.damage.formula, { critical: result.critical,
          extraRank, damageType: sign.damage.damage_type });
        const onHit = asEffects(sign.on_hit).map(effect => ({ ...effect }));
        if (result.critical) {
          for (const criticalEffect of asEffects(sign.on_critical)) {
            if (criticalEffect.type === 'override_applied_status_stacks') {
              for (const effect of onHit) if (effect.type === 'apply_status' && effect.status === criticalEffect.status) effect.stacks = criticalEffect.stacks;
            }
          }
        }
        this.applyEffects(onHit, 'geralt', 'monster');
      } else if (signId === 'yrden') {
        const target = this.state.combatants.monster;
        target.effects = target.effects.filter(effect => effect.kind !== 'yrden');
        this.timedEffect('monster', { kind: 'yrden', remaining: sign.duration.count }, 'geralt');
      } else if (signId === 'quen') {
        actor.effects = actor.effects.filter(effect => effect.kind !== 'quen');
        this.timedEffect('geralt', { kind: 'quen', remaining: sign.duration_end_any[1].count }, 'geralt');
      } else if (signId === 'axii') {
        if (!this.immuneTo('monster', 'axii')) {
          this.applyEffects(asEffects(sign.on_success), 'geralt', 'monster');
          if (result.critical) this.applyEffects(asEffects(sign.on_critical), 'geralt', 'monster');
        } else this.emit('sign_immune', { sign: signId }, 'monster');
      }
      this.applySignHitTraits(signId);
    }
    this.resolveZero('geralt', initiativeAfter, 'finish_action');
    return { initiativeAfter, bonus: result.success && (sign.is_attack ? result.critical || result.withHope : result.withHope) };
  }

  private resolveMonsterAction(id: string): { initiativeAfter: Side; bonus: boolean } {
    const actionId = id.split(':')[1]!;
    const action = actorTemplate(this.state, 'monster').actions[actionId];
    const cost = action.cost?.fear ?? 0;
    if (this.state.fear < cost) throw new Error('Insufficient fear');
    this.state.fear -= cost;
    if (cost) this.emit('fear_spent', { amount: cost, remaining: this.state.fear }, 'monster');
    if (action.when_uncertain_check) {
      const result = this.check('monster', action.when_uncertain_check.difficulty,
        { attack: false, hostile: false, tags: action.tags ?? [] });
      if (result.success) this.endBattle('monster_escaped');
    } else if (action.check) {
      const result = this.check('monster', this.defense('geralt'), { attack: false, hostile: true, tags: action.tags ?? [] });
      if (result.success) this.applyEffects(asEffects(action.on_success), 'monster', 'geralt');
    } else this.applyEffects(asEffects(action.effects), 'monster', 'geralt');
    this.resolveZero('monster', 'geralt', 'finish_action');
    return { initiativeAfter: 'geralt', bonus: false };
  }

  private tickStatuses(side: Side): Record<string, number> | undefined {
    const actor = this.state.combatants[side];
    let deathStatuses: Record<string, number> | undefined;
    const applyPersistentDamage = (status: string, amount: number): void => {
      const hpBefore = actor.hp;
      actor.hp = Math.max(0, actor.hp - amount);
      this.emit('persistent_damage', { status, hpLoss: amount, hp: actor.hp }, side);
      if (side === 'monster' && hpBefore > 0 && actor.hp === 0) deathStatuses = { ...actor.statuses };
    };
    for (const [status, definition] of Object.entries<Rule>(combatData.global.statuses)) {
      if (!actor.statuses[status]) continue;
      if (definition.family === 'persistent_damage') {
        applyPersistentDamage(status, definition.damage_per_action);
        this.consumeStatus(side, status, combatData.global.status_families.persistent_damage.decrement_per_action);
        continue;
      }
      for (const effect of asEffects(definition.on_owner_full_action_end)) {
        if (effect.type === 'direct_hp_loss') applyPersistentDamage(status, effect.amount);
        else if (effect.type === 'decrement_counter') this.consumeStatus(side, status, effect.amount);
        else throw new Error(`Unsupported status end effect: ${effect.type}`);
      }
    }
    return deathStatuses;
  }

  private tickTraits(side: Side, statusesAtActionEnd: Record<string, number>): void {
    for (const effect of traitEffects(this.state, side)) {
      if (effect.type !== 'on_owner_full_action_end') continue;
      if (effect.if_not_status_any?.some((status: string) => statusesAtActionEnd[status])) continue;
      this.applyEffects([effect.effect], side, side);
    }
  }

  private tickTimed(side: Side): void {
    const actor = this.state.combatants[side];
    for (const effect of actor.effects) {
      if (effect.remaining === undefined) continue;
      if (actor.completedActions > (effect.startAfterCompleted ?? 0)) effect.remaining -= 1;
    }
    const expired = actor.effects.filter(effect => effect.remaining !== undefined && effect.remaining <= 0);
    actor.effects = actor.effects.filter(effect => !expired.includes(effect));
    for (const effect of expired) this.emit('effect_expired', { kind: effect.kind, tag: effect.tag, action: effect.action }, side);
  }

  private finishAction(side: Side, initiativeAfter: Side): void {
    if (this.state.outcome) return;
    const actor = this.state.combatants[side];
    const statusesAtActionEnd = { ...actor.statuses };
    actor.completedActions += 1;
    const deathStatuses = this.tickStatuses(side);
    if (actor.hp > 0) this.tickTraits(side, statusesAtActionEnd);
    this.tickTimed(side);
    this.resolveZero(side, initiativeAfter, 'resolve_initiative', deathStatuses);
    if (!this.state.pending && !this.state.outcome) this.resolveInitiative(initiativeAfter);
  }

  private resolveInitiative(next: Side): void {
    if (this.state.outcome) return;
    this.state.initiative = this.state.forcedGeraltInitiative ? 'geralt' : next;
    this.state.forcedGeraltInitiative = false;
    this.emit('initiative', { side: this.state.initiative });
    if (this.state.actionCount >= this.state.maxActions) this.endBattle('action_limit');
  }

  action(command: ActionCommand): void {
    if (this.state.outcome) throw new Error('Battle has ended');
    if (this.state.pending) throw new Error('Resolve pending decision first');
    const option = getOptions(this.state).find(item => item.id === command.id);
    if (!option) throw new Error(`Action unavailable: ${command.id}`);
    if (command.part && (!option.targetParts || !option.targetParts.includes(command.part))) throw new Error(`Invalid target part: ${command.part}`);
    if (option.choices && !option.choices.includes(command.choice ?? '')) throw new Error(`Choice required: ${option.choices.join(', ')}`);
    if (command.advantage && !['none', 'advantage', 'disadvantage'].includes(command.advantage)) throw new Error('Invalid advantage');
    if (command.advantage && command.advantage !== 'none' && !(option.kind === 'attack' || command.id === 'sign:igni')) {
      throw new Error('Advantage applies only to attack hit checks');
    }
    if (command.useHopeAdvantage) {
      if (option.actor !== 'geralt' || !['attack', 'sign'].includes(option.kind)) throw new Error('Hope bonus requires a Geralt check');
      if (this.state.hope < 2) throw new Error('Insufficient hope');
    }
    if (command.empowerHit || command.empowerDamage) {
      if (option.actor !== 'monster' || option.kind !== 'attack') throw new Error('Fear empowerment requires monster attack');
      if (command.empowerDamage && !option.canEmpowerDamage) throw new Error('Damage empowerment unavailable');
      if (command.empowerHit && !option.canEmpowerHit) throw new Error('Hit empowerment unavailable');
    }
    const side = this.state.initiative;
    this.state.actionCount += 1;
    this.emit('action_started', { id: command.id, part: command.part ?? null }, side);
    let result: { initiativeAfter: Side; bonus: boolean };
    if (option.kind === 'attack') result = this.resolveAttack(side, command.id, command);
    else if (option.kind === 'sign') result = this.resolveSign(command.id, command);
    else if (option.kind === 'potion') {
      this.usePotion(command.id.split(':')[1]!, false);
      result = { initiativeAfter: 'monster', bonus: false };
    } else if (option.kind === 'clear') {
      const status = command.id.split(':')[1]!;
      delete this.state.combatants[side].statuses[status];
      this.emit('status_cleared', { status }, side);
      result = { initiativeAfter: other(side), bonus: false };
    } else result = this.resolveMonsterAction(command.id);
    if (this.state.outcome || this.state.pending) return;
    if (result.bonus && side === 'geralt') {
      const options = ['skip', ...this.state.combatants.geralt.potions
        .filter(id => this.state.combatants.geralt.toxicity + combatData.global.potions[id].toxicity <= this.state.combatants.geralt.maxToxicity)
        .map(id => `potion:${id}`)];
      this.state.pending = { kind: 'bonus_action', options, resume: 'finish_action', actingSide: side,
        initiativeAfter: result.initiativeAfter };
      this.emit('decision_required', { kind: 'bonus_action', options }, side);
    } else this.finishAction(side, result.initiativeAfter);
  }

  decision(command: DecisionCommand): void {
    const pending = this.state.pending;
    if (!pending) throw new Error('No pending decision');
    if (!pending.options.includes(command.choice)) throw new Error(`Invalid decision: ${command.choice}`);
    this.state.pending = null;
    this.emit('decision_made', { kind: pending.kind, choice: command.choice }, pending.kind === 'dying' ? 'geralt' : pending.actingSide);
    if (pending.kind === 'bonus_action') {
      if (command.choice.startsWith('potion:')) this.usePotion(command.choice.split(':')[1]!, true);
      this.finishAction(pending.actingSide, pending.initiativeAfter);
      return;
    }
    if (command.choice === 'survive') {
      this.endBattle('geralt_incapacitated');
      return;
    }
    const hope = rollFormula(this.state, combatData.global.dying_choice.gamble_roll.hope);
    const fear = rollFormula(this.state, combatData.global.dying_choice.gamble_roll.fear);
    this.emit('dying_roll', { hope, fear }, 'geralt');
    if (fear > hope) {
      this.endBattle('geralt_dead');
      return;
    }
    const restore = hope === fear ? combatData.global.dying_choice.equal.restore_hp : combatData.global.dying_choice.hope_gt_fear.restore_hp;
    this.state.combatants.geralt.hp = restore;
    this.state.forcedGeraltInitiative = true;
    this.emit('dying_recovered', { hp: restore }, 'geralt');
    if (this.state.combatants.monster.dead) {
      this.endBattle('geralt_won');
      return;
    }
    if (pending.resume === 'finish_action') this.finishAction(pending.actingSide, pending.initiativeAfter);
    else this.resolveInitiative(pending.initiativeAfter);
  }
}

export function advanceBattle(previous: BattleState, command: Command): BattleState {
  if (previous.version !== 1) throw new Error('Unsupported battle state version');
  if (previous.dataRevision !== dataRevision) throw new Error('Battle state uses a different data revision');
  const state = structuredClone(previous);
  const resolver = new Resolver(state);
  if (command.type === 'action') resolver.action(command);
  else if (command.type === 'decision') resolver.decision(command);
  else throw new Error('Unknown command type');
  return state;
}
