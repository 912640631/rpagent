import { commandSchema, createAdventureSession, createBattleHandoff, monsterIds, combatData, type Command,
  type Combatant, type BattleHandoffContext } from 'witcher-combat-engine';
import type { ToolDefinition } from './types.js';
import { tokens } from './context.js';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const strings = { type: 'array', items: string };
export const mainTools: ToolDefinition[] = [
  { name: 'rules_status', description: '读取权威规则资源与上场角色状态。', parameters: object({}) },
  { name: 'narrative_roll', description: '在非战斗阶段执行一次叙事判定。结果以引擎为准。', parameters: object({
    difficulty: { type: 'integer' }, modifier: { type: 'integer' }, useHopeAdvantage: { type: 'boolean' }
  }, ['difficulty']) },
  { name: 'spend_fear', description: '按照 NarrativeDice 规则花费绝望。', parameters: object({}) },
  { name: 'list_monsters', description: '列出 CombatEngine 支持的怪物，开始战斗前查阅。', parameters: object({}) },
  { name: 'start_battle', description: '交接一次杰洛特对单只目录怪物的战斗，随后战斗子 Agent 接管玩家交互。只提供战斗所需信息。', parameters: object({
    monsterId: string, scene: string, facts: strings, objectives: strings, environment: strings, risks: strings,
    monsterObjectId: string
  }, ['monsterId', 'scene', 'facts', 'objectives', 'environment', 'risks', 'monsterObjectId']) }
];
export const combatTools: ToolDefinition[] = [
  { name: 'battle_status', description: '读取当前战斗权威状态、合法行动、可选部位与待决选项。', parameters: object({}) },
  { name: 'battle_act', description: '执行一个合法引擎行动或待决选项。玩家行动必须来自当前玩家输入；怪物回合由你选择。', parameters: object({
    command: commandSchema
  }, ['command']) }
];

export function projectCharacter(actor: Combatant) {
  return { hp: actor.hp, armor: actor.armor, signPoints: actor.signPoints,
    toxicity: actor.toxicity, statuses: structuredClone(actor.statuses), potions: [...actor.potions] };
}

export class Rules {
  readonly adventure: ReturnType<typeof createAdventureSession>;
  readonly handoff: ReturnType<typeof createBattleHandoff>;
  constructor(readonly path: string) {
    this.adventure = createAdventureSession(path);
    this.handoff = createBattleHandoff(path);
  }
  exportSnapshot(): unknown { return this.adventure.exportSnapshot(); }
  validateSnapshot(value: unknown): void { this.adventure.validateSnapshot(value); }
  installSnapshot(value: unknown): void { this.adventure.installSnapshot(value); }
  latestCharacter(): Combatant | undefined {
    try { return this.adventure.battleRecord().state.combatants.geralt; }
    catch (error) { if ((error as { code?: string }).code === 'BATTLE_NOT_FOUND') return undefined; throw error; }
  }
  status() {
    const state = this.adventure.status();
    const actor = this.latestCharacter();
    return { revision: state.revision, owner: state.owner, resources: state.resources,
      character: actor ? { ...projectCharacter(actor), dead: actor.dead } : null };
  }
  execute(name: string, args: Record<string, any>, battleId?: string) {
    const state = this.adventure.status();
    switch (name) {
      case 'rules_status': return this.status();
      case 'narrative_roll': {
        const result = this.adventure.narrativeRoll(state.revision, args as { difficulty: number });
        return { revision: result.revision, resources: result.resources, result: result.result };
      }
      case 'spend_fear': {
        const result = this.adventure.spendFear(state.revision);
        return { revision: result.revision, resources: result.resources, result: result.result };
      }
      case 'list_monsters': return monsterIds.map(id => ({ id, name: combatData.actors[id]!.name_zh,
        difficulty: combatData.actors[id]!.difficulty, type: combatData.actors[id]!.monster_type }));
      case 'start_battle': {
        const actor = this.latestCharacter();
        if (actor && (actor.dead || actor.hp < 1)) throw new Error('杰洛特已死亡或失能，不能通过新战斗自动复活。');
        const context: BattleHandoffContext = {
          scene: args.scene, facts: args.facts, objectives: args.objectives, environment: args.environment, risks: args.risks,
          participants: [{ id: 'geralt', role: 'geralt' }, { id: args.monsterObjectId, role: 'monster' }],
          resources: { revision: state.revision, ...state.resources }
        };
        const result = this.handoff.start(state.revision, { monsterId: args.monsterId,
          ...(actor ? { initial: { geralt: projectCharacter(actor) } } : {}) }, context);
        return { battleId: result.battleId, handedOff: true };
      }
      case 'battle_status': return this.handoff.status(battleId);
      case 'battle_act': {
        if (!battleId) throw new Error('没有活动战斗');
        const current = this.handoff.status(battleId);
        const result = this.handoff.act(battleId, current.revision, args.command as Command);
        return { ...result, combatants: undefined };
      }
      default: throw new Error('未知工具');
    }
  }
  settlement(battleId: string, budget: number, flavor = ''): unknown {
    const result = this.handoff.settlement(battleId, flavor);
    const data = result.structured;
    const essential = { battleId, outcome: data.outcome, actionCount: data.actionCount,
      combatants: data.combatants.map(actor => ({ id: actor.id, role: actor.role,
        ...projectCharacter(actor), dead: actor.dead, trauma: actor.trauma })),
      resources: data.resources.after,
      objectives: data.objectives };
    if (tokens(essential) > budget) throw new Error('战斗必要结果超过预算，请调高 battleResultTokens 后重试。');
    const full = { ...essential, flavor: { text: flavor, trusted: false }, events: data.events.slice(-3) };
    if (tokens(full) <= budget) return full;
    const withFlavor = { ...essential, flavor: { text: flavor, trusted: false } };
    return tokens(withFlavor) <= budget ? withFlavor : essential;
  }
}
