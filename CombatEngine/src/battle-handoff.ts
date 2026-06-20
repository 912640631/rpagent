import { AdventureError, createAdventureSession, type StoredBattle } from './adventure-session.js';
import { makeSessionView } from './session-view.js';
import type { BattleConfig, Command, Side } from './types.js';

export interface BattleHandoffContext {
  scene: string;
  facts: string[];
  participants: { id: string; role: Side }[];
  objectives: string[];
  environment: string[];
  risks: string[];
  resources: { revision: number; hope: number; fear: number };
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);

function validateContext(value: unknown): asserts value is BattleHandoffContext {
  const context = value as BattleHandoffContext | null;
  if (!context || !text(context.scene) || !texts(context.facts) || !texts(context.objectives) ||
      !texts(context.environment) || !texts(context.risks) || !Array.isArray(context.participants) ||
      context.participants.length !== 2 || context.participants.some(p => !p || !text(p.id)) ||
      new Set(context.participants.map(p => p.id)).size !== 2 ||
      context.participants.filter(p => p.role === 'geralt').length !== 1 ||
      context.participants.filter(p => p.role === 'monster').length !== 1 ||
      !context.resources || !Number.isSafeInteger(context.resources.revision) || context.resources.revision < 0 ||
      !Number.isSafeInteger(context.resources.hope) || context.resources.hope < 0 || context.resources.hope > 6 ||
      !Number.isSafeInteger(context.resources.fear) || context.resources.fear < 0 || context.resources.fear > 12) {
    throw new AdventureError('INVALID_HANDOFF', 'Handoff requires scene, string lists, unique Geralt/monster object IDs and versioned resources');
  }
}

function contextOf(record: StoredBattle): BattleHandoffContext {
  if (!record.metadata || record.metadata.kind !== 'battle-handoff-v1' || !record.initialState) {
    throw new AdventureError('HANDOFF_NOT_FOUND', 'Battle has no durable handoff');
  }
  validateContext(record.metadata.context);
  return structuredClone(record.metadata.context);
}

function statusOf(record: StoredBattle) {
  return {
    battleId: record.battleId, revision: record.revision, childSessionId: record.childSessionId ?? null,
    context: contextOf(record), view: makeSessionView(record.state),
    // The legacy view omits dead; retain the engine truth explicitly here.
    combatants: structuredClone(record.state.combatants),
    phase: record.state.outcome ? 'finished' as const : 'active' as const,
    awaiting: record.state.outcome ? null : record.state.pending ? 'player_decision' as const
      : record.state.initiative === 'geralt' ? 'player_action' as const : 'monster_action' as const
  };
}

function itemDelta(before: string[], after: string[]) {
  return [...new Set([...before, ...after])].map(id => ({
    id, before: before.filter(item => item === id).length, after: after.filter(item => item === id).length,
    delta: after.filter(item => item === id).length - before.filter(item => item === id).length
  }));
}

/** RPG-only coordination: no model calls, child spawning, notifications or automatic player choices. */
export function createBattleHandoff(storagePath?: string) {
  const adventure = createAdventureSession(storagePath);
  return {
    start(expectedRevision: number, config: BattleConfig, context: BattleHandoffContext) {
      validateContext(context);
      const ledger = adventure.status();
      if (context.resources.revision !== expectedRevision || ledger.revision !== expectedRevision) {
        throw new AdventureError('STALE_REVISION', 'Handoff resource revision has changed');
      }
      if (context.resources.hope !== ledger.resources.hope || context.resources.fear !== ledger.resources.fear) {
        throw new AdventureError('RESOURCE_MISMATCH', 'Handoff resources do not match the adventure ledger');
      }
      // startBattle checks the same revision under its write lock: a concurrent change cannot commit.
      const result = adventure.startBattle(expectedRevision, config, {
        kind: 'battle-handoff-v1', context: structuredClone(context)
      });
      return { ...statusOf(adventure.battleRecord(result.battle!.battleId)), adventureRevision: result.revision };
    },
    bindChild(battleId: string, childId: string) {
      contextOf(adventure.battleRecord(battleId));
      return statusOf(adventure.bindBattleChild(battleId, childId));
    },
    status(battleId?: string) { return statusOf(adventure.battleRecord(battleId)); },
    act(battleId: string, revision: number, command: Command) {
      const record = adventure.battleRecord(battleId);
      contextOf(record);
      if (!Number.isSafeInteger(revision) || revision < 0 || record.revision !== revision) {
        throw new AdventureError('STALE_REVISION', 'Battle revision has changed');
      }
      if (record.state.outcome) throw new AdventureError('BATTLE_FINISHED', 'Battle has finished');
      const result = adventure.act(battleId, revision, command);
      return { ...statusOf(adventure.battleRecord(battleId)), adventureRevision: result.revision, events: result.events };
    },
    settlement(battleId: string, narrativeSummary = '') {
      if (typeof narrativeSummary !== 'string') throw new AdventureError('INVALID_SUMMARY', 'Narrative summary must be text');
      const record = adventure.battleRecord(battleId);
      const context = contextOf(record);
      const final = record.state;
      const initial = record.initialState!;
      if (!final.outcome) throw new AdventureError('BATTLE_NOT_FINISHED', 'Cannot settle an unfinished battle');
      const combatants = context.participants.map(participant => {
        const before = initial.combatants[participant.role];
        const after = final.combatants[participant.role];
        return {
          ...structuredClone(after), engineId: after.id, id: participant.id, role: participant.role,
          deltas: { hp: after.hp - before.hp, armor: after.armor - before.armor,
            signPoints: after.signPoints - before.signPoints, toxicity: after.toxicity - before.toxicity },
          items: { before: [...before.potions], after: [...after.potions], changes: itemDelta(before.potions, after.potions) }
        };
      });
      return {
        structured: {
          source: 'combat-engine' as const, battleId, revision: record.revision,
          childSessionId: record.childSessionId ?? null, dataRevision: final.dataRevision, seed: final.seed,
          outcome: final.outcome, actionCount: final.actionCount, combatants,
          dead: combatants.filter(actor => actor.dead).map(actor => actor.id),
          survivors: combatants.filter(actor => !actor.dead).map(actor => actor.id),
          resources: { before: { hope: initial.hope, fear: initial.fear }, after: { hope: final.hope, fear: final.fear },
            deltas: { hope: final.hope - initial.hope, fear: final.fear - initial.fear } },
          events: structuredClone(final.events),
          // Free-form objectives and subsequent scenes have no engine evaluator in the single-monster rules.
          objectives: context.objectives.map(description => ({ description, status: 'not_evaluated' as const })),
          handoff: context
        },
        narrativeSummary: { text: narrativeSummary, trusted: false as const, source: 'untrusted_flavor' as const }
      };
    }
  };
}

export type BattleHandoffStatus = ReturnType<ReturnType<typeof createBattleHandoff>['status']>;
export type BattleSettlement = ReturnType<ReturnType<typeof createBattleHandoff>['settlement']>;
